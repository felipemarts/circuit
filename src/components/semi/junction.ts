/**
 * pn-junction building blocks shared by the semiconductor models (SPICE3
 * formulations): the depletion charge with the forward-bias linearization
 * past Fc·Vj, and the diode current with optional reverse breakdown.
 */
import { junctionVcrit, pnjlim, safeExp, type Limited } from '../../solver/limiting';

export interface ChargeValue {
  /** Charge (C). */
  q: number;
  /** dq/dv (F). */
  c: number;
}

/**
 * Depletion charge of a junction with zero-bias capacitance `cj0`, built-in
 * potential `vj`, grading `m` and forward-bias coefficient `fc` (SPICE):
 *
 *   v < fc·vj:  C = cj0·(1 − v/vj)^−m,   Q = cj0·vj·(1 − (1 − v/vj)^(1−m))/(1 − m)
 *   v ≥ fc·vj:  C = cj0/(1−fc)^(1+m)·(1 − fc·(1+m) + m·v/vj)   (linear extrapolation)
 *
 * m = 1 uses the logarithmic limit Q = −cj0·vj·ln(1 − v/vj).
 */
export function depletionCharge(v: number, cj0: number, vj: number, m: number, fc: number): ChargeValue {
  if (!(cj0 > 0)) return { q: 0, c: 0 };
  const fcpv = fc * vj;
  if (v < fcpv) {
    const arg = 1 - v / vj;
    const sarg = Math.exp(-m * Math.log(arg));
    const q = Math.abs(1 - m) < 1e-12 ? -cj0 * vj * Math.log(arg) : (cj0 * vj * (1 - arg * sarg)) / (1 - m);
    return { q, c: cj0 * sarg };
  }
  const f1 = Math.abs(1 - m) < 1e-12 ? -vj * Math.log(1 - fc) : (vj * (1 - Math.pow(1 - fc, 1 - m))) / (1 - m);
  const f2 = Math.pow(1 - fc, 1 + m);
  const f3 = 1 - fc * (1 + m);
  const czf2 = cj0 / f2;
  const q = cj0 * f1 + czf2 * (f3 * (v - fcpv) + (m / (2 * vj)) * (v * v - fcpv * fcpv));
  return { q, c: czf2 * (f3 + (m * v) / vj) };
}

/** Normalized diode model parameters (SI). `BV` = Infinity means no breakdown. */
export interface JunctionModel {
  Is: number;
  n: number;
  Vt: number;
  Cjo: number;
  Vj: number;
  M: number;
  Fc: number;
  Tt: number;
  BV: number;
  IBV: number;
  Nbv: number;
}

export interface JunctionEval {
  /** Junction current (A), gmin included. */
  i: number;
  /** di/dv (S), gmin included. */
  g: number;
  /** Stored charge: depletion + Tt·(diffusion current). */
  q: number;
  /** dq/dv (F). */
  c: number;
}

/**
 * A pn junction: Shockley current Is·(e^(v/(n·Vt)) − 1), optional reverse
 * breakdown and charge storage. Breakdown follows SPICE: below −BV the
 * current grows as −Is·e^(−(BVeff + v)/(Nbv·Vt)), where BVeff is chosen so the
 * reverse current at v = −BV equals IBV (the datasheet Vz-at-Izt point).
 */
export class Junction {
  readonly model: JunctionModel;
  readonly nVt: number;
  readonly vcrit: number;
  /** Effective breakdown voltage of the exponential (Infinity without BV). */
  readonly bvEff: number;
  readonly nbvVt: number;
  readonly vcritBv: number;

  constructor(model: JunctionModel) {
    this.model = model;
    this.nVt = model.n * model.Vt;
    this.vcrit = junctionVcrit(this.nVt, model.Is);
    this.nbvVt = model.Nbv * model.Vt;
    this.vcritBv = junctionVcrit(this.nbvVt, model.Is);
    if (Number.isFinite(model.BV)) {
      // Is·e^((BV − BVeff)/(Nbv·Vt)) = IBV  ⇒  BVeff = BV − Nbv·Vt·ln(IBV/Is).
      const shift = model.IBV > model.Is ? this.nbvVt * Math.log(model.IBV / model.Is) : 0;
      this.bvEff = model.BV - shift;
    } else {
      this.bvEff = Infinity;
    }
  }

  get hasBreakdown(): boolean {
    return Number.isFinite(this.bvEff);
  }

  get hasCharge(): boolean {
    return this.model.Cjo > 0 || this.model.Tt > 0;
  }

  /** Current and conductance (no charge). */
  current(v: number, gmin: number): { i: number; g: number } {
    const { Is } = this.model;
    const e = safeExp(v / this.nVt);
    let i = Is * (e - 1);
    let g = (Is / this.nVt) * e;
    if (this.hasBreakdown) {
      const eb = safeExp(-(this.bvEff + v) / this.nbvVt);
      i -= Is * eb;
      g += (Is / this.nbvVt) * eb;
    }
    return { i: i + gmin * v, g: g + gmin };
  }

  /** Current, conductance and stored charge at v. */
  evaluate(v: number, gmin: number): JunctionEval {
    const { i, g } = this.current(v, gmin);
    const m = this.model;
    let q = 0;
    let c = 0;
    if (m.Cjo > 0) {
      const dep = depletionCharge(v, m.Cjo, m.Vj, m.M, m.Fc);
      q += dep.q;
      c += dep.c;
    }
    if (m.Tt > 0) {
      // Diffusion charge follows the (gmin-free) junction current.
      const d = this.current(v, 0);
      q += m.Tt * d.i;
      c += m.Tt * d.g;
    }
    return { i, g, q, c };
  }

  /**
   * SPICE junction limiting: pnjlim on the forward exponential, or on the
   * breakdown exponential when the iterate is deep in reverse bias.
   */
  limit(vnew: number, vold: number): Limited {
    if (this.hasBreakdown && vnew < Math.min(0, -this.bvEff + 10 * this.nbvVt)) {
      const r = pnjlim(-(vnew + this.bvEff), -(vold + this.bvEff), this.nbvVt, this.vcritBv);
      return { value: -(r.value + this.bvEff), limited: r.limited };
    }
    return pnjlim(vnew, vold, this.nVt, this.vcrit);
  }
}
