/**
 * The mixed-signal co-simulation controller: implements the engine's
 * CoSimHook for a bench with logic ICs / primitives.
 *
 * Algorithm (see src/mixed/README.md):
 *   DC (op, sweep points, transient t = 0): after each converged analog solve
 *     every input bridge classifies its pin voltage (VIL/VIH, VT+/VT−,
 *     comparators), the digital netlist is powered on with those input levels
 *     (zero-delay settle of the level-sensitive behavior, flip-flops at their
 *     power-on state) and the output stages are set from the digital outputs;
 *     re-solved until nothing changes (≤ MAX_SETTLE passes, else D514).
 *   Transient: one DigitalSim runs alongside the adaptive analog stepper.
 *     - every pending digital event and output-ramp corner is an analog breakpoint;
 *     - a converged step in which an input crosses its threshold is cut back to
 *       the crossing (linear interpolation of the threshold distance, accepted
 *       when the crossing is within `crossTol` of the step end);
 *     - on acceptance the crossings are driven into the digital nets at their
 *       interpolated times, the digital side advances to the accepted time
 *       (never beyond), and digital output changes start the output ramps.
 */
import type { CoSimHook, SimulationSystem } from '../analysis/engine';
import type { Pin } from '../core/Pin';
import type { Diagnostic, LogicCapture, LogicLevel } from '../schema/types';
import { DigitalSim, type DigitalRecording, type NetTrace } from '../digital/sim';
import type { DigitalNetlistComponent, DigitalInputPort } from '../digital/netlist';
import type { DigitalDiagnostic } from '../digital/diagnostics';
import type { Logic } from '../digital/logic';
import { formatTime } from '../digital/units';
import { formatEng } from '../core/units';
import { LogicIC, LogicPrimitive, OutputStage, clampCurrent, stageCurrent } from './device';
import { RAMP_FRACTION, UNPOWERED_FRACTION, type LogicFamilyModel, type TimerModel } from './families';
import type { BridgeKind } from './ics';
import { mixedDiagnostic } from './diagnostics';
import type { McuCosim, McuSerialCapture } from './mcu-cosim';
import type { RatingResult } from '../schema/types';

/** Max re-solves of one DC point while the logic state changes. */
export const MAX_SETTLE = 24;
/** Max value changes kept per signal in the RunRecord logic capture. */
export const CAPTURE_LIMIT = 5000;

export type Supply = { kind: 'pins'; vcc: Pin; gnd: Pin } | { kind: 'ideal'; vcc: number };

export interface InputBridge {
  owner: string;
  pin: string;
  /** 'U1.1A' */
  display: string;
  net: string;
  pinObj: Pin;
  kind: Exclude<BridgeKind, 'pushpull' | 'tristate' | 'out555' | 'disch555' | 'none'>;
  supply: Supply;
  fam?: LogicFamilyModel;
  timer?: TimerModel;
  cont?: Pin;
  /** D508 dwell limit applies (non-Schmitt logic inputs). */
  checkZone: boolean;
  // runtime
  level?: 0 | 1;
  zoneSince?: number;
  zoneReported?: boolean;
  clampReported?: boolean;
}

export interface OutputBridge {
  owner: string;
  pin: string;
  display: string;
  net: string;
  pinObj: Pin;
  kind: 'pushpull' | 'tristate' | 'out555' | 'disch555';
  supply: Supply;
  stage: OutputStage;
  fam?: LogicFamilyModel;
  timer?: TimerModel;
  /** Ramp duration (s) at a supply voltage. */
  ramp: (vs: number) => number;
  /** The pin is not connected to anything (no D512 for it). */
  dangling?: boolean;
  overReported?: boolean;
  xReported?: boolean;
}

export interface IcEntry {
  id: string;
  ic: LogicIC;
  vcc: Pin;
  gnd: Pin;
  fam?: LogicFamilyModel;
  timer?: TimerModel;
  stages: OutputStage[];
  // runtime
  powered: boolean;
  everPowered: boolean;
  vs: number;
  rangeReported?: boolean;
  absReported?: boolean;
  brownReported?: boolean;
}

export interface MixedPlan {
  ics: IcEntry[];
  prims: { id: string; prim: LogicPrimitive; pins: Record<string, string>; at?: string }[];
  inputs: InputBridge[];
  outputs: OutputBridge[];
  locOf: Map<string, string | undefined>;
  /** digital net / internal id → display name for messages. */
  display: Map<string, string>;
  /** VHDL blocks: their elaborated processes as digital netlist components (nets already mapped). */
  vhdl?: { id: string; components: DigitalNetlistComponent[] }[];
  /** Microcontrollers (firmware co-simulation, src/mixed/mcu-cosim.ts). */
  mcus?: McuCosim[];
}

export interface MixedRunResult {
  diagnostics: Diagnostic[];
  recording?: DigitalRecording;
  tEnd: number;
  events?: number;
}

const vOf = (x: ArrayLike<number>, p: Pin): number => {
  const i = p.node.index;
  return i > 0 ? x[i - 1] : 0;
};

