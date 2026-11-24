/**
 * Time and value parsing for the digital engine.
 *
 * Internal timebase: integer PICOSECONDS held in a JS number. Integers are
 * exact up to 2^53, so the engine can represent ~9007 s of simulated time
 * with no float drift: every event time is an integer tick, comparisons are
 * exact, and a repeating clock computes each edge from its index (never by
 * accumulating a period), so edge n is always within 0.5 ps of n·period.
 *
 * The public API speaks seconds (floats). Conversion is `Math.round(s * 1e12)`;
 * because ticks are integers far below 2^53, `toTicks(fromTicks(k)) === k`
 * exactly — a time handed out by `nextEventTime()` and passed back into
 * `advanceTo()` lands on the same tick.
 *
 * This module deliberately duplicates the small engineering-suffix parser of
 * src/core/units so src/digital stays self-contained (the integrator may
 * dedupe it).
 */

export type ValueLike = number | string;

/** Ticks per second of the internal timebase (1 tick = 1 ps). */
export const TICKS_PER_SECOND = 1e12;

const MAX_TICKS = Number.MAX_SAFE_INTEGER;

const MULTIPLIERS: Record<string, number> = {
  T: 1e12,
  G: 1e9,
  M: 1e6,
  k: 1e3,
  K: 1e3,
  m: 1e-3,
  u: 1e-6,
  'µ': 1e-6,
  n: 1e-9,
  p: 1e-12,
  f: 1e-15,
};

const VALUE_RE = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)\s*([TGMkKmuµnpf])?\s*(s|Hz|hz)?$/;

/** '10n' → 1e-8, '1M' → 1e6, 5 → 5. Multipliers are case-sensitive (m = milli, M = mega). */
export function parseNumber(input: ValueLike, what = 'value'): number {
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) throw new Error(`invalid ${what}: ${input} is not a finite number`);
    return input;
  }
  if (typeof input !== 'string') {
    throw new Error(`invalid ${what}: expected a number or a string like '10n', got ${JSON.stringify(input)}`);
  }
  const m = input.trim().match(VALUE_RE);
  if (!m) {
    throw new Error(
      `invalid ${what} '${input}': expected a number with optional engineering suffix, e.g. '10n', '1u', '2.5m', '1e-6'`,
    );
  }
  const value = Number(m[1]) * (m[2] ? MULTIPLIERS[m[2]] : 1);
  if (!Number.isFinite(value)) throw new Error(`invalid ${what} '${input}': not a finite number`);
  return value;
}

/** A non-negative time in seconds. */
export function parseTime(input: ValueLike, what = 'time'): number {
  const v = parseNumber(input, what);
  if (v < 0) throw new Error(`invalid ${what} ${JSON.stringify(input)}: time must be >= 0`);
  if (v * TICKS_PER_SECOND > MAX_TICKS) {
    throw new Error(`invalid ${what} ${JSON.stringify(input)}: exceeds the ${Math.floor(MAX_TICKS / TICKS_PER_SECOND)} s range of the 1 ps timebase`);
  }
  return v;
}

/** A strictly positive frequency in Hz. */
export function parseFrequency(input: ValueLike, what = 'frequency'): number {
  const v = parseNumber(input, what);
  if (!(v > 0)) throw new Error(`invalid ${what} ${JSON.stringify(input)}: must be > 0`);
  return v;
}

/** Seconds → integer ticks (round to nearest picosecond). */
export function toTicks(seconds: number): number {
  return Math.round(seconds * TICKS_PER_SECOND);
}

/** Integer ticks → seconds. */
export function fromTicks(ticks: number): number {
  return ticks / TICKS_PER_SECOND;
}

const ENG: [number, string][] = [
  [1, ''],
  [1e-3, 'm'],
  [1e-6, 'u'],
  [1e-9, 'n'],
  [1e-12, 'p'],
];

/** 1.5e-9 → '1.5ns', 0.002 → '2ms'. Deterministic, for messages. */
export function formatTime(seconds: number): string {
  if (seconds === 0) return '0s';
  if (!Number.isFinite(seconds)) return `${seconds}s`;
  const abs = Math.abs(seconds);
  for (const [scale, suffix] of ENG) {
    if (abs >= scale * 0.9995 || scale === 1e-12) {
      const r = Math.round((seconds / scale) * 1000) / 1000;
      return `${r}${suffix}s`;
    }
  }
  return `${seconds}s`;
}
