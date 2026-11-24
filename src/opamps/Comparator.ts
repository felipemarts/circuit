import { Component } from '../core/Component';
import type { Pin } from '../core/Pin';
import type { MNAMatrix, ComplexMNAMatrix } from '../solver/MNAMatrix';
import type { AcLoadContext, AcceptContext, InitContext, LoadContext, Phasor } from '../analysis/context';
import { ReactiveState } from '../analysis/integration';
import { parseValue } from '../core/units';
import { fdStep, limitGatedState, limitTanhArg, linearize, scaleRow, logistic, logit, ramp, stampLinearized } from './numeric';
import { validateFinite, validatePositive, type AmpOperatingPoint } from './OpAmp';

/**
 * Open-collector comparator parameters (plain JSON, SI). Defaults are a
 * generic LM393-class part; `Part('LM393')` / `Part('LM311')` fill them from data.
 */
export type ComparatorParams = { [K in keyof ComparatorNumbers]?: number | string } & {
  /** true: the output transistor's emitter is its own pin 'emit' (LM311); false: it is V− (LM393). */
  emitterPin?: boolean;
  /** Catalog id of the real part (Part('LM393')). */
  part?: string;
};

interface ComparatorNumbers {
  /** Large-signal voltage gain (V/V). Default 2e5. */
  avd?: number;
  /** Input offset voltage (V), in series with inp. Default 0. */
  vos?: number;
  /** Input bias current (A); positive flows INTO the inputs. Default 0. */
  ib?: number;
  /** Input offset current (A). Default 0. */
  ios?: number;
  /** Response time, output high → low (s), at `overdrive`. Default 1e-6. */
  tpdHL?: number;
  /** Response time, output low → high (s), at `overdrive`. Default 1e-6. */
  tpdLH?: number;
  /** Input overdrive the response times are specified at (V). Default 5e-3. */
  overdrive?: number;
  /**
   * Response time with a large (TTL-level) overdrive (s): with it the delay
   * shrinks as the overdrive grows. 0 = same delay for any overdrive ≥ `overdrive`. Default 0.
   */
  tpdFast?: number;
  /** Output low (saturation) voltage (V) at sink current `iol`. Default 0.2. */
  vol?: number;
  /** Sink current at which `vol` is specified (A). Default 4e-3. */
  iol?: number;
  /** Maximum output sink current (A), > iol. Default 16e-3. */
  isink?: number;
  /** Output-off leakage conductance (S). Default 2e-11. */
  gleak?: number;
  /** Quiescent supply current from V+ to V− (A). Default 0.5e-3. */
  iq?: number;
}

type Resolved = Required<ComparatorNumbers>;

export const COMPARATOR_DEFAULTS: Resolved = {
  avd: 2e5,
  vos: 0,
  ib: 0,
  ios: 0,
  tpdHL: 1e-6,
  tpdLH: 1e-6,
  overdrive: 5e-3,
  tpdFast: 0,
  vol: 0.2,
  iol: 4e-3,
  isink: 16e-3,
  gleak: 2e-11,
  iq: 0.5e-3,
};

/** Gate width of the switching state s (dimensionless). */
const DELTA = 0.002;
const RESTORE_OFFSET = 3 * DELTA;
/** Newton evaluates s at most this far outside [0, 1]. */
const BAND = 0.1;
/** Width of the output transistor's turn-on in s (s_eff = logistic((s − ½)/W_ON)). */
const W_ON = 0.025;
/** Output volts per unit of s at the transition, used to map avd onto the state gain. */
const SWING_PER_S = 45;

/**
 * Comparator with an open-collector output: pins 'inp', 'inn', 'out', 'v+',
 * 'v-' (and 'emit' with emitterPin). The output transistor SINKS current
 * (output low) when V(inp) < V(inn); otherwise it is off and an external
 * pull-up sets the output high. Hysteresis only comes from external resistors.
 *
 * Switching state s ∈ [0, 1] (internal unknown), τc = 1/ωc:
 *   τc·ds/dt = (1/ωc)·R(D)·D·G(s) − (s − ½) − Gr·[ramp(s − 1 − 3δ) − ramp(−3δ − s)]
 *   D = tanh(−κ·(vd + vos)): the drive saturates with the overdrive, so the
 *   delay is 0.5/(R·tanh(κ·overdrive)); R = 0.5/(tpd·tanh(κ·overdrive)) per edge.
 * Output: I_sink = logistic((s − ½)/0.025)·isink·tanh(Vce/Vk) + gleak·Vce,
 * Vce = V(out) − V(emitter), Vk chosen so that I_sink(vol) = iol.
 */
