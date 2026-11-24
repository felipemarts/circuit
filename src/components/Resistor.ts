import { TwoTerminalComponent } from '../core/TwoTerminalComponent';
import type { MNAMatrix } from '../solver/MNAMatrix';
import type { AcLoadContext, Phasor } from '../analysis/context';
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

  hasAcModel(): boolean {
    return true;
  }

  acLoad(ctx: AcLoadContext): void {
    ctx.matrix.stampAdmittance(this._n1Index, this._n2Index, 1 / this.resistance, 0);
  }

  acReadResults(re: ArrayLike<number>, im: ArrayLike<number>): { voltage: Phasor; current: Phasor } {
    const v = this.acVoltage(re, im);
    return { voltage: v, current: [v[0] / this.resistance, v[1] / this.resistance] };
  }

  readResults(solution: ArrayLike<number>, matrix: MNAMatrix): { voltage: number; current: number } {
    const v1 = matrix.getNodeVoltage(solution, this._n1Index);
    const v2 = matrix.getNodeVoltage(solution, this._n2Index);
    const voltage = v1 - v2;
    return { voltage, current: voltage / this.resistance };
  }
}
