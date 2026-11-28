/**
 * MCU ↔ transient co-simulation: the McuPinBus of one Mcu component over the
 * analog solution, driven through the MixedController's CoSimHook.
 *
 *   beginTransient(x0)   power check at t = 0, fresh firmware module graph, McuRuntime
 *   work(0)              runUntil(0): setup() up to its first yield (async, awaited by the engine)
 *   nextBreakpoint(t)    runtime.nextWakeTime() (delays, PWM/tone edges, Timer1, queued edges)
 *                        + output-ramp corners — the stepper lands on every one
 *   locate(...)          threshold crossings of pins with an attachInterrupt subscriber
 *                        cut the step (edge time within crossTol)
 *   accepted(t1, x1)     input levels (hysteresis VIL/VIH of the profile), edges → the runtime
 *                        queue at their interpolated times, supply/brown-out, pin currents
 *   work(t1)             runUntil(t1) when the runtime has an event due at or before t1;
 *                        bus calls (drive / setDirection / setPwm) start output ramps at their
 *                        event time and report a discontinuity (BE restart)
 *
 * Firmware time is simulation time: the runtime never runs ahead of the
 * accepted analog solution it reads.
 */
import type { Pin } from '../core/Pin';
import type { Diagnostic, RatingResult } from '../schema/types';
import type { NetTrace } from '../digital/sim';
import type { Logic } from '../digital/logic';
import { formatTime } from '../digital/units';
import { formatEng } from '../core/units';
import { McuRuntime } from '../mcu/runtime';
import { mcuDiagnostic, type McuCode, type DiagFields } from '../mcu/diagnostics';
import type { Level, McuDiagnostic, McuPinBus, PinDirection, PwmDescriptor, SerialEntry } from '../mcu/types';
import { driveAt, thresholdsAt } from '../mcu/electrical';
import { instantiateFirmware } from '../mcu/firmware';
import { serialLines } from '../mcu/measure';
import { clampCurrent, stageCurrent, PIN_LEAK } from './device';
import type { Mcu, McuCell } from './mcu';
import type { RatingOptions } from '../verify/ratings';

const toNs = (t: number): number => (Number.isFinite(t) ? Math.round(t * 1e9) : t);

const vOf = (x: ArrayLike<number>, p: Pin): number => {
  const i = p.node.index;
  return i > 0 ? x[i - 1] : 0;
};

/** Serial output of one MCU in one transient run (RunRecord `stages.tran.serial[]`). */
export interface McuSerialCapture {
  /** Transient configuration label. */
  config: string;
  mcu: string;
  /** Complete lines as [completion time (s), text] (`\r\n` / `\n` stripped). */
  lines: [number, string][];
  /** Text after the last line terminator, with the time of its last chunk. */
  partial?: [number, string];
  /** Lines cut at the capture limit. */
  truncated?: boolean;
}

/** Max serial lines kept per MCU per run in the RunRecord. */
export const SERIAL_CAPTURE_LIMIT = 2000;
/** Currents below this are not listed as rating entries (A). */
const RATING_FLOOR = 1e-6;

interface Peak {
  value: number;
  time: number;
  tFirst?: number;
}

interface CellState {
  cell: McuCell;
  level: 0 | 1;
  subs: Set<(level: Level, t: number) => void>;
  trace: NetTrace;
}

/** Rated quantity: a pin, a port group, a supply pin or a total. */
interface RatedItem {
  key: string;
  code: 'R410' | 'R412' | 'R413';
  rating: string;
  description: string;
  quantity: string;
  limit: number;
  peak: Peak;
}

export class McuCosim implements McuPinBus {
  readonly id: string;
  readonly mcu: Mcu;
  readonly at?: string;
  private readonly ratingOpts: RatingOptions;
  private rt?: McuRuntime;
  /** reset: not started / browned out; running: firmware alive. */
  state: 'reset' | 'running' = 'reset';
  private everRan = false;
  private x: Float64Array = new Float64Array(0);
  private vs = 0;
  private readonly cells = new Map<string, CellState>();
  private dirty = false;
  private diags: Diagnostic[] = [];
  private seen = new Set<string>();
  private items = new Map<string, RatedItem>();
  private supplyReported = { abs: false, range: false };
  /** Last run's results. */
  serial?: SerialEntry[];
  ratings: RatingResult[] = [];