export class Comparator extends Component {
  readonly kind: string = 'Comparator';
  readonly params: Resolved;
  readonly emitterPin: boolean;
  readonly partId: string | undefined;
  /** @internal */
  _vsIndex = -1;
  private readonly _qs: ReactiveState;
  private _rowS = -1;
  private _argOld = 0;
  private _outArgOld = 0;
  private _voltage = 0;
  private _current = 0;
  private _ac: { J: number[][]; rows: number[]; cols: number[] } | null = null;
  /** @internal last published operating point */
  _op: AmpOperatingPoint | null = null;
  // Derived model constants.
  private readonly kappa: number;
  private readonly rUp: number;
  private readonly rDown: number;
  private readonly omegaC: number;
  private readonly vk: number;
  private readonly gr: number;
  /** Gate offsets: with full drive the s equilibrium sits exactly on 0 / 1. */
  private readonly lUp: number;
  private readonly lDn: number;
  private _sOld = 0;

  constructor(params: ComparatorParams = {}) {
    super();
    const p: Resolved = { ...COMPARATOR_DEFAULTS };
    for (const key of Object.keys(COMPARATOR_DEFAULTS) as (keyof Resolved)[]) {
      const v = params[key];
      if (v !== undefined) p[key] = parseValue(v, `Comparator ${key}`);
    }
    for (const k of ['avd', 'tpdHL', 'tpdLH', 'overdrive', 'vol', 'iol', 'isink'] as const) validatePositive('Comparator', k, p[k]);
    for (const k of ['tpdFast', 'gleak', 'iq'] as const) validatePositive('Comparator', k, p[k], true);
    for (const k of ['vos', 'ib', 'ios'] as const) validateFinite('Comparator', k, p[k]);
    if (!(p.iol < p.isink)) throw new Error(`Comparator iol (${p.iol}) must be < isink (${p.isink})`);
    if (p.tpdFast > 0 && !(p.tpdFast < Math.min(p.tpdHL, p.tpdLH))) {
      throw new Error(`Comparator tpdFast (${p.tpdFast}) must be shorter than tpdHL and tpdLH`);
    }
    if (params.emitterPin !== undefined && typeof params.emitterPin !== 'boolean') throw new Error('Comparator emitterPin must be a boolean');
    if (params.part !== undefined && typeof params.part !== 'string') throw new Error('Comparator part must be a string');
    this.params = p;
    this.emitterPin = params.emitterPin === true;
    this.partId = params.part;
    for (const name of ['inp', 'inn', 'out', 'v+', 'v-']) this.addPin(name);
    if (this.emitterPin) this.addPin('emit');

    const tpdAvg = (p.tpdHL + p.tpdLH) / 2;
    const ratio = p.tpdFast > 0 ? p.tpdFast / tpdAvg : Math.tanh(3);
    this.kappa = Math.atanh(ratio) / p.overdrive;
    this.rUp = 0.5 / (p.tpdHL * ratio);
    this.rDown = 0.5 / (p.tpdLH * ratio);
    const gs = p.avd / SWING_PER_S; // ds/dvd at the threshold
    this.omegaC = (((this.rUp + this.rDown) / 2) * this.kappa) / gs;
    this.vk = p.vol / Math.atanh(p.iol / p.isink);
    // Restoring clamp: pulls s back into [0, 1] with a time constant of ~tpd/20.
    this.gr = 20 / (this.omegaC * Math.min(p.tpdHL, p.tpdLH));
    this.lUp = logit(Math.min(0.5, (this.omegaC * 0.5) / this.rUp));
    this.lDn = logit(Math.min(0.5, (this.omegaC * 0.5) / this.rDown));
    const tau = this.tauC;
    this._qs = new ReactiveState(this, 1e-6 * tau, 1e-6 * tau);
    this._qs.evaluate = x => tau * x[this._rowS];
  }

  get tauC(): number {
    return 1 / this.omegaC;
  }

