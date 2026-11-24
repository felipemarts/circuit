import { Component } from '../core/Component';
import type { Pin } from '../core/Pin';
import type { MNAMatrix, ComplexMNAMatrix } from '../solver/MNAMatrix';
import type { AcLoadContext, AcceptContext, InitContext, LoadContext, Phasor } from '../analysis/context';
import { ReactiveState } from '../analysis/integration';
import { parseValue } from '../core/units';
import { fdStep, limitGatedState, limitTanhArg, linearize, scaleRow, logistic, logit, ramp, softLimit, stampLinearized } from './numeric';

/**
 * Macro-model op-amp parameters. Plain JSON, SI units (numbers, or strings with
 * an engineering suffix: gbw: '1M'). Every field has a default (a generic
 * 1 MHz op-amp); `Part('LM358')` fills them from the datasheet data in src/parts.
 */
export type OpAmpParams = { [K in keyof OpAmpNumbers]?: number | string } & { part?: string };

interface OpAmpNumbers {
  /** Open-loop DC gain (V/V). Default 1e5 (100 dB). */
  aol?: number;
  /** Gain-bandwidth product (Hz): the dominant pole is at gbw/aol. Default 1e6. */
  gbw?: number;
  /** Slew rate (V/s). Default 1e6 (1 V/µs). */
  sr?: number;
  /** Second open-loop pole (Hz); 0 = none (single-pole model). Default 0. */
  fp2?: number;
  /** Input offset voltage (V), in series with inp. Default 0. */
  vos?: number;
  /** Input bias current (A); positive flows INTO the inputs (NPN), negative out (PNP). Default 0. */
  ib?: number;
  /** Input offset current (A): Ib(inp) = ib + ios/2, Ib(inn) = ib − ios/2. Default 0. */
  ios?: number;
  /** Upper output limit relative to V+ (V, ≤ 0), at zero load current. Default −0.1. */
  swingHigh?: number;
  /** Lower output limit relative to V− (V, ≥ 0), at zero load current. Default 0.1. */
  swingLow?: number;
  /** Output resistance (Ω) — makes the swing load-dependent. Default 50. */
  rout?: number;
  /** Output short-circuit current, sourcing (A). Default 0.025. */
  iscSource?: number;
  /** Output short-circuit current, sinking (A). Default 0.025. */
  iscSink?: number;
  /** Quiescent supply current drawn from V+ into V− (A). Default 1e-3. */
  iq?: number;
}

type Resolved = Required<OpAmpNumbers>;

export const OPAMP_DEFAULTS: Resolved = {
  aol: 1e5,
  gbw: 1e6,
  sr: 1e6,
  fp2: 0,
  vos: 0,
  ib: 0,
  ios: 0,
  swingHigh: -0.1,
  swingLow: 0.1,
  rout: 50,
  iscSource: 0.025,
  iscSink: 0.025,
  iq: 1e-3,
};

/** Gate width (V): how close to the clamp the gain node starts losing drive. */
const DELTA = 0.005;
/** The restoring clamp acts only beyond clamp + RESTORE_OFFSET. */
const RESTORE_OFFSET = 3 * DELTA;
/** Smallest output window kept when the supply collapses (V). */
const MIN_WINDOW = 20 * DELTA;
/** Newton evaluates the gain node at most this far outside the output window (V). */
const BAND = 0.5;
/** Width (A) of the smooth split of the output current between the rails. */
const SPLIT_CURRENT = 1e-6;

/** Operating-point snapshot (for ratings and reports). */
export interface AmpOperatingPoint {
  vinp: number;
  vinn: number;
  vout: number;
  vpos: number;
  vneg: number;
  /** Current out of the output pin (positive = sourcing). */
  iout: number;
}

export function validatePositive(type: string, name: string, v: number, allowZero = false): void {
  if (!Number.isFinite(v) || (allowZero ? v < 0 : v <= 0)) {
    throw new Error(`${type} ${name} must be a finite number ${allowZero ? '≥' : '>'} 0, got ${v}`);
  }
}

export function validateFinite(type: string, name: string, v: number): void {
  if (!Number.isFinite(v)) throw new Error(`${type} ${name} must be a finite number, got ${v}`);
}

