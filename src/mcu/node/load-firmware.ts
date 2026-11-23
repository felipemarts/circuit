/**
 * Node-only firmware loader (the CLI path). Mirrors src/cli/load.ts:
 * TypeScript is transpiled with sucrase (types stripped, ESM → CJS, line
 * numbers preserved), loops are instrumented with the busy-loop guard, and
 * each file is evaluated with `vm.runInThisContext` under its real filename,
 * so stack frames — and every M6xx `at` — point at the firmware source line.
 *
 * Each call builds a fresh module graph: two MCUs loading the same firmware
 * file get independent module-level state, like two chips.
 *
 * Imports allowed in firmware: 'circuitsvibe/arduino' and relative files.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
import { transform } from 'sucrase';
import type { Firmware, McuDiagnostic, McuProfile } from '../types';
import { getMcuProfile, ATMEGA328P_UNO } from '../profiles';
import { mcuDiagnostic, firmwareLocFromStack, relativeToCwd } from '../diagnostics';
import { instrumentLoops } from '../instrument';
import { installLoopGuard, useProfileConstants } from '../arduino';
import { arduinoModule, ARDUINO_SPECIFIER } from '../module';

export interface LoadFirmwareOptions {
  /** Profile whose board constants (LED_BUILTIN, A0…) module top-level code sees. Default Uno. */
  profile?: McuProfile | string;
  /** Inject the busy-loop guard into loops (default true). */
  instrument?: boolean;
  /** Base for cwd-relative locations (default process.cwd()). */
  cwd?: string;
}

export type LoadFirmwareResult =
  | { ok: true; firmware: Firmware; source: string }
  | { ok: false; diagnostic: McuDiagnostic };

const RESOLVE_EXTENSIONS = ['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs', '.json'];

class LoadError extends Error {
  constructor(
    message: string,
    readonly at?: string,
    readonly note?: string,
  ) {
    super(message);
  }
}

/** Load a firmware file from disk. */
export function loadFirmwareFile(file: string, opts: LoadFirmwareOptions = {}): LoadFirmwareResult {
  const abs = path.resolve(file);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
    return fail(`firmware file not found: ${file}`, undefined, 'pass the path of a .ts/.js file that exports setup() and loop()');
  }
  return loadFirmwareSource(fs.readFileSync(abs, 'utf8'), abs, opts);
}

/**
 * Load firmware from source text. `filename` names it in stack traces and
 * anchors relative imports (which are read from disk).
 */
export function loadFirmwareSource(source: string, filename: string, opts: LoadFirmwareOptions = {}): LoadFirmwareResult {
  const cwd = opts.cwd ?? process.cwd();
  const profile = typeof opts.profile === 'string' ? getMcuProfile(opts.profile) : opts.profile;
  const abs = path.isAbsolute(filename) ? filename : path.resolve(cwd, filename);
  const display = relativeToCwd(abs, cwd);
  installLoopGuard();
  useProfileConstants(profile ?? ATMEGA328P_UNO);
  try {
    const exports = evaluate(abs, source, new Map(), opts.instrument ?? true, cwd);
    const firmware: Firmware = {
      setup: typeof exports.setup === 'function' ? (exports.setup as () => unknown) : undefined,
      loop: typeof exports.loop === 'function' ? (exports.loop as () => unknown) : undefined,
      file: display,
      entryLocs: entryLocs(source, display),
    };
    return { ok: true, firmware, source };
  } catch (err) {
    if (err instanceof LoadError) return fail(err.message, err.at, err.note);
    const e = err instanceof Error ? err : new Error(String(err));
    return fail(
      `firmware ${display} threw while loading: ${e.message}`,
      firmwareLocFromStack(e.stack, cwd) ?? display,
      'module top-level code runs at load time, outside the MCU: call Arduino APIs from setup()/loop() only',
    );
  }
}

