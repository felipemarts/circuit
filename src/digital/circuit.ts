/**
 * Building digital circuits in code.
 *
 *   const c = new DigitalCircuit();
 *   c.add('CLK', new Clock({ freq: '1M' }), { y: 'clk' });
 *   c.add('FF1', new DFF({ delay: '2n', setup: '1n' }), { d: 'D', clk: 'clk', q: 'Q' });
 *   c.input('D', { initial: 0 });
 *   const sim = c.build();
 *   sim.drive('D', 1, '1.2u').advanceTo('5u');
 *
 * Wiring: pass a { pin: netName } map to `add`, and/or connect pins with
 * `pin.connect(otherPinOrNetName)`. Nets without a user name are named after
 * their first output pin ('U1.y'), so names never depend on build order.
 *
 * Identity is structural (`kind: 'digital-part'` + `type`), never instanceof.
 */
import type { Logic, Strength } from './logic';
import { parseLogic } from './logic';
import type { DigitalDiagnostic } from './diagnostics';
import { lintDigital } from './lint';
import type { DigitalInputPort, DigitalNetlist } from './netlist';
import { ID_RE, NET_RE, resolveNetlist, toNetlist } from './netlist';
import type {
  BehavioralOptions,
  ClockOptions,
  CounterOptions,
  FlipFlopOptions,
  GateOptions,
  LatchOptions,
  MuxOptions,
  PartParams,
  PinLayout,
  ShiftRegisterOptions,
  StimulusOptions,
  TimingOptions,
  TriBufOptions,
} from './parts';
import { partDef } from './parts';
import type { DigitalSimOptions } from './sim';
import { DigitalSim } from './sim';

export class DigitalPin {
  constructor(
    readonly part: DigitalPart,
    readonly name: string,
  ) {}

  /** 'U1.a' — valid once the part is registered with `circuit.add`. */
  get ref(): string {
    return `${this.part.id}.${this.name}`;
  }

  /** Wire this pin to another pin or to a named net. */
  connect(other: DigitalPin | string): this {
    const c = this.part._circuit;
    if (!c) throw new Error(`cannot connect pin '${this.name}' of an unregistered ${this.part.type}: call circuit.add(id, part) first`);
    c.connect(this, other);
    return this;
  }
}

/** A digital primitive: a type plus plain-JSON params. */
export class DigitalPart {
  readonly kind = 'digital-part' as const;
  readonly type: string;
  readonly params: PartParams;
  /** @internal */
  _id?: string;
  /** @internal */
  _circuit?: DigitalCircuit;

  constructor(type: string, opts: object = {}) {
    this.type = type;
    this.params = partDef(type).normalize(opts as Record<string, unknown>);
  }

  get id(): string {
    if (!this._id) throw new Error(`${this.type} is not registered: call circuit.add(id, part) first`);
    return this._id;
  }

  layout(): PinLayout {
    return partDef(this.type).pins(this.params);
  }

  pinNames(): string[] {
    const l = this.layout();
    return [...l.inputs, ...l.outputs];
  }

  pin(name: string): DigitalPin {
    const names = this.pinNames();
    if (!names.includes(name)) {
      throw new Error(`${this.type}${this._id ? ` '${this._id}'` : ''} has no pin '${name}'. Pins: ${names.join(', ')}`);
    }
    return new DigitalPin(this, name);
  }
}

// ── primitives ──

