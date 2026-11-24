import { Component } from '../core/Component';
import type { MNAMatrix, ComplexMNAMatrix } from '../solver/MNAMatrix';
import type { AcLoadContext, LoadContext, Phasor } from '../analysis/context';
import { limitTanhArg } from './numeric';
import { parseValue } from '../core/units';
import { validatePositive } from './OpAmp';

export interface IdealOpAmpParams {
  /** Open-loop gain (V/V), frequency-independent. Default 1e6. */
  gain?: number | string;
}

/** Conductance that pins an unconnected optional supply pin to 0 V (keeps the matrix regular). */
const UNUSED_PIN_G = 1e-3;
/** Smallest half-window when both rails are connected (V). */
const MIN_HALF = 1e-3;

/**
 * Ideal op-amp: a voltage-controlled voltage source
 *   V(out) = gain·(V(inp) − V(inn))         (no rails: 'v+'/'v-' unconnected)
 *   V(out) = Vmid + Vh·tanh(gain·vd / Vh)   (both 'v+' and 'v-' connected)
 * with Vmid = (V+ + V−)/2, Vh = (V+ − V−)/2: a smooth clamp at the rails.
 * Zero output resistance, infinite bandwidth, no input current, supply pins
 * draw no current. Works in op, dc, ac and tran.
 */
export class IdealOpAmp extends Component {
  readonly kind: string = 'IdealOpAmp';
  readonly gain: number;
  /** @internal */
  _vsIndex = -1;
  private _argOld = 0;
  private _voltage = 0;
  private _current = 0;
  /** @internal linearization at the operating point: dVout/d[vinp, vinn, vp, vn] */
  private _acCoeff: [number, number, number, number] | null = null;

  constructor(params: IdealOpAmpParams = {}) {
    super();
    const gain = params.gain !== undefined ? parseValue(params.gain, 'IdealOpAmp gain') : 1e6;
    validatePositive('IdealOpAmp', 'gain', gain);
    this.gain = gain;
    for (const name of ['inp', 'inn', 'out', 'v+', 'v-']) this.addPin(name);
  }

  get voltage(): number {
    return this._voltage;
  }

  /** Current out of the output pin (positive = sourcing). */
  get current(): number {
    return this._current;
  }

  _setResults(voltage: number, current: number): void {
    this._voltage = voltage;
    this._current = current;
  }

  describeParams(): Record<string, number> {
    return { gain: this.gain };
  }

  private connected(pin: string): boolean {
    return this.pin(pin).node.pins.size > 1;
  }

  /** Both supply pins wired: the output is clamped to the rails. */
  hasRails(): boolean {
    return this.connected('v+') && this.connected('v-');
  }

  isNonlinear(): boolean {
    return this.hasRails();
  }

  getVSourceCount(): number {
    return 1;
  }

  assignVSourceIndices(startIndex: number): void {
    this._vsIndex = startIndex;
  }

  stamp(_matrix: MNAMatrix): void {
    throw new Error('IdealOpAmp is stamped through load(ctx) only');
  }

  private idx(): [number, number, number, number, number] {
    return [this.pin('inp').node.index, this.pin('inn').node.index, this.pin('out').node.index, this.pin('v+').node.index, this.pin('v-').node.index];
  }

  /** Output value and partials w.r.t. [vinp, vinn, vp, vn] at a given point. */
  private transfer(vinp: number, vinn: number, vp: number, vn: number, rails: boolean): { f: number; d: [number, number, number, number] } {
    const A = this.gain;
    const vd = vinp - vinn;
    if (!rails) return { f: A * vd, d: [A, -A, 0, 0] };
    const rawHalf = (vp - vn) / 2;
    const guarded = rawHalf < MIN_HALF;
    const vh = guarded ? MIN_HALF : rawHalf;
    const a = (A * vd) / vh;
    const t = Math.tanh(a);
    const dvd = A * (1 - t * t);
    const dvh = guarded ? 0 : t - a * (1 - t * t);
    return { f: (vp + vn) / 2 + vh * t, d: [dvd, -dvd, 0.5 + 0.5 * dvh, 0.5 - 0.5 * dvh] };
  }

