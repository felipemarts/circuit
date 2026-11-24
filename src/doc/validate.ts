import type { Diagnostic } from '../schema/types';
import type { Component } from '../core/Component';
import type { ComponentDef } from '../core/CustomComponent';
import { buildComponent, describeComponent, isOverridable } from '../elab/describe';
import { CIRCUIT_SCHEMA, type CircuitDoc } from './types';
import { docDiagnostic, type DocCode } from './errors';

/**
 * Custom component definitions, keyed by type name or given as a list. Each
 * entry is a `ComponentDef` or the class returned by `defineComponent`.
 */
export type ComponentDefinitions =
  | Record<string, ComponentDef | { _componentDef: ComponentDef }>
  | (ComponentDef | { _componentDef: ComponentDef })[];

/** Normalize a definitions registry to `{ [typeName]: ComponentDef }`. */
export function normalizeDefinitions(defs: ComponentDefinitions | undefined): Record<string, ComponentDef> {
  const out: Record<string, ComponentDef> = {};
  if (!defs) return out;
  const entries = Array.isArray(defs) ? defs.map(d => [undefined, d] as const) : Object.entries(defs);
  for (const [key, entry] of entries) {
    const def = (entry as { _componentDef?: ComponentDef })._componentDef ?? (entry as ComponentDef);
    if (!def || typeof def.name !== 'string' || !Array.isArray(def.pins)) {
      throw new Error(`definitions: entry ${key ?? '(list item)'} is not a ComponentDef or a defineComponent class`);
    }
    out[key ?? def.name] = def;
  }
  return out;
}

export interface ValidateOptions {
  /** Custom component definitions; without them a non-built-in type is T012. */
  definitions?: ComponentDefinitions;
}

export type CircuitDocValidation =
  | { ok: true; doc: CircuitDoc; diagnostics: [] }
  | { ok: false; diagnostics: Diagnostic[] };

const ID_RE = /^[A-Za-z][A-Za-z0-9_]*$/;
const AUTO_NET_RE = /^n\d+$/;
const PROBE_RE = /^([A-Za-z][A-Za-z0-9_]*)\.(i|v)$/;
const LANGUAGE_RE = /^[a-z][a-z0-9+#.-]*$/;
const MAX_DIAGNOSTICS = 50;

const TOP_KEYS = ['schema', 'name', 'meta', 'components', 'nets', 'assertions', 'overrides', 'sources', 'layout'];
const META_KEYS = ['title', 'description', 'author'];
const COMPONENT_KEYS = ['id', 'type', 'params', 'pins', 'free', 'at'];
const ASSERTION_KEYS = ['id', 'stage', 'probe', 'check', 'at', 'ref', 'tran', 'dc', 'ac'];
const SCALAR_OPS = ['within', 'closeTo', 'above', 'below'];
const STAGE_OPS: Record<string, string[]> = {
  op: SCALAR_OPS,
  dc: ['at', 'slopeAt', 'monotonic', 'crosses'],
  ac: ['gainAt', 'phaseAt', 'bandwidth3dB', 'unityGainFrequency', 'phaseMargin'],
  tran: ['settleWithin', 'neverExceed', 'stayAbove', 'stayBelow', 'rippleBelow', 'finalCloseTo'],
};
/** Required and optional numeric fields of each non-scalar check (beyond `op`). */
const CHECK_FIELDS: Record<string, { num: string[]; optNum?: string[]; nested?: boolean; extra?: string[] }> = {
  within: { num: ['min', 'max'] },
  closeTo: { num: ['value', 'tol'] },
  above: { num: ['value'] },
  below: { num: ['value'] },
  at: { num: ['x'], nested: true },
  slopeAt: { num: ['x'], nested: true },
  monotonic: { num: [], extra: ['direction'] },
  crosses: { num: ['level'], optNum: ['min', 'max'] },
  gainAt: { num: ['f'], nested: true },
  phaseAt: { num: ['f'], nested: true },
  bandwidth3dB: { num: [], nested: true },
  unityGainFrequency: { num: [], nested: true },
  phaseMargin: { num: [], nested: true },
  settleWithin: { num: ['target', 'tol', 'by'] },
  neverExceed: { num: ['value'] },
  stayAbove: { num: ['value'], optNum: ['from'] },
  stayBelow: { num: ['value'], optNum: ['from'] },
  rippleBelow: { num: ['amplitude'], optNum: ['from'] },
  finalCloseTo: { num: ['value', 'tol'] },
};

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isInt = (v: unknown): v is number => isNum(v) && Number.isInteger(v);

class Collector {
  readonly diagnostics: Diagnostic[] = [];
  add(code: DocCode, path: string, message: string, components?: string[]): void {
    if (this.diagnostics.length >= MAX_DIAGNOSTICS) return;
    this.diagnostics.push(
      docDiagnostic(code, `${path || '(document)'}: ${message}`, {
        path,
        components,
        fixes:
          code === 'T012'
            ? [{ kind: 'provide-definition', confidence: 'suggested', detail: 'use a built-in type (circuitsvibe catalog) or pass the custom definition in `definitions`' }]
            : [],
      }),
    );
  }
  get count(): number {
    return this.diagnostics.length;
  }
}

/** Canonical (unique) pin names of a component, as the netlist names them. */
export function canonicalPins(comp: Component): string[] {
  const names = new Map<unknown, string>();
  for (const [name, pin] of comp.pinEntries()) names.set(pin, name);
  const out: string[] = [];
  const seen = new Set<unknown>();
  for (const pin of comp.allPins()) {
    if (seen.has(pin)) continue;
    seen.add(pin);
    out.push(names.get(pin)!);
  }
  return out;
}

function unknownKeys(c: Collector, obj: Obj, allowed: string[], path: string): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) {
      c.add('T010', `${path}/${key}`, `unknown field '${key}' (allowed: ${allowed.join(', ')}); a newer circuitsvibe may be needed`);
    }
  }
}

