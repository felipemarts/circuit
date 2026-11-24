import { elaborate, type BenchDescriptor, type TB } from '../elab/bench';
import { buildComponent, kindOf, restoreModelCard } from '../elab/describe';
import { isLogicCheck } from '../elab/logic';
import type { Component } from '../core/Component';
import type { ComponentDef } from '../core/CustomComponent';
import type { Pin } from '../core/Pin';
import type { AssertionSpec, Diagnostic, ParamValue, ScalarCheck } from '../schema/types';
import { canonicalJson } from './canonical';
import { CIRCUIT_SCHEMA, type CircuitDoc, type CircuitMeta, type CircuitRatings } from './types';
import type { RatingOptions } from '../verify/ratings';
import { CircuitDocError, docDiagnostic } from './errors';
import { normalizeDefinitions, validateCircuitDoc, type ComponentDefinitions } from './validate';

const AUTO_NET_RE = /^n\d+$/;

/** A bench rebuilt from a document: remembers the document (meta, layout, sources). */
export interface DocBenchDescriptor extends BenchDescriptor {
  circuitDoc: CircuitDoc;
  definitions?: Record<string, ComponentDef>;
}

export interface ToCircuitDocOptions {
  /** Custom (`defineComponent`) definitions; without them such parts are T013. */
  definitions?: ComponentDefinitions;
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
  for (const [id, comp] of elab.components) {
    const isCustom = (comp as { _def?: unknown })._def !== undefined;
    if (isCustom && !(kindOf(comp) in defs)) offenders.push(id);
  }
  if (offenders.length > 0) {
    const named = offenders.map(id => `${id} (${kindOf(elab.components.get(id)!)})`).join(', ');
    throw new CircuitDocError([
      docDiagnostic(
        'T013',
        `${named} ${offenders.length > 1 ? 'are' : 'is a'} defineComponent part${offenders.length > 1 ? 's' : ''}: a circuit document carries data, not code, so ${offenders.length > 1 ? 'they' : 'it'} cannot be exported or shared`,
        {
          components: offenders,
          note: 'custom components are TypeScript functions (stamp/ac); only built-in component types are serializable without a definition registry',
          fixes: [
            {
              kind: 'use-builtin',
              confidence: 'suggested',
              detail: 'model the part with built-in components (circuitsvibe catalog), or export through the library with toCircuitDoc(bench, {}, { definitions }) and give the reader the same definitions',
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
    ...(carried?.sources ? { sources: clone(carried.sources) } : {}),
    ...(carried?.layout ? { layout: clone(carried.layout) } : {}),
  };
  return canonicalizeDoc(doc);
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

  const build = (tb: TB): void => {
    const comps = new Map<string, Component>();
    for (const c of doc.components) {
      const built = buildComponent(c.type, clone(c.params), defs);
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
      if (isLogicCheck(ch)) {
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