function supplyV(x: ArrayLike<number>, s: Supply): { vcc: number; gnd: number } {
  return s.kind === 'ideal' ? { vcc: s.vcc, gnd: 0 } : { vcc: vOf(x, s.vcc), gnd: vOf(x, s.gnd) };
}

/** Rising/falling thresholds of a logic or Schmitt input at supply vs. */
function thresholds(b: InputBridge, vs: number): { rise: number; fall: number; mid: number } {
  const f = b.fam!;
  if (b.kind === 'schmitt' && f.vtPlus && f.vtMinus) {
    const rise = f.vtPlus(vs);
    const fall = f.vtMinus(vs);
    return { rise, fall, mid: (rise + fall) / 2 };
  }
  const rise = f.vih(vs);
  const fall = f.vil(vs);
  return { rise, fall, mid: (rise + fall) / 2 };
}

/**
 * Signed distance of an input to its switching point given the current level:
 * the level flips when it becomes > 0. state undefined: distance to the midpoint
 * (static classification without history).
 */
function trigger(b: InputBridge, x: ArrayLike<number>, state: 0 | 1 | undefined): number {
  const vin = vOf(x, b.pinObj);
  const { vcc, gnd } = supplyV(x, b.supply);
  switch (b.kind) {
    case 'logic':
    case 'schmitt': {
      const th = thresholds(b, vcc - gnd);
      const v = vin - gnd;
      if (state === undefined) return v - th.mid;
      return state === 0 ? v - th.rise : th.fall - v;
    }
    case 'thres555': {
      const d = vin - vOf(x, b.cont!);
      return state === 1 ? -d : d;
    }
    case 'trig555': {
      const d = vOf(x, b.cont!) / 2 - vin;
      return state === 1 ? -d : d;
    }
    case 'reset555': {
      const d = gnd + b.timer!.resetThreshold - vin;
      return state === 1 ? -d : d;
    }
  }
}

function inZone(b: InputBridge, x: ArrayLike<number>): boolean {
  const { vcc, gnd } = supplyV(x, b.supply);
  const vs = vcc - gnd;
  const v = vOf(x, b.pinObj) - gnd;
  return v > b.fam!.vil(vs) && v < b.fam!.vih(vs);
}

const logicLevel = (v: Logic): LogicLevel => v;

export class MixedController implements CoSimHook {
  readonly plan: MixedPlan;
  /** Results of the last analysis (attach → … ). */
  run: MixedRunResult = { diagnostics: [], tEnd: 0 };
  /** Signals (display name → digital net) to capture for the RunRecord. */
  private sim?: DigitalSim;
  private t0 = 0;
  private x0: Float64Array = new Float64Array(0);
  private staticDone = false;
  private crossTol = 1e-12;
  private seen = new Set<string>();

  constructor(plan: MixedPlan) {
    this.plan = plan;
  }

  // ── setup ──

  /** Crossing time tolerance for the next transient (s). */
  setTimeScale(tstop: number): void {
    this.crossTol = Math.max(1e-12, Math.min(1e-9, tstop * 1e-7));
  }

  /** Label of the transient configuration being run (MCU rating / serial records). */
  config = '';

  /** Serial output of every MCU that printed, in the last transient. */
  serialCaptures(): McuSerialCapture[] {
    const out: McuSerialCapture[] = [];
    for (const m of this.plan.mcus ?? []) {
      const c = m.serialCapture(this.config);
      if (c) out.push(c);
    }
    return out;
  }

  /** Serial log of one MCU in the last transient (undefined: no such MCU). */
  serialLog(id: string): { t: number; port: string; text: string }[] | undefined {
    const m = (this.plan.mcus ?? []).find(x => x.id === id);
    return m ? (m.serial ?? []) : undefined;
  }

  /** MCU pin-current ratings (R410–R413) of the last transient. */
  mcuRatings(): RatingResult[] {
    return (this.plan.mcus ?? []).flatMap(m => m.ratings);
  }

  attach(_system: SimulationSystem): void {
    this.run = { diagnostics: [], tEnd: 0 };
    this.sim = undefined;
    this.staticDone = false;
    this.seen.clear();
    for (const b of this.plan.inputs) {
      b.level = undefined;
      b.zoneSince = undefined;
      b.zoneReported = false;
      b.clampReported = false;
    }
    for (const o of this.plan.outputs) {
      o.stage.setStatic(0);
      o.stage.powered = true;
      o.overReported = false;
      o.xReported = false;
    }
    for (const ic of this.plan.ics) {
      ic.powered = true;
      ic.everPowered = false;
      ic.vs = 0;
      ic.rangeReported = ic.absReported = ic.brownReported = false;
      ic.ic._powered = true;
    }
    for (const m of this.plan.mcus ?? []) m.attach();
  }

