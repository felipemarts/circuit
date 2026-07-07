/**
 * Engineering-notation value parsing: '4.7k' → 4700, '10m' → 0.01, '2u' → 2e-6.
 * Multipliers are case-sensitive (m = milli, M = mega); a trailing unit
 * (V, A, F, H, s, Hz, ohm) is accepted and ignored.
 */

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

const VALUE_RE = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)\s*([TGMkKmuµnpf])?\s*(A|V|F|H|s|Hz|Ohm|ohm|Ω)?$/;

export function parseValue(input: number | string, what = 'value'): number {
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) {
      throw new Error(`invalid ${what}: ${input} is not a finite number`);
    }
    return input;
  }
  const m = input.trim().match(VALUE_RE);
  if (!m) {
    throw new Error(
      `invalid ${what} '${input}': expected a number with optional engineering suffix, e.g. '4.7k', '10m', '2u', '1e-6'`,
    );
  }
  const base = Number(m[1]);
  const mult = m[2] ? MULTIPLIERS[m[2]] : 1;
  const value = base * mult;
  if (!Number.isFinite(value)) {
    throw new Error(`invalid ${what} '${input}': not a finite number`);
  }
  return value;
}

const ENG_SUFFIXES: [number, string][] = [
  [1e12, 'T'],
  [1e9, 'G'],
  [1e6, 'M'],
  [1e3, 'k'],
  [1, ''],
  [1e-3, 'm'],
  [1e-6, 'u'],
  [1e-9, 'n'],
  [1e-12, 'p'],
  [1e-15, 'f'],
];

/** 0.01364 → '13.64m'; 4700 → '4.7k'. Deterministic, for reports. */
export function formatEng(value: number, unit = ''): string {
  if (value === 0) return `0${unit}`;
  if (!Number.isFinite(value)) return `${value}`;
  const abs = Math.abs(value);
  for (const [scale, suffix] of ENG_SUFFIXES) {
    if (abs >= scale) {
      const scaled = value / scale;
      const rounded = Math.round(scaled * 1000) / 1000;
      return `${rounded}${suffix}${unit}`;
    }
  }
  const [scale, suffix] = ENG_SUFFIXES[ENG_SUFFIXES.length - 1];
  const rounded = Math.round((value / scale) * 1000) / 1000;
  return `${rounded}${suffix}${unit}`;
}
