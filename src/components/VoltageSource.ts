import { TwoTerminalComponent } from '../core/TwoTerminalComponent';
import type { MNAMatrix } from '../solver/MNAMatrix';
import { parseValue } from '../core/units';

export class VoltageSource extends TwoTerminalComponent {
  readonly kind: string = 'VoltageSource';
  readonly declaredVoltage: number;
  /** @internal Assigned during analysis */
  _vsIndex: number = -1;

  /** AC parameters for transient analysis */
  acAmplitude: number = 0;
  frequency: number = 0;

  /** @internal Effective voltage used by stamp (set per timestep in transient) */
  _effectiveVoltage: number;

  constructor(voltage: number | string) {
    super();
    const v = parseValue(voltage, 'voltage');
    this.pins.set('+', this.pin('1'));
    this.pins.set('-', this.pin('2'));
    this.declaredVoltage = v;
    this._effectiveVoltage = v;
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

  // --- Protocol methods ---

  getVSourceCount(): number { return 1; }

  assignVSourceIndices(startIndex: number): void {
    this._vsIndex = startIndex;
  }

  setTime(t: number): void {
    this._effectiveVoltage = this.voltageAtTime(t);
  }

  resetToDC(): void {
    this._effectiveVoltage = this.declaredVoltage;
  }

  readResults(solution: number[], matrix: MNAMatrix): { voltage: number; current: number } {
    const v1 = matrix.getNodeVoltage(solution, this._n1Index);
    const v2 = matrix.getNodeVoltage(solution, this._n2Index);
    return {
      voltage: v1 - v2,
      current: matrix.getVSourceCurrent(solution, this._vsIndex),
    };
  }
}
