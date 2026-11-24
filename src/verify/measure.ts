import type { CheckSpec, ScalarCheck } from '../schema/types';

/**
 * Measurement kernel. Waveforms and curves may be sampled non-uniformly
 * (adaptive transient steps, arbitrary sweeps), so every measurement treats
 * the samples as a piecewise-linear signal: crossings and window starts are
 * interpolated, never snapped to the nearest sample.
 */

export interface Waveform {
  t: number[];
  y: number[];
}

export interface CheckOutcome {
  pass: boolean;
  /** The scalar the check measured (max, min, settle time, ripple, ...). Absent when it could not be measured. */
  measured?: number;
  /** How far outside the allowed bound, when failing (absolute). */
  outsideBy?: number;
  /** measured/bound ratio when meaningful (band and limit checks). */
  ratio?: number;
  /** Simulated time of the first violation (tran checks). */
  tFirstViolation?: number;
  /** Sweep value of the first violation (dc/ac checks). */
  xFirstViolation?: number;
  /** Why the measurement is missing or how it was obtained. */
  note?: string;
}

/** Evaluate a scalar (op-stage) check. */
export function evaluateScalarCheck(check: CheckSpec, value: number): CheckOutcome & { measured: number } {
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
      throw new Error(`check '${check.op}' is not a scalar check`);
  }
}

/** Linear interpolation of a piecewise-linear signal at t (clamped to the ends). */
export function valueAt(xs: ArrayLike<number>, ys: ArrayLike<number>, x: number): number {
  const n = xs.length;
  if (n === 0) throw new Error('valueAt: empty signal');
  const ascending = xs[n - 1] >= xs[0];
  const before = (a: number, b: number) => (ascending ? a <= b : a >= b);
  if (before(x, xs[0])) return ys[0];
  if (before(xs[n - 1], x)) return ys[n - 1];
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (before(xs[mid], x)) lo = mid;
    else hi = mid;
  }
  const dx = xs[hi] - xs[lo];
  if (dx === 0) return ys[hi];
  return ys[lo] + ((ys[hi] - ys[lo]) * (x - xs[lo])) / dx;
}

/** Time where the segment (t0,y0)–(t1,y1) reaches `level` (clamped to the segment). */
function crossing(t0: number, y0: number, t1: number, y1: number, level: number): number {
  if (y1 === y0) return t1;
  const f = (level - y0) / (y1 - y0);
  return t0 + Math.min(1, Math.max(0, f)) * (t1 - t0);
}

/** The window [from, end] as samples, starting with the interpolated value at `from`. */
function windowFrom(wf: Waveform, from: number): Waveform {
  const { t, y } = wf;
  const out: Waveform = { t: [], y: [] };
  if (from > t[t.length - 1]) return out;
  if (from > t[0]) {
    out.t.push(from);
    out.y.push(valueAt(t, y, from));
  }
  for (let i = 0; i < t.length; i++) {
    if (t[i] < from) continue;
    if (out.t.length > 0 && t[i] === out.t[out.t.length - 1]) continue;
    out.t.push(t[i]);
    out.y.push(y[i]);
  }
  return out;
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
      // Settle time: where the signal re-enters the band after the last
      // out-of-band sample (interpolated). A signal that never settles reports
      // the end of the window, NOT Infinity — Infinity becomes null under
      // JSON.stringify and would corrupt --json output.
      const never = lastOut === y.length - 1;
      let settleTime: number;
      if (lastOut === -1) settleTime = t[0];
      else if (never) settleTime = t[t.length - 1];
      else {
        const edge = y[lastOut] > hi ? hi : lo;
        settleTime = crossing(t[lastOut], y[lastOut], t[lastOut + 1], y[lastOut + 1], edge);
      }
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
        if (tFirst === undefined && y[i] > check.value) {
          tFirst = i === 0 ? t[0] : crossing(t[i - 1], y[i - 1], t[i], y[i], check.value);
        }
      }
      const pass = max <= check.value;
      return {
        pass,
        measured: max,
        ...(pass ? {} : { outsideBy: max - check.value, ratio: safeRatio(max, check.value), tFirstViolation: tFirst }),
      };
    }
    case 'stayAbove':
    case 'stayBelow': {
      const from = check.from ?? 0;
      const w = windowFrom(wf, from);
      if (w.t.length === 0) throw new Error(`${check.op}: window from=${from} contains no samples (tstop=${tstop})`);
      const above = check.op === 'stayAbove';
      let extreme = above ? Infinity : -Infinity;
      let tFirst: number | undefined;
      for (let i = 0; i < w.y.length; i++) {
        const v = w.y[i];
        if (above ? v < extreme : v > extreme) extreme = v;
        const bad = above ? v < check.value : v > check.value;
        if (tFirst === undefined && bad) {
          tFirst = i === 0 ? w.t[0] : crossing(w.t[i - 1], w.y[i - 1], w.t[i], w.y[i], check.value);
        }
      }
      const pass = above ? extreme >= check.value : extreme <= check.value;
      const outsideBy = above ? check.value - extreme : extreme - check.value;
      return { pass, measured: extreme, ...(pass ? {} : { outsideBy, tFirstViolation: tFirst }) };
    }
    case 'rippleBelow': {
      const from = check.from ?? tstop / 2;
      const w = windowFrom(wf, from);
      if (w.t.length === 0) throw new Error(`rippleBelow: window from=${from} contains no samples (tstop=${tstop})`);
      let min = Infinity;
      let max = -Infinity;
      for (const v of w.y) {
        if (v < min) min = v;
        if (v > max) max = v;
      }
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

/** Apply a scalar check to a measurement that may be missing. */
export function checkMeasurement(check: ScalarCheck, measured: number | undefined, note?: string): CheckOutcome {
  if (measured === undefined || !Number.isFinite(measured)) {
    return { pass: false, note: note ?? 'the quantity could not be measured' };
  }
  const out = evaluateScalarCheck(check, measured);
  return note ? { ...out, note } : out;
}

/** Curve sorted by ascending x (DC sweeps may run downward). */
function ascending(xs: number[], ys: number[]): { x: number[]; y: number[] } {
  if (xs.length < 2 || xs[xs.length - 1] >= xs[0]) return { x: xs, y: ys };
  return { x: [...xs].reverse(), y: [...ys].reverse() };
}

/** Derivative estimate at each sample: central differences, one-sided at the ends. */
export function slopes(xs: number[], ys: number[]): number[] {
  const n = xs.length;
  const s: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - 1);
    const b = Math.min(n - 1, i + 1);
    s.push((ys[b] - ys[a]) / (xs[b] - xs[a]));
  }
  return s;
}