  /** The digital netlist with IC delays at their current supply. */
  netlist(): { components: DigitalNetlistComponent[]; inputs: DigitalInputPort[] } {
    const components: DigitalNetlistComponent[] = [];
    for (const p of this.plan.prims) {
      const at = this.plan.locOf.get(p.id);
      components.push({ id: p.id, type: p.prim.logicType, params: p.prim.params, pins: p.pins, ...(at ? { at } : {}) });
    }
    for (const e of this.plan.ics) {
      const at = this.plan.locOf.get(e.id);
      const vs = e.vs > 0 ? e.vs : nominalVs(e);
      const byName = new Map(e.ic.def.pins.map(p => [p.name, p.number]));
      for (const c of e.ic.def.build({ vs, corner: e.ic.corner })) {
        const pins: Record<string, string> = {};
        for (const [pin, target] of Object.entries(c.pins)) {
          pins[pin] = target.startsWith('pin:') ? icPinNet(e.id, byName.get(target.slice(4))!) : `_${e.id}__${target.slice(4)}`;
        }
        components.push({ id: `${e.id}__${c.local}`, type: c.type, params: c.params, pins, ...(at ? { at } : {}) });
      }
    }
    for (const v of this.plan.vhdl ?? []) components.push(...v.components.map(c => ({ ...c, params: c.params, pins: { ...c.pins } })));
    const inputs: DigitalInputPort[] = this.plan.inputs.map(b => ({ net: b.net, initial: b.level ?? 0, strength: 'strong' }));
    return { components, inputs };
  }

  // ── supplies ──

  /** Update supply voltages/powered flags from a solution. Returns true if a powered state changed. */
  private updateSupplies(x: ArrayLike<number>, transient = false): boolean {
    let changed = false;
    for (const e of this.plan.ics) {
      e.vs = vOf(x, e.vcc) - vOf(x, e.gnd);
      const min = e.fam?.vccMin ?? e.timer!.vccMin;
      // A brown-out in the transient latches the IC off for the rest of the run
      // (re-power after a collapse is not modeled; D510 is an error anyway).
      const powered = transient && e.everPowered && !e.powered ? false : e.vs >= UNPOWERED_FRACTION * min;
      if (powered !== e.powered) {
        e.powered = powered;
        e.ic._powered = powered;
        for (const s of e.stages) s.powered = powered;
        changed = true;
      }
      if (powered) e.everPowered = true;
    }
    return changed;
  }

  /** Output-stage resistances and ramps at the current supplies. */
  private updateDrive(): void {
    for (const o of this.plan.outputs) {
      const vs = o.supply.kind === 'ideal' ? o.supply.vcc : this.icOf(o.owner).vs;
      const v = vs > 0 ? vs : 1e-3;
      const corner = o.supply.kind === 'ideal' ? 'typ' : this.icOf(o.owner).ic.corner;
      if (o.timer) {
        if (o.kind === 'disch555') o.stage.rLow = o.timer.rDischarge(v, corner);
        else {
          o.stage.rLow = o.timer.rOutLow(v, corner);
          o.stage.rHigh = o.timer.rOutHigh;
          o.stage.vDrop = o.timer.vDropHigh;
        }
      } else {
        o.stage.rHigh = o.fam!.rOutHigh(v, corner);
        o.stage.rLow = o.fam!.rOutLow(v, corner);
      }
      o.stage.ramp = o.ramp(v);
    }
  }

  private icOf(id: string): IcEntry {
    return this.plan.ics.find(e => e.id === id)!;
  }

  // ── DC ──

  settleDc(x: Float64Array, mode: 'dc' | 'tran', pass: number): boolean {
    const poweredChanged = this.updateSupplies(x);
    this.updateDrive();
    for (const b of this.plan.inputs) {
      const f = trigger(b, x, b.level);
      if (b.level === undefined) b.level = f > 0 ? 1 : 0;
      else if (f > 0) b.level = b.level === 0 ? 1 : 0;
    }
    const sim = new DigitalSim(this.netlist(), { record: false });
    let outChanged = false;
    for (const o of this.plan.outputs) {
      const v = sim.value(o.net);
      if (o.stage.setStatic(v)) outChanged = true;
    }
    const changed = outChanged || poweredChanged;
    if (changed && pass < MAX_SETTLE) return true;
    if (changed) {
      this.report(
        mixedDiagnostic('D514', mode === 'dc' ? 'op' : 'tran', {
          message: `no consistent DC logic state after ${MAX_SETTLE} passes: the logic outputs keep changing the inputs that set them (the circuit oscillates)`,
          note: 'a DC operating point holds every logic output at a fixed level; a loop such as an inverter fed back through an RC has no such state. Analog values are reported with the outputs at the last pass',
          evidence: { passes: MAX_SETTLE },
          fixes: [{ kind: 'use-transient', confidence: 'suggested', detail: `assert on this circuit with tb.expect.tran(...) / tb.expect.logic(...) (ic: 'zero'), not at the operating point` }],
        }),
      );
    }
    if (mode === 'dc' && !this.staticDone) {
      this.staticDone = true;
      this.staticChecks(x, sim, !changed);
    }
    return false;
  }

