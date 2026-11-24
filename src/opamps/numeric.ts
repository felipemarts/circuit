/**
 * Smooth limiting functions and Newton helpers shared by the op-amp and
 * comparator models. Every clamp is C1 or smoother: hard switches make
 * Newton-Raphson chatter between branches.
 */
import type { LoadContext } from '../analysis/context';

/** Logistic 1 / (1 + e^-u), overflow-safe. */
export function logistic(u: number): number {
  if (u >= 0) {
    const e = Math.exp(-u);
    return 1 / (1 + e);
  }
  const e = Math.exp(u);
  return e / (1 + e);
}

/** ln(p / (1 − p)) for p in (0, 1). */
export function logit(p: number): number {
  return Math.log(p / (1 - p));
}

/**
 * One-sided Huber ramp: 0 for u ≤ 0, u²/(2w) for 0 < u < w, u − w/2 beyond.
 * C1, no tail — used for the restoring clamp that only acts outside the window.
 */
export function ramp(u: number, w: number): number {
  if (u <= 0) return 0;
  if (u < w) return (u * u) / (2 * w);
  return u - w / 2;
}

/**
 * Newton limiting for the argument of a tanh (pnjlim's analogue for a
 * saturating function). A step that would jump across the saturated tails —
 * where the slope is ~0 and Newton loses the feedback loop — is limited to
 * max(2, |old|), so the argument doubles at most per iteration; a move between
 * two points deep in the same saturated tail is free (tanh is ±1 at both).
 */
export function limitTanhArg(anew: number, aold: number): { value: number; limited: boolean } {
  const d = anew - aold;
  if (Math.abs(d) <= 2) return { value: anew, limited: false };
  if (anew * aold > 0 && Math.abs(anew) >= 15 && Math.abs(aold) >= 15) return { value: anew, limited: false };
  const step = Math.max(2, Math.abs(aold));
  if (Math.abs(d) <= step) return { value: anew, limited: false };
  return { value: aold + Math.sign(d) * step, limited: true };
}

/** Asymmetric smooth current limit: x for small x, → +limPos / −limNeg. C2 at 0. */
export function softLimit(x: number, limPos: number, limNeg: number): number {
  return x >= 0 ? limPos * Math.tanh(x / limPos) : limNeg * Math.tanh(x / limNeg);
}

/**
 * Linearize a vector function f: R^n → R^m around u0 by central finite
 * differences (steps h[j]). Returns f(u0) and the m×n Jacobian.
 */
export function linearize(
  f: (u: number[]) => number[],
  u0: number[],
  h: number[],
): { f0: number[]; J: number[][] } {
  const f0 = f(u0);
  const m = f0.length;
  const J: number[][] = Array.from({ length: m }, () => new Array<number>(u0.length).fill(0));
  const u = u0.slice();
  for (let j = 0; j < u0.length; j++) {
    const hj = h[j];
    u[j] = u0[j] + hj;
    const fp = f(u);
    u[j] = u0[j] - hj;
    const fm = f(u);
    u[j] = u0[j];
    for (let i = 0; i < m; i++) J[i][j] = (fp[i] - fm[i]) / (2 * hj);
  }
  return { f0, J };
}

/**
 * Stamp a linearized device: output i is the residual of matrix row rows[i]
 * (a current leaving a node for KCL rows, or the device's own branch
 * equation), local input j is unknown cols[j] (−1 = ground, value 0).
 * f(u) ≈ f0 + J·(u − u0) contributes J to G and −(f0 − J·u0) to the RHS.
 */
export function stampLinearized(
  ctx: Pick<LoadContext, 'matrix'>,
  rows: number[],
  cols: number[],
  f0: number[],
  J: number[][],
  u0: number[],
): void {
  const m = ctx.matrix;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (r < 0) continue;
    let rhs = f0[i];
    for (let j = 0; j < cols.length; j++) {
      const g = J[i][j];
      if (g === 0) continue;
      rhs -= g * u0[j];
      if (cols[j] >= 0) m.add(r, cols[j], g);
    }
    m.addRHS(r, -rhs);
  }
}