  constructor(id: string, mcu: Mcu, at: string | undefined, ratingOpts: RatingOptions) {
    this.id = id;
    this.mcu = mcu;
    this.at = at;
    this.ratingOpts = ratingOpts;
    for (const cell of mcu._cells.values()) {
      this.cells.set(cell.name, { cell, level: 0, subs: new Set(), trace: { net: `${id}.${cell.name}`, t: [0], v: [0] } });
    }
  }

  // ── lifecycle ──

  /** A new analysis system: the MCU is in reset (all pins high-Z). */
  attach(): void {
    this.rt = undefined;
    this.state = 'reset';
    this.everRan = false;
    this.diags = [];
    this.seen.clear();
    this.items.clear();
    this.peakDir.clear();
    this.supplyReported = { abs: false, range: false };
    this.serial = undefined;
    this.ratings = [];
    this.mcu._powered = false;
    for (const s of this.cells.values()) {
      s.cell.dir = 'input';
      s.cell.avg = undefined;
      s.cell.stage.setStatic('Z');
      s.cell.stage.powered = true;
      s.subs.clear();
      s.level = 0;
      s.trace = { net: s.trace.net, t: [0], v: [0] };
    }
  }

  beginTransient(x: Float64Array): void {
    this.x = x;
    this.vs = this.supply(x);
    this.updateDrive();
    for (const s of this.cells.values()) {
      const { vil, vih } = thresholdsAt(this.mcu.profile, this.vs);
      s.level = this.pinV(x, s.cell) > (vil + vih) / 2 ? 1 : 0;
      s.trace = { net: s.trace.net, t: [0], v: [s.level] };
    }
    const e = this.mcu.electrical;
    if (this.vs < e.resetBelow) {
      this.report({
        code: 'M622',
        message: `${this.id} (${this.mcu.profile.part}) is held in reset: VCC−GND = ${fmtV(this.vs)} at t = 0, below the ${fmtV(e.resetBelow)} reset threshold — the firmware never runs and every pin stays high-Z`,
        note: `${e.resetSource}. The MCU starts only if it is powered at t = 0 (a delayed power-up is not modelled)`,
        evidence: { supply: this.vs, resetBelow: e.resetBelow, time: 0 },
        fixes: [
          { kind: 'start-from-op', confidence: 'suggested', detail: `if ${this.id}.${this.mcu.vccName} is fed through a regulator, a resistor or an RC, it is still at 0 V at t = 0 of a transient that starts from the zero state: start from the operating point with tb.expect.tran({ …, ic: 'op' })` },
          { kind: 'rewire', confidence: 'suggested', detail: `power ${this.id}.${this.mcu.vccName} from a stiff ${fmtV(this.mcu.profile.vcc)} source and ${this.id}.GND from tb.gnd` },
        ],
        time: 0,
      });
      return;
    }
    this.checkSupply(0);
    let firmware = this.mcu.inline;
    if (!firmware) {
      const c = this.mcu.compiled;
      if (!c || !c.ok) return; // M608 was reported by the lint
      const r = instantiateFirmware(c.value, this.mcu.profile);
      if (!r.ok) {
        this.pushMcu(r.diagnostic, 'tran');
        return;
      }
      firmware = r.value;
    }
    this.rt = new McuRuntime({
      id: this.id,
      profile: this.mcu.profile,
      firmware,
      bus: this,
      pwm: this.mcu.pwmMode === 'average' ? 'descriptor' : 'edges',
      ...(this.mcu.randomSeed !== undefined ? { randomSeed: this.mcu.randomSeed } : {}),
    });
    this.state = 'running';
    this.everRan = true;
    this.mcu._powered = true;
  }