function checkParamValue(c: Collector, v: unknown, path: string): void {
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) c.add('T010', path, 'numbers must be finite');
  } else if (typeof v === 'string' || typeof v === 'boolean') {
    // ok
  } else if (Array.isArray(v)) {
    v.forEach((x, i) => checkParamValue(c, x, `${path}/${i}`));
  } else if (isObj(v)) {
    for (const [k, x] of Object.entries(v)) checkParamValue(c, x, `${path}/${k}`);
  } else {
    c.add('T010', path, `parameter values must be numbers, strings, booleans, arrays or objects (got ${v === null ? 'null' : typeof v})`);
  }
}

/** doc ⊆ described: every value the document gives must survive the rebuild unchanged. */
function subsetMismatch(given: unknown, actual: unknown, path: string): string | undefined {
  if (isObj(given)) {
    if (!isObj(actual)) return `${path || 'params'} is not an object for this type`;
    for (const [k, v] of Object.entries(given)) {
      if (!(k in actual)) return `unknown parameter '${path ? `${path}.` : ''}${k}'`;
      const m = subsetMismatch(v, actual[k], path ? `${path}.${k}` : k);
      if (m) return m;
    }
    return undefined;
  }
  if (Array.isArray(given)) {
    if (!Array.isArray(actual) || actual.length !== given.length) return `parameter '${path}' does not match the rebuilt component`;
    for (let i = 0; i < given.length; i++) {
      const m = subsetMismatch(given[i], actual[i], `${path}[${i}]`);
      if (m) return m;
    }
    return undefined;
  }
  return Object.is(given, actual) || given === actual
    ? undefined
    : `parameter '${path}' = ${JSON.stringify(given)} is not supported as given (the component uses ${JSON.stringify(actual)})`;
}

/**
 * Validate a value as a `circuitsvibe-circuit/1` document: structure, field
 * types, references (pins → nets, probes → components/nets, overrides and
 * layout → component ids) and that every component can be rebuilt from its
 * type + params with exactly the listed pins. Pure, browser-safe.
 */