  private staticChecks(x: Float64Array, sim: DigitalSim, consistent: boolean): void {
    for (const e of this.plan.ics) this.checkSupply(e, 'op', undefined);
    for (const e of this.plan.ics) {
      if (!e.powered) {
        this.report(
          mixedDiagnostic('D510', 'op', {
            severity: 'warning',
            message: `${e.id} (${e.ic.partId}) is unpowered at the operating point: VCC−GND = ${fmtV(e.vs)} (< ${fmtV(UNPOWERED_FRACTION * (e.fam?.vccMin ?? e.timer!.vccMin))}); its outputs are high-Z`,
            subject: { components: [e.id] },
            note: 'below about half its minimum operating supply a CMOS/bipolar IC does nothing useful: outputs float and inputs are undefined',
            evidence: { supply: e.vs },
            fixes: [{ kind: 'rewire', confidence: 'suggested', detail: `connect ${e.id}.${e.ic.supplyName('vcc')} to the supply rail and ${e.id}.${e.ic.supplyName('gnd')} to tb.gnd` }],
            at: this.plan.locOf.get(e.id),
          }),
        );
      }
    }
    for (const b of this.plan.inputs) {
      if (b.kind !== 'logic' || !this.powered(b.owner)) continue;
      if (inZone(b, x)) {
        const { vcc, gnd } = supplyV(x, b.supply);
        const vs = vcc - gnd;
        this.report(this.zoneDiagnostic(b, 'op', vOf(x, b.pinObj) - gnd, vs, undefined, undefined));
      }
    }
    for (const o of this.plan.outputs) {
      if (o.stage.value === 'X') this.xDiagnostic(o, 'op', undefined);
    }
    for (const d of sim.diagnostics()) this.report(this.translate(d, 'op'));
    // Without a consistent state the solution belongs to the previous pass's outputs.
    if (consistent) this.checkCurrents(x, 0, 'op');
  }

  private powered(owner: string): boolean {
    const e = this.plan.ics.find(i => i.id === owner);
    return e ? e.powered : true;
  }

  // ── transient ──

  beginTransient(x: Float64Array): void {
    this.updateSupplies(x);
    this.updateDrive();
    const sim = new DigitalSim(this.netlist(), { record: true });
    this.sim = sim;
    for (const o of this.plan.outputs) {
      const v = sim.value(o.net);
      if (o.stage.value !== v) o.stage.setStatic(v);
    }
    const byNet = new Map(this.plan.outputs.map(o => [o.net, o]));
    sim.onChange(
      ch => {
        const o = byNet.get(ch.net);
        if (!o) return;
        o.stage.drive(ch.value, ch.t);
        if (ch.value === 'X') this.xDiagnostic(o, 'tran', ch.t);
      },
      { nets: [...byNet.keys()] },
    );
    this.t0 = 0;
    this.x0 = Float64Array.from(x);
    for (const e of this.plan.ics) this.checkSupply(e, 'tran', 0);
    for (const b of this.plan.inputs) {
      if (b.checkZone && inZone(b, x)) b.zoneSince = 0;
    }
    for (const m of this.plan.mcus ?? []) m.beginTransient(x);
  }

  /** Firmware due at t: run it (asynchronously) — see CoSimHook.work. */
  work(t: number): Promise<boolean> | undefined {
    const due = (this.plan.mcus ?? []).filter(m => m.due(t));
    if (due.length === 0) return undefined;
    return (async () => {
      let changed = false;
      // One runtime at a time: the Arduino API is ambient.
      for (const m of due) if (await m.work(t)) changed = true;
      return changed;
    })();
  }

  nextBreakpoint(t: number): number {
    let bp = Infinity;
    const ne = this.sim?.nextEventTime();
    if (ne !== undefined && ne > t) bp = ne;
    for (const o of this.plan.outputs) {
      const c = o.stage.nextCorner(t);
      if (c < bp) bp = c;
    }
    for (const m of this.plan.mcus ?? []) {
      const c = m.nextBreakpoint(t);
      if (c < bp) bp = c;
    }
    return bp;
  }

  /** Crossings inside (t0, t1], earliest first. */
  private crossings(t0: number, x0: ArrayLike<number>, t1: number, x1: ArrayLike<number>): { b: InputBridge; t: number }[] {
    const out: { b: InputBridge; t: number }[] = [];
    for (const b of this.plan.inputs) {
      if (!this.powered(b.owner)) continue;
      const f1 = trigger(b, x1, b.level);
      if (!(f1 > 0)) continue;
      const f0 = trigger(b, x0, b.level);
      const t = f0 >= 0 ? t0 : t0 + ((t1 - t0) * -f0) / (f1 - f0);
      out.push({ b, t: Math.min(Math.max(t, t0), t1) });
    }
    return out.sort((a, b) => a.t - b.t);
  }

  locate(t0: number, x0: Float64Array, t1: number, x1: Float64Array): number | undefined {
    if (!this.sim) return undefined;
    const c = this.crossings(t0, x0, t1, x1);
    let tc = c.length > 0 ? c[0].t : Infinity;
    for (const m of this.plan.mcus ?? []) {
      const t = m.earliestCrossing(t0, x0, t1, x1);
      if (t !== undefined && t < tc) tc = t;
    }
    if (tc === Infinity) return undefined;
    if (t1 - tc <= this.crossTol) return undefined;
    return Math.max(tc + this.crossTol / 2, t0 + this.crossTol / 2);
  }

