import { parseValue } from '../core/units';

/**
 * Independent-source waveforms. Every waveform is plain JSON data (numbers in
 * SI units, defaults materialized) so a source can be serialized through the
 * netlist `params` and rebuilt identically.
 */

type ValueLike = number | string;

/** offset + amplitude·e^(−damping·(t−delay))·sin(2π·freq·(t−delay) + phase°) for t > delay. */
export interface SinWave {
  offset: number;
  amplitude: number;
  freq: number;
  delay: number;
  damping: number;
  /** degrees */
  phase: number;
}

/** SPICE PULSE: v1 → (td) → rise tr → v2 for pw → fall tf → v1, repeating every per. */
export interface PulseWave {
  v1: number;
  v2: number;
  td: number;
  tr: number;
  tf: number;
  pw: number;
  /** Period; omitted for a single pulse. */
  per?: number;
}

/** Piecewise-linear: [time, value] corners, strictly increasing times. */
export interface PwlWave {
  points: [number, number][];
  /** Repeat the pattern with period = last time − first time. */
  repeat: boolean;
}

/** Square/PWM: duty is the fraction of the period above the 50 % level. */
export interface PwmWave {
  low: number;
  high: number;
  freq: number;
  /** 0 < duty < 1 */
  duty: number;
  rise: number;
  fall: number;
  delay: number;
}

export type WaveformSpec =
  | { sin: SinWave }
  | { pulse: PulseWave }
  | { pwl: PwlWave }
  | { pwm: PwmWave };

export type WaveKind = 'sin' | 'pulse' | 'pwl' | 'pwm';
export const WAVE_KINDS: WaveKind[] = ['sin', 'pulse', 'pwl', 'pwm'];

// ─── Authoring input (units strings accepted) ────────────────────────────────

export interface SinInput {
  offset?: ValueLike;
  amplitude: ValueLike;
  freq: ValueLike;
  delay?: ValueLike;
  damping?: ValueLike;
  phase?: ValueLike;
}
export interface PulseInput {
  v1: ValueLike;
  v2: ValueLike;
  td?: ValueLike;
  tr?: ValueLike;
  tf?: ValueLike;
  pw: ValueLike;
  per?: ValueLike;
}
export interface PwlInput {
  points: [ValueLike, ValueLike][];
  repeat?: boolean;
}
export interface PwmInput {
  low?: ValueLike;
  high: ValueLike;
  freq: ValueLike;
  /** fraction (0.25) or percentage string ('25%') */
  duty: ValueLike;
  rise?: ValueLike;
  fall?: ValueLike;
  delay?: ValueLike;
}

export interface WaveformInput {
  sin?: SinInput;
  pulse?: PulseInput;
  pwl?: PwlInput;
  pwm?: PwmInput;
}

function num(v: ValueLike | undefined, what: string, dflt?: number): number {
  if (v === undefined) {
    if (dflt === undefined) throw new Error(`${what} is required`);
    return dflt;
  }
  return parseValue(v, what);
}

function nonNeg(v: number, what: string): number {
  if (v < 0) throw new Error(`${what} must be >= 0, got ${v}`);
  return v;
}

function positive(v: number, what: string): number {
  if (!(v > 0)) throw new Error(`${what} must be > 0, got ${v}`);
  return v;
}

function parseDuty(v: ValueLike): number {
  if (typeof v === 'string' && v.trim().endsWith('%')) {
    const n = Number(v.trim().slice(0, -1));
    if (!Number.isFinite(n)) throw new Error(`pwm duty '${v}' is not a percentage`);
    return n / 100;
  }
  return parseValue(v, 'pwm duty');
}

