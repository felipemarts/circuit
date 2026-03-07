import { TwoTerminalComponent } from '../core/TwoTerminalComponent';
import type { MNAMatrix } from '../solver/MNAMatrix';

export class Inductor extends TwoTerminalComponent {
  readonly inductance: number;
  /** @internal Used as 0V voltage source for DC */
  _vsIndex: number = -1;

  /** @internal Transient state */
  _transient = false;
  _dt = 0;
  _prevCurrent = 0;

  constructor(inductance: number) {
    super();
    if (inductance <= 0) throw new Error('Inductance must be positive');
    this.inductance = inductance;
  }

  setTransientState(dt: number, prevCurrent: number): void {
    this._transient = true;
    this._dt = dt;
    this._prevCurrent = prevCurrent;
  }

  resetToDC(): void {
    this._transient = false;
  }

  stamp(matrix: MNAMatrix): void {
    if (!this._transient) {
      // DC: short circuit (0V voltage source)
      matrix.stampVoltageSource(this._n1Index, this._n2Index, this._vsIndex, 0);
      return;
    }

    // Backward Euler companion model:
    // i = g_eq * V + i_prev where g_eq = dt/L
    // Backward Euler: i_n = g_eq*(V1-V2) + i_prev, g_eq = dt/L
    // i_prev flows from n1→n2 (leaves n1), so in RHS: stamp as current into n2
    const g_eq = this._dt / this.inductance;
    matrix.stampConductance(this._n1Index, this._n2Index, g_eq);
    matrix.stampCurrentSource(this._n2Index, this._n1Index, this._prevCurrent);
  }
}
