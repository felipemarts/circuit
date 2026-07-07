import { TwoTerminalComponent } from '../core/TwoTerminalComponent';
import type { MNAMatrix } from '../solver/MNAMatrix';
import { parseValue } from '../core/units';

export class Resistor extends TwoTerminalComponent {
  readonly kind: string = 'Resistor';
  readonly resistance: number;

  constructor(resistance: number | string) {
    super();
    const r = parseValue(resistance, 'resistance');
    if (r <= 0) {
      throw new Error(`Resistance must be a finite number > 0, got ${resistance}`);
    }
    this.resistance = r;
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