  /** Firmware work due at t (an event at or before t, at the runtime's 1 ns resolution). */
  due(t: number): boolean {
    return this.state === 'running' && !!this.rt && toNs(this.rt.nextWakeTime()) <= toNs(t);
  }

  /** Run the firmware up to t; true when it changed any pin (a discontinuity at t). */
  async work(t: number): Promise<boolean> {
    this.dirty = false;
    await this.rt!.runUntil(t);
    return this.dirty;
  }

  nextBreakpoint(t: number): number {
    let bp = Infinity;
    if (this.state === 'running' && this.rt) {
      // Wake times are integer nanoseconds: one in the same nanosecond as t is due now (work(t)),
      // not a breakpoint an ulp later.
      const w = this.rt.nextWakeTime();
      if (toNs(w) > toNs(t)) bp = w;
    }
    for (const s of this.cells.values()) {
      const c = s.cell.stage.nextCorner(t);
      if (c < bp) bp = c;
    }
    return bp;
  }

  // ── inputs ──

  private pinV(x: ArrayLike<number>, c: McuCell): number {
    return vOf(x, c.pin) - vOf(x, this.mcu.gndPin());
  }

  private supply(x: ArrayLike<number>): number {
    return vOf(x, this.mcu.vccPin()) - vOf(x, this.mcu.gndPin());
  }

  /** Signed distance to the switching threshold given the current level (> 0: the level flips). */
  private trigger(s: CellState, x: ArrayLike<number>): number {
    const { vil, vih } = thresholdsAt(this.mcu.profile, this.supply(x));
    const v = this.pinV(x, s.cell);
    return s.level === 0 ? v - vih : vil - v;
  }

  private crossing(s: CellState, t0: number, x0: ArrayLike<number>, t1: number, x1: ArrayLike<number>): number | undefined {
    const f1 = this.trigger(s, x1);
    if (!(f1 > 0)) return undefined;
    const f0 = this.trigger(s, x0);
    const t = f0 >= 0 ? t0 : t0 + ((t1 - t0) * -f0) / (f1 - f0);
    return Math.min(Math.max(t, t0), t1);
  }

  /** Earliest crossing of an interrupt-subscribed pin inside (t0, t1]. */
  earliestCrossing(t0: number, x0: ArrayLike<number>, t1: number, x1: ArrayLike<number>): number | undefined {
    if (this.state !== 'running') return undefined;
    let best: number | undefined;
    for (const s of this.cells.values()) {
      if (s.subs.size === 0) continue;
      const tc = this.crossing(s, t0, x0, t1, x1);
      if (tc !== undefined && (best === undefined || tc < best)) best = tc;
    }
    return best;
  }

  /** The step t0 → t1 was accepted. True on a discontinuity (brown-out). */
  accepted(t0: number, x0: Float64Array, t1: number, x1: Float64Array): boolean {
    this.trackCurrents(t1, x1);
    const crossings: { s: CellState; t: number }[] = [];
    for (const s of this.cells.values()) {
      const tc = this.crossing(s, t0, x0, t1, x1);
      if (tc !== undefined) crossings.push({ s, t: tc });
    }
    crossings.sort((a, b) => a.t - b.t || (a.s.cell.name < b.s.cell.name ? -1 : 1));
    for (const { s, t } of crossings) {
      s.level = s.level === 0 ? 1 : 0;
      if (s.cell.dir !== 'output' || this.state !== 'running') this.rec(s, t, s.level);
      if (this.state === 'running' && this.rt) {
        const te = Math.max(t, this.rt.now);
        for (const cb of [...s.subs]) cb(s.level, te);
      }
    }
    this.x = x1;
    this.vs = this.supply(x1);
    this.updateDrive();
    if (this.state !== 'running') return false;
    const e = this.mcu.electrical;
    if (this.vs < e.resetBelow) {
      this.enterReset(t1);
      this.report({
        code: 'M622',
        message: `${this.id} (${this.mcu.profile.part}) browned out at t=${formatTime(t1)}: VCC−GND fell to ${fmtV(this.vs)}, below the ${fmtV(e.resetBelow)} reset threshold — firmware stopped, every pin high-Z from then on`,
        note: `${e.resetSource}. After a brown-out the MCU stays in reset for the rest of the run (restart is not modelled)`,
        evidence: { supply: this.vs, resetBelow: e.resetBelow, time: t1 },
        fixes: [{ kind: 'rewire', confidence: 'suggested', detail: `feed ${this.id}.${this.mcu.vccName} from a stiff source (no series resistance), or reduce the load on its pins` }],
        time: t1,
      });
      return true;
    }
    this.checkSupply(t1);
    return false;
  }

