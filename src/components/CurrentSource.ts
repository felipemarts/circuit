import { TwoTerminalComponent } from '../core/TwoTerminalComponent';
import type { MNAMatrix } from '../solver/MNAMatrix';

export class CurrentSource extends TwoTerminalComponent {
  readonly currentValue: number;

  constructor(current: number) {
    super();
    this.pins.set('+', this.pin('1'));
    this.pins.set('-', this.pin('2'));
    this.currentValue = current;
  }

  stamp(matrix: MNAMatrix): void {
    // Current flows from pin '-' to pin '+' (into pin 1)
    matrix.stampCurrentSource(this._n1Index, this._n2Index, this.currentValue);
  }
}
