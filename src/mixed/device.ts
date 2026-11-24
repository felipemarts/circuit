/**
 * Analog-side devices of the mixed-signal bridge.
 *
 *   LogicIC         a real IC (Part('74HC00')): explicit supply pins, a bridge at
 *                   every logic pin, the NE555's internal divider/discharge/output.
 *   LogicPrimitive  a generic logic element usable in benches (new Nand(), new
 *                   DFF(), new Clock(), …). On pure-digital nets it is simulated by
 *                   the event engine alone; where a pin meets an analog net it is
 *                   bridged with a logic family's levels at an ideal supply.
 *
 * The device stamps; the controller (controller.ts) owns the logic state and
 * sets the output stages and supply status between solves.
 */
import { Component } from '../core/Component';
import type { Pin } from '../core/Pin';
import type { MNAMatrix } from '../solver/MNAMatrix';
import type { AcLoadContext, LoadContext } from '../analysis/context';
import { junctionVcrit, pnjlim, safeExp } from '../solver/limiting';
import { partDef, type PartParams } from '../digital/parts';
import type { Logic } from '../digital/logic';
import { parseValue } from '../core/units';
import type {
  ClockOptions,
  CounterOptions,
  FlipFlopOptions,
  GateOptions,
  LatchOptions,
  MuxOptions,
  ShiftRegisterOptions,
  StimulusOptions,
  TimingOptions,
  TriBufOptions,
} from '../digital/parts';
import { findIcDef, pinKey, type IcDef, type IcPin } from './ics';
import type { Corner, FamilyName } from './families';
import type { ParamValue } from '../schema/types';

/** Leakage from every bridged pin to the reference (keeps unconnected pins solvable): 1 GΩ. */
export const PIN_LEAK = 1e-9;

/** Input clamp (protection) diodes: Shockley Is (A) and ideality — generic CMOS ESD diode, a model choice. */
export const CLAMP_IS = 1e-14;
export const CLAMP_N = 1;
const VT = 0.02585;

/** A ramped value: `from` → `to` linearly over [t0, t0 + dur]. */
export class Ramp {
  from = 0;
  to = 0;
  t0 = 0;
  dur = 0;
  constructor(v = 0) {
    this.from = this.to = v;
  }
  at(t: number): number {
    if (this.dur <= 0 || t >= this.t0 + this.dur) return this.to;
    if (t <= this.t0) return this.from;
    return this.from + ((this.to - this.from) * (t - this.t0)) / this.dur;
  }
  /** Start a ramp at t from the current value toward `to`. */
  go(to: number, t: number, dur: number): void {
    const now = this.at(t);
    this.from = now;
    this.to = to;
    this.t0 = t;
    this.dur = now === to ? 0 : dur;
  }
  set(v: number): void {
    this.from = this.to = v;
    this.dur = 0;
  }
  /** End of the ramp if it is still running after t. */
  endAfter(t: number): number {
    const end = this.t0 + this.dur;
    return this.dur > 0 && end > t ? end : Infinity;
  }
}

/**
 * One output stage: a pull-up conductance s·e/rHigh and a pull-down
 * (1−s)·e/rLow. s = high fraction (1 = logic 1), e = enable (0 = high-Z).
 */
export class OutputStage {
  readonly s = new Ramp(0);
  readonly e = new Ramp(1);
  rHigh = 50;
  rLow = 50;
  /** Darlington offset of the high side (NE555 only), V. */
  vDrop = 0;
  ramp = 1e-9;
  powered = true;
  value: Logic = 0;

  /** Target levels for a logic value. */
  static targets(v: Logic, s: number): { s: number; e: number } {
    if (v === 1) return { s: 1, e: 1 };
    if (v === 0) return { s: 0, e: 1 };
    if (v === 'Z') return { s, e: 0 };
    return { s: 0.5, e: 1 };
  }

