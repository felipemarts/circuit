import { TwoTerminalComponent } from '../core/TwoTerminalComponent';
import type { MNAMatrix } from '../solver/MNAMatrix';

export class VoltageSource extends TwoTerminalComponent {
  readonly declaredVoltage: number;
  /** @internal Assigned during analysis */
  _vsIndex: number = -1;

  /** AC parameters for transient analysis */
  acAmplitude: number = 0;
  frequency: number = 0;

  /** @internal Effective voltage used by stamp (set per timestep in transient) */
  _effectiveVoltage: number;

  constructor(voltage: number) {
    super();
    this.pins.set('+', this.pin('1'));
    this.pins.set('-', this.pin('2'));
    this.declaredVoltage = voltage;
    this._effectiveVoltage = voltage;
  }

  voltageAtTime(t: number): number {
    if (this.frequency > 0) {
      return this.declaredVoltage + this.acAmplitude * Math.sin(2 * Math.PI * this.frequency * t);
    }
    return this.declaredVoltage;
  }

  stamp(matrix: MNAMatrix): void {
    matrix.stampVoltageSource(this._n1Index, this._n2Index, this._vsIndex, this._effectiveVoltage);
  }
}
