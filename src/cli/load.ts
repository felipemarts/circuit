import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
import { createRequire } from 'node:module';
import { transform } from 'sucrase';
import * as platform from '../forge';
import type { BenchDescriptor } from '../elab/bench';
import { PACKAGE_NAME } from '../schema/version';
import { installNodeFirmwareHost } from '../mcu/node/firmware-host';

// `new Mcu({ firmware: './blink.fw.ts' })` in a bench: firmware files are read from disk, relative to the bench file.
installNodeFirmwareHost();

export const EXAMPLE = `a bench file looks like:

  import { bench, VoltageSource, Resistor, LED } from '${PACKAGE_NAME}';

  export default bench('led-driver', (tb) => {
    const v1 = tb.add('V1', new VoltageSource(5));
    const r1 = tb.add('R1', new Resistor('330'));
    const d1 = tb.add('D1', new LED());
    v1.pin('+').connect(r1.pin('1'));
    r1.pin('2').connect(d1.pin('anode'));
    d1.pin('cathode').connect(tb.gnd);
    v1.pin('-').connect(tb.gnd);
    tb.expect.op('D1.i').toBeWithin('5m', '15m');
  });`;

/**
 * What `import ... from 'circuitsvibe'` resolves to inside a bench: the very
 * module instance the CLI runs, so a bench needs no local install and the CLI
 * and the bench can never disagree on versions.
 */
const PLATFORM_MODULE: Record<string, unknown> = Object.freeze({ __esModule: true, ...platform });

const RESOLVE_EXTENSIONS = ['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs', '.json'];

interface LoadedModule {
  exports: Record<string, unknown>;
}

/**
 * Load a .bench.ts file and return its default-exported bench descriptor.
 *
 * Pure JS, no native toolchain: each TS/JS file is transpiled with sucrase
 * (type stripping + ESM→CJS, line numbers preserved) and evaluated with
 * `vm.runInThisContext` under its real absolute filename, so stack frames —
 * and therefore every diagnostic's `at` — point at the original source line.
 * Relative imports between the user's files are followed; `'circuitsvibe'`
 * maps to the running platform; anything else goes through Node's require
 * from the importing file's directory.
 *
 * Limits (documented in AGENTS.md): no top-level await and no `import.meta`
 * in bench files — the module system is CommonJS under the hood.
 */
export async function loadBench(file: string): Promise<BenchDescriptor> {
  const abs = path.resolve(file);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
    throw new Error(`bench file not found: ${file}\n\n${EXAMPLE}`);
  }

  const mod = loadModule(abs, new Map());
  const desc = mod.default as BenchDescriptor | undefined;
  if (!desc || typeof desc !== 'object' || typeof desc.name !== 'string' || typeof desc.build !== 'function') {
    throw new Error(`${file} must default-export a bench(...) descriptor\n\n${EXAMPLE}`);
  }
  return desc;
}

function loadModule(abs: string, cache: Map<string, LoadedModule>): Record<string, unknown> {
  const cached = cache.get(abs);
  if (cached) return cached.exports;

  const source = fs.readFileSync(abs, 'utf8');
  const module: LoadedModule = { exports: {} };
  cache.set(abs, module);

  if (abs.endsWith('.json')) {
    module.exports = JSON.parse(source) as Record<string, unknown>;
    return module.exports;
  }

  // VHDL sources: `import counter from './counter.vhd'` yields a VhdlSource
  // { kind: 'vhdl-source', text, path } (path relative to the cwd, for
  // diagnostics) — pass it straight to compileVhdl / instantiateVhdl.
  if (/\.vhdl?$/i.test(abs)) {
    module.exports = Object.freeze({ kind: 'vhdl-source', text: source, path: displayPath(abs) });
    return module.exports;
  }

  const rel = displayPath(abs);
  let code: string;
  try {
    code = transform(source, {
      transforms: /\.[mc]?ts$/.test(abs) ? ['typescript', 'imports'] : ['imports'],
      filePath: abs,
      production: true,
    }).code;
  } catch (err) {
    throw new Error(`failed to compile ${rel}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (/\bimport\.meta\b/.test(code)) {
    throw new Error(`failed to compile ${rel}: import.meta is not supported in bench files`);
  }

  const nodeRequire = createRequire(abs);
  const localRequire = (specifier: string): unknown => {
    if (specifier === PACKAGE_NAME) return PLATFORM_MODULE;
    if (specifier.startsWith('.') || path.isAbsolute(specifier)) {
      return loadModule(resolveLocal(specifier, abs), cache);
    }
    return nodeRequire(specifier);
  };

  // The wrapper opens on the same line as the first source line so line
  // numbers in stack traces match the file on disk.
  let fn: (...args: unknown[]) => void;
  try {
    fn = vm.runInThisContext(`(function (exports, require, module, __filename, __dirname) {${code}\n})`, {
      filename: abs,
    }) as typeof fn;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const hint = /await/.test(message) ? ' (top-level await is not supported in bench files)' : '';
    throw new Error(`failed to compile ${rel}: ${message}${hint}`);
  }
  fn(module.exports, localRequire, module, abs, path.dirname(abs));
  return module.exports;
}

function resolveLocal(specifier: string, fromFile: string): string {
  const base = path.resolve(path.dirname(fromFile), specifier);
  const candidates = [base];
  // TS-in-ESM convention: `import './util.js'` refers to util.ts on disk.
  const jsExt = base.match(/\.(m|c)?js$/);
  if (jsExt) candidates.push(base.slice(0, -jsExt[0].length) + `.${jsExt[1] ?? ''}ts`);
  for (const ext of RESOLVE_EXTENSIONS) candidates.push(base + ext);
  for (const ext of RESOLVE_EXTENSIONS) candidates.push(path.join(base, `index${ext}`));
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  throw new Error(`cannot resolve '${specifier}' imported from ${displayPath(fromFile)}`);
}

function displayPath(abs: string): string {
  const rel = path.relative(process.cwd(), abs);
  return (rel.startsWith('..') ? abs : rel).split(path.sep).join('/');
}
