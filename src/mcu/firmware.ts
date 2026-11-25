/**
 * Firmware from SOURCE TEXT — browser-safe (no Node APIs): the path the CLI,
 * circuit documents and the web viewer share.
 *
 *   bundle      { entry, files }: the entry path plus every file it imports
 *               relatively, keyed by stable POSIX paths (cwd-relative in the
 *               CLI; the circuit document's `sources[].path`)
 *   compile     sucrase (types stripped, ESM → CommonJS, line numbers kept) +
 *               busy-loop instrumentation, once per bundle
 *   instantiate a FRESH module graph per call (one per MCU per transient run,
 *               so module-level state starts over and runs are deterministic),
 *               evaluated with an indirect eval under `//# sourceURL=<path>` so
 *               stack frames — and every M6xx `at` — read `<path>:<line>`
 *
 * Imports allowed in firmware: 'circuitsvibe/arduino' and relative files of
 * the bundle. Reading files from disk is the host's job (src/mcu/node/firmware-host.ts).
 */
import { transform } from 'sucrase';
import type { Firmware, McuDiagnostic, McuProfile } from './types';
import { mcuDiagnostic, firmwareLocFromStack } from './diagnostics';
import { instrumentLoops } from './instrument';
import { installLoopGuard, useProfileConstants } from './arduino';
import { arduinoModule, ARDUINO_SPECIFIER } from './module';

/** Firmware source files: `entry` plus everything it imports relatively. Paths are POSIX, relative. */
export interface FirmwareBundle {
  entry: string;
  files: Record<string, string>;
}

export interface CompiledFirmware {
  readonly bundle: FirmwareBundle;
  /** path → CommonJS code (instrumented). */
  readonly modules: Record<string, string>;
}

export type FirmwareResult<T> = { ok: true; value: T } | { ok: false; diagnostic: McuDiagnostic };

export const FIRMWARE_EXTENSIONS = ['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs', '.json'];

/** Language tag of a firmware file in a circuit document's `sources`. */
export function firmwareLanguage(path: string): string {
  return /\.[mc]?ts$/.test(path) ? 'typescript' : /\.json$/.test(path) ? 'json' : 'javascript';
}

/** POSIX dirname / join / normalize (no Node `path` in the browser). */
export function posixDirname(p: string): string {
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i);
}

export function posixJoin(dir: string, rel: string): string {
  const parts = (dir ? `${dir}/${rel}` : rel).split('/');
  const out: string[] = [];
  for (const s of parts) {
    if (s === '' || s === '.') continue;
    if (s === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..') out.pop();
      else out.push('..');
    } else out.push(s);
  }
  return out.join('/');
}

/** Candidate paths of a relative import (TS-in-ESM `.js` → `.ts`, extensions, index files). */
export function importCandidates(spec: string, fromPath: string): string[] {
  const base = posixJoin(posixDirname(fromPath), spec);
  const out = [base];
  const js = base.match(/\.(m|c)?js$/);
  if (js) out.push(`${base.slice(0, -js[0].length)}.${js[1] ?? ''}ts`);
  for (const ext of FIRMWARE_EXTENSIONS) out.push(base + ext);
  for (const ext of FIRMWARE_EXTENSIONS) out.push(`${base}/index${ext}`);
  return out;
}

/** Relative specifiers a firmware file imports (static `import … from`, `export … from`, `import('…')`, `require('…')`). */
export function relativeImports(source: string): string[] {
  const out = new Set<string>();
  const re = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)(['"])(\.{1,2}\/[^'"]*)\1/g;
  for (const m of source.matchAll(re)) out.add(m[2]);
  return [...out];
}

/** The files of a bundle reachable from its entry (sorted), or the first unresolved import. */
export function reachableFiles(bundle: FirmwareBundle): { files: string[]; missing?: { spec: string; from: string } } {
  const seen = new Set<string>();
  const queue = [bundle.entry];
  while (queue.length > 0) {
    const p = queue.pop()!;
    if (seen.has(p)) continue;
    seen.add(p);
    const text = bundle.files[p];
    if (text === undefined) return { files: [...seen].sort(), missing: { spec: p, from: bundle.entry } };
    if (p.endsWith('.json')) continue;
    for (const spec of relativeImports(text)) {
      const hit = importCandidates(spec, p).find(c => bundle.files[c] !== undefined);
      if (!hit) return { files: [...seen].sort(), missing: { spec, from: p } };
      queue.push(hit);
    }
  }
  return { files: [...seen].sort() };
}

function loadError(message: string, at?: string, note?: string): { ok: false; diagnostic: McuDiagnostic } {
  return {
    ok: false,
    diagnostic: mcuDiagnostic('M608', {
      message,
      ...(at ? { at } : {}),
      ...(note ? { note } : {}),
      fixes: [{ kind: 'fix-firmware-source', confidence: 'suggested', detail: at ? `fix the firmware at ${at}` : 'fix the firmware path or source' }],
    }),
  };
}

/** Transpile every reachable file of a bundle (TypeScript → CommonJS, instrumented loops). */
export function compileFirmware(bundle: FirmwareBundle, opts: { instrument?: boolean } = {}): FirmwareResult<CompiledFirmware> {
  const reach = reachableFiles(bundle);
  if (reach.missing) {
    return loadError(
      bundle.files[reach.missing.spec] === undefined && reach.missing.spec === bundle.entry
        ? `firmware file not found: ${bundle.entry}`
        : `cannot resolve '${reach.missing.spec}' imported from ${reach.missing.from}`,
      reach.missing.from,
      'firmware may import \'circuitsvibe/arduino\' and relative files only',
    );
  }
  const modules: Record<string, string> = {};
  for (const p of reach.files) {
    const source = bundle.files[p];
    if (p.endsWith('.json')) {
      modules[p] = `module.exports = ${source};`;
      continue;
    }
    let code: string;
    try {
      code = transform(source, {
        transforms: /\.[mc]?ts$/.test(p) ? ['typescript', 'imports'] : ['imports'],
        filePath: p,
        production: true,
      }).code;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const m = msg.match(/\((\d+):(\d+)\)/);
      return loadError(`firmware ${p} failed to compile: ${msg}`, m ? `${p}:${m[1]}` : p);
    }
    if (/\bimport\.meta\b/.test(code)) return loadError(`firmware ${p} uses import.meta, which is not supported`, p);
    modules[p] = opts.instrument === false ? code : instrumentLoops(code);
  }
  return { ok: true, value: { bundle, modules } };
}

/** file:line of `export … function setup/loop`, found textually. */
export function firmwareEntryLocs(source: string, display: string): Firmware['entryLocs'] {
  const locs: NonNullable<Firmware['entryLocs']> = {};
  const lines = source.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/\bexport\s+(?:async\s+)?(?:function\s*\*?\s*|(?:const|let|var)\s+)(setup|loop)\b/);
    if (m && !locs[m[1] as 'setup' | 'loop']) locs[m[1] as 'setup' | 'loop'] = `${display}:${i + 1}`;
  }
  return locs;
}

