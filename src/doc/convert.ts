import { elaborate, type BenchDescriptor, type TB } from '../elab/bench';
import { buildComponent, kindOf, restoreModelCard } from '../elab/describe';
import { isLogicCheck } from '../elab/logic';
import { isSerialCheck } from '../elab/serial';
import type { Component } from '../core/Component';
import type { ComponentDef } from '../core/CustomComponent';
import type { Pin } from '../core/Pin';
import type { AssertionSpec, Diagnostic, ParamValue, ScalarCheck } from '../schema/types';
import { canonicalJson } from './canonical';
import { CIRCUIT_SCHEMA, type CircuitDefinition, type CircuitDoc, type CircuitMeta, type CircuitRatings } from './types';
import { describeDefinitions } from './definitions';
import { firmwareLanguage } from '../mcu/firmware';
import type { RatingOptions } from '../verify/ratings';
import type { PlacementInput } from '../pcb/normalize';
import type { PcbSpec } from '../pcb/types';
import { CircuitDocError, docDiagnostic } from './errors';
import { normalizeDefinitions, validateCircuitDoc, type ComponentDefinitions } from './validate';

const AUTO_NET_RE = /^n\d+$/;

/** A bench rebuilt from a document: remembers the document (meta, layout, sources). */
export interface DocBenchDescriptor extends BenchDescriptor {
  circuitDoc: CircuitDoc;
  definitions?: Record<string, ComponentDef>;
}

/** Where a custom component's code lives: the module that exports it, with its relative imports. */
export interface DefinitionSource {
  /** POSIX path of the module (cwd-relative in the CLI). */
  path: string;
  /** Export name ('default' for the default export). */
  export: string;
  /** The module and every file it imports relatively, as embedded `sources`. */
  files: { path: string; text: string }[];
  /** Registry provenance (a file installed with `circuitsvibe component add`, unmodified). */
  registry?: { ref: string; hash: string };
}