/** file:line of `export … function setup/loop`, found textually. */
export function entryLocs(source: string, display: string): Firmware['entryLocs'] {
  const locs: NonNullable<Firmware['entryLocs']> = {};
  const lines = source.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/\bexport\s+(?:async\s+)?(?:function\s*\*?\s*|(?:const|let|var)\s+)(setup|loop)\b/);
    if (m && !locs[m[1] as 'setup' | 'loop']) locs[m[1] as 'setup' | 'loop'] = `${display}:${i + 1}`;
  }
  return locs;
}

function fail(message: string, at?: string, note?: string): LoadFirmwareResult {
  return {
    ok: false,
    diagnostic: mcuDiagnostic('M608', {
      message,
      at,
      note,
      fixes: [{ kind: 'fix-firmware-source', confidence: 'suggested', detail: at ? `fix the firmware at ${at}` : 'fix the firmware path or source' }],
    }),
  };
}

function evaluate(
  abs: string,
  source: string,
  cache: Map<string, { exports: Record<string, unknown> }>,
  instrument: boolean,
  cwd: string,
): Record<string, unknown> {
  const cached = cache.get(abs);
  if (cached) return cached.exports;
  const module = { exports: {} as Record<string, unknown> };
  cache.set(abs, module);
  const display = relativeToCwd(abs, cwd);

  if (abs.endsWith('.json')) {
    module.exports = JSON.parse(source) as Record<string, unknown>;
    return module.exports;
  }

  let code: string;
  try {
    code = transform(source, {
      transforms: /\.[mc]?ts$/.test(abs) ? ['typescript', 'imports'] : ['imports'],
      filePath: abs,
      production: true,
    }).code;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const m = msg.match(/\((\d+):(\d+)\)/);
    throw new LoadError(`firmware ${display} failed to compile: ${msg}`, m ? `${display}:${m[1]}` : display);
  }
  if (/\bimport\.meta\b/.test(code)) {
    throw new LoadError(`firmware ${display} uses import.meta, which is not supported`, display);
  }
  if (instrument) code = instrumentLoops(code);

  const localRequire = (specifier: string): unknown => {
    if (specifier === ARDUINO_SPECIFIER) return arduinoModule();
    if (specifier.startsWith('.') || path.isAbsolute(specifier)) {
      const dep = resolveLocal(specifier, abs, display);
      return evaluate(dep, fs.readFileSync(dep, 'utf8'), cache, instrument, cwd);
    }
    throw new LoadError(
      `firmware ${display} imports '${specifier}' — firmware may only import '${ARDUINO_SPECIFIER}' and relative files`,
      display,
      'firmware runs on the simulated MCU, not on the host: Node modules and npm packages are not available',
    );
  };

  let fn: (...args: unknown[]) => void;
  try {
    // Same-line wrapper keeps line numbers identical to the file on disk.
    fn = vm.runInThisContext(`(function (exports, require, module, __filename, __dirname) {${code}\n})`, {
      filename: abs,
    }) as typeof fn;
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err));
    const m = e.stack?.match(/^(.*):(\d+)\r?\n/);
    const hint = /await/.test(e.message) ? ' (await is only valid inside an async function — declare setup/loop as `async function`)' : '';
    throw new LoadError(`firmware ${display} failed to compile: ${e.message}${hint}`, m ? `${display}:${m[2]}` : display);
  }
  fn(module.exports, localRequire, module, abs, path.dirname(abs));
  return module.exports;
}

function resolveLocal(specifier: string, fromFile: string, display: string): string {
  const base = path.resolve(path.dirname(fromFile), specifier);
  const candidates = [base];
  const jsExt = base.match(/\.(m|c)?js$/);
  if (jsExt) candidates.push(base.slice(0, -jsExt[0].length) + `.${jsExt[1] ?? ''}ts`);
  for (const ext of RESOLVE_EXTENSIONS) candidates.push(base + ext);
  for (const ext of RESOLVE_EXTENSIONS) candidates.push(path.join(base, `index${ext}`));
  for (const c of candidates) if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  throw new LoadError(`cannot resolve '${specifier}' imported from ${display}`, display);
}
