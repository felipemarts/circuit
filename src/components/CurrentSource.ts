import { TwoTerminalComponent } from '../core/TwoTerminalComponent';
import type { MNAMatrix } from '../solver/MNAMatrix';
import { parseValue } from '../core/units';

export class CurrentSource extends TwoTerminalComponent {
  readonly kind: string = 'CurrentSource';
  readonly currentValue: number;

  constructor(current: number | string) {
    super();
    this.pins.set('+', this.pin('1'));
    this.pins.set('-', this.pin('2'));
    this.currentValue = parseValue(current, 'current');
  }

  stamp(matrix: MNAMatrix): void {
    // Current flows from pin '-' to pin '+' (into pin 1)
    matrix.stampCurrentSource(this._n1Index, this._n2Index, this.currentValue);
  }

  readResults(solution: number[], matrix: MNAMatrix): { voltage: number; current: number } {
    const v1 = matrix.getNodeVoltage(solution, this._n1Index);
    const v2 = matrix.getNodeVoltage(solution, this._n2Index);
    return { voltage: v1 - v2, current: this.currentValue };
  }
}
