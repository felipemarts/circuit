import { TwoTerminalComponent } from '../core/TwoTerminalComponent';
import type { MNAMatrix } from '../solver/MNAMatrix';

const R_CLOSED = 1e-3; // 1 mΩ — effectively a short
const R_OPEN = 1e12;   // 1 TΩ — effectively an open circuit (current < 1 pA)

/**
 * Toggle switch (on/off). Click toggles `closed`; the simulation models the
 * switch as a tiny resistance when closed and a huge resistance when open.
 */
export class Switch extends TwoTerminalComponent {
  closed: boolean;

  constructor(closed = false) {
    super();
    this.closed = closed;
  }

  get resistance(): number {
    return this.closed ? R_CLOSED : R_OPEN;
  }

  toggle(): void {
    this.closed = !this.closed;
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