export function validateCircuitDoc(value: unknown, opts: ValidateOptions = {}): CircuitDocValidation {
  const c = new Collector();
  if (!isObj(value)) {
    c.add('T010', '', `a circuit document must be a JSON object with "schema": "${CIRCUIT_SCHEMA}"`);
    return { ok: false, diagnostics: c.diagnostics };
  }
  const schema = value.schema;
  if (schema !== CIRCUIT_SCHEMA) {
    if (typeof schema === 'string' && /^circuitsvibe-circuit\//.test(schema)) {
      c.add('T011', '/schema', `document schema '${schema}' is not supported by this circuitsvibe (it reads '${CIRCUIT_SCHEMA}'); upgrade circuitsvibe or re-export the document`);
    } else if (typeof schema === 'string' && /^circuitsvibe-run\//.test(schema)) {
      c.add('T010', '/schema', `this is a RunRecord ('${schema}'), not a circuit document; create one with \`circuitsvibe export <bench.ts>\``);
    } else {
      c.add('T010', '/schema', `not a circuit document: "schema" must be "${CIRCUIT_SCHEMA}" (got ${JSON.stringify(schema)})`);
    }
    return { ok: false, diagnostics: c.diagnostics };
  }
  unknownKeys(c, value, TOP_KEYS, '');
  if (typeof value.name !== 'string' || value.name.trim() === '') c.add('T010', '/name', 'name must be a non-empty string');

  if (value.meta !== undefined) {
    if (!isObj(value.meta)) c.add('T010', '/meta', 'meta must be an object');
    else {
      unknownKeys(c, value.meta, META_KEYS, '/meta');
      for (const k of META_KEYS) {
        if (value.meta[k] !== undefined && typeof value.meta[k] !== 'string') c.add('T010', `/meta/${k}`, `${k} must be a string`);
      }
    }
  }

  // ── nets ──
  const declaredNets = new Set<string>();
  if (value.nets !== undefined) {
    if (!Array.isArray(value.nets)) c.add('T010', '/nets', 'nets must be an array of net names');
    else {
      value.nets.forEach((n, i) => {
        const p = `/nets/${i}`;
        if (typeof n !== 'string' || !ID_RE.test(n)) c.add('T010', p, 'net names are letters/digits/underscore starting with a letter');
        else if (n === 'gnd' || AUTO_NET_RE.test(n)) c.add('T010', p, `'${n}' is reserved (gnd is ground, n<digits> are anonymous nets) and must not be declared`);
        else if (declaredNets.has(n)) c.add('T010', p, `duplicate net '${n}'`);
        else declaredNets.add(n);
      });
    }
  }

  // ── components ──
  const ids = new Set<string>();
  const comps: { id: string; type: string; obj: Obj; path: string }[] = [];
  const pinNet = new Map<string, string>(); // "id.pin" -> net
  const usedNets = new Set<string>();
  if (!Array.isArray(value.components)) c.add('T010', '/components', 'components must be an array');
  else {
    value.components.forEach((comp, i) => {
      const p = `/components/${i}`;
      if (!isObj(comp)) return c.add('T010', p, 'each component must be an object');
      unknownKeys(c, comp, COMPONENT_KEYS, p);
      const id = comp.id;
      if (typeof id !== 'string' || !ID_RE.test(id)) return c.add('T010', `${p}/id`, 'id must be letters/digits/underscore starting with a letter');
      if (ids.has(id)) return c.add('T010', `${p}/id`, `duplicate component id '${id}'`, [id]);
      ids.add(id);
      if (typeof comp.type !== 'string' || comp.type === '') return c.add('T010', `${p}/type`, 'type must be a non-empty string', [id]);
      if (!isObj(comp.params)) c.add('T010', `${p}/params`, 'params must be an object', [id]);
      else checkParamValue(c, comp.params, `${p}/params`);
      if (!isObj(comp.pins)) c.add('T010', `${p}/pins`, 'pins must be an object { pinName: netName }', [id]);
      else {
        for (const [pin, net] of Object.entries(comp.pins)) {
          const pp = `${p}/pins/${pin}`;
          if (typeof net !== 'string' || !ID_RE.test(net)) {
            c.add('T010', pp, 'net names are letters/digits/underscore starting with a letter', [id]);
            continue;
          }
          if (net !== 'gnd' && !AUTO_NET_RE.test(net) && !declaredNets.has(net)) {
            c.add('T010', pp, `net '${net}' is not declared in "nets" (named nets must be listed; use n<digits> for anonymous nets)`, [id]);
          }
          pinNet.set(`${id}.${pin}`, net);
          usedNets.add(net);
        }
      }
      if (comp.free !== undefined) {
        const f = comp.free;
        if (!isObj(f)) c.add('T010', `${p}/free`, 'free must be { min, max, scale }', [id]);
        else {
          unknownKeys(c, f, ['min', 'max', 'scale'], `${p}/free`);
          if (!isNum(f.min) || !isNum(f.max) || !(f.min < f.max)) c.add('T010', `${p}/free`, 'free needs finite min < max', [id]);
          if (f.scale !== 'lin' && f.scale !== 'log') c.add('T010', `${p}/free/scale`, "scale must be 'lin' or 'log'", [id]);
          else if (f.scale === 'log' && isNum(f.min) && f.min <= 0) c.add('T010', `${p}/free/min`, 'log scale needs min > 0', [id]);
        }
      }
      if (comp.at !== undefined && typeof comp.at !== 'string') c.add('T010', `${p}/at`, 'at must be a string', [id]);
      comps.push({ id, type: comp.type, obj: comp, path: p });
    });
  }
  for (const n of declaredNets) {
    if (!usedNets.has(n)) c.add('T010', '/nets', `net '${n}' is declared but no component pin is on it`);
  }

  // ── assertions ──
  const probeOk = (probe: unknown, path: string): void => {
    if (typeof probe !== 'string') return c.add('T010', path, 'probe must be a string');
    const m = probe.match(PROBE_RE);
    if (m) {
      if (!ids.has(m[1])) c.add('T010', path, `probe '${probe}': no component '${m[1]}'`);
      return;
    }
    if (probe !== 'gnd' && !declaredNets.has(probe)) {
      c.add('T010', path, `probe '${probe}' must be '<id>.i', '<id>.v' or a net listed in "nets"`);
    }
  };
  const assertionIds = new Set<string>();
  if (!Array.isArray(value.assertions)) c.add('T010', '/assertions', 'assertions must be an array (may be empty)');
  else {
    value.assertions.forEach((a, i) => {
      const p = `/assertions/${i}`;
      if (!isObj(a)) return c.add('T010', p, 'each assertion must be an object');
      unknownKeys(c, a, ASSERTION_KEYS, p);
      if (typeof a.id !== 'string' || !ID_RE.test(a.id)) c.add('T010', `${p}/id`, 'id must be letters/digits/underscore starting with a letter');
      else if (assertionIds.has(a.id)) c.add('T010', `${p}/id`, `duplicate assertion id '${a.id}'`);
      else assertionIds.add(a.id);
      const stage = a.stage;
      if (typeof stage !== 'string' || !(stage in STAGE_OPS)) {
        return c.add('T010', `${p}/stage`, "stage must be 'op', 'dc', 'ac' or 'tran'");
      }
      probeOk(a.probe, `${p}/probe`);
      if (a.at !== undefined && typeof a.at !== 'string') c.add('T010', `${p}/at`, 'at must be a string');
      for (const k of ['tran', 'dc', 'ac'] as const) {
        if (k === stage) {
          if (!isObj(a[k])) c.add('T010', `${p}/${k}`, `a ${stage} assertion needs its "${k}" analysis config`);
        } else if (a[k] !== undefined) {
          c.add('T010', `${p}/${k}`, `"${k}" config is only valid on ${k} assertions`);
        }
      }
      if (a.ref !== undefined) {
        if (stage !== 'ac') c.add('T010', `${p}/ref`, 'ref is only valid on ac assertions');
        else probeOk(a.ref, `${p}/ref`);
      }
      if (stage === 'tran' && isObj(a.tran)) checkTran(c, a.tran, `${p}/tran`);
      if (stage === 'dc' && isObj(a.dc)) checkDc(c, a.dc, `${p}/dc`, ids);
      if (stage === 'ac' && isObj(a.ac)) checkAc(c, a.ac, `${p}/ac`);
      checkCheck(c, a.check, STAGE_OPS[stage], `${p}/check`, stage);
    });
  }

  // ── overrides ──
  if (value.overrides !== undefined) {
    if (!isObj(value.overrides)) c.add('T010', '/overrides', 'overrides must be an object { id: number }');
    else {
      for (const [k, v] of Object.entries(value.overrides)) {
        if (!ids.has(k)) c.add('T010', `/overrides/${k}`, `override for unknown component '${k}'`);
        if (!isNum(v)) c.add('T010', `/overrides/${k}`, 'override values must be finite numbers');
      }
    }
  }

  // ── sources ──
  if (value.sources !== undefined) {
    if (!Array.isArray(value.sources)) c.add('T010', '/sources', 'sources must be an array of { path, language, text }');
    else {
      const paths = new Set<string>();
      value.sources.forEach((s, i) => {
        const p = `/sources/${i}`;
        if (!isObj(s)) return c.add('T010', p, 'each source must be { path, language, text }');
        unknownKeys(c, s, ['path', 'language', 'text'], p);
        if (typeof s.path !== 'string' || !validPath(s.path)) {
          c.add('T010', `${p}/path`, "path must be a relative POSIX path without '.', '..', '\\\\', ':' or a leading '/'");
        } else if (paths.has(s.path)) c.add('T010', `${p}/path`, `duplicate source path '${s.path}'`);
        else paths.add(s.path);
        if (typeof s.language !== 'string' || !LANGUAGE_RE.test(s.language)) c.add('T010', `${p}/language`, "language must be a lowercase tag like 'vhdl', 'typescript' or 'text'");
        if (typeof s.text !== 'string') c.add('T010', `${p}/text`, 'text must be a string');
      });
    }
  }

  // ── layout (viewer-only; extension fields allowed) ──
  if (value.layout !== undefined) {
    const l = value.layout;
    if (!isObj(l)) c.add('T010', '/layout', 'layout must be an object');
    else {
      if (l.components !== undefined) {
        if (!isObj(l.components)) c.add('T010', '/layout/components', 'layout.components must be an object keyed by component id');
        else {
          for (const [id, pl] of Object.entries(l.components)) {
            const p = `/layout/components/${id}`;
            if (!ids.has(id)) c.add('T010', p, `layout for unknown component '${id}'`);
            if (!isObj(pl) || !isNum(pl.x) || !isNum(pl.y)) c.add('T010', p, 'placement needs finite x and y');
            else {
              if (pl.rotation !== undefined && ![0, 90, 180, 270].includes(pl.rotation as number)) c.add('T010', `${p}/rotation`, 'rotation must be 0, 90, 180 or 270');
              if (pl.flip !== undefined && typeof pl.flip !== 'boolean') c.add('T010', `${p}/flip`, 'flip must be a boolean');
            }
          }
        }
      }
      if (l.wires !== undefined) {
        if (!Array.isArray(l.wires)) c.add('T010', '/layout/wires', 'layout.wires must be an array');
        else {
          l.wires.forEach((w, i) => {
            const p = `/layout/wires/${i}`;
            if (!isObj(w)) return c.add('T010', p, 'each wire must be { from, to, points? }');
            const from = typeof w.from === 'string' ? pinNet.get(w.from) : undefined;
            const to = typeof w.to === 'string' ? pinNet.get(w.to) : undefined;
            if (from === undefined) c.add('T010', `${p}/from`, `from must be a pin ref 'id.pin' of a component (got ${JSON.stringify(w.from)})`);
            if (to === undefined) c.add('T010', `${p}/to`, `to must be a pin ref 'id.pin' of a component (got ${JSON.stringify(w.to)})`);
            if (from !== undefined && to !== undefined && from !== to) c.add('T010', p, `wire joins two different nets ('${from}' and '${to}')`);
            if (w.points !== undefined && (!Array.isArray(w.points) || !w.points.every(pt => Array.isArray(pt) && pt.length === 2 && isNum(pt[0]) && isNum(pt[1])))) {
              c.add('T010', `${p}/points`, 'points must be an array of [x, y] number pairs');
            }
          });
        }
      }
    }
  }

  if (c.count > 0) return { ok: false, diagnostics: c.diagnostics };

  // ── semantic: every component rebuilds from type + params with exactly its pins ──
  let defs: Record<string, ComponentDef>;
  try {
    defs = normalizeDefinitions(opts.definitions);
  } catch (err) {
    c.add('T010', '', err instanceof Error ? err.message : String(err));
    return { ok: false, diagnostics: c.diagnostics };
  }
  for (const { id, type, obj, path } of comps) {
    let built: Component;
    try {
      built = buildComponent(type, obj.params as Record<string, never>, defs);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!(type in defs) && /unknown type/.test(message)) {
        c.add('T012', `${path}/type`, `component ${id} has unknown type '${type}': not a built-in type and no definition was provided`, [id]);
      } else {
        c.add('T014', `${path}/params`, `component ${id} (${type}) cannot be built from its params: ${message}`, [id]);
      }
      continue;
    }
    const mismatch = subsetMismatch(obj.params, describeComponent(built).params, '');
    if (mismatch) c.add('T014', `${path}/params`, `component ${id} (${type}): ${mismatch}`, [id]);
    const want = canonicalPins(built);
    const given = Object.keys(obj.pins as Obj);
    for (const pin of given) {
      if (!want.includes(pin)) c.add('T014', `${path}/pins/${pin}`, `${type} ${id} has no pin '${pin}' (pins: ${want.join(', ')})`, [id]);
    }
    for (const pin of want) {
      if (!given.includes(pin)) c.add('T014', `${path}/pins`, `${type} ${id} is missing pin '${pin}' (list every pin; a pin alone on an n<digits> net is unconnected)`, [id]);
    }
    if (obj.free !== undefined && !isOverridable(built)) {
      c.add('T014', `${path}/free`, `${type} ${id} has no sweepable scalar value, so it cannot be a free parameter`, [id]);
    }
  }
  for (const a of value.assertions as Obj[]) {
    const dc = a.dc as Obj | undefined;
    const id = dc && ((dc.source ?? dc.param) as string);
    const comp = id ? comps.find(x => x.id === id) : undefined;
    if (dc && comp && dc.source !== undefined && comp.type !== 'VoltageSource' && comp.type !== 'CurrentSource') {
      c.add('T010', `/assertions/${(value.assertions as Obj[]).indexOf(a)}/dc/source`, `dc sweep source '${id}' is a ${comp.type}; sweep a VoltageSource/CurrentSource or use "param"`);
    }
  }
  if (c.count > 0) return { ok: false, diagnostics: c.diagnostics };
  return { ok: true, doc: value as unknown as CircuitDoc, diagnostics: [] };
}