  accepted(t1: number, x1: Float64Array): boolean {
    const sim = this.sim;
    if (!sim) return false;
    const t0 = this.t0;
    const x0 = this.x0;
    // Currents with the stage state the step was solved with — before zero-delay
    // logic (VHDL processes) reacts to this step's crossings inside (t0, t1].
    this.checkCurrents(x1, t1, 'tran');
    for (const { b, t } of this.crossings(t0, x0, t1, x1)) {
      b.level = b.level === 0 ? 1 : 0;
      sim.drive(b.net, b.level, Math.max(t, sim.now));
    }
    let discontinuity = false;
    const off = sim.onChange(ch => {
      if (ch.t <= t1) discontinuity = true;
    });
    sim.advanceTo(t1);
    off();
    if (this.updateSupplies(x1, true)) discontinuity = true;
    this.updateDrive();
    for (const e of this.plan.ics) this.checkSupply(e, 'tran', t1);
    this.trackZones(t0, x0, t1, x1);
    for (const m of this.plan.mcus ?? []) if (m.accepted(t0, x0, t1, Float64Array.from(x1))) discontinuity = true;
    this.t0 = t1;
    this.x0 = Float64Array.from(x1);
    this.run.tEnd = t1;
    return discontinuity;
  }

  /** After the transient: final checks, digital diagnostics, recording. */
  finishTransient(tEnd: number): void {
    const sim = this.sim;
    if (!sim) return;
    for (const b of this.plan.inputs) {
      if (b.zoneSince !== undefined && !b.zoneReported) {
        const limit = this.zoneLimit(b);
        if (limit !== undefined && tEnd - b.zoneSince > limit) this.reportZone(b, b.zoneSince, tEnd, limit, true);
      }
    }
    for (const e of this.plan.ics) {
      if (!e.everPowered) {
        this.report(
          mixedDiagnostic('D510', 'tran', {
            message: `${e.id} (${e.ic.partId}) was never powered during the transient: VCC−GND stayed below ${fmtV(UNPOWERED_FRACTION * (e.fam?.vccMin ?? e.timer!.vccMin))} (last ${fmtV(e.vs)}); its outputs were high-Z throughout`,
            subject: { components: [e.id] },
            note: 'an IC without supply cannot drive anything; logic assertions on it measure a floating pin',
            evidence: { supply: e.vs },
            fixes: [{ kind: 'rewire', confidence: 'suggested', detail: `connect ${e.id}.${e.ic.supplyName('vcc')} to the supply rail (e.g. a 5 V VoltageSource) and ${e.id}.${e.ic.supplyName('gnd')} to tb.gnd` }],
            at: this.plan.locOf.get(e.id),
          }),
        );
      }
    }
    for (const d of sim.diagnostics()) this.report(this.translate(d, 'tran'));
    for (const m of this.plan.mcus ?? []) {
      m.finish(this.config, tEnd);
      for (const d of m.diagnostics()) this.report(d);
    }
    this.run.recording = sim.recording();
    this.run.tEnd = tEnd;
    this.run.events = sim.stats().events;
  }

  /** Pure-digital bench: the event engine alone over [0, tstop]. */
  runDigitalOnly(tstop: number): void {
    this.attach(undefined as unknown as SimulationSystem);
    const sim = new DigitalSim(this.netlist(), { record: true });
    this.sim = sim;
    sim.advanceTo(tstop);
    this.finishTransient(tstop);
  }

  // ── checks ──

  private checkSupply(e: IcEntry, stage: 'op' | 'tran', t: number | undefined): void {
    const min = e.fam?.vccMin ?? e.timer!.vccMin;
    const max = e.fam?.vccMax ?? e.timer!.vccMax;
    const absMax = e.fam?.vccAbsMax ?? e.timer!.vccAbsMax;
    const absMin = e.fam?.vccAbsMin ?? -0.5;
    const vs = e.vs;
    const when = t !== undefined ? ` at t=${formatTime(t)}` : ' at the operating point';
    const vccName = e.ic.supplyName('vcc');
    if ((vs > absMax || vs < absMin) && !e.absReported) {
      e.absReported = true;
      this.report(
        mixedDiagnostic('D509', stage, {
          message: `${e.id} (${e.ic.partId}) supply ${fmtV(vs)}${when} is beyond its absolute maximum rating [${fmtV(absMin)}, ${fmtV(absMax)}] — the part would be damaged`,
          subject: { components: [e.id] },
          note: `datasheet (${e.fam?.source ?? e.timer!.source}): absolute maximum supply ${fmtV(absMax)}; recommended ${fmtV(min)}–${fmtV(max)}`,
          evidence: { supply: vs, recommended: [min, max], absoluteMax: absMax, ...(t !== undefined ? { time: t } : {}) },
          fixes: [{ kind: 'change-value', confidence: 'suggested', detail: `power ${e.id}.${vccName} from ${fmtV(min)}–${fmtV(max)}` }],
          at: this.plan.locOf.get(e.id),
          ...(t !== undefined ? { time: t } : {}),
        }),
      );
      return;
    }
    if (e.powered && (vs < min - 1e-9 || vs > max + 1e-9) && !e.rangeReported && vs <= absMax) {
      e.rangeReported = true;
      this.report(
        mixedDiagnostic('D509', stage, {
          severity: 'warning',
          message: `${e.id} (${e.ic.partId}) supply ${fmtV(vs)}${when} is outside its recommended operating range ${fmtV(min)}–${fmtV(max)}; levels and delays are extrapolated from the datasheet`,
          subject: { components: [e.id] },
          note: `datasheet (${e.fam?.source ?? e.timer!.source}) guarantees thresholds, drive and timing only inside the recommended range`,
          evidence: { supply: vs, recommended: [min, max], ...(t !== undefined ? { time: t } : {}) },
          fixes: [{ kind: 'change-value', confidence: 'suggested', detail: `run ${e.id} from ${fmtV(min)}–${fmtV(max)}${e.fam?.family === 'HCT' ? ' (74HCT needs 4.5–5.5 V; use 74HC for 2–6 V)' : ''}` }],
          at: this.plan.locOf.get(e.id),
          ...(t !== undefined ? { time: t } : {}),
        }),
      );
    }
    if (stage === 'tran' && t !== undefined && !e.powered && e.everPowered && !e.brownReported) {
      e.brownReported = true;
      this.report(
        mixedDiagnostic('D510', 'tran', {
          message: `${e.id} (${e.ic.partId}) lost its supply at t=${formatTime(t)}: VCC−GND fell to ${fmtV(vs)} (brown-out); outputs high-Z from then on`,
          subject: { components: [e.id] },
          note: 'the supply collapsed below half the minimum operating voltage — usually too much load on a supply fed through a resistor, or a supply that is switched off',
          evidence: { supply: vs, time: t },
          fixes: [{ kind: 'rewire', confidence: 'suggested', detail: `feed ${e.id}.${vccName} from a stiff source (no series resistor), add decoupling, or reduce the load on its outputs` }],
          at: this.plan.locOf.get(e.id),
          time: t,
        }),
      );
    }
  }