class FirmwareLoadError extends Error {
  constructor(
    message: string,
    readonly at?: string,
    readonly note?: string,
  ) {
    super(message);
  }
}

// Indirect eval: global scope, no access to this module's bindings.
const globalEval: (code: string) => unknown = globalThis.eval;

/**
 * Evaluate a compiled bundle into a fresh module graph and return its
 * entry points. Board constants (LED_BUILTIN, A0…) seen by module top-level
 * code are those of `profile`.
 */
export function instantiateFirmware(compiled: CompiledFirmware, profile: McuProfile): FirmwareResult<Firmware> {
  installLoopGuard();
  useProfileConstants(profile);
  const cache = new Map<string, { exports: Record<string, unknown> }>();
  const evaluate = (p: string): Record<string, unknown> => {
    const hit = cache.get(p);
    if (hit) return hit.exports;
    const module = { exports: {} as Record<string, unknown> };
    cache.set(p, module);
    const code = compiled.modules[p];
    const localRequire = (spec: string): unknown => {
      if (spec === ARDUINO_SPECIFIER) return arduinoModule();
      if (spec.startsWith('.')) {
        const dep = importCandidates(spec, p).find(c => compiled.modules[c] !== undefined);
        if (!dep) throw new FirmwareLoadError(`cannot resolve '${spec}' imported from ${p}`, p);
        return evaluate(dep);
      }
      throw new FirmwareLoadError(
        `firmware ${p} imports '${spec}' — firmware may only import '${ARDUINO_SPECIFIER}' and relative files`,
        p,
        'firmware runs on the simulated MCU, not on the host: Node modules and npm packages are not available',
      );
    };
    let fn: (...args: unknown[]) => void;
    try {
      // Same-line wrapper keeps line numbers identical to the source file.
      fn = globalEval(`(function (exports, require, module, __filename, __dirname) {${code}\n})\n//# sourceURL=${p}`) as typeof fn;
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      const hint = /await/.test(e.message) ? ' (await is only valid inside an async function — declare setup/loop as `async function`)' : '';
      throw new FirmwareLoadError(`firmware ${p} failed to compile: ${e.message}${hint}`, p);
    }
    fn(module.exports, localRequire, module, p, posixDirname(p));
    return module.exports;
  };
  const entry = compiled.bundle.entry;
  try {
    const exports = evaluate(entry);
    return {
      ok: true,
      value: {
        setup: typeof exports.setup === 'function' ? (exports.setup as () => unknown) : undefined,
        loop: typeof exports.loop === 'function' ? (exports.loop as () => unknown) : undefined,
        file: entry,
        entryLocs: firmwareEntryLocs(compiled.bundle.files[entry] ?? '', entry),
      },
    };
  } catch (err) {
    if (err instanceof FirmwareLoadError) return loadError(err.message, err.at, err.note);
    const e = err instanceof Error ? err : new Error(String(err));
    return loadError(
      `firmware ${entry} threw while loading: ${e.message}`,
      firmwareLocFromStack(e.stack) ?? entry,
      'module top-level code runs at load time, outside the MCU: call Arduino APIs from setup()/loop() only',
    );
  }
}

// ───────────────────────── host (reads firmware files) ─────────────────────────

/**
 * Reads a firmware entry file and its relative imports. The CLI installs a
 * Node implementation (src/mcu/node/firmware-host.ts); without a host a
 * firmware PATH cannot be resolved (pass a bundle or { setup, loop }).
 */
export interface FirmwareHost {
  /**
   * `spec` as written in the bench (`'./blink.fw.ts'`), relative to the
   * directory of `fromFile` (the bench file, cwd-relative) — or to the
   * working directory when `fromFile` is unknown.
   */
  readBundle(spec: string, fromFile: string | undefined): FirmwareBundle;
}

let host: FirmwareHost | undefined;

export function setFirmwareHost(h: FirmwareHost | undefined): void {
  host = h;
}

export function firmwareHost(): FirmwareHost | undefined {
  return host;
}
