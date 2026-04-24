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

  // --- Protocol methods ---

  getVSourceCount(): number {
    return this._transient ? 0 : 1;
  }

  assignVSourceIndices(startIndex: number): void {
    this._vsIndex = startIndex;
  }

  prepareTransientStep(dt: number): void {
    if (dt === 0) {
      // Enter transient mode, cold start
      this._transient = true;
      this._prevCurrent = 0;
      return;
    }
    this.setTransientState(dt, this._prevCurrent);
  }

  updateState(solution: number[], matrix: MNAMatrix): void {
    const v1 = matrix.getNodeVoltage(solution, this._n1Index);
    const v2 = matrix.getNodeVoltage(solution, this._n2Index);
    const g_eq = this._dt / this.inductance;
    this._prevCurrent = g_eq * (v1 - v2) + this._prevCurrent;
  }

  readResults(solution: number[], matrix: MNAMatrix): { voltage: number; current: number } {
    const v1 = matrix.getNodeVoltage(solution, this._n1Index);
    const v2 = matrix.getNodeVoltage(solution, this._n2Index);
    if (!this._transient) {
      return {
        voltage: v1 - v2,
        current: matrix.getVSourceCurrent(solution, this._vsIndex),
      };
    }
    return {
      voltage: v1 - v2,
      current: this._prevCurrent,
    };
  }
}