  /** DC / power-on: jump to the value. Returns true if the stamped state changed. */
  setStatic(v: Logic): boolean {
    const t = OutputStage.targets(v, this.s.to);
    const changed = t.s !== this.s.to || t.e !== this.e.to || this.s.dur > 0 || this.e.dur > 0;
    this.value = v;
    this.s.set(t.s);
    this.e.set(t.e);
    return changed;
  }

  /** Transient: ramp toward the value starting at t. */
  drive(v: Logic, t: number): void {
    const tg = OutputStage.targets(v, this.s.at(t));
    this.value = v;
    this.s.go(tg.s, t, this.ramp);
    this.e.go(tg.e, t, this.ramp);
  }

  sAt(ctx: LoadContext): number {
    return ctx.mode === 'dc' || ctx.initial ? this.s.to : this.s.at(ctx.time);
  }

  eAt(ctx: LoadContext): number {
    if (!this.powered) return 0;
    return ctx.mode === 'dc' || ctx.initial ? this.e.to : this.e.at(ctx.time);
  }

  /** Values at an accepted time (for current checks). */
  sNow(t: number): number {
    return this.s.at(t);
  }
  eNow(t: number): number {
    return this.powered ? this.e.at(t) : 0;
  }

  nextCorner(t: number): number {
    return Math.min(this.s.endAfter(t), this.e.endAfter(t));
  }
}

/** Clamp-diode junction with Newton limiting (per-iteration state). */
class Junction {
  vd = 0;
  /** Small-signal conductance at the last linearization point. */
  get g(): number {
    return (CLAMP_IS / Junction.nVt) * safeExp(this.vd / Junction.nVt) + 1e-12;
  }
  private static readonly nVt = CLAMP_N * VT;
  private static readonly vcrit = junctionVcrit(CLAMP_N * VT, CLAMP_IS);

  stamp(ctx: LoadContext, anode: number, cathode: number): void {
    const nVt = Junction.nVt;
    let vd: number;
    if (ctx.init === 'junction') vd = 0;
    else {
      vd = ctx.v(anode) - ctx.v(cathode);
      if (ctx.init === 'none') {
        const lim = pnjlim(vd, this.vd, nVt, Junction.vcrit);
        if (lim.limited) {
          vd = lim.value;
          ctx.limited();
        }
      }
    }
    this.vd = vd;
    const ex = safeExp(vd / nVt);
    const g = (CLAMP_IS / nVt) * ex + ctx.gmin;
    const id = CLAMP_IS * (ex - 1) + ctx.gmin * vd;
    ctx.matrix.stampConductance(anode, cathode, g);
    ctx.matrix.stampCurrentSource(anode, cathode, -(id - g * vd));
  }
}

/** Current (A) of a clamp diode at forward voltage vd. */
export function clampCurrent(vd: number): number {
  return CLAMP_IS * (safeExp(vd / (CLAMP_N * VT)) - 1);
}

const idx = (p: Pin): number => p.node.index;

// ─── Real ICs ────────────────────────────────────────────────────────────────

export interface IcOptions {
  /** 'typ' (default): typical datasheet delays and drive; 'worst': max tpd and max output resistance. */
  corner?: Corner;
  /** Model the input protection diodes to VCC/GND (default true; NE555 inputs never have them). */
  clamp?: boolean;
}

/**
 * A real IC from the catalog, with datasheet pin names and numbers.
 * `u1.pin('1A')`, `u1.pin(1)`, `u1.pin('vcc')` (lenient: case, spaces and '_' ignored).
 */
export class LogicIC extends Component {
  readonly kind = 'IC' as const;
  readonly partId: string;
  readonly def: IcDef;
  readonly corner: Corner;
  readonly clamp: boolean;
  /** @internal output stages by pin name (set up by the controller). */
  _stages = new Map<string, OutputStage>();
  /** @internal powered state (controller). */
  _powered = true;
  private byNumber = new Map<number, Pin>();
  private byKey = new Map<string, Pin>();
  private icPins: { info: IcPin; pin: Pin }[] = [];
  private junctions = new Map<string, [Junction, Junction]>();