/**
 * Macro-model op-amp: pins 'inp' (non-inverting), 'inn' (inverting), 'out',
 * and the REQUIRED supply pins 'v+' and 'v-'.
 *
 * Gain node y (an internal unknown), with τ1 = aol/(2π·gbw):
 *   τ1·dy/dt = (1/ωp)·P(vd)·G(y) − (y − ymid) − aol·[ramp(y − yhi − 3δ) − ramp(ylo − 3δ − y)]
 *   P = sr·tanh(2π·gbw·vd/sr),  vd = V(inp) − V(inn) + vos
 * Small signal: y/vd = aol/(1 + s·τ1) → GBW = gbw; |dy/dt| ≤ sr (slew limit).
 * The gate G ∈ (0, 1) removes the drive as y reaches the output window
 * [ylo, yhi] = [V− + swingLow, V+ + swingHigh] (anti-windup, no stiff clamp);
 * the ramp term pulls y back if the rails move under it. Optional second pole:
 * τ2·dy2/dt = y − y2. Output stage: a Norton source
 *   Iout = softLimit((y2 − V(out))/rout, iscSource, iscSink)
 * whose current is drawn from V+ (sourcing) or returned to V− (sinking), plus
 * the quiescent current iq·tanh((V+ − V−)/0.5 V) from V+ to V−.
 */
export class OpAmp extends Component {
  readonly kind: string = 'OpAmp';
  readonly params: Resolved;
  readonly partId: string | undefined;
  /** @internal branch index of the gain node (and of y2 = index + 1 when fp2 > 0) */
  _vsIndex = -1;
  private readonly _qy: ReactiveState;
  private readonly _qy2: ReactiveState | null;
  private _rowY = -1;
  private _rowY2 = -1;
  private _argOld = 0;
  private _outArgOld = 0;
  private _yOld = 0;
  private _voltage = 0;
  private _current = 0;
  /** @internal small-signal Jacobian at the operating point */
  private _ac: { J: number[][]; cols: number[]; rows: number[] } | null = null;
  /** @internal last published operating point */
  _op: AmpOperatingPoint | null = null;

  constructor(params: OpAmpParams = {}) {
    super();
    const p: Resolved = { ...OPAMP_DEFAULTS };
    for (const key of Object.keys(OPAMP_DEFAULTS) as (keyof Resolved)[]) {
      const v = params[key];
      if (v !== undefined) p[key] = parseValue(v, `OpAmp ${key}`);
    }
    for (const k of ['aol', 'gbw', 'sr', 'rout', 'iscSource', 'iscSink'] as const) validatePositive('OpAmp', k, p[k]);
    for (const k of ['fp2', 'iq'] as const) validatePositive('OpAmp', k, p[k], true);
    for (const k of ['vos', 'ib', 'ios', 'swingHigh', 'swingLow'] as const) validateFinite('OpAmp', k, p[k]);
    if (p.swingHigh > 0) throw new Error(`OpAmp swingHigh is relative to V+ and must be ≤ 0, got ${p.swingHigh}`);
    if (p.swingLow < 0) throw new Error(`OpAmp swingLow is relative to V- and must be ≥ 0, got ${p.swingLow}`);
    if (params.part !== undefined && typeof params.part !== 'string') throw new Error(`OpAmp part must be a string`);
    this.params = p;
    this.partId = params.part;
    for (const name of ['inp', 'inn', 'out', 'v+', 'v-']) this.addPin(name);
    const tau1 = this.tau1;
    this._qy = new ReactiveState(this, 1e-6 * tau1, 1e-6 * tau1);
    this._qy.evaluate = x => tau1 * x[this._rowY];
    if (p.fp2 > 0) {
      const tau2 = 1 / (2 * Math.PI * p.fp2);
      this._qy2 = new ReactiveState(this, 1e-6 * tau2, 1e-6 * tau2);
      this._qy2.evaluate = x => tau2 * x[this._rowY2];
    } else {
      this._qy2 = null;
    }
  }