export class Buf extends DigitalPart {
  constructor(opts: TimingOptions = {}) {
    super('Buf', opts);
  }
}
export class Not extends DigitalPart {
  constructor(opts: TimingOptions = {}) {
    super('Not', opts);
  }
}
export class And extends DigitalPart {
  constructor(opts: GateOptions = {}) {
    super('And', opts);
  }
}
export class Or extends DigitalPart {
  constructor(opts: GateOptions = {}) {
    super('Or', opts);
  }
}
export class Nand extends DigitalPart {
  constructor(opts: GateOptions = {}) {
    super('Nand', opts);
  }
}
export class Nor extends DigitalPart {
  constructor(opts: GateOptions = {}) {
    super('Nor', opts);
  }
}
export class Xor extends DigitalPart {
  constructor(opts: GateOptions = {}) {
    super('Xor', opts);
  }
}
export class Xnor extends DigitalPart {
  constructor(opts: GateOptions = {}) {
    super('Xnor', opts);
  }
}
export class TriBuf extends DigitalPart {
  constructor(opts: TriBufOptions = {}) {
    super('TriBuf', opts);
  }
}
export class Mux extends DigitalPart {
  constructor(opts: MuxOptions = {}) {
    super('Mux', opts);
  }
}
export class DFF extends DigitalPart {
  constructor(opts: FlipFlopOptions = {}) {
    super('DFF', opts);
  }
}
export class JKFF extends DigitalPart {
  constructor(opts: FlipFlopOptions = {}) {
    super('JKFF', opts);
  }
}
export class DLatch extends DigitalPart {
  constructor(opts: LatchOptions = {}) {
    super('DLatch', opts);
  }
}
export class Counter extends DigitalPart {
  constructor(opts: CounterOptions = {}) {
    super('Counter', opts);
  }
}
export class ShiftRegister extends DigitalPart {
  constructor(opts: ShiftRegisterOptions = {}) {
    super('ShiftRegister', opts);
  }
}
export class Clock extends DigitalPart {
  constructor(opts: ClockOptions) {
    super('Clock', opts);
  }
}
export class Const extends DigitalPart {
  constructor(value: Logic) {
    super('Const', { value });
  }
}
export class Pull extends DigitalPart {
  /** Pull(1) = pull-up, Pull(0) = pull-down. */
  constructor(value: 0 | 1) {
    super('Pull', { value });
  }
}
export class Stimulus extends DigitalPart {
  constructor(opts: StimulusOptions) {
    super('Stimulus', opts);
  }
}

/** A behavioral component whose model comes from a factory registered with `registerBehavior` (see behavior.ts). */
export class Behavioral extends DigitalPart {
  constructor(opts: BehavioralOptions) {
    super('Behavioral', opts);
  }
}

/** Rebuild a part from its serialized `{ type, params }`. */
export function partFromJSON(type: string, params: PartParams): DigitalPart {
  return new DigitalPart(type, params);
}

// ── circuit ──

export interface DigitalCircuitOptions {
  /** Called on every `add` to capture a source location ('file:line') for lint diagnostics. */
  locate?: () => string | undefined;
}

export class DigitalCircuit {
  private parts = new Map<string, DigitalPart>();
  private locs = new Map<string, string | undefined>();
  private parent = new Map<string, string>();
  private inputPorts = new Map<string, DigitalInputPort>();

  constructor(private opts: DigitalCircuitOptions = {}) {}

  /**
   * Register a part under a stable id ('U1', 'FF1', …) and optionally wire it:
   * `{ a: 'A', b: 'B', y: 'Y' }` maps pins to net names (or to other pins).
   * Returns the part, so `c.add('U1', new And()).pin('y')` works.
   * `opts.at` sets the source location lint reports for this part (generated
   * parts, e.g. from VHDL, point at their own source line); otherwise the
   * circuit's `locate` hook is used.
   */
  add<T extends DigitalPart>(id: string, part: T, wiring: Record<string, string | DigitalPin> = {}, opts: { at?: string } = {}): T {
    if (!ID_RE.test(id)) {
      throw new Error(`invalid component id '${id}': use letters/digits/underscore starting with a letter, e.g. c.add('U1', new And())`);
    }
    if (this.parts.has(id)) throw new Error(`duplicate component id '${id}': every id must be unique`);
    if (!part || part.kind !== 'digital-part') throw new Error(`c.add('${id}', part): part must be a digital part such as new And()`);
    if (part._circuit) throw new Error(`this ${part.type} is already registered as '${part._id}' — create a new instance for '${id}'`);
    part._id = id;
    part._circuit = this;
    this.parts.set(id, part);
    this.locs.set(id, opts.at ?? this.opts.locate?.());
    for (const [pin, target] of Object.entries(wiring)) this.connect(part.pin(pin), target);
    return part;
  }

  /** Get a registered part by id. */
  get(id: string): DigitalPart {
    const p = this.parts.get(id);
    if (!p) throw new Error(`no component '${id}' in this circuit`);
    return p;
  }

  /**
   * Declare a net driven from outside the circuit (testbench `sim.drive`,
   * or an analog→digital bridge). Lint treats it as driven. Default initial 'Z'… use
   * `{ initial: 0 }` for a defined power-on level.
   */
  input(net: string, opts: { initial?: Logic; strength?: Strength } = {}): string {
    this.checkNetName(net);
    if (this.inputPorts.has(net)) throw new Error(`input '${net}' declared twice`);
    this.inputPorts.set(net, { net, initial: parseLogic(opts.initial ?? 'Z', `input ${net} initial`), strength: opts.strength ?? 'strong' });
    this.find(`n:${net}`);
    return net;
  }

  /** Name the net that contains `pin`. */
  name(net: string, pin: DigitalPin): void {
    this.checkNetName(net);
    this.connect(pin, net);
  }