  constructor(partId: string, opts: IcOptions = {}) {
    super();
    const def = findIcDef(partId);
    if (!def) throw new Error(`Part('${partId}'): not a simulatable IC`);
    if (opts === null || typeof opts !== 'object') throw new Error(`Part('${partId}', options): options must be an object`);
    for (const k of Object.keys(opts)) {
      if (k !== 'corner' && k !== 'clamp') throw new Error(`Part('${def.id}'): unknown option '${k}'. Valid options: corner ('typ' | 'worst'), clamp (boolean)`);
    }
    const corner = opts.corner ?? 'typ';
    if (corner !== 'typ' && corner !== 'worst') throw new Error(`Part('${def.id}'): corner must be 'typ' or 'worst', got ${JSON.stringify(corner)}`);
    if (opts.clamp !== undefined && typeof opts.clamp !== 'boolean') throw new Error(`Part('${def.id}'): clamp must be true or false`);
    this.def = def;
    this.partId = def.id;
    this.corner = corner;
    this.clamp = def.kind === 'timer' ? false : (opts.clamp ?? true);
    for (const info of def.pins) {
      const p = this.addPin(info.name);
      this.byNumber.set(info.number, p);
      this.byKey.set(pinKey(info.name), p);
      this.icPins.push({ info, pin: p });
      if (this.clamp && info.role === 'in') this.junctions.set(info.name, [new Junction(), new Junction()]);
    }
  }

  /** Pin by datasheet name ('1A', '~OE', 'CARRY OUT') or number (1..N). */
  pin(name: string | number): Pin {
    if (typeof name === 'number') {
      const p = this.byNumber.get(name);
      if (!p) throw new Error(`${this.partId} has no pin ${name} (pins 1–${this.def.pins.length})`);
      return p;
    }
    const exact = this.pins.get(name);
    if (exact) return exact;
    const m = /^pin(\d+)$/i.exec(name);
    if (m) return this.pin(Number(m[1]));
    const p = this.byKey.get(pinKey(name));
    if (!p) {
      throw new Error(`${this.partId} has no pin '${name}'. Pins: ${this.def.pins.map(x => `${x.number}=${x.name}`).join(', ')}`);
    }
    return p;
  }

  /** Datasheet info of a pin. */
  pinInfo(p: Pin): IcPin {
    const e = this.icPins.find(x => x.pin === p);
    if (!e) throw new Error(`pin does not belong to ${this.partId}`);
    return e.info;
  }

  describeParams(): Record<string, ParamValue> {
    return { corner: this.corner, clamp: this.clamp };
  }

  isNonlinear(): boolean {
    return this.junctions.size > 0;
  }

  load(ctx: LoadContext): void {
    const m = ctx.matrix;
    const vcc = idx(this.pins.get(this.supplyName('vcc'))!);
    const gnd = idx(this.pins.get(this.supplyName('gnd'))!);
    for (const { info, pin } of this.icPins) {
      if (info.role === 'vcc' || info.role === 'gnd') continue;
      const n = idx(pin);
      if (info.role !== 'analog') m.stampConductance(n, gnd, PIN_LEAK);
      const j = this.junctions.get(info.name);
      if (j) {
        j[0].stamp(ctx, n, vcc); // input → VCC
        j[1].stamp(ctx, gnd, n); // GND → input
      }
      const st = this._stages.get(info.name);
      if (st) stampStage(m, ctx, st, info.bridge, n, vcc, gnd);
    }
    if (this.def.kind === 'timer') {
      const t = this.pins.get('CONT')!;
      m.stampConductance(vcc, idx(t), 1 / 5e3);
      m.stampConductance(idx(t), gnd, 1 / 10e3);
    }
  }

  /**
   * Small-signal model around the operating point: logic outputs hold their DC
   * level, so each output stage is its pull-up/pull-down conductance to the
   * rails; inputs are the pin leakage plus the clamp diodes' conductance.
   */
  hasAcModel(): boolean {
    return true;
  }