  private checkCurrents(x: ArrayLike<number>, t: number, stage: 'op' | 'tran'): void {
    for (const o of this.plan.outputs) {
      if (o.overReported || o.kind === 'disch555') continue;
      const { vcc, gnd } = supplyV(x, o.supply);
      const vPin = vOf(x, o.pinObj);
      const i = stageCurrent(o.stage, o.kind, stage === 'op' ? Infinity : t, vPin, vcc, gnd);
      const imax = o.timer ? o.timer.outputCurrentMax : o.fam?.outputCurrentMax;
      const pmax = o.fam?.outputPowerMax;
      const drop = i > 0 ? vcc - vPin : vPin - gnd;
      const over = imax !== undefined ? Math.abs(i) > imax : pmax !== undefined ? Math.abs(i) * Math.abs(drop) > pmax : false;
      if (!over) continue;
      o.overReported = true;
      const fighters = this.plan.outputs.filter(
        p => p !== o && p.pinObj.node === o.pinObj.node && p.kind !== 'disch555' && p.stage.e.to > 0 && p.stage.value !== o.stage.value,
      );
      const when = stage === 'op' ? ' at the operating point' : ` at t=${formatTime(t)}`;
      const limitText = imax !== undefined ? `${formatEng(imax, 'A')} absolute maximum` : `${formatEng(pmax!, 'W')} per-output dissipation limit (${formatEng(Math.abs(i) * Math.abs(drop), 'W')})`;
      const src = o.timer?.source ?? o.fam?.source ?? '';
      this.report(
        mixedDiagnostic('D511', stage, {
          message: fighters.length > 0
            ? `contention through the analog net: ${o.display} drives ${o.stage.value} while ${fighters.map(f => `${f.display} drives ${f.stage.value}`).join(', ')} — ${formatEng(Math.abs(i), 'A')} through the output stages${when}, above the ${limitText}`
            : `${o.display} ${i > 0 ? 'sources' : 'sinks'} ${formatEng(Math.abs(i), 'A')}${when}, above the ${limitText}`,
          subject: { components: [...new Set([o.owner, ...fighters.map(f => f.owner)])].sort(), pins: [o.display, ...fighters.map(f => f.display)] },
          note: `datasheet (${src}); an overloaded CMOS output also loses its logic level (VOH/VOL collapse through Rout)`,
          evidence: { current: i, ...(imax !== undefined ? { limit: imax } : { powerLimit: pmax }), pinVoltage: vPin, ...(stage === 'tran' ? { time: t } : {}) },
          fixes: fighters.length > 0
            ? [{ kind: 'rewire', confidence: 'suggested', detail: `never tie push-pull outputs together: combine the signals with a gate, or use tri-state outputs with exclusive enables` }]
            : [{ kind: 'add-component', confidence: 'suggested', detail: `limit the load current with a series resistor (e.g. ≥ ${formatEng(Math.ceil(Math.abs(vcc - gnd) / (imax ?? 0.01)), 'Ω')}), or buffer with a transistor` }],
          at: this.plan.locOf.get(o.owner),
          ...(stage === 'tran' ? { time: t } : {}),
        }),
      );
    }
    for (const b of this.plan.inputs) {
      if (b.clampReported || b.supply.kind !== 'pins') continue;
      const ic = this.plan.ics.find(e => e.id === b.owner);
      if (!ic || !ic.ic.clamp) continue;
      const vd = ic.ic.clampVoltages(b.pin, p => vOf(x, p));
      if (!vd) continue;
      const i = Math.max(clampCurrent(vd[0]), clampCurrent(vd[1]));
      const lim = ic.fam?.inputClampCurrentMax;
      if (lim === undefined || i <= lim) continue;
      b.clampReported = true;
      const above = vd[0] > vd[1];
      this.report(
        mixedDiagnostic('D513', stage, {
          message: `${b.display} is ${above ? 'above VCC' : 'below GND'} by ${fmtV(above ? vd[0] : vd[1])}${stage === 'op' ? ' at the operating point' : ` at t=${formatTime(t)}`}: ${formatEng(i, 'A')} through its protection diode, above the ${formatEng(lim, 'A')} absolute maximum`,
          subject: { components: [b.owner], pins: [b.display] },
          note: `an input driven beyond the rails forward-biases the ESD clamp diode to ${above ? 'VCC' : 'GND'} (datasheet ${ic.fam?.source}: |IIK| max ${formatEng(lim, 'A')}); it can latch up or back-power the IC`,
          evidence: { current: i, limit: lim, ...(stage === 'tran' ? { time: t } : {}) },
          fixes: [{ kind: 'add-component', confidence: 'suggested', detail: `add a series resistor (e.g. 10k) in front of ${b.display}, or keep the driving signal within 0..VCC` }],
          at: this.plan.locOf.get(b.owner),
          ...(stage === 'tran' ? { time: t } : {}),
        }),
      );
    }
  }