  private enterReset(t: number): void {
    this.state = 'reset';
    this.mcu._powered = false;
    for (const s of this.cells.values()) {
      s.cell.dir = 'input';
      s.cell.avg = undefined;
      s.cell.stage.drive('Z', t);
      this.rec(s, t, s.level);
    }
  }

  private updateDrive(): void {
    const { rHigh, rLow } = driveAt(this.mcu.electrical, this.vs > 0 ? this.vs : this.mcu.profile.vcc);
    for (const s of this.cells.values()) {
      s.cell.stage.rHigh = rHigh;
      s.cell.stage.rLow = rLow;
    }
  }

  private checkSupply(t: number): void {
    const e = this.mcu.electrical;
    const vs = this.vs;
    if (vs > e.vccAbsMax && !this.supplyReported.abs) {
      this.supplyReported.abs = true;
      this.report({
        code: 'M623',
        message: `${this.id} (${this.mcu.profile.part}) supply ${fmtV(vs)} at t=${formatTime(t)} is above its absolute maximum ${fmtV(e.vccAbsMax)} — the part would be damaged`,
        note: `datasheet: absolute maximum VCC ${fmtV(e.vccAbsMax)}, recommended ${fmtV(e.vccRecommended[0])}–${fmtV(e.vccRecommended[1])} for the modelled clock`,
        evidence: { supply: vs, absoluteMax: e.vccAbsMax, recommended: e.vccRecommended, time: t },
        fixes: [{ kind: 'change-value', confidence: 'suggested', detail: `power ${this.id} from ${fmtV(e.vccRecommended[0])}–${fmtV(e.vccRecommended[1])}` }],
        time: t,
      });
      return;
    }
    if ((vs < e.vccRecommended[0] - 1e-9 || vs > e.vccRecommended[1] + 1e-9) && vs <= e.vccAbsMax && !this.supplyReported.range) {
      this.supplyReported.range = true;
      this.report({
        code: 'M623',
        severity: 'warning',
        message: `${this.id} (${this.mcu.profile.part}) supply ${fmtV(vs)} at t=${formatTime(t)} is outside the recommended ${fmtV(e.vccRecommended[0])}–${fmtV(e.vccRecommended[1])} for ${formatEng(this.mcu.profile.cpuHz, 'Hz')}; the firmware keeps running in the model, a real part may not`,
        note: `datasheet speed grade / operating range (${e.sources[0]}); output drive and thresholds are extrapolated`,
        evidence: { supply: vs, recommended: e.vccRecommended, time: t },
        fixes: [{ kind: 'change-value', confidence: 'suggested', detail: `power ${this.id} from ${fmtV(e.vccRecommended[0])}–${fmtV(e.vccRecommended[1])}` }],
        time: t,
      });
    }
  }

  // ── McuPinBus ──

  setDirection(pin: string, dir: PinDirection, t: number): void {
    const s = this.cells.get(pin);
    if (!s) return;
    s.cell.dir = dir;
    if (dir !== 'output') {
      s.cell.avg = undefined;
      s.cell.stage.drive('Z', t);
      this.rec(s, t, s.level);
    }
    this.dirty = true;
  }

  drive(pin: string, level: Level, t: number): void {
    const s = this.cells.get(pin);
    if (!s) return;
    s.cell.avg = undefined;
    s.cell.stage.drive(level, t);
    this.rec(s, t, level);
    this.dirty = true;
  }