  /** Dominant-pole time constant τ1 = aol / (2π·gbw) (s). */
  get tau1(): number {
    return this.params.aol / (2 * Math.PI * this.params.gbw);
  }

  get tau2(): number {
    return this.params.fp2 > 0 ? 1 / (2 * Math.PI * this.params.fp2) : 0;
  }

  /** Output voltage (to ground) at the last published point — probe '<id>.v'. */
  get voltage(): number {
    return this._voltage;
  }

  /** Current out of the output pin (positive = sourcing) — probe '<id>.i'. */
  get current(): number {
    return this._current;
  }

  _setResults(voltage: number, current: number): void {
    this._voltage = voltage;
    this._current = current;
  }

  /** Plain-JSON parameters (the circuit document's params). */
  describeParams(): Record<string, number | string> {
    return { ...this.params, ...(this.partId !== undefined ? { part: this.partId } : {}) };
  }

  isNonlinear(): boolean {
    return true;
  }

  getVSourceCount(): number {
    return this.params.fp2 > 0 ? 2 : 1;
  }

  assignVSourceIndices(startIndex: number): void {
    this._vsIndex = startIndex;
  }

  stamp(_matrix: MNAMatrix): void {
    throw new Error('OpAmp is stamped through load(ctx) only');
  }

  private nodeIdx(): number[] {
    return ['inp', 'inn', 'out', 'v+', 'v-'].map(n => (this.pin(n) as Pin).node.index);
  }

  /**
   * The static part of the device: inputs u = [vinp, vinn, vout, vp, vn, y, y2],
   * outputs = currents leaving the five pin nodes into the device, then the
   * gain-node residual (without the τ1·dy/dt term).
   */
  private evaluate(u: number[], sf: number): number[] {
    const p = this.params;
    const [vinp, vinn, vout, vp, vn, y, y2in] = u;
    const y2 = p.fp2 > 0 ? y2in : y;
    const omegaP = (2 * Math.PI * p.gbw) / p.aol;
    const kappa = (2 * Math.PI * p.gbw) / p.sr;
    const vd = vinp - vinn + p.vos * sf;
    const P = p.sr * Math.tanh(kappa * vd);

    // Output window and anti-windup gate.
    const { yhi, ylo, L } = this.frame(vp, vn);
    const ymid = (yhi + ylo) / 2;
    const hHi = logistic((yhi - y) / DELTA + L);
    const hLo = logistic((y - ylo) / DELTA + L);
    const sigma = 0.5 * (1 + Math.tanh(P / (1e-3 * p.sr)));
    const gate = sigma * hHi + (1 - sigma) * hLo;
    const restore = p.aol * (ramp(y - yhi - RESTORE_OFFSET, DELTA) - ramp(ylo - RESTORE_OFFSET - y, DELTA));
    const fy = y - ymid - (P * gate) / omegaP + restore;

    // Output stage (Norton) and supply currents.
    const x = (y2 - vout) / p.rout;
    const io = softLimit(x, p.iscSource, p.iscSink);
    const s = 0.5 * (1 + Math.tanh(io / SPLIT_CURRENT));
    const iq = p.iq * sf * Math.tanh((vp - vn) / 0.5);
    const ibp = (p.ib + p.ios / 2) * sf;
    const ibn = (p.ib - p.ios / 2) * sf;
    return [ibp, ibn, -io, io * s + iq, io * (1 - s) - iq - ibp - ibn, fy];
  }

  /**
   * Output window [ylo, yhi] and the gate offset L = logit(h*), h* = ωp·(window/2)/sr:
   * with full drive (P = sr) the gate equilibrium then sits exactly on the clamp.
   */
  private frame(vp: number, vn: number): { yhi: number; ylo: number; L: number } {
    const p = this.params;
    let yhi = vp + p.swingHigh;
    let ylo = vn + p.swingLow;
    if (yhi - ylo < MIN_WINDOW) {
      const mid = (yhi + ylo) / 2;
      yhi = mid + MIN_WINDOW / 2;
      ylo = mid - MIN_WINDOW / 2;
    }
    const omegaP = (2 * Math.PI * p.gbw) / p.aol;
    const hStar = Math.min(0.5, Math.max(1e-12, (omegaP * (yhi - ylo)) / 2 / p.sr));
    return { yhi, ylo, L: logit(hStar) };
  }