  private zoneLimit(b: InputBridge): number | undefined {
    const vs = b.supply.kind === 'ideal' ? b.supply.vcc : this.icOf(b.owner).vs;
    return b.fam!.maxInputTransition(vs);
  }

  private trackZones(t0: number, x0: ArrayLike<number>, t1: number, x1: ArrayLike<number>): void {
    for (const b of this.plan.inputs) {
      if (!b.checkZone || b.zoneReported) continue;
      const was = b.zoneSince !== undefined;
      const now = this.powered(b.owner) && inZone(b, x1);
      if (now && !was) b.zoneSince = t0 + (t1 - t0) * this.zoneFraction(b, x0, x1, true);
      else if (!now && was) {
        const exit = t0 + (t1 - t0) * this.zoneFraction(b, x0, x1, false);
        const limit = this.zoneLimit(b);
        if (limit !== undefined && exit - b.zoneSince! > limit) this.reportZone(b, b.zoneSince!, exit, limit, false);
        b.zoneSince = undefined;
      }
    }
  }

  /** Fraction of the step at which the input entered (or left) the forbidden zone. */
  private zoneFraction(b: InputBridge, x0: ArrayLike<number>, x1: ArrayLike<number>, entering: boolean): number {
    const dist = (x: ArrayLike<number>) => {
      const { vcc, gnd } = supplyV(x, b.supply);
      const vs = vcc - gnd;
      const v = vOf(x, b.pinObj) - gnd;
      // distance into the zone: positive inside
      return Math.min(v - b.fam!.vil(vs), b.fam!.vih(vs) - v);
    };
    const d0 = dist(x0);
    const d1 = dist(x1);
    const f = entering ? -d0 / (d1 - d0) : d0 / (d0 - d1);
    return Number.isFinite(f) ? Math.min(Math.max(f, 0), 1) : 1;
  }

  private reportZone(b: InputBridge, from: number, to: number, limit: number, atEnd: boolean): void {
    b.zoneReported = true;
    const vs = b.supply.kind === 'ideal' ? b.supply.vcc : this.icOf(b.owner).vs;
    this.report(this.zoneDiagnostic(b, 'tran', undefined, vs, { from, to, limit, atEnd }, from));
  }

  private zoneDiagnostic(
    b: InputBridge,
    stage: 'op' | 'tran',
    v: number | undefined,
    vs: number,
    dwell: { from: number; to: number; limit: number; atEnd: boolean } | undefined,
    time: number | undefined,
  ): Diagnostic {
    const vil = b.fam!.vil(vs);
    const vih = b.fam!.vih(vs);
    const where = dwell
      ? `stayed between VIL ${fmtV(vil)} and VIH ${fmtV(vih)} for ${formatTime(dwell.to - dwell.from)} from t=${formatTime(dwell.from)}${dwell.atEnd ? ' (until the end of the run)' : ''}, longer than the ${formatTime(dwell.limit)} maximum input transition time`
      : `sits at ${fmtV(v!)} at the operating point, between VIL ${fmtV(vil)} and VIH ${fmtV(vih)} (VCC ${fmtV(vs)})`;
    return mixedDiagnostic('D508', stage, {
      message: `${b.display} ${where}`,
      subject: { components: [b.owner], pins: [b.display] },
      note: `a CMOS input in the forbidden zone has both input transistors on: its logic level is undefined (it may oscillate) and it draws shoot-through current. Datasheet (${b.fam!.source}) levels at VCC ${fmtV(vs)}`,
      evidence: { vil, vih, supply: vs, ...(v !== undefined ? { voltage: v } : {}), ...(dwell ? { enteredAt: dwell.from, leftAt: dwell.to, dwell: dwell.to - dwell.from, limit: dwell.limit } : {}) },
      fixes: [
        dwell
          ? { kind: 'replace-component', confidence: 'suggested', detail: `drive ${b.display} with a fast edge, or square up the slow signal with a Schmitt-trigger input first (Part('74HC14'))` }
          : { kind: 'rewire', confidence: 'suggested', detail: `drive ${b.display} to a valid level: below ${fmtV(vil)} or above ${fmtV(vih)} (check the divider / pull resistor)` },
      ],
      at: this.plan.locOf.get(b.owner),
      ...(time !== undefined ? { time } : {}),
    });
  }