  /** Wire pins and/or named nets together. */
  connect(first: DigitalPin | string, ...rest: (DigitalPin | string)[]): void {
    const a = this.terminal(first);
    for (const r of rest) this.union(a, this.terminal(r));
  }

  /** The canonical, deterministic plain-JSON netlist. */
  netlist(): DigitalNetlist {
    // Group terminals by union-find root.
    const groups = new Map<string, string[]>();
    for (const key of this.parent.keys()) {
      const r = this.find(key);
      const g = groups.get(r);
      if (g) g.push(key);
      else groups.set(r, [key]);
    }
    const netOfTerminal = new Map<string, string>();
    for (const keys of groups.values()) {
      const named = keys.filter(k => k.startsWith('n:')).map(k => k.slice(2)).sort();
      if (named.length > 1) {
        throw new Error(`nets ${named.map(n => `'${n}'`).join(' and ')} are wired together — one net cannot have two names; drop one name or remove the connection`);
      }
      let name = named[0];
      if (name === undefined) {
        const pins = keys.filter(k => k.startsWith('p:')).map(k => k.slice(2)).sort();
        const outputs = pins.filter(ref => {
          const [id, pin] = ref.split('.');
          return this.parts.get(id)!.layout().outputs.includes(pin);
        });
        name = (outputs[0] ?? pins[0])!;
      }
      for (const k of keys) netOfTerminal.set(k, name);
    }
    const components = [...this.parts.entries()].map(([id, part]) => ({
      id,
      type: part.type,
      params: part.params,
      pins: Object.fromEntries(part.pinNames().map(pin => [pin, netOfTerminal.get(`p:${id}.${pin}`) ?? `${id}.${pin}`])),
      ...(this.locs.get(id) !== undefined ? { at: this.locs.get(id) } : {}),
    }));
    return toNetlist(resolveNetlist({ components, inputs: [...this.inputPorts.values()] }));
  }

  /** Structural lint (F130–F134) of the circuit. */
  lint(): DigitalDiagnostic[] {
    return lintDigital(this.netlist());
  }

  /** Elaborate and power on a simulation (t = 0, settled). */
  build(opts: DigitalSimOptions = {}): DigitalSim {
    return new DigitalSim(this.netlist(), opts);
  }

  /** Rebuild an editable circuit from a netlist produced by `netlist()` (or hand-written JSON). */
  static fromJSON(n: Pick<DigitalNetlist, 'components'> & { inputs?: DigitalInputPort[] }): DigitalCircuit {
    const r = resolveNetlist(n);
    const c = new DigitalCircuit();
    for (const i of r.inputs) c.input(i.net, { initial: i.initial, strength: i.strength });
    for (const comp of r.components) c.add(comp.id, partFromJSON(comp.type, comp.params));
    for (const comp of r.components) {
      for (const [pin, net] of Object.entries(comp.pins)) {
        // Auto nets are named after one of their pins ('U1.y'): connect to that pin.
        if (net.includes('.')) {
          const [id, other] = net.split('.');
          if (id === comp.id && other === pin) continue;
          c.connect(c.get(comp.id).pin(pin), c.get(id).pin(other));
        } else {
          c.connect(c.get(comp.id).pin(pin), net);
        }
      }
    }
    return c;
  }

  // ── internals ──

  private checkNetName(net: string): void {
    if (typeof net !== 'string' || !NET_RE.test(net)) {
      throw new Error(`invalid net name '${net}': use letters/digits/underscore (and [] for bus bits, e.g. 'Q[3]'), starting with a letter`);
    }
  }

  private terminal(t: DigitalPin | string): string {
    if (typeof t === 'string') {
      this.checkNetName(t);
      return `n:${t}`;
    }
    if (!(t instanceof DigitalPin) && !(t && typeof t === 'object' && 'part' in t)) throw new Error(`expected a pin or a net name, got ${JSON.stringify(t)}`);
    if (t.part._circuit !== this) throw new Error(`pin '${t.name}' belongs to a part that is not registered in this circuit`);
    return `p:${t.part.id}.${t.name}`;
  }

  private find(x: string): string {
    if (!this.parent.has(x)) this.parent.set(x, x);
    let r = x;
    while (this.parent.get(r) !== r) r = this.parent.get(r)!;
    let y = x;
    while (y !== r) {
      const next = this.parent.get(y)!;
      this.parent.set(y, r);
      y = next;
    }
    return r;
  }

  private union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return;
    // Deterministic root choice (smaller key) — grouping is order-independent anyway.
    if (ra < rb) this.parent.set(rb, ra);
    else this.parent.set(ra, rb);
  }
}