  private outputCurrent(y2: number, vout: number): number {
    const p = this.params;
    return softLimit((y2 - vout) / p.rout, p.iscSource, p.iscSink);
  }

  private locals(v: (i: number) => number, x: ArrayLike<number>): number[] {
    const idx = this.nodeIdx();
    const u = idx.map(i => v(i));
    u.push(x[this._rowY]);
    u.push(this.params.fp2 > 0 ? x[this._rowY2] : 0);
    return u;
  }

  private steps(u: number[]): number[] {
    return u.map(fdStep);
  }

  load(ctx: LoadContext): void {
    const m = ctx.matrix;
    this._rowY = m.vsIndex(this._vsIndex);
    this._rowY2 = this.params.fp2 > 0 ? m.vsIndex(this._vsIndex + 1) : -1;
    const idx = this.nodeIdx();
    const rows = [...idx.map(i => m.nodeRow(i)), this._rowY];
    const cols = [...idx.map(i => m.nodeRow(i)), this._rowY, this._rowY2];
    const u = this.locals(i => ctx.v(i), ctx.x);
    const p = this.params;

    // Newton limiting, in dependency order: input-stage tanh argument, gain
    // node (gates + band), then the output current-limit tanh argument.
    const kappa = (2 * Math.PI * p.gbw) / p.sr;
    const warm = ctx.init === 'none';
    let limited = false;
    const a = kappa * (u[0] - u[1] + p.vos * ctx.srcFactor);
    if (warm) {
      const lim = limitTanhArg(a, this._argOld);
      if (lim.limited) {
        u[0] += (lim.value - a) / kappa;
        limited = true;
      }
      this._argOld = lim.value;
    } else {
      this._argOld = a;
    }
    {
      const { yhi, ylo, L } = this.frame(u[3], u[4]);
      const lim = limitGatedState(u[5], this._yOld, { lo: ylo, hi: yhi, delta: DELTA, lLo: L, lHi: L, band: BAND }, warm);
      if (lim.limited) limited = true;
      u[5] = lim.value;
      this._yOld = u[5];
    }
    {
      const y2 = p.fp2 > 0 ? u[6] : u[5];
      const scale = p.rout * Math.min(p.iscSource, p.iscSink);
      const b = (y2 - u[2]) / scale;
      if (warm) {
        const limB = limitTanhArg(b, this._outArgOld);
        if (limB.limited) {
          u[2] -= (limB.value - b) * scale;
          limited = true;
        }
        this._outArgOld = limB.value;
      } else {
        this._outArgOld = b;
      }
    }
    if (limited) ctx.limited();

    const sf = ctx.srcFactor;
    const { f0, J } = linearize(w => this.evaluate(w, sf), u, this.steps(u));
    if (ctx.mode === 'tran' && ctx.initial) {
      // t = 0 of a transient: the internal states hold their initial values.
      for (let j = 0; j < J[5].length; j++) J[5][j] = 0;
      J[5][5] = 1;
      f0[5] = u[5] - this._qy.hx[0] / this.tau1;
    }
    if (ctx.mode === 'tran' && !ctx.initial) {
      // τ1·dy/dt, linearized: d0 + coeff·τ1·(y − y0).
      const tau1 = this.tau1;
      const { derivative, coeff } = ctx.integrate(this._qy, tau1 * u[5]);
      J[5][5] += coeff * tau1;
      f0[5] += derivative;
    }
    scaleRow(J, f0, 5);
    stampLinearized(ctx, rows, cols, f0, J, u);

    if (this._qy2) {
      // τ2·dy2/dt + y2 − y = 0
      const r = this._rowY2;
      if (ctx.mode === 'tran' && ctx.initial) {
        m.add(r, r, 1);
        m.addRHS(r, this._qy2.hx[0] / this.tau2);
      } else {
        m.add(r, r, 1);
        m.add(r, this._rowY, -1);
        if (ctx.mode === 'tran') {
          const tau2 = this.tau2;
          const { derivative, coeff } = ctx.integrate(this._qy2, tau2 * u[6]);
          m.add(r, r, coeff * tau2);
          m.addRHS(r, -(derivative - coeff * tau2 * u[6]));
        }
      }
    }
  }