/** Pick the (single) waveform from an options object, normalized. Null when none. */
export function normalizeWaveform(input: WaveformInput, who: string): WaveformSpec | null {
  const given = WAVE_KINDS.filter(k => input[k] !== undefined);
  if (given.length > 1) {
    throw new Error(`${who}: give at most one waveform, got ${given.join(' + ')}`);
  }
  if (given.length === 0) return null;
  const kind = given[0];
  const p = `${who} ${kind}`;
  switch (kind) {
    case 'sin': {
      const s = input.sin!;
      return {
        sin: {
          offset: num(s.offset, `${p}.offset`, 0),
          amplitude: num(s.amplitude, `${p}.amplitude`),
          freq: positive(num(s.freq, `${p}.freq`), `${p}.freq`),
          delay: nonNeg(num(s.delay, `${p}.delay`, 0), `${p}.delay`),
          damping: num(s.damping, `${p}.damping`, 0),
          phase: num(s.phase, `${p}.phase`, 0),
        },
      };
    }
    case 'pulse': {
      const s = input.pulse!;
      const w: PulseWave = {
        v1: num(s.v1, `${p}.v1`),
        v2: num(s.v2, `${p}.v2`),
        td: nonNeg(num(s.td, `${p}.td`, 0), `${p}.td`),
        tr: nonNeg(num(s.tr, `${p}.tr`, 0), `${p}.tr`),
        tf: nonNeg(num(s.tf, `${p}.tf`, 0), `${p}.tf`),
        pw: nonNeg(num(s.pw, `${p}.pw`), `${p}.pw`),
      };
      if (s.per !== undefined) {
        const per = positive(num(s.per, `${p}.per`), `${p}.per`);
        if (w.tr + w.pw + w.tf > per * (1 + 1e-12)) {
          throw new Error(`${p}: tr + pw + tf (${w.tr + w.pw + w.tf}) exceeds the period per=${per}`);
        }
        w.per = per;
      }
      return { pulse: w };
    }
    case 'pwl': {
      const s = input.pwl!;
      if (!Array.isArray(s.points) || s.points.length === 0) {
        throw new Error(`${p}.points must be a non-empty array of [time, value] pairs`);
      }
      const points = s.points.map((pt, i): [number, number] => {
        if (!Array.isArray(pt) || pt.length !== 2) throw new Error(`${p}.points[${i}] must be [time, value]`);
        return [nonNeg(parseValue(pt[0], `${p}.points[${i}] time`), `${p}.points[${i}] time`), parseValue(pt[1], `${p}.points[${i}] value`)];
      });
      for (let i = 1; i < points.length; i++) {
        if (!(points[i][0] > points[i - 1][0])) {
          throw new Error(`${p}.points times must be strictly increasing (point ${i}: ${points[i][0]} after ${points[i - 1][0]})`);
        }
      }
      const repeat = s.repeat === true;
      if (repeat && points.length < 2) throw new Error(`${p}: repeat needs at least two points`);
      return { pwl: { points, repeat } };
    }
    case 'pwm': {
      const s = input.pwm!;
      const w: PwmWave = {
        low: num(s.low, `${p}.low`, 0),
        high: num(s.high, `${p}.high`),
        freq: positive(num(s.freq, `${p}.freq`), `${p}.freq`),
        duty: parseDuty(s.duty),
        rise: nonNeg(num(s.rise, `${p}.rise`, 0), `${p}.rise`),
        fall: nonNeg(num(s.fall, `${p}.fall`, 0), `${p}.fall`),
        delay: nonNeg(num(s.delay, `${p}.delay`, 0), `${p}.delay`),
      };
      if (!(w.duty > 0 && w.duty < 1)) {
        throw new Error(`${p}.duty must be strictly between 0 and 1 (or '0%'..'100%' exclusive), got ${w.duty}; use a DC source for 0 % / 100 %`);
      }
      const per = 1 / w.freq;
      const pw = w.duty * per - (w.rise + w.fall) / 2;
      if (pw < 0 || pw + w.rise + w.fall > per * (1 + 1e-12)) {
        throw new Error(`${p}: rise/fall (${w.rise}/${w.fall}) too slow for duty ${w.duty} at ${w.freq} Hz`);
      }
      return { pwm: w };
    }
  }
}

/** Rebuild-safe deep copy of a normalized waveform (for params / reconstruction). */
export function waveformToJSON(w: WaveformSpec): Record<string, unknown> {
  return JSON.parse(JSON.stringify(w));
}

/** PWM as the equivalent PULSE. */
export function pwmAsPulse(w: PwmWave): PulseWave {
  const per = 1 / w.freq;
  return {
    v1: w.low,
    v2: w.high,
    td: w.delay,
    tr: w.rise,
    tf: w.fall,
    pw: w.duty * per - (w.rise + w.fall) / 2,
    per,
  };
}

