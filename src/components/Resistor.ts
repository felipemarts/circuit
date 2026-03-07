import { TwoTerminalComponent } from '../core/TwoTerminalComponent';
import type { MNAMatrix } from '../solver/MNAMatrix';

export class Resistor extends TwoTerminalComponent {
  readonly resistance: number;

  constructor(resistance: number) {
    super();
    if (resistance <= 0) throw new Error('Resistance must be positive');
    this.resistance = resistance;
  }

  stamp(matrix: MNAMatrix): void {
    const g = 1 / this.resistance;
    matrix.stampConductance(this._n1Index, this._n2Index, g);
  }
}