  setPwm(pin: string, pwm: PwmDescriptor | null, t: number): void {
    const s = this.cells.get(pin);
    if (!s) return;
    s.cell.avg = pwm ? pwm.duty : undefined;
    if (pwm) s.cell.stage.setStatic('Z');
    void t;
    this.dirty = true;
  }

  readDigital(pin: string): Level {
    return this.cells.get(pin)?.level ?? 0;
  }

  readVoltage(pin: string): number {
    const s = this.cells.get(pin);
    return s ? this.pinV(this.x, s.cell) : 0;
  }

  readSupply(): number {
    return this.supply(this.x);
  }

  onEdge(pin: string, cb: (level: Level, t: number) => void): () => void {
    const s = this.cells.get(pin);
    if (!s) return () => undefined;
    s.subs.add(cb);
    return () => {
      s.subs.delete(cb);
    };
  }

  // ── traces ──

  private rec(s: CellState, t: number, v: Logic): void {
    const tr = s.trace;
    const n = tr.t.length;
    if (tr.v[n - 1] === v) return;
    if (tr.t[n - 1] === t) {
      tr.v[n - 1] = v;
      if (n >= 2 && tr.v[n - 2] === v) {
        tr.t.pop();
        tr.v.pop();
      }
      return;
    }
    tr.t.push(t);
    tr.v.push(v);
  }

  /** Logic trace of a pin: the driven level while OUTPUT, the input-buffer level otherwise. */
  trace(pin: string): NetTrace | undefined {
    return this.cells.get(pin)?.trace;
  }

  pinNames(): string[] {
    return [...this.cells.keys()];
  }

  // ── currents and ratings (R410–R413) ──

  /** Current out of a pin into its net (A; > 0 sourcing) and the part drawn from VCC / returned to GND. */
  private pinCurrents(s: CellState, t: number, x: ArrayLike<number>): { out: number; fromVcc: number; toGnd: number } {
    const c = s.cell;
    const vp = vOf(x, c.pin);
    const vv = vOf(x, this.mcu.vccPin());
    const vg = vOf(x, this.mcu.gndPin());
    let up = 0; // VCC → pin, inside the MCU
    let dn = 0; // pin → GND, inside the MCU
    if (this.mcu._powered) {
      if (c.avg !== undefined) {
        const g = 1 / (c.avg * c.stage.rHigh + (1 - c.avg) * c.stage.rLow);
        up += c.avg * g * (vv - vp);
        dn += (1 - c.avg) * g * (vp - vg);
      } else {
        const e = c.stage.eNow(t);
        const sv = c.stage.sNow(t);
        if (e > 0) {
          up += ((e * sv) / c.stage.rHigh) * (vv - vp);
          dn += ((e * (1 - sv)) / c.stage.rLow) * (vp - vg);
        }
      }
      if (c.dir === 'input_pullup') up += (vv - vp) / this.mcu.electrical.pullup;
      else if (c.dir === 'input_pulldown' && this.mcu.electrical.pulldown) dn += (vp - vg) / this.mcu.electrical.pulldown;
    }
    const clampUp = clampCurrent(vp - vv); // pin → VCC through the upper ESD diode
    const clampDn = clampCurrent(vg - vp); // GND → pin through the lower ESD diode
    dn += PIN_LEAK * (vp - vg);
    const out = up - dn - clampUp + clampDn;
    return { out, fromVcc: up - clampUp, toGnd: dn - clampDn };
  }

  private track(key: string, make: () => Omit<RatedItem, 'peak' | 'key'>, value: number, t: number): void {
    let it = this.items.get(key);
    if (!it) {
      it = { key, ...make(), peak: { value: 0, time: 0 } };
      this.items.set(key, it);
    }
    if (value > it.peak.value) {
      it.peak.value = value;
      it.peak.time = t;
    }
    if (it.peak.tFirst === undefined && value > it.limit * this.ratingOpts.derate) it.peak.tFirst = t;
  }

  private ratingsEnabled(): boolean {
    return this.ratingOpts.enabled && !this.ratingOpts.ignore.includes(this.id);
  }

