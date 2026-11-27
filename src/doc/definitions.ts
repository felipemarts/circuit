/**
 * Custom components inside a circuit document. A `defineComponent` part is
 * CODE: the document carries its TypeScript module in `sources` and declares
 * it in `definitions` ({ type, pins, source, export?, registry? }). Reading
 * such a document only needs the declaration (types and pins are checked
 * without running anything); SIMULATING it needs the code, evaluated here.
 *
 * Who evaluates what:
 *  - the web viewer: inside its simulation Web Worker (no DOM, no storage, no
 *    credentials — the API token never enters the worker);
 *  - the CLI: only with an explicit `--allow-code` (T019 otherwise), because
 *    a document may come from anyone.
 * Browser-safe: no Node APIs.
 */
import { transform } from 'sucrase';
import type { ComponentDef } from '../core/CustomComponent';
import { importCandidates, posixDirname, relativeImports } from '../mcu/firmware';
import { CircuitDocError, docDiagnostic } from './errors';
import type { CircuitDefinition, CircuitDoc, CircuitSource } from './types';

/** The module `import … from 'circuitsvibe'` resolves to inside a component file. */
export type PlatformModule = Record<string, unknown>;

const SPECIFIER = 'circuitsvibe';
const globalEval: (code: string) => unknown = globalThis.eval;

/** Every source path a definition's entry reaches through relative imports (entry first). */
export function definitionFiles(entry: string, sources: readonly CircuitSource[]): { files: string[]; missing?: { spec: string; from: string } } {
  const byPath = new Map(sources.map(s => [s.path, s.text]));
  const out: string[] = [];
  const queue = [entry];
  while (queue.length > 0) {
    const p = queue.shift()!;
    if (out.includes(p)) continue;
    const text = byPath.get(p);
    if (text === undefined) return { files: out, missing: { spec: p, from: out[out.length - 1] ?? p } };
    out.push(p);
    for (const spec of relativeImports(text)) {
      const hit = importCandidates(spec, p).find(c => byPath.has(c));
      if (!hit) return { files: out, missing: { spec, from: p } };
      queue.push(hit);
    }
  }
  return { files: out };
}

function definitionOf(value: unknown): ComponentDef | undefined {
  const def = (value as { _componentDef?: ComponentDef } | undefined)?._componentDef ?? (value as ComponentDef | undefined);
  return def && typeof def === 'object' && typeof def.name === 'string' && Array.isArray(def.pins) && typeof def.stamp === 'function' ? def : undefined;
}

/**
 * Evaluate the custom components of a document. Throws CircuitDocError T014
 * when a module does not compile, throws, or does not export a definition
 * matching its declaration (type name and pins).
 */
export function loadDocDefinitions(doc: CircuitDoc, platform: PlatformModule): Record<string, ComponentDef> {
  const sources = doc.sources ?? [];
  const byPath = new Map(sources.map(s => [s.path, s.text]));
  const compiled = new Map<string, string>();
  const out: Record<string, ComponentDef> = {};
  const fail = (d: CircuitDefinition, message: string): never => {
    throw new CircuitDocError([docDiagnostic('T014', `custom component ${d.type} (${d.source}): ${message}`, { path: '/definitions', note: 'the definition module must `export default defineComponent({ name, pins, stamp, … })` (or the named export given in "export"), importing only from \'circuitsvibe\' and relative files' })]);
  };
  for (const d of doc.definitions ?? []) {
    const reach = definitionFiles(d.source, sources);
    if (reach.missing) fail(d, `'${reach.missing.from}' imports '${reach.missing.spec}', which is not in the document's sources`);
    const cache = new Map<string, { exports: Record<string, unknown> }>();
    const evaluate = (p: string): Record<string, unknown> => {
      const hit = cache.get(p);
      if (hit) return hit.exports;
      let code = compiled.get(p);
      if (code === undefined) {
        const text = byPath.get(p)!;
        if (/\.json$/.test(p)) code = `module.exports = ${text};`;
        else code = transform(text, { transforms: ['typescript', 'imports'], filePath: p, keepUnusedImports: false }).code;
        compiled.set(p, code);
      }
      const module = { exports: {} as Record<string, unknown> };
      cache.set(p, module);
      const require = (spec: string): unknown => {
        if (spec === SPECIFIER) return platform;
        const dep = importCandidates(spec, p).find(c => byPath.has(c));
        if (!dep) throw new Error(`cannot import '${spec}' from ${p}: only '${SPECIFIER}' and relative files of the document are available`);
        return evaluate(dep);
      };
      const fn = globalEval(`(function (exports, require, module, __filename, __dirname) {${code}\n})\n//# sourceURL=${p}`) as (...a: unknown[]) => void;
      fn(module.exports, require, module, p, posixDirname(p));
      return module.exports;
    };
    let exports: Record<string, unknown>;
    try {
      exports = evaluate(d.source);
    } catch (err) {
      return fail(d, `the module failed to load: ${err instanceof Error ? err.message : String(err)}`);
    }
    const name = d.export ?? 'default';
    const def = definitionOf(exports[name]);
    if (!def) fail(d, `export '${name}' is not a defineComponent definition`);
    if (def!.name !== d.type) fail(d, `the module defines '${def!.name}', but the document declares type '${d.type}'`);
    if (def!.pins.join(',') !== d.pins.join(',')) fail(d, `pins are [${def!.pins.join(', ')}], but the document declares [${d.pins.join(', ')}]`);
    out[d.type] = def!;
  }
  return out;
}

/** One line per definition, for "this document runs code" notices. */
export function describeDefinitions(doc: CircuitDoc): string[] {
  return (doc.definitions ?? []).map(d => `${d.type} — ${d.source}${d.registry ? ` (${d.registry.ref}, ${d.registry.hash.slice(0, 19)}…)` : ' (not from the registry)'}`);
}