  private xDiagnostic(o: OutputBridge, stage: 'op' | 'tran', t: number | undefined): void {
    if (o.xReported || o.dangling) return;
    o.xReported = true;
    this.report(
      mixedDiagnostic('D512', stage, {
        message: `${o.display} drives an unknown logic value (X)${t !== undefined ? ` from t=${formatTime(t)}` : ' at the operating point'}; the analog net sees a mid-rail level`,
        subject: { components: [o.owner], pins: [o.display] },
        note: 'X comes from an undefined input (floating, contention, a setup/hold violation) or an uninitialized loop; the output stage is modeled half-on (mid-rail), which a real part may resolve either way',
        fixes: [{ kind: 'inspect', confidence: 'suggested', detail: `look for D501–D507 / F130 diagnostics upstream of ${o.display}, or give the circuit a defined reset` }],
        at: this.plan.locOf.get(o.owner),
        ...(t !== undefined ? { time: t } : {}),
      }),
    );
  }

  // ── diagnostics plumbing ──

  private report(d: Diagnostic): void {
    const key = JSON.stringify([d.code, d.message]);
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.run.diagnostics.push(d);
  }

  private displayRe?: RegExp;

  /** Rename internal nets/ids of a digital diagnostic to bench names ('_U1_3' → 'U1.1Y'). */
  translate(d: DigitalDiagnostic, stage: 'op' | 'tran' | 'lint'): Diagnostic {
    const map = this.plan.display;
    if (!this.displayRe) {
      const keys = [...map.keys()].sort((a, b) => b.length - a.length).map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
      this.displayRe = keys.length > 0 ? new RegExp(`(${keys.join('|')})(?![A-Za-z0-9_])`, 'g') : /$^/;
    }
    const re = this.displayRe;
    const rename = (s: string) => s.replace(re, m => map.get(m) ?? m);
    const owner = (c: string) => c.split('__')[0];
    const comps = [...new Set((d.subject?.components ?? []).map(owner))].sort();
    const out = JSON.parse(rename(JSON.stringify({ ...d, stage }))) as Diagnostic & { subject?: { components?: string[] } };
    if (out.subject) out.subject.components = comps.length > 0 ? comps : undefined;
    if (out.subject && out.subject.components === undefined) delete out.subject.components;
    // VHDL diagnostics point into the .vhd source; everything else at the owner's tb.add line.
    if (/^V\d{3}$/.test(d.code) && d.at) return out;
    const at = comps.map(c => this.plan.locOf.get(c)).find(a => a !== undefined);
    if (at) out.at = at;
    else delete out.at;
    return out;
  }

  // ── capture ──

  /** Value-change lists of the given signals (display name → digital net). */
  capture(config: string, signals: Map<string, string>): LogicCapture | undefined {
    const rec = this.run.recording;
    if (!rec) return undefined;
    const out: Record<string, [number, LogicLevel][]> = {};
    const truncated: string[] = [];
    for (const name of [...signals.keys()].sort()) {
      const tr: NetTrace | undefined = this.trace(signals.get(name)!);
      if (!tr) continue;
      const n = Math.min(tr.t.length, CAPTURE_LIMIT);
      if (tr.t.length > CAPTURE_LIMIT) truncated.push(name);
      const list: [number, LogicLevel][] = [];
      for (let i = 0; i < n; i++) list.push([tr.t[i], logicLevel(tr.v[i])]);
      out[name] = list;
    }
    return { config, tEnd: rec.tEnd, signals: out, ...(truncated.length > 0 ? { truncated } : {}), ...(this.run.events !== undefined ? { events: this.run.events } : {}) };
  }

  trace(net: string): NetTrace | undefined {
    if (net.startsWith('mcu:')) {
      const ref = net.slice(4);
      const dot = ref.indexOf('.');
      const m = (this.plan.mcus ?? []).find(x => x.id === ref.slice(0, dot));
      return m?.trace(ref.slice(dot + 1));
    }
    return this.run.recording?.traces[net];
  }
}

export function icPinNet(id: string, number: number): string {
  return `_${id}_${number}`;
}

function nominalVs(e: IcEntry): number {
  return e.fam ? (e.fam.vccMin + e.fam.vccMax) / 2 : 5;
}

function fmtV(v: number): string {
  return `${Number(v.toPrecision(4))} V`;
}

/** Ramp of a generic primitive output: RAMP_FRACTION × its delay (≥ 1 ns basis). */
export function primitiveRamp(delay: number): number {
  return RAMP_FRACTION * Math.max(delay, 1e-9);
}