  acLoad(ctx: AcLoadContext): void {
    const m = ctx.matrix;
    const vcc = idx(this.pins.get(this.supplyName('vcc'))!);
    const gnd = idx(this.pins.get(this.supplyName('gnd'))!);
    for (const { info, pin } of this.icPins) {
      if (info.role === 'vcc' || info.role === 'gnd') continue;
      const n = idx(pin);
      if (info.role !== 'analog') m.stampAdmittance(n, gnd, PIN_LEAK, 0);
      const j = this.junctions.get(info.name);
      if (j) {
        m.stampAdmittance(n, vcc, j[0].g, 0);
        m.stampAdmittance(gnd, n, j[1].g, 0);
      }
      const st = this._stages.get(info.name);
      if (!st || !st.powered || st.e.to <= 0) continue;
      const s = st.s.to;
      const e = st.e.to;
      if (info.bridge === 'disch555') {
        if (s > 0) m.stampAdmittance(n, gnd, (e * s) / st.rLow, 0);
        continue;
      }
      if (s > 0) m.stampAdmittance(n, vcc, (e * s) / st.rHigh, 0);
      if (s < 1) m.stampAdmittance(n, gnd, (e * (1 - s)) / st.rLow, 0);
    }
    if (this.def.kind === 'timer') {
      const t = idx(this.pins.get('CONT')!);
      m.stampAdmittance(vcc, t, 1 / 5e3, 0);
      m.stampAdmittance(t, gnd, 1 / 10e3, 0);
    }
  }

  /** @internal name of the supply pin of a role. */
  supplyName(role: 'vcc' | 'gnd'): string {
    return this.def.pins.find(p => p.role === role)!.name;
  }

  /** @internal clamp diode currents of an input pin: [into VCC, out of GND] at a solution. */
  clampVoltages(name: string, v: (pin: Pin) => number): [number, number] | undefined {
    if (!this.junctions.has(name)) return undefined;
    const p = this.pins.get(name)!;
    return [v(p) - v(this.pins.get(this.supplyName('vcc'))!), v(this.pins.get(this.supplyName('gnd'))!) - v(p)];
  }

  /** Legacy entry point: the device stamps through load(ctx). */
  stamp(_matrix: MNAMatrix): void {}
}

function stampStage(m: MNAMatrix, ctx: LoadContext, st: OutputStage, kind: string, n: number, vcc: number, gnd: number): void {
  const e = st.eAt(ctx);
  if (e <= 0) return;
  const s = st.sAt(ctx);
  if (kind === 'disch555') {
    if (s > 0) m.stampConductance(n, gnd, (e * s) / st.rLow);
    return;
  }
  const gUp = (e * s) / st.rHigh;
  const gDn = (e * (1 - s)) / st.rLow;
  if (gUp > 0) {
    m.stampConductance(n, vcc, gUp);
    if (st.vDrop > 0) m.stampCurrentSource(vcc, n, gUp * st.vDrop);
  }
  if (gDn > 0) m.stampConductance(n, gnd, gDn);
}

/** Output current (A, out of the pin into the load) of a stage at node voltages. */
export function stageCurrent(st: OutputStage, kind: string, t: number, vPin: number, vVcc: number, vGnd: number): number {
  const e = st.eNow(t);
  if (e <= 0) return 0;
  const s = st.sNow(t);
  if (kind === 'disch555') return -((e * s) / st.rLow) * (vPin - vGnd);
  const up = ((e * s) / st.rHigh) * (vVcc - vPin - st.vDrop);
  const dn = ((e * (1 - s)) / st.rLow) * (vPin - vGnd);
  return up - dn;
}

// ─── Generic logic primitives ────────────────────────────────────────────────

export interface BridgeOptions {
  /** Logic family whose datasheet levels apply where a pin meets an analog net (default 'HC'). */
  family?: FamilyName;
  /** Ideal supply the bridged levels are referenced to (default 5 V; ground is tb.gnd). */
  vcc?: number | string;
}

const FAMILIES: FamilyName[] = ['HC', 'HCT', 'CD4000'];

/**
 * A generic logic element. Pins and options are those of src/digital (see
 * catalog); `family`/`vcc` set the analog bridge used where a pin touches an
 * analog net.
 */
