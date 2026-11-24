/**
 * Four-valued logic (0, 1, X, Z), operator tables and multi-driver resolution.
 *
 * Public values are the plain-JSON `Logic` type: 0 | 1 | 'X' | 'Z'.
 * Internally the kernel uses small integer codes for speed:
 *   value code  0 → 0, 1 → 1, 2 → X, 3 → Z
 *   drive code  value | (strength << 2), strength 0 = none (Z), 1 = weak, 2 = strong
 *
 * Gate inputs read Z as X (a floating CMOS input is unknown), so every
 * operator table treats Z exactly like X. Controlling values dominate:
 * AND(0, X) = 0, OR(1, X) = 1; XOR has no controlling value, so any X/Z → X.
 */

export type Logic = 0 | 1 | 'X' | 'Z';
export type Strength = 'strong' | 'weak';

/** Internal value codes. */
export type Code = 0 | 1 | 2 | 3;
export const C0 = 0;
export const C1 = 1;
export const CX = 2;
export const CZ = 3;

/** Internal drive codes (value | strength << 2). */
export const S0 = 8;
export const S1 = 9;
export const SX = 10;
export const W0 = 4;
export const W1 = 5;
export const WX = 6;
export const DZ = 3;

const FROM_CODE: Logic[] = [0, 1, 'X', 'Z'];

export function toCode(v: Logic): Code {
  switch (v) {
    case 0:
      return 0;
    case 1:
      return 1;
    case 'X':
      return 2;
    case 'Z':
      return 3;
  }
  throw new Error(`invalid logic value ${JSON.stringify(v)}: expected 0, 1, 'X' or 'Z'`);
}

export function fromCode(c: number): Logic {
  return FROM_CODE[c & 3];
}

/** Accepts 0/1, '0'/'1', true/false, 'X'/'x', 'Z'/'z' and returns the canonical Logic value. */
export function parseLogic(v: unknown, what = 'logic value'): Logic {
  if (v === 0 || v === '0' || v === false) return 0;
  if (v === 1 || v === '1' || v === true) return 1;
  if (v === 'X' || v === 'x') return 'X';
  if (v === 'Z' || v === 'z') return 'Z';
  throw new Error(`invalid ${what} ${JSON.stringify(v)}: expected 0, 1, 'X' or 'Z'`);
}

/** Strong drive of a value code (Z stays Z). */
export function strong(c: number): number {
  return c === CZ ? DZ : c | 8;
}

/** Weak drive of a value code (Z stays Z). */
export function weak(c: number): number {
  return c === CZ ? DZ : c | 4;
}

export function driveValue(d: number): Code {
  return (d & 3) as Code;
}

export function driveStrength(d: number): 0 | 1 | 2 {
  return (d >> 2) as 0 | 1 | 2;
}

export function makeDrive(v: Logic, s: Strength = 'strong'): number {
  const c = toCode(v);
  return s === 'weak' ? weak(c) : strong(c);
}

// ── operator tables, indexed [a * 4 + b] (rows/cols: 0, 1, X, Z) ──

// prettier-ignore
export const AND_T: readonly Code[] = [
  0, 0, 0, 0,
  0, 1, 2, 2,
  0, 2, 2, 2,
  0, 2, 2, 2,
];
// prettier-ignore
export const OR_T: readonly Code[] = [
  0, 1, 2, 2,
  1, 1, 1, 1,
  2, 1, 2, 2,
  2, 1, 2, 2,
];
// prettier-ignore
export const XOR_T: readonly Code[] = [
  0, 1, 2, 2,
  1, 0, 2, 2,
  2, 2, 2, 2,
  2, 2, 2, 2,
];
export const NOT_T: readonly Code[] = [1, 0, 2, 2];
/** Buffer: Z on an input reads as X. */
export const BUF_T: readonly Code[] = [0, 1, 2, 2];

function fold(table: readonly Code[], values: Logic[]): Code {
  if (values.length === 0) throw new Error('logic operator needs at least one input');
  let acc: Code = BUF_T[toCode(values[0])];
  for (let i = 1; i < values.length; i++) acc = table[acc * 4 + toCode(values[i])];
  return acc;
}

export const logicNot = (a: Logic): Logic => FROM_CODE[NOT_T[toCode(a)]];
export const logicBuf = (a: Logic): Logic => FROM_CODE[BUF_T[toCode(a)]];
export const logicAnd = (...v: Logic[]): Logic => FROM_CODE[fold(AND_T, v)];
export const logicOr = (...v: Logic[]): Logic => FROM_CODE[fold(OR_T, v)];
export const logicXor = (...v: Logic[]): Logic => FROM_CODE[fold(XOR_T, v)];
export const logicNand = (...v: Logic[]): Logic => FROM_CODE[NOT_T[fold(AND_T, v)]];
export const logicNor = (...v: Logic[]): Logic => FROM_CODE[NOT_T[fold(OR_T, v)]];
export const logicXnor = (...v: Logic[]): Logic => FROM_CODE[NOT_T[fold(XOR_T, v)]];

// ── resolution ──

/** Resolved net value plus contention flags. */
export const CONTENTION_NONE = 0;
export const CONTENTION_STRONG = 1;
export const CONTENTION_WEAK = 2;

/**
 * Resolve the drive codes of every driver on a net. Returns
 * `value | (contention << 2)` where contention is 0 none, 1 strong 0 vs
 * strong 1, 2 weak 0 vs weak 1 (only when no strong driver is active).
 *
 * Rules: Z drivers are ignored. The strongest active strength wins; within
 * it, unanimous drivers give their value, an X driver gives X, and 0 vs 1
 * gives X (contention). No active driver → Z.
 */
export function resolveCodes(drives: ArrayLike<number>, idx?: ArrayLike<number>): number {
  let s = 0; // bitmask of strong values seen: 1 → 0, 2 → 1, 4 → X
  let w = 0;
  const n = idx ? idx.length : drives.length;
  for (let i = 0; i < n; i++) {
    const d = idx ? drives[idx[i]] : drives[i];
    const st = d >> 2;
    if (st === 2) s |= 1 << (d & 3);
    else if (st === 1) w |= 1 << (d & 3);
  }
  if (s !== 0) {
    if ((s & 3) === 3) return CX | (CONTENTION_STRONG << 2);
    if (s & 4) return CX;
    return s & 1 ? C0 : C1;
  }
  if (w !== 0) {
    if ((w & 3) === 3) return CX | (CONTENTION_WEAK << 2);
    if (w & 4) return CX;
    return w & 1 ? C0 : C1;
  }
  return CZ;
}

export interface ResolvedLogic {
  value: Logic;
  contention: 'none' | 'strong' | 'weak';
}

/** Public resolution function over plain driver data. */
export function resolveLogic(drivers: { value: Logic; strength?: Strength }[]): ResolvedLogic {
  const r = resolveCodes(drivers.map(d => makeDrive(d.value, d.strength ?? 'strong')));
  const c = r >> 2;
  return {
    value: fromCode(r & 3),
    contention: c === CONTENTION_STRONG ? 'strong' : c === CONTENTION_WEAK ? 'weak' : 'none',
  };
}
