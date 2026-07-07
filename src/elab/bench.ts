import { Circuit } from '../core/Circuit';
import type { Component } from '../core/Component';
import type { Pin } from '../core/Pin';
import type { Node } from '../core/Node';
import { parseValue } from './units';
import { fnv1a64 } from './hash';
import { captureLoc } from './loc';
import { describeComponent, rebuildWithValue, isOverridable } from './describe';
import type {
  AssertionSpec,
  CheckSpec,
  NetlistComponent,
  NetlistDoc,
  ParamSpec,
  StageName,
} from '../schema/types';

const ID_RE = /^[A-Za-z][A-Za-z0-9_]*$/;
const COMPONENT_PROBE_RE = /^([A-Za-z][A-Za-z0-9_]*)\.(i|v)$/;

export interface BenchDescriptor {
  name: string;
  build: (tb: TB) => void;
}

/**
 * Declare a testbench. The build function is lazy — it runs at elaboration
 * time (CLI, vitest, browser worker), never at import time, and may run many
 * times with different parameter overrides (micro-sweeps, `--set`).
 */
export function bench(name: string, build: (tb: TB) => void): BenchDescriptor {
  if (!name || typeof build !== 'function') {
    throw new Error(`bench(name, build): expected a name and a build function`);
  }
  return { name, build };
}

export type ValueLike = number | string;

export class TB {
  /** The circuit ground pin — connect return paths here. */
  readonly gnd: Pin;

  /** @internal */
  _circuit: Circuit;
  /** @internal */
  _components = new Map<string, Component>();
  /** @internal */
  _locOf = new Map<string, string | undefined>();
  /** @internal */
  _params = new Map<string, ParamSpec>();
  /** @internal */
  _namedNets: { name: string; pin: Pin; at?: string }[] = [];
  /** @internal */
  _assertions: AssertionSpec[] = [];
  /** @internal */
  _overrides: Record<string, number>;

  constructor(circuit: Circuit, overrides: Record<string, number> = {}) {
    this._circuit = circuit;
    this._overrides = overrides;
    this.gnd = circuit.ground;
  }

  /**
   * Register a component under a stable id. The id is how every diagnostic,
   * probe and assertion refers to it. Returns the component (possibly rebuilt
   * when an override for this id is active — always use the returned value).
   */
  add<T extends Component>(id: string, component: T): T {
    if (!ID_RE.test(id)) {
      throw new Error(
        `invalid component id '${id}': use letters/digits/underscore starting with a letter, e.g. tb.add('R1', new Resistor('4.7k'))`,
      );
    }
    if (this._components.has(id)) {
      throw new Error(`duplicate component id '${id}': every tb.add id must be unique`);
    }
    let comp: Component = component;
    const override = this._overrides[id];
    if (override !== undefined) {
      comp = rebuildWithValue(component, override);
    }
    this._components.set(id, comp);
    this._locOf.set(id, captureLoc());
    return comp as T;
  }

  /**
   * Declare a free parameter over a component's scalar value. The platform —
   * not the agent — explores this range to compute verified sizing hints.
   */
  param(id: string, spec: { min: ValueLike; max: ValueLike; scale?: 'lin' | 'log' }): void {
    const min = parseValue(spec.min, `param ${id} min`);
    const max = parseValue(spec.max, `param ${id} max`);
    const scale = spec.scale ?? 'lin';
    if (!(min < max)) throw new Error(`param '${id}': min (${min}) must be < max (${max})`);
    if (scale === 'log' && min <= 0) {
      throw new Error(`param '${id}': log scale requires min > 0, got ${min}`);
    }
    this._params.set(id, { min, max, scale });
  }

  /** Name the electrical net that contains this pin, so probes can cite it. */
  name(netName: string, pin: Pin): void {
    if (!ID_RE.test(netName)) {
      throw new Error(`invalid net name '${netName}': use letters/digits/underscore starting with a letter`);
    }
    if (netName === 'gnd') {
      throw new Error(`net name 'gnd' is reserved for the ground net`);
    }
    this._namedNets.push({ name: netName, pin, at: captureLoc() });
  }