  private trackCurrents(t: number, x: ArrayLike<number>): void {
    if (!this.ratingsEnabled()) return;
    const L = this.mcu.profile.limits;
    const id = this.id;
    const byPin = new Map<string, number>();
    let fromVcc = 0;
    let toGnd = 0;
    let sink = 0;
    let source = 0;
    for (const s of this.cells.values()) {
      const c = this.pinCurrents(s, t, x);
      byPin.set(s.cell.name, c.out);
      fromVcc += c.fromVcc;
      toGnd += c.toGnd;
      if (c.out > 0) source += c.out;
      else sink -= c.out;
      if (L.pinAbsMaxMa !== undefined) {
        const mag = Math.abs(c.out);
        const dir = c.out >= 0 ? 'source' : 'sink';
        this.track(
          `pin:${s.cell.name}`,
          () => ({ code: 'R410', rating: 'IIO(max)', description: `I/O pin current (source or sink) of ${s.cell.name}`, quantity: `${id}.${s.cell.name}.i`, limit: L.pinAbsMaxMa! / 1000 }),
          mag,
          t,
        );
        const dirs = this.peakDir.get(s.cell.name);
        if (!dirs || mag > dirs.value) this.peakDir.set(s.cell.name, { value: mag, dir });
      }
    }
    (L.portGroups ?? []).forEach((g, i) => {
      const label = groupLabel(g.pins);
      if (g.sinkMaxMa !== undefined) {
        const v = g.pins.reduce((a, p) => a + Math.max(0, -(byPin.get(p) ?? 0)), 0);
        this.track(`group:${i}:sink`, () => ({ code: 'R412', rating: 'ΣIOL', description: `sum of sink currents of port group ${label}${g.note ? ` (${g.note})` : ''}`, quantity: `${id}.ΣIOL(${label})`, limit: g.sinkMaxMa! / 1000 }), v, t);
      }
      if (g.sourceMaxMa !== undefined) {
        const v = g.pins.reduce((a, p) => a + Math.max(0, byPin.get(p) ?? 0), 0);
        this.track(`group:${i}:source`, () => ({ code: 'R412', rating: 'ΣIOH', description: `sum of source currents of port group ${label}${g.note ? ` (${g.note})` : ''}`, quantity: `${id}.ΣIOH(${label})`, limit: g.sourceMaxMa! / 1000 }), v, t);
      }
    });
    if (L.vccGndMaxMa !== undefined) {
      const v = Math.max(Math.abs(fromVcc), Math.abs(toGnd));
      this.track('supply', () => ({ code: 'R413', rating: 'IVCC/IGND', description: 'current through the VCC / GND pins (I/O load currents; the core supply current is not modelled)', quantity: `${id}.${this.mcu.vccName}.i`, limit: L.vccGndMaxMa! / 1000 }), v, t);
    }
    if (L.totalSinkMaxMa !== undefined) this.track('total:sink', () => ({ code: 'R413', rating: 'ΣIOL', description: 'sum of the sink currents of all pins', quantity: `${id}.ΣIOL`, limit: L.totalSinkMaxMa! / 1000 }), sink, t);
    if (L.totalSourceMaxMa !== undefined) this.track('total:source', () => ({ code: 'R413', rating: 'ΣIOH', description: 'sum of the source currents of all pins', quantity: `${id}.ΣIOH`, limit: L.totalSourceMaxMa! / 1000 }), source, t);
  }

  /** Direction (source / sink) at each pin's peak current. */
  private peakDir = new Map<string, { value: number; dir: string }>();

