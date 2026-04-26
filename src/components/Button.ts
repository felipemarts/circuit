import { TwoTerminalComponent } from '../core/TwoTerminalComponent';
import type { MNAMatrix } from '../solver/MNAMatrix';

const R_CLOSED = 1e-3;
const R_OPEN = 1e12;

/**
 * Momentary push-button. Default state is open; while `pressed` is true the
 * button conducts. The UI sets `pressed` on mousedown and clears on mouseup.
 */
export class Button extends TwoTerminalComponent {
  pressed: boolean;

  constructor(pressed = false) {
    super();
    this.pressed = pressed;
  }

  get resistance(): number {
    return this.pressed ? R_CLOSED : R_OPEN;
  }

  stamp(matrix: MNAMatrix): void {
    const g = 1 / this.resistance;
    matrix.stampConductance(this._n1Index, this._n2Index, g);
  }

  readResults(solution: number[], matrix: MNAMatrix): { voltage: number; current: number } {
    const v1 = matrix.getNodeVoltage(solution, this._n1Index);
    const v2 = matrix.getNodeVoltage(solution, this._n2Index);
    const voltage = v1 - v2;
    return { voltage, current: voltage / this.resistance };
  }
}