function validPath(p: string): boolean {
  if (p === '' || p.startsWith('/') || p.includes('\\') || p.includes(':')) return false;
  return p.split('/').every(seg => seg !== '' && seg !== '.' && seg !== '..');
}

function checkScalar(c: Collector, check: unknown, path: string): void {
  if (!isObj(check) || typeof check.op !== 'string' || !SCALAR_OPS.includes(check.op)) {
    return c.add('T010', path, `nested check must be a scalar check (op: ${SCALAR_OPS.join(' | ')})`);
  }
  checkFields(c, check, path);
}

function checkFields(c: Collector, check: Obj, path: string): void {
  const spec = CHECK_FIELDS[check.op as string];
  const allowed = ['op', ...spec.num, ...(spec.optNum ?? []), ...(spec.extra ?? []), ...(spec.nested ? ['check'] : [])];
  unknownKeys(c, check, allowed, path);
  for (const k of spec.num) if (!isNum(check[k])) c.add('T010', `${path}/${k}`, `${check.op} needs a finite number '${k}'`);
  for (const k of spec.optNum ?? []) if (check[k] !== undefined && !isNum(check[k])) c.add('T010', `${path}/${k}`, `'${k}' must be a finite number`);
  if (check.op === 'within' && isNum(check.min) && isNum(check.max) && !(check.min <= check.max)) c.add('T010', path, 'within needs min <= max');
  if (check.op === 'crosses' && (check.min === undefined) !== (check.max === undefined)) {
    c.add('T010', path, 'crosses takes both min and max (the window of the first crossing) or neither');
  }
  if (check.op === 'crosses' && isNum(check.min) && isNum(check.max) && !(check.min <= check.max)) c.add('T010', path, 'crosses needs min <= max');
  if (check.op === 'monotonic' &&check.direction !== 'increasing' && check.direction !== 'decreasing') {
    c.add('T010', `${path}/direction`, "direction must be 'increasing' or 'decreasing'");
  }
  if (spec.nested) checkScalar(c, check.check, `${path}/check`);
}