  load(ctx: LoadContext): void {
    const m = ctx.matrix;
    const [ip, inn, io, ivp, ivn] = this.idx();
    const k = m.vsIndex(this._vsIndex);
    const rails = this.hasRails();
    for (const [pin, node] of [['v+', ivp], ['v-', ivn]] as const) {
      if (!this.connected(pin)) m.stampConductance(node, 0, UNUSED_PIN_G);
    }
    // KCL: the branch current I_k leaves node 'out' into the source (sourcing = −I_k).
    m.add(m.nodeRow(io), k, 1);
    let vinp = ctx.v(ip);
    const vinn = ctx.v(inn);
    const vp = rails ? ctx.v(ivp) : 0;
    const vn = rails ? ctx.v(ivn) : 0;
    if (rails) {
      const vh = Math.max(MIN_HALF, (vp - vn) / 2);
      const a = (this.gain * (vinp - vinn)) / vh;
      if (ctx.init === 'none') {
        const lim = limitTanhArg(a, this._argOld);
        if (lim.limited) {
          vinp += ((lim.value - a) * vh) / this.gain;
          ctx.limited();
        }
        this._argOld = lim.value;
      } else {
        this._argOld = a;
      }
    }
    const { f, d } = this.transfer(vinp, vinn, vp, vn, rails);
    // Branch row: V(out) − f(u) = 0, linearized.
    m.add(k, m.nodeRow(io), 1);
    const cols = [ip, inn, ivp, ivn];
    const u0 = [vinp, vinn, vp, vn];
    let rhs = f;
    for (let j = 0; j < 4; j++) {
      if (d[j] === 0) continue;
      m.add(k, m.nodeRow(cols[j]), -d[j]);
      rhs -= d[j] * u0[j];
    }
    m.addRHS(k, rhs);
  }

  resetToDC(): void {
    this._argOld = 0;
  }

  setOperatingPoint(solution: ArrayLike<number>, _matrix: MNAMatrix): void {
    const v = (i: number) => (i > 0 ? solution[i - 1] : 0);
    const [ip, inn, , ivp, ivn] = this.idx();
    const rails = this.hasRails();
    this._acCoeff = this.transfer(v(ip), v(inn), rails ? v(ivp) : 0, rails ? v(ivn) : 0, rails).d;
  }

  hasAcModel(): boolean {
    return true;
  }

  acLoad(ctx: AcLoadContext): void {
    const m = ctx.matrix;
    const [ip, inn, io, ivp, ivn] = this.idx();
    const k = m.vsIndex(this._vsIndex);
    for (const [pin, node] of [['v+', ivp], ['v-', ivn]] as const) {
      if (!this.connected(pin)) m.stampAdmittance(node, 0, UNUSED_PIN_G, 0);
    }
    const d = this._acCoeff ?? [this.gain, -this.gain, 0, 0];
    m.add(m.nodeRow(io), k, 1, 0);
    m.add(k, m.nodeRow(io), 1, 0);
    const cols = [ip, inn, ivp, ivn];
    for (let j = 0; j < 4; j++) if (d[j] !== 0) m.add(k, m.nodeRow(cols[j]), -d[j], 0);
  }

  acReadResults(re: ArrayLike<number>, im: ArrayLike<number>, _omega: number, matrix: ComplexMNAMatrix): { voltage: Phasor; current: Phasor } {
    const io = this.pin('out').node.index;
    const k = matrix.vsIndex(this._vsIndex);
    return { voltage: matrix.nodeVoltage(re, im, io), current: [-re[k], -im[k]] };
  }

  readResults(solution: ArrayLike<number>, matrix: MNAMatrix): { voltage: number; current: number } {
    return {
      voltage: matrix.getNodeVoltage(solution, this.pin('out').node.index),
      current: -matrix.getVSourceCurrent(solution, this._vsIndex),
    };
  }
}