/** Finite-difference step for a voltage-like unknown of magnitude v. */
export function fdStep(v: number): number {
  return 1e-6 * Math.max(1, Math.abs(v));
}

/**
 * Newton limiting for the argument of a gate logistic(a): the gate is
 * exponential for a < 0, so an inward step (a increasing) from the
 * exponential side is taken logarithmically, as pnjlim does for a junction;
 * an outward step is capped like limitTanhArg. The gate's equilibrium sits
 * at a ≥ L (L = logit of the equilibrium gate value); below L − 5 the gate
 * is negligible and moves are free.
 */
export function limitGateArg(anew: number, aold: number, L: number): { value: number; limited: boolean } {
  const FLOOR = L - 5;
  if (anew <= FLOOR) {
    if (aold <= FLOOR) return { value: anew, limited: false };
    // Outward move from the active region: cap it.
    const step = Math.max(2, Math.abs(aold));
    if (aold - anew <= step) return { value: anew, limited: false };
    return { value: aold - step, limited: true };
  }
  if (anew > aold) {
    const base = Math.max(aold, FLOOR);
    const d = anew - base;
    if (aold < 3 && d > 1) return { value: base + Math.log(1 + d), limited: true };
    return { value: anew, limited: false };
  }
  const d = aold - anew;
  if (d > 2 && anew < -2) {
    const step = Math.max(2, Math.abs(aold));
    if (d > step) return { value: aold - step, limited: true };
  }
  return { value: anew, limited: false };
}

/**
 * Newton limiting of a gated state y with output window [lo, hi] (gate width
 * delta, gate offsets lLo/lHi): logarithmic steps on the exponential side of
 * either gate, then a band [lo − band, hi + band] the state is never evaluated
 * outside — except that a state already outside (the window moved in a
 * transient) may only move back. `warm` = a regular iteration with a previous
 * iterate yOld; on a cold/guess iteration only the band applies.
 */
export function limitGatedState(
  ynew: number,
  yold: number,
  w: { lo: number; hi: number; delta: number; lLo: number; lHi: number; band: number },
  warm: boolean,
): { value: number; limited: boolean } {
  let y = ynew;
  let limited = false;
  if (warm) {
    const lo = limitGateArg((ynew - w.lo) / w.delta + w.lLo, (yold - w.lo) / w.delta + w.lLo, w.lLo);
    if (lo.limited) {
      y = w.lo + (lo.value - w.lLo) * w.delta;
      limited = true;
    }
    const hi = limitGateArg((w.hi - ynew) / w.delta + w.lHi, (w.hi - yold) / w.delta + w.lHi, w.lHi);
    if (hi.limited) {
      const yh = w.hi - (hi.value - w.lHi) * w.delta;
      if (!limited || Math.abs(yh - yold) < Math.abs(y - yold)) y = yh;
      limited = true;
    }
  }
  const top = warm ? Math.max(w.hi + w.band, yold) : w.hi + w.band;
  const bottom = warm ? Math.min(w.lo - w.band, yold) : w.lo - w.band;
  const clamped = Math.min(top, Math.max(bottom, y));
  if (clamped !== y) {
    y = clamped;
    if (warm) limited = true;
  }
  return { value: y, limited };
}

/**
 * Equilibrate one equation row (an internal state's residual): divide it by
 * its largest coefficient. The solution is unchanged, but a row whose entries
 * span 1e-4…1e7 (a saturated gain stage at a small transient step) can no
 * longer win the partial pivot of a node column through a tiny coupling and
 * wipe out that node's own (much smaller) conductances.
 */
export function scaleRow(J: number[][], f0: number[], row: number): void {
  let max = 0;
  for (const g of J[row]) max = Math.max(max, Math.abs(g));
  if (!(max > 0) || !Number.isFinite(max)) return;
  for (let j = 0; j < J[row].length; j++) J[row][j] /= max;
  f0[row] /= max;
}