function checkCheck(c: Collector, check: unknown, ops: string[], path: string, stage: string): void {
  if (!isObj(check) || typeof check.op !== 'string') return c.add('T010', path, 'check must be an object with an "op"');
  if (!ops.includes(check.op)) return c.add('T010', `${path}/op`, `'${check.op}' is not a ${stage} check (${ops.join(', ')})`);
  checkFields(c, check, path);
}

function checkTran(c: Collector, t: Obj, path: string): void {
  unknownKeys(c, t, ['tstop', 'dt', 'maxStep', 'minStep', 'method', 'ic', 'reltol'], path);
  if (!isNum(t.tstop) || t.tstop <= 0) c.add('T010', `${path}/tstop`, 'tstop must be a number > 0 (seconds)');
  if (!isNum(t.dt) || t.dt <= 0) c.add('T010', `${path}/dt`, 'dt must be a number > 0 (seconds)');
  for (const k of ['maxStep', 'minStep']) if (t[k] !== undefined && (!isNum(t[k]) || (t[k] as number) <= 0)) c.add('T010', `${path}/${k}`, `${k} must be a number > 0`);
  if (t.method !== undefined && t.method !== 'trap' && t.method !== 'be') c.add('T010', `${path}/method`, "method must be 'trap' or 'be'");
  if (t.ic !== undefined && t.ic !== 'zero' && t.ic !== 'op') c.add('T010', `${path}/ic`, "ic must be 'zero' or 'op'");
  if (t.reltol !== undefined && (!isNum(t.reltol) || t.reltol <= 0 || t.reltol >= 1)) c.add('T010', `${path}/reltol`, 'reltol must be in (0, 1)');
}

