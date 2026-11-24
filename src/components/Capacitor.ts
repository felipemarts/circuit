import { TwoTerminalComponent } from '../core/TwoTerminalComponent';
import type { MNAMatrix } from '../solver/MNAMatrix';
import { parseValue } from '../core/units';
import { ReactiveState } from '../analysis/integration';
import type { AcLoadContext, AcceptContext, InitContext, LoadContext, Phasor } from '../analysis/context';

/** Conductance that pins a capacitor to its initial voltage during the t = 0 solve. */
export const IC_CONDUCTANCE = 1e6;

export class Capacitor extends TwoTerminalComponent {
  readonly kind: string = 'Capacitor';
  readonly capacitance: number;

  /** @internal charge state integrated by the transient engine */
  readonly _q: ReactiveState;
  /** @internal capacitor current at the last accepted point (0 in DC) */
  _i = 0;
  /** @internal true while the last solve was a transient one */
  _transient = false;

  constructor(capacitance: number | string) {
    super();
    const c = parseValue(capacitance, 'capacitance');
    if (c <= 0) {
      throw new Error(`Capacitance must be a finite number > 0, got ${capacitance}`);
    }
    this.capacitance = c;
    // chgtol 1e-14 C, abstol 1e-12 A (SPICE defaults).
    this._q = new ReactiveState(this, 1e-12, 1e-14);
    this._q.evaluate = x => {
      const a = this._n1Index;
      const b = this._n2Index;
      return this.capacitance * ((a > 0 ? x[a - 1] : 0) - (b > 0 ? x[b - 1] : 0));
    };
  }

  /** DC: open circuit. */
  stamp(_matrix: MNAMatrix): void {}

  load(ctx: LoadContext): void {
    if (ctx.mode !== 'tran') {
      this._transient = false;
      return; // DC: open circuit
    }
    this._transient = true;
    const n1 = this._n1Index;
    const n2 = this._n2Index;
    if (ctx.initial) {
      // Hold the initial voltage (the zero state, or the operating point).
      const vic = this._q.hx[0] / this.capacitance;
      ctx.matrix.stampConductance(n1, n2, IC_CONDUCTANCE);
      ctx.matrix.stampCurrentSource(n1, n2, IC_CONDUCTANCE * vic);
      return;
    }
    const v = ctx.v(n1) - ctx.v(n2);
    const { derivative, coeff } = ctx.integrate(this._q, this.capacitance * v);
    const geq = coeff * this.capacitance;
    const ieq = derivative - geq * v; // i = geq·v + ieq
    ctx.matrix.stampConductance(n1, n2, geq);
    ctx.matrix.stampCurrentSource(n1, n2, -ieq);
  }

  initTransient(ctx: InitContext): void {
    const v = ctx.v(this._n1Index) - ctx.v(this._n2Index);
    if (ctx.fromOp) {
      ctx.setState(this._q, this.capacitance * v, 0);
      this._i = 0;
    } else {
      const vic = this._q.hx[0] / this.capacitance;
      // Current drawn by the IC clamp at t = 0 (what charges the capacitor).
      this._i = IC_CONDUCTANCE * (v - vic);
      ctx.setState(this._q, this._q.hx[0], this._i);
    }
    this._transient = true;
  }

  acceptStep(_ctx: AcceptContext): void {
    this._i = this._q.hd[0];
  }

  /** Reset the transient state to the zero state (0 V). */
  resetToDC(): void {
    this._transient = false;
    this._q.seed(0, 0);
    this._i = 0;
  }

  hasAcModel(): boolean {
    return true;
  }

  acLoad(ctx: AcLoadContext): void {
    ctx.matrix.stampAdmittance(this._n1Index, this._n2Index, 0, ctx.omega * this.capacitance);
  }

  acReadResults(re: ArrayLike<number>, im: ArrayLike<number>, omega: number): { voltage: Phasor; current: Phasor } {
    const v = this.acVoltage(re, im);
    const b = omega * this.capacitance;
    return { voltage: v, current: [-b * v[1], b * v[0]] };
  }

  readResults(solution: ArrayLike<number>, matrix: MNAMatrix): { voltage: number; current: number } {
    const v1 = matrix.getNodeVoltage(solution, this._n1Index);
    const v2 = matrix.getNodeVoltage(solution, this._n2Index);
    return { voltage: v1 - v2, current: this._transient ? this._i : 0 };
  }
}