  /** RatingResults of the run (config label) from the tracked peaks. */
  private buildRatings(config: string): RatingResult[] {
    const out: RatingResult[] = [];
    const derate = this.ratingOpts.derate;
    const p = this.mcu.profile;
    const slugs: Record<string, string> = { R410: 'mcu-pin-current-exceeded', R412: 'mcu-port-current-exceeded', R413: 'mcu-supply-current-exceeded' };
    const items = [...this.items.values()].sort((a, b) => (a.code !== b.code ? (a.code < b.code ? -1 : 1) : a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    for (const it of items) {
      const allowed = it.limit * derate;
      const value = it.peak.value;
      const fail = value > allowed;
      if (!fail && value < RATING_FLOOR) continue;
      const r: RatingResult = {
        code: it.code,
        slug: slugs[it.code],
        verdict: fail ? 'fail' : 'pass',
        component: this.id,
        part: p.part,
        rating: it.rating,
        description: it.description,
        quantity: it.quantity,
        measure: 'peak',
        limit: it.limit,
        ...(derate !== 1 ? { derate } : {}),
        allowed,
        unit: 'A',
        value: Number(value.toPrecision(8)),
        utilization: Number((value / allowed).toPrecision(4)),
        margin: Number((allowed - value).toPrecision(6)),
        time: it.peak.time,
        ...(fail && it.peak.tFirst !== undefined ? { tFirstViolation: it.peak.tFirst } : {}),
        config,
        source: `${p.part} datasheet absolute maximum ratings`,
        url: p.sources[0],
        confidence: 'verified',
      };
      if (fail) {
        r.message = `${this.id} (${p.part}) ${it.description} peaks at ${formatEng(value, 'A')} (t=${formatTime(it.peak.time)}) — exceeds the absolute maximum ${formatEng(it.limit, 'A')}${derate !== 1 ? ` derated ×${derate}` : ''} (${(value / allowed).toFixed(2)}×)`;
        r.note = `simulated in the transient with the MCU pin model (Rout from the datasheet VOH/VOL rows); ${(p.limits.notes ?? [])[0] ?? 'absolute maximum ratings must never be exceeded'}`;
        r.fixes = [
          {
            kind: 'add-component',
            confidence: 'suggested',
            detail:
              it.code === 'R410'
                ? `add a series resistor on ${it.quantity.replace(/\.i$/, '')} (an LED from a ${fmtV(p.vcc)} pin needs ≥ ${formatEng(Math.ceil((p.vcc - 2) / ((p.limits.pinRecommendedMa ?? 20) / 1000)), 'Ω')} for ${p.limits.pinRecommendedMa ?? 20} mA), or switch the load with a transistor`
                : 'spread the loads over other pins / port groups, or switch the heavy loads with transistors',
          },
        ];
        if (this.at) r.at = this.at;
      }
      out.push(r);
    }
    return out;
  }

  // ── results ──

  finish(config: string, tEnd: number): void {
    void tEnd;
    if (this.rt) {
      for (const d of this.rt.diagnostics()) this.pushMcu(d, d.stage === 'lint' ? 'lint' : 'tran');
      this.serial = this.rt.serialLog();
    }
    const p = this.mcu.profile;
    const rec = p.limits.pinRecommendedMa !== undefined ? p.limits.pinRecommendedMa / 1000 : undefined;
    const abs = p.limits.pinAbsMaxMa !== undefined ? (p.limits.pinAbsMaxMa / 1000) * this.ratingOpts.derate : Infinity;
    const over = rec === undefined || !this.ratingsEnabled()
      ? []
      : [...this.items.values()]
          .filter(it => it.code === 'R410' && it.peak.value > rec && it.peak.value <= abs)
          .map(it => ({ pin: it.key.slice(4), value: it.peak.value, t: it.peak.time, dir: this.peakDir.get(it.key.slice(4))?.dir ?? 'source' }))
          .sort((a, b) => (a.pin < b.pin ? -1 : 1));
    for (const w of over) {
      this.report({
        code: 'R411',
        message: `${this.id}.${w.pin} ${w.dir}s up to ${formatEng(w.value, 'A')} (t=${formatTime(w.t)}), above the ${p.limits.pinRecommendedMa} mA the datasheet specifies output levels at — VOH/VOL are not guaranteed and the part runs hot`,
        note: `${p.part}: ${(p.limits.notes ?? []).join('; ') || 'the recommended pin current is the VOH/VOL test condition'}`,
        evidence: { current: w.value, recommended: (p.limits.pinRecommendedMa ?? 0) / 1000, ...(p.limits.pinAbsMaxMa !== undefined ? { absoluteMax: p.limits.pinAbsMaxMa / 1000 } : {}), time: w.t },
        fixes: [{ kind: 'change-value', confidence: 'suggested', detail: `increase the series resistance on ${this.id}.${w.pin} or drive the load through a transistor` }],
        severity: 'warning',
        time: w.t,
        pins: [w.pin],
        noMcuCode: true,
      });
    }
    this.ratings = this.ratingsEnabled() ? this.buildRatings(config) : [];
  }

  /** Serial capture of the last run (undefined when the firmware printed nothing). */
  serialCapture(config: string): McuSerialCapture | undefined {
    const log = this.serial;
    if (!log || log.length === 0) return undefined;
    const all = serialLines(log);
    const complete = all.filter(l => l.complete);
    const tail = all.find(l => !l.complete);
    const lines = complete.slice(0, SERIAL_CAPTURE_LIMIT).map(l => [l.t, l.text] as [number, string]);
    return {
      config,
      mcu: this.id,
      lines,
      ...(tail ? { partial: [tail.t, tail.text] as [number, string] } : {}),
      ...(complete.length > SERIAL_CAPTURE_LIMIT ? { truncated: true } : {}),
    };
  }

  diagnostics(): Diagnostic[] {
    return this.diags;
  }

  // ── diagnostics plumbing ──

  private pushMcu(d: McuDiagnostic, stage: 'lint' | 'tran'): void {
    const dd = mcuToDiagnostic(this.id, d, stage, this.at);
    const key = JSON.stringify([dd.code, dd.message, dd.at]);
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.diags.push(dd);
  }

  private report(f: DiagFields & { code: string; pins?: string[]; noMcuCode?: boolean }): void {
    const { code, pins, noMcuCode, ...fields } = f;
    if (noMcuCode) {
      const d: Diagnostic & { time?: number } = {
        code,
        slug: code === 'R411' ? 'mcu-pin-current-above-recommended' : code.toLowerCase(),
        severity: fields.severity ?? 'warning',
        stage: 'tran',
        message: fields.message,
        subject: { components: [this.id], ...(pins ? { pins: pins.map(p => `${this.id}.${p}`) } : {}) },
        ...(fields.time !== undefined ? { time: fields.time } : {}),
        ...(fields.note ? { note: fields.note } : {}),
        ...(fields.evidence ? { evidence: fields.evidence } : {}),
        fixes: fields.fixes ?? [],
        ...(this.at ? { at: this.at } : {}),
      };
      this.diags.push(d);
      return;
    }
    this.pushMcu(mcuDiagnostic(code as McuCode, { ...fields, subject: { mcu: this.id, ...(pins ? { pins } : {}) }, ...(fields.at ? {} : this.at ? { at: this.at } : {}) }), 'tran');
  }
}

/** An McuDiagnostic as a platform Diagnostic (subject → component / pin refs, api → evidence). */
export function mcuToDiagnostic(id: string, d: McuDiagnostic, stage: 'lint' | 'tran', fallbackAt?: string): Diagnostic & { time?: number } {
  const pins = d.subject?.pins?.map(p => `${id}.${p}`);
  const evidence = { ...(d.evidence ?? {}), ...(d.subject?.api ? { api: d.subject.api } : {}) };
  const at = d.at ?? fallbackAt;
  return {
    code: d.code,
    slug: d.slug,
    severity: d.severity,
    stage,
    message: d.message.startsWith(`${id} `) ? d.message : `${id}: ${d.message}`,
    subject: { components: [id], ...(pins && pins.length > 0 ? { pins } : {}) },
    ...(d.time !== undefined && stage !== 'lint' ? { time: d.time } : {}),
    ...(d.note ? { note: d.note } : {}),
    ...(Object.keys(evidence).length > 0 ? { evidence } : {}),
    fixes: d.fixes,
    ...(at ? { at } : {}),
  };
}

function groupLabel(pins: string[]): string {
  return pins.length > 3 ? `${pins[0]}…${pins[pins.length - 1]}` : pins.join(',');
}

function fmtV(v: number): string {
  return `${Number(v.toPrecision(4))} V`;
}
