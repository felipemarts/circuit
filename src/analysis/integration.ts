import type { Component } from '../core/Component';

/**
 * One integrated quantity of a reactive element — a capacitor's charge or an
 * inductor's flux. The transient engine owns the stepping; the element only
 * asks `ctx.integrate(state, value)` for the derivative each iteration.
 *
 * History index 0 is the most recent ACCEPTED time point; the `value`/
 * `derivative` pair is the tentative value of the step being attempted, which
 * a rejected step simply discards.
 */
export class ReactiveState {
  /** Accepted values, most recent first (t_n, t_{n-1}, t_{n-2}, t_{n-3}). */
  readonly hx = new Float64Array(4);
  /** Accepted derivatives, most recent first. */
  readonly hd = new Float64Array(4);
  /** Tentative value/derivative of the step in progress. */
  value = 0;
  derivative = 0;
  /** @internal engine bookkeeping: iteration stamp of the last integrate() call. */
  _stamp = -1;
  /** @internal integration parameters of the tentative step (for finalize). */
  _h = 0;
  _method: 'be' | 'trap' = 'be';
  /**
   * Evaluates the quantity from a solution vector. The engine re-evaluates
   * the tentative value at the converged solution before committing (the
   * last load saw the previous iterate).
   */
  evaluate: ((x: ArrayLike<number>) => number) | null = null;

  constructor(
    /** Device that owns the state — named as the culprit when the step collapses. */
    readonly owner: Component,
    /** Absolute tolerance on the derivative (A for a charge, V for a flux). */
    readonly absDerivative: number,
    /** Absolute tolerance floor on the value (C for a charge, Wb for a flux). */
    readonly absValue: number,
  ) {}

  /** Recompute the tentative value/derivative at the converged solution. */
  finalize(x: ArrayLike<number>): void {
    if (!this.evaluate || this._h <= 0) return;
    integrateStep(this, this.evaluate(x), this._h, this._method);
  }

  /** Commit the tentative value as the newest accepted point. */
  commit(): void {
    for (let k = 3; k > 0; k--) {
      this.hx[k] = this.hx[k - 1];
      this.hd[k] = this.hd[k - 1];
    }
    this.hx[0] = this.value;
    this.hd[0] = this.derivative;
  }

  /** Seed the state (t = 0 or start from the operating point). */
  seed(value: number, derivative: number): void {
    this.hx.fill(value);
    this.hd.fill(derivative);
    this.value = value;
    this.derivative = derivative;
  }
}

/** Integration step: derivative and its sensitivity for method/h. */
export function integrateStep(
  state: ReactiveState,
  value: number,
  h: number,
  method: 'be' | 'trap',
): { derivative: number; coeff: number } {
  let derivative: number;
  let coeff: number;
  if (method === 'trap') {
    coeff = 2 / h;
    derivative = coeff * (value - state.hx[0]) - state.hd[0];
  } else {
    coeff = 1 / h;
    derivative = coeff * (value - state.hx[0]);
  }
  state.value = value;
  state.derivative = derivative;
  state._h = h;
  state._method = method;
  return { derivative, coeff };
}

export interface LteTolerances {
  reltol: number;
  trtol: number;
}

/**
 * Local truncation error of the tentative step, relative to its tolerance
 * (≤ 1 is acceptable), estimated from divided differences of the value
 * history: BE ≈ h²·|x''|/2, trapezoidal ≈ h³·|x'''|/12.
 *
 * `times` holds the accepted times, most recent first; `points` is how many
 * of them are valid since the last breakpoint (derivatives jump at a
 * breakpoint, so differences must not straddle one).
 */
export function lteRatio(
  state: ReactiveState,
  tNew: number,
  times: Float64Array,
  points: number,
  order: 1 | 2,
  tol: LteTolerances,
): { ratio: number; order: 1 | 2 } | null {
  // Need order+2 points including the tentative one.
  let k: 1 | 2 = order;
  if (points + 1 < k + 2) k = 1;
  if (points + 1 < k + 2) return null;
  const ts = [tNew, times[0], times[1], times[2]];
  const xs = [state.value, state.hx[0], state.hx[1], state.hx[2]];
  // Divided differences up to order k+1.
  const n = k + 2;
  const dd = xs.slice(0, n);
  for (let level = 1; level < n; level++) {
    for (let i = 0; i < n - level; i++) {
      dd[i] = (dd[i] - dd[i + 1]) / (ts[i] - ts[i + level]);
    }
  }
  const h = tNew - times[0];
  const top = Math.abs(dd[0]); // ≈ x^(k+1)/(k+1)!
  // BE: h²·x''/2 = h²·DD2 ; trap: h³·x'''/12 = h³·DD3/2
  const lte = k === 1 ? h * h * top : (h * h * h * top) / 2;
  const tolValue = tol.reltol * Math.max(Math.abs(state.value), Math.abs(state.hx[0])) + state.absValue;
  const tolFromDerivative =
    h * (tol.reltol * Math.max(Math.abs(state.derivative), Math.abs(state.hd[0])) + state.absDerivative);
  const allowed = tol.trtol * Math.max(tolValue, tolFromDerivative);
  return { ratio: lte / allowed, order: k };
}