export interface ToCircuitDocOptions {
  /** Custom (`defineComponent`) definitions known to every reader; the document declares nothing for them. */
  definitions?: ComponentDefinitions;
  /**
   * The source module of a custom definition (the CLI knows every file a bench
   * loaded). A definition with a source is carried by the document as code:
   * `definitions[]` + its files in `sources[]`. Without one (and not in
   * `definitions`) a custom part is T013.
   */
  definitionSources?: (def: ComponentDef) => DefinitionSource | undefined;
  /** Metadata to record (merged over the metadata of a document-derived bench). */
  meta?: CircuitMeta;
  /** Keep `at` origin locations (default true). */
  locations?: boolean;
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** Canonical form of a document: components by id, nets and sources sorted, keys sorted. */
export function canonicalizeDoc(doc: CircuitDoc): CircuitDoc {
  const d = { ...doc } as CircuitDoc;
  d.components = [...doc.components].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (doc.nets) d.nets = [...doc.nets].sort();
  if (doc.sources) d.sources = [...doc.sources].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return JSON.parse(canonicalJson(d)) as CircuitDoc;
}

/** The document without `at` origin locations (what share links carry). */
export function stripLocations(doc: CircuitDoc): CircuitDoc {
  const d = clone(doc);
  for (const c of d.components) delete c.at;
  for (const a of d.assertions) delete a.at;
  for (const pl of Object.values(d.pcb?.placements ?? {})) delete pl.at;
  return d;
}

/**
 * Elaborate a bench and emit its circuit document. Component `params` are the
 * elaborated values (with `overrides` applied); `overrides` is recorded too.
 * Throws CircuitDocError: T001 when the bench throws, T013 when it uses
 * `defineComponent` parts that `options.definitions` does not cover.
 */
export function toCircuitDoc(
  desc: BenchDescriptor,
  overrides: Record<string, number> = {},
  options: ToCircuitDocOptions = {},
): CircuitDoc {
  const carried = (desc as Partial<DocBenchDescriptor>).circuitDoc;
  const defs = { ...((desc as Partial<DocBenchDescriptor>).definitions ?? {}), ...normalizeDefinitions(options.definitions) };

  let elab;
  try {
    elab = elaborate(desc, overrides);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new CircuitDocError([
      {
        code: 'T001',
        slug: 'bench-error',
        severity: 'error',
        stage: 'lint',
        message: `the bench threw during elaboration: ${message}`,
        note: 'this is an error in the bench code itself, not in the circuit; fix the bench and re-run',
        fixes: [],
      } satisfies Diagnostic,
    ]);
  }

  const offenders: string[] = [];
  const inlineFirmware: string[] = [];
  // Custom components carried as code: type → declaration + files.
  const declared = new Map<string, { def: CircuitDefinition; files: { path: string; text: string }[] }>();
  for (const d of carried?.definitions ?? []) declared.set(d.type, { def: clone(d), files: [] });
  for (const [id, comp] of elab.components) {
    const def = (comp as { _def?: ComponentDef })._def;
    if (def !== undefined) {
      const type = kindOf(comp);
      const src = declared.has(type) ? undefined : options.definitionSources?.(def);
      if (src) {
        declared.set(type, {
          def: { type, pins: [...def.pins], source: src.path, ...(src.export !== 'default' ? { export: src.export } : {}), ...(src.registry ? { registry: { ...src.registry } } : {}) },
          files: src.files,
        });
      } else if (!declared.has(type) && !(type in defs)) offenders.push(id);
    }
    if ((comp as { serializable?: boolean }).serializable === false) inlineFirmware.push(id);
  }
  if (inlineFirmware.length > 0) {
    throw new CircuitDocError([
      docDiagnostic(
        'T013',
        `${inlineFirmware.join(', ')} run${inlineFirmware.length > 1 ? '' : 's'} inline firmware functions: a circuit document carries source text, not live functions, so ${inlineFirmware.length > 1 ? 'they' : 'it'} cannot be exported or shared`,
        {
          components: inlineFirmware,
          note: 'firmware given as { setup, loop } functions only exists in the running process; a document (and a share link) embeds firmware SOURCE files',
          fixes: [{ kind: 'firmware-file', confidence: 'mechanical', detail: "move the firmware into a file and pass its path: new Mcu({ firmware: './app.fw.ts' })" }],
        },
      ),
    ]);
  }
  if (offenders.length > 0) {
    const named = offenders.map(id => `${id} (${kindOf(elab.components.get(id)!)})`).join(', ');
    throw new CircuitDocError([
      docDiagnostic(
        'T013',
        `${named} ${offenders.length > 1 ? 'are' : 'is a'} defineComponent part${offenders.length > 1 ? 's' : ''} whose definition is not exported from its own module file, so the document cannot carry ${offenders.length > 1 ? 'their' : 'its'} code`,
        {
          components: offenders,
          note: 'a document carries a custom component as the SOURCE of the module that exports it; a defineComponent written inside the bench file (or not exported) has no such module',
          fixes: [
            {
              kind: 'module-file',
              confidence: 'mechanical',
              detail: "move the definition into its own file and export it (e.g. thermistor.part.ts: export default defineComponent({ name: 'Thermistor', ... })), then import it in the bench",
            },
            {
              kind: 'use-builtin',
              confidence: 'suggested',
              detail: 'or model the part with built-in components (circuitsvibe catalog), or install one from the registry (circuitsvibe component search / add)',
            },
          ],
        },
      ),
    ]);
  }

  const keepAt = options.locations !== false;
  const components = elab.netlist.components.map(c => {
    const modelCard = (elab.components.get(c.id) as { modelCard?: unknown }).modelCard;
    return {
      id: c.id,
      type: c.type,
      params: clone(c.params) as Record<string, ParamValue>,
      pins: { ...c.pins },
      ...(c.free ? { free: { ...c.free } } : {}),
      ...(typeof modelCard === 'string' ? { modelCard } : {}),
      ...(keepAt && c.at ? { at: c.at } : {}),
    };
  });
  const ratings = ratingsField(elab.ratingOptions);
  const nets = [...elab.netNode.keys()].filter(n => n !== 'gnd' && !AUTO_NET_RE.test(n)).sort();
  const assertions = elab.assertions.map(a => {
    const copy = clone(a) as AssertionSpec;
    if (!keepAt || copy.at === undefined) delete copy.at;
    return copy;
  });
  // Firmware and VHDL files of the components travel in `sources` (params reference them by path).
  const sourceMap = new Map<string, { path: string; language: string; text: string }>();
  for (const s of carried?.sources ?? []) sourceMap.set(s.path, clone(s));
  for (const id of [...elab.components.keys()].sort()) {
    const files = (elab.components.get(id) as { sourceFiles?: () => { path: string; language: string; text: string }[] }).sourceFiles?.() ?? [];
    for (const f of files) {
      const prev = sourceMap.get(f.path);
      if (prev && prev.text !== f.text) {
        throw new CircuitDocError([
          docDiagnostic('T014', `two different files are embedded under the same source path '${f.path}' (component ${id})`, {
            components: [id],
            fixes: [{ kind: 'rename-file', confidence: 'suggested', detail: 'give the files distinct paths' }],
          }),
        ]);
      }
      sourceMap.set(f.path, { ...f });
    }
  }
  for (const { files } of declared.values()) {
    for (const f of files) {
      const prev = sourceMap.get(f.path);
      if (prev && prev.text !== f.text) {
        throw new CircuitDocError([docDiagnostic('T014', `two different files are embedded under the same source path '${f.path}'`, { fixes: [{ kind: 'rename-file', confidence: 'suggested', detail: 'give the files distinct paths' }] })]);
      }
      sourceMap.set(f.path, { path: f.path, language: firmwareLanguage(f.path), text: f.text });
    }
  }
  const usedTypes = new Set(components.map(c => c.type));
  const definitions = [...declared.values()].map(d => d.def).filter(d => usedTypes.has(d.type)).sort((a, b) => (a.type < b.type ? -1 : a.type > b.type ? 1 : 0));
  const sources = [...sourceMap.values()];
  const meta: CircuitMeta = { ...(carried?.meta ?? {}), ...(options.meta ?? {}) };
  for (const k of Object.keys(meta) as (keyof CircuitMeta)[]) if (!meta[k]) delete meta[k];

  const doc: CircuitDoc = {
    schema: CIRCUIT_SCHEMA,
    name: desc.name,
    ...(Object.keys(meta).length > 0 ? { meta } : {}),
    components,
    ...(nets.length > 0 ? { nets } : {}),
    assertions,
    ...(Object.keys(overrides).length > 0 ? { overrides: { ...overrides } } : {}),
    ...(ratings ? { ratings } : {}),
    ...(sources.length > 0 ? { sources } : {}),
    ...(definitions.length > 0 ? { definitions } : {}),
    ...(carried?.layout ? { layout: clone(carried.layout) } : {}),
    ...(elab.pcb ? { pcb: pcbField(elab.pcb, keepAt ? elab.pcbLocs?.place : undefined) } : {}),
  };
  return canonicalizeDoc(doc);
}

/** The board as a document field: placements carry their tb.place location (`at`) when kept. */
function pcbField(pcb: PcbSpec, at: Record<string, string | undefined> | undefined): PcbSpec {
  const out = clone(pcb);
  for (const [id, pl] of Object.entries(out.placements)) if (at?.[id]) pl.at = at[id];
  return out;
}

/** tb.ratings(...) settings as a document field: only the non-default keys, undefined when all are defaults. */
function ratingsField(o: RatingOptions | undefined): CircuitRatings | undefined {
  if (!o) return undefined;
  const r: CircuitRatings = {};
  if (!o.enabled) r.enabled = false;
  if (o.derate !== 1) r.derate = o.derate;
  if (o.pd !== 'average') r.pd = o.pd;
  if (o.ignore.length > 0) r.ignore = [...o.ignore];
  return Object.keys(r).length > 0 ? r : undefined;
}

/**
 * Rebuild a BenchDescriptor from a circuit document: components through
 * `buildComponent`, wiring from `pins`, `nets` as tb.name, `free` as
 * tb.param, `ratings` as tb.ratings, `modelCard` re-read for its lint
 * diagnostics, and every assertion replayed through the bench DSL (so the DSL's
 * own checks apply and ids/locations come from the document). Throws
 * CircuitDocError (T010–T014) when the document is invalid.
 *
 * Note: `doc.overrides` are already contained in the params; pass them to
 * runLadder({ overrides }) only to reproduce the RunRecord `overrides` field.
 */
export function benchFromDoc(input: unknown, opts: { definitions?: ComponentDefinitions } = {}): DocBenchDescriptor {
  const result = validateCircuitDoc(input, opts);
  if (!result.ok) throw new CircuitDocError(result.diagnostics);
  const doc = clone(result.doc);
  const defs = normalizeDefinitions(opts.definitions);
  const missing = (doc.definitions ?? []).filter(d => !(d.type in defs) && doc.components.some(c => c.type === d.type));
  if (missing.length > 0) {
    throw new CircuitDocError([
      docDiagnostic('T019', `the document runs custom-component code (${missing.map(d => d.type).join(', ')}) that was not loaded`, {
        components: doc.components.filter(c => missing.some(d => d.type === c.type)).map(c => c.id),
        evidence: { definitions: describeDefinitions({ ...doc, definitions: missing }) },
        note: 'simulating these parts executes their TypeScript modules (embedded in sources[])',
        fixes: [{ kind: 'allow-code', confidence: 'suggested', detail: 'review the sources, then re-run with --allow-code (CLI), or pass the evaluated definitions: benchFromDoc(doc, { definitions: loadDocDefinitions(doc, platform) })' }],
      }),
    ]);
  }

  const build = (tb: TB): void => {
    const comps = new Map<string, Component>();
    for (const c of doc.components) {
      const built = buildComponent(c.type, clone(c.params), defs, doc.sources);
      if (c.modelCard !== undefined) restoreModelCard(built, c.modelCard);
      const added = tb.add(c.id, built);
      tb._locOf.set(c.id, c.at);
      comps.set(c.id, added);
    }
    const byNet = new Map<string, Pin[]>();
    for (const c of doc.components) {
      const comp = comps.get(c.id)!;
      for (const [pin, net] of Object.entries(c.pins)) {
        const list = byNet.get(net) ?? [];
        list.push(comp.pin(pin));
        byNet.set(net, list);
      }
    }
    for (const net of [...byNet.keys()].sort()) {
      const pins = byNet.get(net)!;
      if (net === 'gnd') for (const p of pins) p.connect(tb.gnd);
      else for (let i = 1; i < pins.length; i++) pins[0].connect(pins[i]);
    }
    for (const net of doc.nets ?? []) {
      tb.name(net, byNet.get(net)![0]);
      tb._namedNets[tb._namedNets.length - 1].at = undefined;
    }
    for (const c of doc.components) if (c.free) tb.param(c.id, c.free);
    if (doc.ratings) tb.ratings(clone(doc.ratings));
    if (doc.pcb) {
      tb.board(clone(doc.pcb.board));
      const custom = doc.pcb.footprints ?? {};
      for (const id of Object.keys(doc.pcb.placements).sort()) {
        const { at, ...pl } = clone(doc.pcb.placements[id]);
        const footprint = pl.footprint !== undefined && custom[pl.footprint] ? clone(custom[pl.footprint]) : pl.footprint;
        tb.place(id, { ...pl, ...(footprint !== undefined ? { footprint } : {}) } as PlacementInput);
        tb._placeAt.set(id, at);
      }
    }
    for (const a of doc.assertions) {
      const before = tb._assertions.length;
      replayAssertion(tb, a);
      const spec = tb._assertions[before];
      if (tb._assertions.length !== before + 1 || !spec) throw new Error(`assertion ${a.id}: replay did not record exactly one assertion`);
      spec.id = a.id;
      if (a.at !== undefined) spec.at = a.at;
      else delete spec.at;
    }
  };

  return { name: doc.name, build, circuitDoc: doc, ...(Object.keys(defs).length > 0 ? { definitions: defs } : {}) };
}

interface ScalarTarget<P> {
  toBeWithin(min: number, max: number): P;
  toBeCloseTo(value: number, tol: number): P;
  toBeAbove(value: number): P;
  toBeBelow(value: number): P;
}

function applyScalar<P>(target: ScalarTarget<P>, check: ScalarCheck): void {
  switch (check.op) {
    case 'within':
      target.toBeWithin(check.min, check.max);
      return;
    case 'closeTo':
      target.toBeCloseTo(check.value, check.tol);
      return;
    case 'above':
      target.toBeAbove(check.value);
      return;
    case 'below':
      target.toBeBelow(check.value);
      return;
  }
}

/** Key order of each logic check as src/elab/logic.ts records it. */
const LOGIC_KEY_ORDER: Record<string, string[]> = {
  logicAt: ['op', 't', 'value'],
  logicEdges: ['op', 'edge', 'from', 'to', 'count', 'min', 'max'],
  logicFrequency: ['op', 'value', 'tol', 'from', 'to'],
  logicDutyCycle: ['op', 'value', 'tol', 'from', 'to'],
  logicStable: ['op', 'from', 'to', 'value'],
  serialContains: ['op', 'text', 'by'],
  serialNotContains: ['op', 'text'],
  serialMatches: ['op', 'pattern', 'flags'],
  serialLines: ['op', 'count', 'min', 'max'],
};

function replayAssertion(tb: TB, a: AssertionSpec): void {
  const ch = a.check;
  switch (a.stage) {
    case 'op':
      return applyScalar(tb.expect.op(a.probe), ch as ScalarCheck);
    case 'dc': {
      const p = tb.expect.dc(a.dc!).probe(a.probe);
      switch (ch.op) {
        case 'at':
          return applyScalar(p.at(ch.x), ch.check);
        case 'slopeAt':
          return applyScalar(p.slopeAt(ch.x), ch.check);
        case 'monotonic':
          p.toBeMonotonic(ch.direction);
          return;
        case 'crosses': {
          const x = p.toCross(ch.level);
          if (ch.min !== undefined && ch.max !== undefined) x.between(ch.min, ch.max);
          return;
        }
      }
      break;
    }
    case 'ac': {
      const p = tb.expect.ac(a.ac!).probe(a.probe, a.ref !== undefined ? { ref: a.ref } : {});
      switch (ch.op) {
        case 'gainAt':
          return applyScalar(p.gainAt(ch.f), ch.check);
        case 'phaseAt':
          return applyScalar(p.phaseAt(ch.f), ch.check);
        case 'bandwidth3dB':
          return applyScalar(p.bandwidth3dB(), ch.check);
        case 'unityGainFrequency':
          return applyScalar(p.unityGainFrequency(), ch.check);
        case 'phaseMargin':
          return applyScalar(p.phaseMargin(), ch.check);
      }
      break;
    }
    case 'tran': {
      if (isLogicCheck(ch) || isSerialCheck(ch)) {
        // Logic checks are plain data already validated against the document
        // schema; record them directly, in the key order the fluent API emits
        // (RunRecords are compared byte for byte), on the DSL-normalized window.
        const order = LOGIC_KEY_ORDER[ch.op] ?? [];
        const src = ch as unknown as Record<string, unknown>;
        const check = Object.fromEntries(order.filter(k => src[k] !== undefined).map(k => [k, src[k]]));
        tb._record('tran', a.probe, check as typeof ch, { tran: tb.expect.tran(a.tran!)._config });
        return;
      }
      const p = tb.expect.tran(a.tran!).probe(a.probe);
      const from = (f: number | undefined) => (f !== undefined ? { from: f } : undefined);
      switch (ch.op) {
        case 'settleWithin':
          p.toSettleWithin({ target: ch.target, tol: ch.tol, by: ch.by });
          return;
        case 'neverExceed':
          p.toNeverExceed(ch.value);
          return;
        case 'stayAbove':
          p.toStayAbove(ch.value, from(ch.from));
          return;
        case 'stayBelow':
          p.toStayBelow(ch.value, from(ch.from));
          return;
        case 'rippleBelow':
          p.toRippleBelow(ch.amplitude, from(ch.from));
          return;
        case 'finalCloseTo':
          p.toEndCloseTo(ch.value, ch.tol);
          return;
      }
      break;
    }
  }
  throw new Error(`assertion ${a.id}: check '${ch.op}' is not valid in the ${a.stage} stage`);
}