/** Evaluate a DC-sweep curve check. */
export function evaluateDcCheck(check: CheckSpec, xs: number[], ys: number[]): CheckOutcome {
  if (xs.length < 2 || xs.length !== ys.length) {
    throw new Error(`malformed curve: ${xs.length} sweep points, ${ys.length} values`);
  }
  const c = ascending(xs, ys);
  switch (check.op) {
    case 'at':
      return checkMeasurement(check.check, valueAt(c.x, c.y, check.x));
    case 'slopeAt':
      return checkMeasurement(check.check, valueAt(c.x, slopes(c.x, c.y), check.x));
    case 'monotonic': {
      const sign = check.direction === 'increasing' ? 1 : -1;
      let scale = 0;
      for (const v of c.y) scale = Math.max(scale, Math.abs(v));
      const tol = 1e-9 * scale + 1e-15;
      let worst = 0;
      let xFirst: number | undefined;
      for (let i = 1; i < c.y.length; i++) {
        const against = -sign * (c.y[i] - c.y[i - 1]);
        if (against > tol) {
          if (xFirst === undefined) xFirst = c.x[i];
          worst = Math.max(worst, against);
        }
      }
      const pass = xFirst === undefined;
      return {
        pass,
        measured: worst,
        ...(pass ? {} : { outsideBy: worst, xFirstViolation: xFirst }),
        note: `measured: largest step against the ${check.direction} direction`,
      };
    }
    case 'crosses': {
      let xc: number | undefined;
      for (let i = 1; i < c.y.length; i++) {
        const a = c.y[i - 1] - check.level;
        const b = c.y[i] - check.level;
        if (a === 0) {
          xc = c.x[i - 1];
          break;
        }
        if ((a < 0 && b >= 0) || (a > 0 && b <= 0)) {
          xc = crossing(c.x[i - 1], c.y[i - 1], c.x[i], c.y[i], check.level);
          break;
        }
      }
      if (xc === undefined) {
        const lo = Math.min(...c.y);
        const hi = Math.max(...c.y);
        return { pass: false, note: `never crosses ${check.level} within the sweep (curve spans [${lo.toPrecision(6)}, ${hi.toPrecision(6)}])` };
      }
      const min = check.min ?? -Infinity;
      const max = check.max ?? Infinity;
      const pass = xc >= min && xc <= max;
      return {
        pass,
        measured: xc,
        ...(pass ? {} : { outsideBy: xc < min ? min - xc : xc - max, xFirstViolation: xc }),
      };
    }
    default:
      throw new Error(`check '${check.op}' is not a DC-sweep check`);
  }
}

function safeRatio(value: number, bound: number): number | undefined {
  if (bound === 0 || !Number.isFinite(bound)) return undefined;
  const r = value / bound;
  return Number.isFinite(r) ? Math.round(r * 100) / 100 : undefined;
}