function pulseValue(w: PulseWave, t: number): number {
  if (t <= w.td) return w.v1;
  let tt = t - w.td;
  const span = w.tr + w.pw + w.tf;
  if (w.per !== undefined) {
    const k = Math.floor(tt / w.per);
    tt -= k * w.per;
    // Snap round-off at the period boundary back to the end of the previous period.
    if (tt < w.per * 1e-12 && k > 0) tt = 0;
  }
  const eps = Math.max(span, w.per ?? 0) * 1e-12;
  if (tt <= eps) return w.v1;
  if (tt <= w.tr) return w.v1 + ((w.v2 - w.v1) * tt) / w.tr;
  if (tt <= w.tr + w.pw + eps) return w.v2;
  if (tt <= span) return w.v2 + ((w.v1 - w.v2) * (tt - w.tr - w.pw)) / w.tf;
  return w.v1;
}

function pulseCorners(w: PulseWave): number[] {
  return [0, w.tr, w.tr + w.pw, w.tr + w.pw + w.tf];
}

function pulseNextBreakpoint(w: PulseWave, t: number): number {
  const corners = pulseCorners(w);
  const after = (base: number): number => {
    for (const c of corners) {
      const bp = base + c;
      if (bp > t * (1 + 1e-13) + 1e-300 && bp > t) return bp;
    }
    return Infinity;
  };
  if (w.per === undefined) return after(w.td);
  const k = Math.max(0, Math.floor((t - w.td) / w.per));
  const first = after(w.td + k * w.per);
  if (first !== Infinity) return first;
  return after(w.td + (k + 1) * w.per);
}

function pwlValue(w: PwlWave, t: number): number {
  const pts = w.points;
  const t0 = pts[0][0];
  const tEnd = pts[pts.length - 1][0];
  let tt = t;
  if (w.repeat && t > tEnd) {
    const period = tEnd - t0;
    const k = Math.floor((t - t0) / period);
    tt = t - k * period;
    if (tt <= t0 + period * 1e-12) tt = tEnd; // left-continuous at the wrap
  }
  if (tt <= t0) return pts[0][1];
  if (tt >= tEnd) return pts[pts.length - 1][1];
  // binary search for the segment containing tt
  let lo = 0;
  let hi = pts.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (pts[mid][0] <= tt) lo = mid;
    else hi = mid;
  }
  const [ta, va] = pts[lo];
  const [tb, vb] = pts[hi];
  return va + ((vb - va) * (tt - ta)) / (tb - ta);
}

function pwlNextBreakpoint(w: PwlWave, t: number): number {
  const pts = w.points;
  const t0 = pts[0][0];
  const tEnd = pts[pts.length - 1][0];
  const strictlyAfter = (bp: number) => bp > t && bp > t * (1 + 1e-13);
  if (!w.repeat || t < tEnd) {
    for (const [tp] of pts) if (strictlyAfter(tp)) return tp;
    if (!w.repeat) return Infinity;
  }
  const period = tEnd - t0;
  let k = Math.max(1, Math.floor((t - t0) / period));
  for (let guard = 0; guard < 3; guard++, k++) {
    for (let i = 1; i < pts.length; i++) {
      const bp = pts[i][0] + k * period;
      if (strictlyAfter(bp)) return bp;
    }
  }
  return Infinity;
}

/** Waveform value at time t (t ≥ 0). */
export function waveformValue(w: WaveformSpec, t: number): number {
  if ('sin' in w) {
    const s = w.sin;
    const ph = (s.phase * Math.PI) / 180;
    if (t <= s.delay) return s.offset + s.amplitude * Math.sin(ph);
    const tt = t - s.delay;
    return s.offset + s.amplitude * Math.exp(-s.damping * tt) * Math.sin(2 * Math.PI * s.freq * tt + ph);
  }
  if ('pulse' in w) return pulseValue(w.pulse, t);
  if ('pwm' in w) return pulseValue(pwmAsPulse(w.pwm), t);
  return pwlValue(w.pwl, t);
}

/** Smallest corner strictly after t (Infinity when none). */
export function waveformNextBreakpoint(w: WaveformSpec, t: number): number {
  if ('sin' in w) return w.sin.delay > t ? w.sin.delay : Infinity;
  if ('pulse' in w) return pulseNextBreakpoint(w.pulse, t);
  if ('pwm' in w) return pulseNextBreakpoint(pwmAsPulse(w.pwm), t);
  return pwlNextBreakpoint(w.pwl, t);
}

/** A step cap so smooth waveforms are resolved (≥ 25 points per sine period). */
export function waveformMaxStep(w: WaveformSpec): number {
  if ('sin' in w) return 1 / (w.sin.freq * 25);
  return Infinity;
}