  get voltage(): number {
    return this._voltage;
  }

  /** Current out of the output pin (negative while sinking). */
  get current(): number {
    return this._current;
  }

  _setResults(voltage: number, current: number): void {
    this._voltage = voltage;
    this._current = current;
  }

  describeParams(): Record<string, number | string | boolean> {
    return {
      ...this.params,
      ...(this.emitterPin ? { emitterPin: true } : {}),
      ...(this.partId !== undefined ? { part: this.partId } : {}),
    };
  }

  isNonlinear(): boolean {
    return true;
  }

  getVSourceCount(): number {
    return 1;
  }

  assignVSourceIndices(startIndex: number): void {
    this._vsIndex = startIndex;
  }

  stamp(_matrix: MNAMatrix): void {
    throw new Error('Comparator is stamped through load(ctx) only');
  }

  private nodeIdx(): number[] {
    const names = ['inp', 'inn', 'out', 'v+', 'v-', this.emitterPin ? 'emit' : 'v-'];
    return names.map(n => (this.pin(n) as Pin).node.index);
  }

  /** u = [vinp, vinn, vout, vp, vn, vemit, s] → currents leaving the six pin nodes, then the s residual. */
  private evaluate(u: number[], sf: number): number[] {
    const p = this.params;
    const [vinp, vinn, vout, vp, vn, ve, s] = u;
    const vd = vinp - vinn + p.vos * sf;
    const D = Math.tanh(-this.kappa * vd);
    const rAvg = (this.rUp + this.rDown) / 2;
    const rDiff = (this.rUp - this.rDown) / 2;
    const P = D * (rAvg + rDiff * Math.tanh(D / 0.01));
    const hHi = logistic((1 - s) / DELTA + this.lUp);
    const hLo = logistic(s / DELTA + this.lDn);
    const sigma = 0.5 * (1 + Math.tanh(D / 1e-3));
    const gate = sigma * hHi + (1 - sigma) * hLo;
    const restore = this.gr * (ramp(s - 1 - RESTORE_OFFSET, DELTA) - ramp(-RESTORE_OFFSET - s, DELTA));
    const fs = s - 0.5 - (P * gate) / this.omegaC + restore;

    const vce = vout - ve;
    const on = logistic((s - 0.5) / W_ON);
    const isink = on * p.isink * Math.tanh(vce / this.vk) + p.gleak * vce;
    const iq = p.iq * sf * Math.tanh((vp - vn) / 0.5);
    const ibp = (p.ib + p.ios / 2) * sf;
    const ibn = (p.ib - p.ios / 2) * sf;
    // [inp, inn, out, v+, v-, emitter]; with emitter = v- the two rows coincide (contributions add).
    return [ibp, ibn, isink, iq, -iq - ibp - ibn, -isink, fs];
  }

  private sinkCurrent(s: number, vout: number, ve: number): number {
    const vce = vout - ve;
    return logistic((s - 0.5) / W_ON) * this.params.isink * Math.tanh(vce / this.vk) + this.params.gleak * vce;
  }

  private locals(v: (i: number) => number, x: ArrayLike<number>): number[] {
    const u = this.nodeIdx().map(i => v(i));
    u.push(x[this._rowS]);
    return u;
  }

