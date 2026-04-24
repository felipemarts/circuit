import { TwoTerminalComponent } from '../core/TwoTerminalComponent';
import type { MNAMatrix } from '../solver/MNAMatrix';

export interface DiodeParams {
  Is?: number;    // Saturation current (A)
  n?: number;     // Ideality factor
  Vt?: number;    // Thermal voltage (V)
}

const DEFAULTS: Required<DiodeParams> = {
  Is: 1e-14,
  n: 1,
  Vt: 0.02585,  // ~26mV at room temp
};

export class Diode extends TwoTerminalComponent {
  readonly Is: number;
  readonly n: number;
  readonly Vt: number;
  private _operatingVoltage = 0.7; // Initial guess

  constructor(params?: DiodeParams) {
    super();
    const p = { ...DEFAULTS, ...params };
    this.Is = p.Is;
    this.n = p.n;
    this.Vt = p.Vt;

    // Named pin aliases: anode = pin 1, cathode = pin 2
    this.pins.set('anode', this.pin('1'));
    this.pins.set('cathode', this.pin('2'));
  }

  get anode() { return this.pin('1'); }
  get cathode() { return this.pin('2'); }

  isNonlinear(): boolean {
    return true;
  }

  getOperatingVoltage(): number {
    return this._operatingVoltage;
  }

  /** Compute diode current at given voltage */
  computeDiodeCurrent(vd: number): number {
    const nVt = this.n * this.Vt;
    return this.Is * (Math.exp(vd / nVt) - 1);
  }

  setOperatingPoint(solution: number[], matrix: MNAMatrix): void {
    const v1 = matrix.getNodeVoltage(solution, this._n1Index);
    const v2 = matrix.getNodeVoltage(solution, this._n2Index);
    let vd = v1 - v2;

    // Damping: limit voltage change to prevent exp() overflow
    const delta = vd - this._operatingVoltage;
    const maxDelta = 0.5;
    if (Math.abs(delta) > maxDelta) {
      vd = this._operatingVoltage + Math.sign(delta) * maxDelta;
    }

    this._operatingVoltage = vd;
  }

  stamp(matrix: MNAMatrix): void {
    const vd = this._operatingVoltage;
    const nVt = this.n * this.Vt;

    // Linearized companion model at operating point
    const expTerm = Math.exp(vd / nVt);
    const Geq = (this.Is / nVt) * expTerm;
    const Id = this.Is * (expTerm - 1);
    const Ieq = Id - Geq * vd;

    // Stamp as parallel conductance + current source
    matrix.stampConductance(this._n1Index, this._n2Index, Geq);
    // Current source: Ieq flows from cathode to anode (into anode = pin 1)
    matrix.stampCurrentSource(this._n1Index, this._n2Index, -Ieq);
  }

  readResults(solution: number[], matrix: MNAMatrix): { voltage: number; current: number } {
    const v1 = matrix.getNodeVoltage(solution, this._n1Index);
    const v2 = matrix.getNodeVoltage(solution, this._n2Index);
    const voltage = v1 - v2;
    return { voltage, current: this.computeDiodeCurrent(voltage) };
  }
}
