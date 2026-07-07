import type { CheckSpec } from '../schema/types';

export interface Waveform {
  t: number[];
  y: number[];
}

export interface CheckOutcome {
  pass: boolean;
  /** The scalar the check measured (max, min, settle time, ripple, ...). */
  measured: number;
  /** How far outside the allowed bound, when failing (absolute). */
  outsideBy?: number;
  /** measured/bound ratio when meaningful (band and limit checks). */
  ratio?: number;
  /** Simulated time of the first violating sample (tran checks). */
  tFirstViolation?: number;
}

/** Evaluate a scalar (op-stage) check. */
export function evaluateScalarCheck(check: CheckSpec, value: number): CheckOutcome {
  switch (check.op) {
    case 'within': {
      const pass = value >= check.min && value <= check.max;
      const outsideBy = value < check.min ? check.min - value : value > check.max ? value - check.max : 0;
      const bound = value > check.max ? check.max : check.min;
      return { pass, measured: value, ...(pass ? {} : { outsideBy, ratio: safeRatio(value, bound) }) };
    }
    case 'closeTo': {
      const diff = Math.abs(value - check.value);
      const pass = diff <= check.tol;
      return { pass, measured: value, ...(pass ? {} : { outsideBy: diff - check.tol }) };
    }
    case 'above': {
      const pass = value > check.value;
      return { pass, measured: value, ...(pass ? {} : { outsideBy: check.value - value }) };
    }
    case 'below': {
      const pass = value < check.value;
      return { pass, measured: value, ...(pass ? {} : { outsideBy: value - check.value }) };
    }
    default:
      throw new Error(`check '${check.op}' is not a DC operating-point check`);
  }
}

/** Evaluate a waveform (tran-stage) check. */
export function evaluateTranCheck(check: CheckSpec, wf: Waveform, tstop: number): CheckOutcome {
  const { t, y } = wf;
  if (t.length === 0 || t.length !== y.length) {
    throw new Error(`malformed waveform: ${t.length} time points, ${y.length} values`);
  }
  switch (check.op) {
    case 'settleWithin': {
      const band = Math.abs(check.target) * check.tol;
      const lo = check.target - band;
      const hi = check.target + band;
      let lastOut = -1;
      for (let i = 0; i < y.length; i++) {
        if (y[i] < lo || y[i] > hi) lastOut = i;
      }
      // Settle time: instant after the last out-of-band sample. A signal that
      // never settles reports the end of the window, NOT Infinity — Infinity
      // becomes null under JSON.stringify and would corrupt --json output.
      const never = lastOut === y.length - 1;
      const settleTime = lastOut === -1 ? t[0] : never ? t[t.length - 1] : t[lastOut + 1];
      const pass = !never && settleTime <= check.by;
      let tFirstViolation: number | undefined;
      if (!pass) {
        for (let i = 0; i < y.length; i++) {
          if (t[i] > check.by && (y[i] < lo || y[i] > hi)) {
            tFirstViolation = t[i];
            break;
          }
        }
      }
      return {
        pass,
        measured: settleTime,
        ...(pass ? {} : { outsideBy: settleTime - check.by, tFirstViolation }),
      };
    }
    case 'neverExceed': {
      let max = -Infinity;
      let tFirst: number | undefined;
      for (let i = 0; i < y.length; i++) {
        if (y[i] > max) max = y[i];
        if (tFirst === undefined && y[i] > check.value) tFirst = t[i];
      }
      const pass = max <= check.value;
      return {
        pass,
        measured: max,
        ...(pass ? {} : { outsideBy: max - check.value, ratio: safeRatio(max, check.value), tFirstViolation: tFirst }),
      };
    }
    case 'stayAbove': {
      const from = check.from ?? 0;
      let min = Infinity;
      let tFirst: number | undefined;
      for (let i = 0; i < y.length; i++) {
        if (t[i] < from) continue;
        if (y[i] < min) min = y[i];
        if (tFirst === undefined && y[i] < check.value) tFirst = t[i];
      }
      if (min === Infinity) throw new Error(`stayAbove: window from=${from} contains no samples (tstop=${tstop})`);
      const pass = min >= check.value;
      return { pass, measured: min, ...(pass ? {} : { outsideBy: check.value - min, tFirstViolation: tFirst }) };
    }
    case 'stayBelow': {
      const from = check.from ?? 0;
      let max = -Infinity;
      let tFirst: number | undefined;
      for (let i = 0; i < y.length; i++) {
        if (t[i] < from) continue;
        if (y[i] > max) max = y[i];
        if (tFirst === undefined && y[i] > check.value) tFirst = t[i];
      }
      if (max === -Infinity) throw new Error(`stayBelow: window from=${from} contains no samples (tstop=${tstop})`);
      const pass = max <= check.value;
      return { pass, measured: max, ...(pass ? {} : { outsideBy: max - check.value, tFirstViolation: tFirst }) };
    }
    case 'rippleBelow': {
      const from = check.from ?? tstop / 2;
      let min = Infinity;
      let max = -Infinity;
      for (let i = 0; i < y.length; i++) {
        if (t[i] < from) continue;
        if (y[i] < min) min = y[i];
        if (y[i] > max) max = y[i];
      }
      if (min === Infinity) throw new Error(`rippleBelow: window from=${from} contains no samples (tstop=${tstop})`);
      const ripple = max - min;
      const pass = ripple <= check.amplitude;
      return { pass, measured: ripple, ...(pass ? {} : { outsideBy: ripple - check.amplitude }) };
    }
    case 'finalCloseTo': {
      const final = y[y.length - 1];
      const diff = Math.abs(final - check.value);
      const pass = diff <= check.tol;
      return { pass, measured: final, ...(pass ? {} : { outsideBy: diff - check.tol, tFirstViolation: t[t.length - 1] }) };
    }
    default:
      throw new Error(`check '${check.op}' is not a transient check`);
  }
}

function safeRatio(value: number, bound: number): number | undefined {
  if (bound === 0 || !Number.isFinite(bound)) return undefined;
  const r = value / bound;
  return Number.isFinite(r) ? Math.round(r * 100) / 100 : undefined;
}
