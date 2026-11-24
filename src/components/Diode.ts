import { TwoTerminalComponent } from '../core/TwoTerminalComponent';
import type { MNAMatrix } from '../solver/MNAMatrix';
import type { AcLoadContext, LoadContext, Phasor } from '../analysis/context';
import { junctionVcrit, pnjlim, safeExp } from '../solver/limiting';

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

/** Conductance used for the AC model and as numerical floor when ctx.gmin is 0. */
const GMIN_FLOOR = 1e-12;

/**
 * Shockley diode I = Is·(e^(V/(n·Vt)) − 1), with SPICE pn-junction voltage
 * limiting (pnjlim) in Newton-Raphson and gmin in parallel.
 */
export class Diode extends TwoTerminalComponent {
  readonly kind: string = 'Diode';
  readonly Is: number;
  readonly n: number;
  readonly Vt: number;
  /** @internal junction voltage used by the last load (the linearization point) */
  _vd = 0;
  /** @internal small-signal conductance at the last load */
  _gd = 0;
  /** @internal gmin used at the last load */
  private _gmin = GMIN_FLOOR;

  constructor(params?: DiodeParams) {
    super();
    const p = { ...DEFAULTS, ...params };
    for (const key of ['Is', 'n', 'Vt'] as const) {
      if (!Number.isFinite(p[key]) || p[key] <= 0) {
        throw new Error(`Diode ${key} must be a finite number > 0, got ${p[key]}`);
      }
    }
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

  /** Critical voltage of the junction (where pnjlim starts limiting). */
  get vcrit(): number {
    return junctionVcrit(this.n * this.Vt, this.Is);
  }

  getOperatingVoltage(): number {
    return this._vd;
  }

  /** Compute diode current at given voltage */
  computeDiodeCurrent(vd: number): number {
    const nVt = this.n * this.Vt;
    return this.Is * (safeExp(vd / nVt) - 1);
  }

  /** Legacy stamp: linearized at the last junction voltage. */
  stamp(matrix: MNAMatrix): void {
    this.stampAt(matrix, this._vd, this._gmin);
  }

  load(ctx: LoadContext): void {
    const nVt = this.n * this.Vt;
    const vcrit = this.vcrit;
    let vd: number;
    if (ctx.init === 'junction') {
      vd = vcrit;
    } else {
      vd = ctx.v(this._n1Index) - ctx.v(this._n2Index);
      if (ctx.init === 'none') {
        const lim = pnjlim(vd, this._vd, nVt, vcrit);
        if (lim.limited) {
          vd = lim.value;
          ctx.limited();
        }
      }
    }
    this._vd = vd;
    this._gmin = ctx.gmin > 0 ? ctx.gmin : GMIN_FLOOR;
    this.stampAt(ctx.matrix, vd, this._gmin);
  }

  private stampAt(matrix: MNAMatrix, vd: number, gmin: number): void {
    const nVt = this.n * this.Vt;
    const expTerm = safeExp(vd / nVt);
    const gd = (this.Is / nVt) * expTerm + gmin;
    const id = this.Is * (expTerm - 1) + gmin * vd;
    const ieq = id - gd * vd;
    this._gd = gd;
    matrix.stampConductance(this._n1Index, this._n2Index, gd);
    // Current source: ieq flows anode → cathode through the diode
    matrix.stampCurrentSource(this._n1Index, this._n2Index, -ieq);
  }

  hasAcModel(): boolean {
    return true;
  }

  /** Small-signal: the junction conductance at the operating point. */
  acLoad(ctx: AcLoadContext): void {
    ctx.matrix.stampAdmittance(this._n1Index, this._n2Index, this._gd, 0);
  }

  acReadResults(re: ArrayLike<number>, im: ArrayLike<number>): { voltage: Phasor; current: Phasor } {
    const v = this.acVoltage(re, im);
    return { voltage: v, current: [v[0] * this._gd, v[1] * this._gd] };
  }

  readResults(solution: ArrayLike<number>, matrix: MNAMatrix): { voltage: number; current: number } {
    const v1 = matrix.getNodeVoltage(solution, this._n1Index);
    const v2 = matrix.getNodeVoltage(solution, this._n2Index);
    const voltage = v1 - v2;
    return { voltage, current: this.computeDiodeCurrent(voltage) };
  }
}