  readonly expect = {
    /** DC operating-point assertion on a probe ('R1.i', 'D1.v', or a named net). */
    op: (probe: string): OpExpect => new OpExpect(this, probe),
    /** Transient assertions; probes are component quantities ('D1.i', 'C1.v'). */
    tran: (config: { tstop: ValueLike; dt: ValueLike }): TranExpect => new TranExpect(this, config),
  };

  /** @internal */
  _record(stage: StageName, probe: string, check: CheckSpec, tran?: { tstop: number; dt: number }): void {
    this._assertions.push({
      id: `a${this._assertions.length + 1}`,
      stage,
      probe,
      check,
      at: captureLoc(),
      ...(tran ? { tran } : {}),
    });
  }
}

export class OpExpect {
  constructor(private tb: TB, private probe: string) {}

  toBeWithin(min: ValueLike, max: ValueLike): this {
    this.tb._record('op', this.probe, {
      op: 'within',
      min: parseValue(min, 'toBeWithin min'),
      max: parseValue(max, 'toBeWithin max'),
    });
    return this;
  }

  toBeCloseTo(value: ValueLike, tol: ValueLike): this {
    this.tb._record('op', this.probe, {
      op: 'closeTo',
      value: parseValue(value, 'toBeCloseTo value'),
      tol: parseValue(tol, 'toBeCloseTo tol'),
    });
    return this;
  }

  toBeAbove(value: ValueLike): this {
    this.tb._record('op', this.probe, { op: 'above', value: parseValue(value, 'toBeAbove value') });
    return this;
  }

  toBeBelow(value: ValueLike): this {
    this.tb._record('op', this.probe, { op: 'below', value: parseValue(value, 'toBeBelow value') });
    return this;
  }
}

export class TranExpect {
  /** @internal */
  _config: { tstop: number; dt: number };

  constructor(private tb: TB, config: { tstop: ValueLike; dt: ValueLike }) {
    const tstop = parseValue(config.tstop, 'tran tstop');
    const dt = parseValue(config.dt, 'tran dt');
    if (dt <= 0) throw new Error(`tran dt must be > 0, got ${dt}`);
    if (tstop <= 0) throw new Error(`tran tstop must be > 0, got ${tstop}`);
    if (tstop / dt > 5_000_000) {
      throw new Error(
        `tran tstop/dt = ${Math.round(tstop / dt)} steps: too many (max 5,000,000). Increase dt or reduce tstop`,
      );
    }
    this._config = { tstop, dt };
  }

  probe(probe: string): TranProbeExpect {
    return new TranProbeExpect(this.tb, this, probe);
  }
}

export class TranProbeExpect {
  constructor(private tb: TB, private parent: TranExpect, private probeExpr: string) {}

  /** Assert on a different probe of the same transient run. */
  probe(probe: string): TranProbeExpect {
    return this.parent.probe(probe);
  }

  /** Settles into target ± tol (fraction) no later than `by`, and stays there. */
  toSettleWithin(spec: { target: ValueLike; tol: number; by: ValueLike }): this {
    this.record({
      op: 'settleWithin',
      target: parseValue(spec.target, 'settle target'),
      tol: spec.tol,
      by: parseValue(spec.by, 'settle by'),
    });
    return this;
  }

  toNeverExceed(value: ValueLike): this {
    this.record({ op: 'neverExceed', value: parseValue(value, 'neverExceed value') });
    return this;
  }

  toStayAbove(value: ValueLike, opts?: { from?: ValueLike }): this {
    this.record({
      op: 'stayAbove',
      value: parseValue(value, 'stayAbove value'),
      ...(opts?.from !== undefined ? { from: parseValue(opts.from, 'stayAbove from') } : {}),
    });
    return this;
  }

  toStayBelow(value: ValueLike, opts?: { from?: ValueLike }): this {
    this.record({
      op: 'stayBelow',
      value: parseValue(value, 'stayBelow value'),
      ...(opts?.from !== undefined ? { from: parseValue(opts.from, 'stayBelow from') } : {}),
    });
    return this;
  }