export class LogicPrimitive extends Component {
  readonly kind = 'LogicPrimitive' as const;
  readonly logicType: string;
  /** Normalized digital params (plain JSON, seconds). */
  readonly params: PartParams;
  readonly family: FamilyName;
  readonly vcc: number;
  /** @internal pins on analog nets (set by the mixed elaboration). */
  _bridged = new Set<string>();
  /** @internal output stages by pin name. */
  _stages = new Map<string, OutputStage>();
  private readonly layoutPins: { name: string; output: boolean }[];

  constructor(type: string, opts: object = {}) {
    super();
    if (opts === null || typeof opts !== 'object' || Array.isArray(opts)) throw new Error(`${type}: options must be an object`);
    const { family, vcc, ...rest } = opts as Record<string, unknown> & BridgeOptions;
    const def = partDef(type);
    this.logicType = type;
    this.params = def.normalize(rest);
    const fam = (family ?? 'HC') as FamilyName;
    if (!FAMILIES.includes(fam)) throw new Error(`${type}: family must be one of ${FAMILIES.map(f => `'${f}'`).join(', ')}, got ${JSON.stringify(family)}`);
    this.family = fam;
    this.vcc = vcc === undefined ? 5 : parseValue(vcc as number | string, `${type} vcc`);
    if (!(this.vcc > 0)) throw new Error(`${type}: vcc must be > 0, got ${this.vcc}`);
    const layout = def.pins(this.params);
    this.layoutPins = [...layout.inputs.map(name => ({ name, output: false })), ...layout.outputs.map(name => ({ name, output: true }))];
    for (const p of this.layoutPins) this.addPin(p.name);
  }

  /** Input/output pin names of the layout. */
  layout(): { inputs: string[]; outputs: string[] } {
    return {
      inputs: this.layoutPins.filter(p => !p.output).map(p => p.name),
      outputs: this.layoutPins.filter(p => p.output).map(p => p.name),
    };
  }

  describeParams(): Record<string, ParamValue> {
    return { ...(this.params as Record<string, ParamValue>), family: this.family, vcc: this.vcc };
  }

  load(ctx: LoadContext): void {
    const m = ctx.matrix;
    for (const p of this.layoutPins) {
      const n = idx(this.pins.get(p.name)!);
      if (!this._bridged.has(p.name)) {
        // Pure-digital net: decoupled dummy unknown held at 0 V.
        m.stampConductance(n, 0, 1);
        continue;
      }
      m.stampConductance(n, 0, PIN_LEAK);
      const st = this._stages.get(p.name);
      if (!st) continue;
      const e = st.eAt(ctx);
      if (e <= 0) continue;
      const s = st.sAt(ctx);
      const gUp = (e * s) / st.rHigh;
      const gDn = (e * (1 - s)) / st.rLow;
      m.stampConductance(n, 0, gUp + gDn);
      m.stampCurrentSource(n, 0, gUp * this.vcc);
    }
  }

  /** Small-signal: bridged outputs are their DC output conductance to the (ideal) rails. */
  hasAcModel(): boolean {
    return true;
  }

  acLoad(ctx: AcLoadContext): void {
    const m = ctx.matrix;
    for (const p of this.layoutPins) {
      const n = idx(this.pins.get(p.name)!);
      if (!this._bridged.has(p.name)) {
        m.stampAdmittance(n, 0, 1, 0);
        continue;
      }
      const st = this._stages.get(p.name);
      const g = st && st.e.to > 0 ? (st.e.to * st.s.to) / st.rHigh + (st.e.to * (1 - st.s.to)) / st.rLow : 0;
      m.stampAdmittance(n, 0, PIN_LEAK + g, 0);
    }
  }

  /** Legacy entry point: the device stamps through load(ctx). */
  stamp(_matrix: MNAMatrix): void {}
}

type WithBridge<T> = T & BridgeOptions;