function checkDc(c: Collector, d: Obj, path: string, ids: Set<string>): void {
  unknownKeys(c, d, ['source', 'param', 'from', 'to', 'points'], path);
  if ((d.source === undefined) === (d.param === undefined)) c.add('T010', path, 'give exactly one of "source" or "param"');
  const id = d.source ?? d.param;
  if (id !== undefined && (typeof id !== 'string' || !ids.has(id))) c.add('T010', path, `dc sweep of unknown component ${JSON.stringify(id)}`);
  if (!isNum(d.from) || !isNum(d.to) || d.from === d.to) c.add('T010', path, 'from and to must be different finite numbers');
  if (!isInt(d.points) || d.points < 2 || d.points > 10001) c.add('T010', `${path}/points`, 'points must be an integer in 2..10001');
}

function checkAc(c: Collector, a: Obj, path: string): void {
  unknownKeys(c, a, ['from', 'to', 'pointsPerDecade'], path);
  if (!isNum(a.from) || a.from <= 0 || !isNum(a.to) || !(a.to > a.from)) c.add('T010', path, 'needs 0 < from < to (Hz)');
  if (!isInt(a.pointsPerDecade) || a.pointsPerDecade < 1 || a.pointsPerDecade > 1000) c.add('T010', `${path}/pointsPerDecade`, 'pointsPerDecade must be an integer in 1..1000');
}