  /** Peak-to-peak ripple below `amplitude` over t >= from (default: tstop/2). */
  toRippleBelow(amplitude: ValueLike, opts?: { from?: ValueLike }): this {
    this.record({
      op: 'rippleBelow',
      amplitude: parseValue(amplitude, 'ripple amplitude'),
      ...(opts?.from !== undefined ? { from: parseValue(opts.from, 'ripple from') } : {}),
    });
    return this;
  }

  toEndCloseTo(value: ValueLike, tol: ValueLike): this {
    this.record({
      op: 'finalCloseTo',
      value: parseValue(value, 'endCloseTo value'),
      tol: parseValue(tol, 'endCloseTo tol'),
    });
    return this;
  }

  private record(check: CheckSpec): void {
    this.tb._record('tran', this.probeExpr, check, this.parent._config);
  }
}

// ─── Elaboration ─────────────────────────────────────────────────────────────

export interface Elaboration {
  desc: BenchDescriptor;
  overrides: Record<string, number>;
  circuit: Circuit;
  components: Map<string, Component>;
  idOf: Map<Component, string>;
  locOf: Map<string, string | undefined>;
  params: Map<string, ParamSpec>;
  assertions: AssertionSpec[];
  netlist: NetlistDoc;
  /** net name -> engine node (for DC voltage lookup) */
  netNode: Map<string, Node>;
  /** unique pin -> canonical "id.pinName" ref (registered components only) */
  refOf: Map<Pin, string>;
  /** net name -> member pins */
  netPins: Map<string, Pin[]>;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

/** Canonical pin name per unique Pin: later alias registrations win ('+' over '1'). */
function canonicalPinNames(comp: Component): Map<Pin, string> {
  const names = new Map<Pin, string>();
  for (const [name, pin] of comp.pinEntries()) {
    names.set(pin, name);
  }
  return names;
}

/**
 * Run the bench build function and derive the canonical netlist. Fresh
 * engine instances every call — elaborations are fully isolated, which is
 * what makes micro-sweeps and --set overrides safe.
 */
export function elaborate(desc: BenchDescriptor, overrides: Record<string, number> = {}): Elaboration {
  for (const key of Object.keys(overrides)) {
    const v = overrides[key];
    if (!Number.isFinite(v)) throw new Error(`override ${key}=${v}: value must be a finite number`);
  }

  const circuit = new Circuit();
  const tb = new TB(circuit, overrides);
  desc.build(tb);

  // Unknown override ids are authoring errors — surface them.
  for (const key of Object.keys(overrides)) {
    if (!tb._components.has(key)) {
      throw new Error(
        `override for unknown component id '${key}'. Known ids: ${[...tb._components.keys()].join(', ') || '(none)'}`,
      );
    }
  }
  for (const id of tb._params.keys()) {
    const comp = tb._components.get(id);
    if (!comp) {
      throw new Error(`tb.param('${id}', ...): no component registered with that id`);
    }
    if (!isOverridable(comp)) {
      throw new Error(
        `tb.param('${id}', ...): ${describeComponent(comp).type} has no sweepable scalar value`,
      );
    }
  }

  // Unique pins + canonical refs.
  const refOf = new Map<Pin, string>();
  const pinsOf = new Map<string, { pin: Pin; name: string }[]>();
  for (const [id, comp] of tb._components) {
    const canonical = canonicalPinNames(comp);
    const unique: { pin: Pin; name: string }[] = [];
    const seen = new Set<Pin>();
    for (const pin of comp.allPins()) {
      if (seen.has(pin)) continue;
      seen.add(pin);
      const name = canonical.get(pin)!;
      unique.push({ pin, name });
      refOf.set(pin, `${id}.${name}`);
    }
    pinsOf.set(id, unique);
  }

  // Group pins into nets by live Node identity.
  const groundNode = circuit.ground.node;
  const nodePins = new Map<Node, Pin[]>();
  nodePins.set(groundNode, []);
  for (const pin of refOf.keys()) {
    const node = pin.node;
    const list = nodePins.get(node) ?? [];
    list.push(pin);
    nodePins.set(node, list);
  }

  // Name nets: gnd, then user names, then n1..nN in deterministic order.
  const nodeName = new Map<Node, string>();
  nodeName.set(groundNode, 'gnd');
  for (const { name, pin, at } of tb._namedNets) {
    const node = pin.node;
    if (node === groundNode) {
      throw new Error(`tb.name('${name}', ...)${at ? ` at ${at}` : ''}: that pin is on the ground net (already named 'gnd')`);
    }
    const existing = nodeName.get(node);
    if (existing && existing !== name) {
      throw new Error(`net already named '${existing}'; cannot also name it '${name}'${at ? ` (${at})` : ''}`);
    }
    for (const [otherNode, otherName] of nodeName) {
      if (otherName === name && otherNode !== node) {
        throw new Error(`net name '${name}' used for two different nets${at ? ` (${at})` : ''}`);
      }
    }
    nodeName.set(node, name);
  }
  const anonymous = [...nodePins.keys()]
    .filter(node => !nodeName.has(node))
    .map(node => ({
      node,
      key: (nodePins.get(node) ?? [])
        .map(p => refOf.get(p)!)
        .sort()
        .join(','),
    }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  anonymous.forEach(({ node }, i) => nodeName.set(node, `n${i + 1}`));

  const netNode = new Map<string, Node>();
  const netPins = new Map<string, Pin[]>();
  for (const [node, pins] of nodePins) {
    const name = nodeName.get(node)!;
    netNode.set(name, node);
    netPins.set(name, pins);
  }

  // Validate probes now that nets are named.
  const knownNets = [...netNode.keys()].filter(n => n === 'gnd' || !/^n\d+$/.test(n));
  for (const a of tb._assertions) {
    const m = a.probe.match(COMPONENT_PROBE_RE);
    if (m) {
      if (!tb._components.has(m[1])) {
        throw new Error(
          `unknown probe '${a.probe}'${a.at ? ` at ${a.at}` : ''}: no component with id '${m[1]}'. Known ids: ${[...tb._components.keys()].join(', ')}`,
        );
      }
      continue;
    }
    if (a.stage === 'op' && netNode.has(a.probe)) {
      if (/^n\d+$/.test(a.probe)) {
        throw new Error(
          `probe '${a.probe}'${a.at ? ` at ${a.at}` : ''}: auto-generated net names are not stable; name the net first with tb.name('${a.probe}', pin)`,
        );
      }
      continue;
    }
    if (a.stage === 'tran') {
      throw new Error(
        `unknown tran probe '${a.probe}'${a.at ? ` at ${a.at}` : ''}: transient probes must be component quantities like 'D1.i' or 'C1.v'`,
      );
    }
    throw new Error(
      `unknown probe '${a.probe}'${a.at ? ` at ${a.at}` : ''}: use '<id>.i' / '<id>.v', or a net named via tb.name(...). Named nets: ${knownNets.join(', ') || '(none)'}`,
    );
  }

  // Canonical netlist document.
  const components: NetlistComponent[] = [...tb._components.keys()].sort().map(id => {
    const comp = tb._components.get(id)!;
    const info = describeComponent(comp);
    const pins: Record<string, string> = {};
    for (const { pin, name } of pinsOf.get(id)!) {
      pins[name] = nodeName.get(pin.node)!;
    }
    const free = tb._params.get(id);
    const at = tb._locOf.get(id);
    return { id, type: info.type, params: info.params, pins, ...(free ? { free } : {}), ...(at ? { at } : {}) };
  });
  const nets: Record<string, string[]> = {};
  for (const name of [...netNode.keys()].sort()) {
    nets[name] = (netPins.get(name) ?? []).map(p => refOf.get(p)!).sort();
  }
  const hash = fnv1a64(
    stableStringify({
      components: components.map(({ id, type, params, pins }) => ({ id, type, params, pins })),
      nets,
    }),
  );

  const idOf = new Map<Component, string>();
  for (const [id, comp] of tb._components) idOf.set(comp, id);

  return {
    desc,
    overrides,
    circuit,
    components: tb._components,
    idOf,
    locOf: tb._locOf,
    params: tb._params,
    assertions: tb._assertions,
    netlist: { hash, components, nets },
    netNode,
    refOf,
    netPins,
  };
}