  load(ctx: LoadContext): void {
    const m = ctx.matrix;
    this._rowS = m.vsIndex(this._vsIndex);
    const idx = this.nodeIdx();
    const rows = [...idx.map(i => m.nodeRow(i)), this._rowS];
    const cols = [...idx.map(i => m.nodeRow(i)), this._rowS];
    const u = this.locals(i => ctx.v(i), ctx.x);
    const a = -this.kappa * (u[0] - u[1] + this.params.vos * ctx.srcFactor);
    const b = (u[2] - u[5]) / this.vk;
    if (ctx.init === 'none') {
      const lim = limitTanhArg(a, this._argOld);
      if (lim.limited) {
        u[0] -= (lim.value - a) / this.kappa;
        ctx.limited();
      }
      this._argOld = lim.value;
      const limB = limitTanhArg(b, this._outArgOld);
      if (limB.limited) {
        u[2] += (limB.value - b) * this.vk;
        ctx.limited();
      }
      this._outArgOld = limB.value;
    } else {
      this._argOld = a;
      this._outArgOld = b;
    }
    {
      const lim = limitGatedState(u[6], this._sOld, { lo: 0, hi: 1, delta: DELTA, lLo: this.lDn, lHi: this.lUp, band: BAND }, ctx.init === 'none');
      if (lim.limited) ctx.limited();
      u[6] = lim.value;
      this._sOld = u[6];
    }
    const sf = ctx.srcFactor;
    const { f0, J } = linearize(w => this.evaluate(w, sf), u, u.map(fdStep));
    const sRow = 6;
    if (ctx.mode === 'tran' && ctx.initial) {
      for (let j = 0; j < J[sRow].length; j++) J[sRow][j] = 0;
      J[sRow][sRow] = 1;
      f0[sRow] = u[sRow] - this._qs.hx[0] / this.tauC;
    }
    if (ctx.mode === 'tran' && !ctx.initial) {
      const tau = this.tauC;
      const { derivative, coeff } = ctx.integrate(this._qs, tau * u[sRow]);
      J[sRow][sRow] += coeff * tau;
      f0[sRow] += derivative;
    }
    scaleRow(J, f0, sRow);
    stampLinearized(ctx, rows, cols, f0, J, u);
  }

  initTransient(ctx: InitContext): void {
    ctx.setState(this._qs, this.tauC * ctx.x[ctx.matrix.vsIndex(this._vsIndex)], 0);
  }

  acceptStep(_ctx: AcceptContext): void {}

  resetToDC(): void {
    this._qs.seed(0, 0);
    this._argOld = 0;
    this._outArgOld = 0;
    this._sOld = 0;
  }

  setOperatingPoint(solution: ArrayLike<number>, matrix: MNAMatrix): void {
    const v = (i: number) => (i > 0 ? solution[i - 1] : 0);
    this._rowS = matrix.vsIndex(this._vsIndex);
    const idx = this.nodeIdx();
    const u = this.locals(v, solution);
    const { J } = linearize(w => this.evaluate(w, 1), u, u.map(fdStep));
    this._ac = {
      J,
      rows: [...idx.map(i => matrix.nodeRow(i)), this._rowS],
      cols: [...idx.map(i => matrix.nodeRow(i)), this._rowS],
    };
    this._op = { vinp: u[0], vinn: u[1], vout: u[2], vpos: u[3], vneg: u[4], iout: -this.sinkCurrent(u[6], u[2], u[5]) };
  }

  hasAcModel(): boolean {
    return true;
  }

  acLoad(ctx: AcLoadContext): void {
    const ac = this._ac;
    if (!ac) throw new Error('Comparator: AC analysis needs an operating point first');
    const m = ctx.matrix;
    for (let i = 0; i < ac.rows.length; i++) {
      if (ac.rows[i] < 0) continue;
      for (let j = 0; j < ac.cols.length; j++) {
        const g = ac.J[i][j];
        if (g !== 0 && ac.cols[j] >= 0) m.add(ac.rows[i], ac.cols[j], g, 0);
      }
    }
    m.add(ac.rows[6], ac.rows[6], 0, ctx.omega * this.tauC);
  }

  acReadResults(re: ArrayLike<number>, im: ArrayLike<number>, _omega: number, _matrix: ComplexMNAMatrix): { voltage: Phasor; current: Phasor } {
    const ac = this._ac!;
    const c = ac.cols[2];
    let ir = 0;
    let ii = 0;
    for (let j = 0; j < ac.cols.length; j++) {
      if (ac.cols[j] < 0) continue;
      ir -= ac.J[2][j] * re[ac.cols[j]];
      ii -= ac.J[2][j] * im[ac.cols[j]];
    }
    return { voltage: c >= 0 ? [re[c], im[c]] : [0, 0], current: [ir, ii] };
  }

  readResults(solution: ArrayLike<number>, matrix: MNAMatrix): { voltage: number; current: number } {
    const idx = this.nodeIdx();
    const vout = matrix.getNodeVoltage(solution, idx[2]);
    const ve = matrix.getNodeVoltage(solution, idx[5]);
    const s = solution[matrix.vsIndex(this._vsIndex)];
    return { voltage: vout, current: -this.sinkCurrent(s, vout, ve) };
  }
}