  initTransient(ctx: InitContext): void {
    const x = ctx.x;
    const rowY = ctx.matrix.vsIndex(this._vsIndex);
    ctx.setState(this._qy, this.tau1 * x[rowY], 0);
    if (this._qy2) {
      const rowY2 = ctx.matrix.vsIndex(this._vsIndex + 1);
      ctx.setState(this._qy2, this.tau2 * x[rowY2], 0);
    }
  }

  acceptStep(_ctx: AcceptContext): void {}

  resetToDC(): void {
    this._qy.seed(0, 0);
    this._qy2?.seed(0, 0);
    this._argOld = 0;
    this._outArgOld = 0;
    this._yOld = 0;
  }

  setOperatingPoint(solution: ArrayLike<number>, matrix: MNAMatrix): void {
    const v = (i: number) => (i > 0 ? solution[i - 1] : 0);
    const rowY = matrix.vsIndex(this._vsIndex);
    const rowY2 = this.params.fp2 > 0 ? matrix.vsIndex(this._vsIndex + 1) : -1;
    this._rowY = rowY;
    this._rowY2 = rowY2;
    const idx = this.nodeIdx();
    const u = this.locals(v, solution);
    const { J } = linearize(w => this.evaluate(w, 1), u, this.steps(u));
    this._ac = {
      J,
      rows: [...idx.map(i => matrix.nodeRow(i)), rowY],
      cols: [...idx.map(i => matrix.nodeRow(i)), rowY, rowY2],
    };
    const y2 = this.params.fp2 > 0 ? u[6] : u[5];
    this._op = { vinp: u[0], vinn: u[1], vout: u[2], vpos: u[3], vneg: u[4], iout: this.outputCurrent(y2, u[2]) };
  }

  hasAcModel(): boolean {
    return true;
  }

  acLoad(ctx: AcLoadContext): void {
    const ac = this._ac;
    if (!ac) throw new Error('OpAmp: AC analysis needs an operating point first');
    const m = ctx.matrix;
    for (let i = 0; i < ac.rows.length; i++) {
      const r = ac.rows[i];
      if (r < 0) continue;
      for (let j = 0; j < ac.cols.length; j++) {
        const g = ac.J[i][j];
        if (g !== 0 && ac.cols[j] >= 0) m.add(r, ac.cols[j], g, 0);
      }
    }
    const rowY = ac.rows[5];
    m.add(rowY, rowY, 0, ctx.omega * this.tau1);
    if (this.params.fp2 > 0) {
      const r = ac.cols[6];
      m.add(r, r, 1, ctx.omega * this.tau2);
      m.add(r, rowY, -1, 0);
    }
  }

  acReadResults(re: ArrayLike<number>, im: ArrayLike<number>, _omega: number, _matrix: ComplexMNAMatrix): { voltage: Phasor; current: Phasor } {
    const ac = this._ac!;
    const vout: Phasor = ac.cols[2] >= 0 ? [re[ac.cols[2]], im[ac.cols[2]]] : [0, 0];
    // Output current = −(current leaving the out node into the device) = −Σ J[2][j]·u_j.
    let ir = 0;
    let ii = 0;
    for (let j = 0; j < ac.cols.length; j++) {
      const c = ac.cols[j];
      if (c < 0) continue;
      ir -= ac.J[2][j] * re[c];
      ii -= ac.J[2][j] * im[c];
    }
    return { voltage: vout, current: [ir, ii] };
  }

  readResults(solution: ArrayLike<number>, matrix: MNAMatrix): { voltage: number; current: number } {
    const out = this.pin('out').node.index;
    const vout = matrix.getNodeVoltage(solution, out);
    const rowY = matrix.vsIndex(this._vsIndex);
    const y2 = this.params.fp2 > 0 ? solution[rowY + 1] : solution[rowY];
    return { voltage: vout, current: this.outputCurrent(y2, vout) };
  }
}
