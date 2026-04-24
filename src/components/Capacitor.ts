import { TwoTerminalComponent } from '../core/TwoTerminalComponent';
import type { MNAMatrix } from '../solver/MNAMatrix';

export class Capacitor extends TwoTerminalComponent {
  readonly capacitance: number;

  /** @internal Transient state */
  _transient = false;
  _dt = 0;
  _prevVoltage = 0;

  constructor(capacitance: number) {
    super();
    if (capacitance <= 0) throw new Error('Capacitance must be positive');
    this.capacitance = capacitance;
  }

  setTransientState(dt: number, prevVoltage: number): void {
    this._transient = true;
    this._dt = dt;
    this._prevVoltage = prevVoltage;
  }

  resetToDC(): void {
    this._transient = false;
  }

  stamp(matrix: MNAMatrix): void {
    if (!this._transient) return; // DC: open circuit

    // Backward Euler companion model:
    // i = C * (V - V_prev) / dt = g_eq * V - g_eq * V_prev
    // Norton equivalent: conductance g_eq = C/dt, history current I_hist = g_eq * V_prev
    // History current: capacitor was charged to V_prev, equivalent to current source
    // injecting g_eq * V_prev into n1 (maintaining the charge)
    const g_eq = this.capacitance / this._dt;
    matrix.stampConductance(this._n1Index, this._n2Index, g_eq);
    matrix.stampCurrentSource(this._n1Index, this._n2Index, g_eq * this._prevVoltage);
  }

  // --- Protocol methods ---

  prepareTransientStep(dt: number): void {
    if (dt === 0) {
      // Enter transient mode, cold start
      this._transient = true;
      this._prevVoltage = 0;
      return;
    }
    this.setTransientState(dt, this._prevVoltage);
  }

  updateState(solution: number[], matrix: MNAMatrix): void {
    const v1 = matrix.getNodeVoltage(solution, this._n1Index);
    const v2 = matrix.getNodeVoltage(solution, this._n2Index);
    this._prevVoltage = v1 - v2;
  }

  readResults(solution: number[], matrix: MNAMatrix): { voltage: number; current: number } {
    const v1 = matrix.getNodeVoltage(solution, this._n1Index);
    const v2 = matrix.getNodeVoltage(solution, this._n2Index);
    const voltage = v1 - v2;
    return {
      voltage,
      current: this._transient ? this.capacitance * (voltage - this._prevVoltage) / this._dt : 0,
    };
  }
}