export class Buf extends LogicPrimitive {
  constructor(opts: WithBridge<TimingOptions> = {}) {
    super('Buf', opts);
  }
}
export class Not extends LogicPrimitive {
  constructor(opts: WithBridge<TimingOptions> = {}) {
    super('Not', opts);
  }
}
export class And extends LogicPrimitive {
  constructor(opts: WithBridge<GateOptions> = {}) {
    super('And', opts);
  }
}
export class Or extends LogicPrimitive {
  constructor(opts: WithBridge<GateOptions> = {}) {
    super('Or', opts);
  }
}
export class Nand extends LogicPrimitive {
  constructor(opts: WithBridge<GateOptions> = {}) {
    super('Nand', opts);
  }
}
export class Nor extends LogicPrimitive {
  constructor(opts: WithBridge<GateOptions> = {}) {
    super('Nor', opts);
  }
}
export class Xor extends LogicPrimitive {
  constructor(opts: WithBridge<GateOptions> = {}) {
    super('Xor', opts);
  }
}
export class Xnor extends LogicPrimitive {
  constructor(opts: WithBridge<GateOptions> = {}) {
    super('Xnor', opts);
  }
}
export class TriBuf extends LogicPrimitive {
  constructor(opts: WithBridge<TriBufOptions> = {}) {
    super('TriBuf', opts);
  }
}
export class Mux extends LogicPrimitive {
  constructor(opts: WithBridge<MuxOptions> = {}) {
    super('Mux', opts);
  }
}
export class DFF extends LogicPrimitive {
  constructor(opts: WithBridge<FlipFlopOptions> = {}) {
    super('DFF', opts);
  }
}
export class JKFF extends LogicPrimitive {
  constructor(opts: WithBridge<FlipFlopOptions> = {}) {
    super('JKFF', opts);
  }
}
export class DLatch extends LogicPrimitive {
  constructor(opts: WithBridge<LatchOptions> = {}) {
    super('DLatch', opts);
  }
}
export class Counter extends LogicPrimitive {
  constructor(opts: WithBridge<CounterOptions> = {}) {
    super('Counter', opts);
  }
}
export class ShiftRegister extends LogicPrimitive {
  constructor(opts: WithBridge<ShiftRegisterOptions> = {}) {
    super('ShiftRegister', opts);
  }
}
export class Clock extends LogicPrimitive {
  constructor(opts: WithBridge<ClockOptions>) {
    super('Clock', opts as Record<string, unknown>);
  }
}
export class Stimulus extends LogicPrimitive {
  constructor(opts: WithBridge<StimulusOptions>) {
    super('Stimulus', opts as Record<string, unknown>);
  }
}
/** Constant logic level → y. */
export class Const extends LogicPrimitive {
  constructor(value: Logic, opts: BridgeOptions = {}) {
    super('Const', { ...opts, value });
  }
}
/** Weak pull-up (1) / pull-down (0) on a pure-digital net. */
export class Pull extends LogicPrimitive {
  constructor(value: 0 | 1) {
    super('Pull', { value });
  }
}

/** Type names of the generic logic primitives (netlist `type`). */
export const LOGIC_PRIMITIVE_TYPES = [
  'Buf', 'Not', 'And', 'Or', 'Nand', 'Nor', 'Xor', 'Xnor', 'TriBuf', 'Mux', 'DFF', 'JKFF', 'DLatch',
  'Counter', 'ShiftRegister', 'Clock', 'Stimulus', 'Const', 'Pull',
];

/** Rebuild an IC or a logic primitive from its netlist { type, params } (buildComponent). */
export function buildMixedComponent(type: string, params: Record<string, ParamValue>): Component | undefined {
  if (LOGIC_PRIMITIVE_TYPES.includes(type)) return new LogicPrimitive(type, JSON.parse(JSON.stringify(params)));
  const def = findIcDef(type);
  if (def && def.id === type) {
    const opts: IcOptions = {};
    if (params.corner !== undefined) opts.corner = params.corner as Corner;
    if (params.clamp !== undefined) opts.clamp = params.clamp as boolean;
    return new LogicIC(type, opts);
  }
  return undefined;
}
