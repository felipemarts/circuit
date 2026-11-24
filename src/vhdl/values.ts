/**
 * Runtime value domain of compiled VHDL.
 *
 *   std_logic        number 0..8 in IEEE 1164 order: U X 0 1 Z W L H -
 *   boolean          number 0 / 1
 *   integer, enum    number (enum = literal position), time = number of ps
 *   vectors          Uint8Array of std_logic codes, element 0 = leftmost (MSB for numeric_std)
 *   string           JS string (report messages only)
 *
 * Mapping onto the digital engine's 4-valued nets (documented in README.md):
 *   drive:  '0' → strong 0   '1' → strong 1   'Z' → Z (released)
 *           'L' → weak 0     'H' → weak 1     'W' → weak X
 *           'U' 'X' '-' → strong X
 *   read:   0 → '0'   1 → '1'   X → 'X'   Z → 'Z'
 */

export type Value = number | Uint8Array | string;

export const LU = 0;
export const LX = 1;
export const L0 = 2;
export const L1 = 3;
export const LZ = 4;
export const LW = 5;
export const LL = 6;
export const LH = 7;
export const LD = 8;

export const LOGIC_CHARS = 'UX01ZWLH-';

/** std_logic code → engine drive code (value | strength << 2). */
export const LOGIC_TO_DRIVE = [10, 10, 8, 9, 3, 6, 4, 5, 10];
/** engine net value code (0, 1, X, Z) → std_logic code. */
export const NET_TO_LOGIC = [L0, L1, LX, LZ];

/** IEEE 1164 To_X01 reduced to codes {U, X, 0, 1}: L→0, H→1, Z/W/- → X. */
const X01 = [LU, LX, L0, L1, LX, LX, L0, L1, LX];

export function logicAnd(a: number, b: number): number {
  const x = X01[a];
  const y = X01[b];
  if (x === L0 || y === L0) return L0;
  if (x === LU || y === LU) return LU;
  if (x === LX || y === LX) return LX;
  return L1;
}
export function logicOr(a: number, b: number): number {
  const x = X01[a];
  const y = X01[b];
  if (x === L1 || y === L1) return L1;
  if (x === LU || y === LU) return LU;
  if (x === LX || y === LX) return LX;
  return L0;
}
export function logicXor(a: number, b: number): number {
  const x = X01[a];
  const y = X01[b];
  if (x === LU || y === LU) return LU;
  if (x === LX || y === LX) return LX;
  return x === y ? L0 : L1;
}
export const NOT_TABLE = [LU, LX, L1, L0, LX, LX, L1, L0, LX];
export const logicNot = (a: number): number => NOT_TABLE[a];

export type LogicFn = 'and' | 'or' | 'xor' | 'nand' | 'nor' | 'xnor';

export function logicOp(f: LogicFn, a: number, b: number): number {
  switch (f) {
    case 'and':
      return logicAnd(a, b);
    case 'or':
      return logicOr(a, b);
    case 'xor':
      return logicXor(a, b);
    case 'nand':
      return NOT_TABLE[logicAnd(a, b)];
    case 'nor':
      return NOT_TABLE[logicOr(a, b)];
    case 'xnor':
      return NOT_TABLE[logicXor(a, b)];
  }
}

export function boolOp(f: LogicFn, a: number, b: number): number {
  switch (f) {
    case 'and':
      return a & b;
    case 'or':
      return a | b;
    case 'xor':
      return a ^ b;
    case 'nand':
      return (a & b) ^ 1;
    case 'nor':
      return (a | b) ^ 1;
    case 'xnor':
      return a ^ b ^ 1;
  }
}

export function vecFromString(s: string): Uint8Array {
  const v = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) {
    const c = LOGIC_CHARS.indexOf(s[i]);
    if (c < 0) throw new Error(`invalid std_logic character '${s[i]}'`);
    v[i] = c;
  }
  return v;
}

export function vecToString(v: Uint8Array): string {
  let s = '';
  for (let i = 0; i < v.length; i++) s += LOGIC_CHARS[v[i]];
  return s;
}

/** True when every element is 0/1 (or L/H). */
export function isKnown(v: Uint8Array): boolean {
  for (let i = 0; i < v.length; i++) {
    const x = X01[v[i]];
    if (x !== L0 && x !== L1) return false;
  }
  return true;
}

/** Unsigned (or two's complement) value of a known vector. */
export function vecToBig(v: Uint8Array, signed: boolean): bigint {
  let r = 0n;
  for (let i = 0; i < v.length; i++) r = (r << 1n) | (X01[v[i]] === L1 ? 1n : 0n);
  if (signed && v.length > 0 && X01[v[0]] === L1) r -= 1n << BigInt(v.length);
  return r;
}

/** Vector of `len` bits holding `x` modulo 2^len (two's complement for negatives). */
export function bigToVec(x: bigint, len: number): Uint8Array {
  const v = new Uint8Array(len);
  if (len === 0) return v;
  let m = BigInt.asUintN(len, x);
  for (let i = len - 1; i >= 0; i--) {
    v[i] = m & 1n ? L1 : L0;
    m >>= 1n;
  }
  return v;
}

export function allX(len: number): Uint8Array {
  return new Uint8Array(len).fill(LX);
}

/** Does `x` fit in `len` bits (unsigned, or two's complement when signed)? */
export function fits(x: bigint, len: number, signed: boolean): boolean {
  if (len === 0) return x === 0n;
  if (signed) return x >= -(1n << BigInt(len - 1)) && x < 1n << BigInt(len - 1);
  return x >= 0n && x < 1n << BigInt(len);
}

/** Number of bits that encode an integer subtype range on nets. */
export function intWidth(lo: number, hi: number): number {
  if (lo >= 0) {
    let w = 1;
    while (2 ** w <= hi) w++;
    return w;
  }
  let w = 1;
  while (!(-(2 ** (w - 1)) <= lo && hi <= 2 ** (w - 1) - 1)) w++;
  return w;
}

/** Number of bits that encode an enumeration of n literals. */
export function enumWidth(n: number): number {
  let w = 1;
  while (2 ** w < n) w++;
  return w;
}

/** numeric_std resize. */
export function resizeVec(v: Uint8Array, len: number, signed: boolean): Uint8Array {
  const out = new Uint8Array(len);
  const n = v.length;
  if (n === 0) return out.fill(L0);
  if (!signed) {
    for (let i = 0; i < len; i++) {
      const src = n - len + i;
      out[i] = src >= 0 ? v[src] : L0;
    }
    return out;
  }
  // signed: keep the sign bit, then the rightmost len-1 bits (or sign-extend).
  if (len === 0) return out;
  if (len >= n) {
    for (let i = 0; i < len; i++) out[i] = i < len - n ? v[0] : v[i - (len - n)];
    return out;
  }
  out[0] = v[0];
  for (let i = 1; i < len; i++) out[i] = v[n - len + i];
  return out;
}

/** numeric_std shift_left / shift_right / rotate_left / rotate_right. */
export function shiftVec(v: Uint8Array, n: number, kind: 'l' | 'r' | 'rl' | 'rr', arith: boolean): Uint8Array {
  const len = v.length;
  const out = new Uint8Array(len);
  if (len === 0) return out;
  if (kind === 'rl' || kind === 'rr') {
    const k = (((kind === 'rl' ? n : -n) % len) + len) % len;
    for (let i = 0; i < len; i++) out[i] = v[(i + k) % len];
    return out;
  }
  if (n < 0) return shiftVec(v, -n, kind === 'l' ? 'r' : 'l', arith);
  const fill = kind === 'r' && arith ? v[0] : L0;
  for (let i = 0; i < len; i++) {
    const src = kind === 'l' ? i + n : i - n;
    out[i] = src >= 0 && src < len ? v[src] : fill;
  }
  return out;
}

/** Integer division truncating toward zero (VHDL '/'). */
export const idiv = (a: number, b: number): number => Math.trunc(a / b);
/** VHDL mod: result has the sign of b. */
export const imod = (a: number, b: number): number => ((a % b) + b) % b;
/** VHDL rem: result has the sign of a. */
export const irem = (a: number, b: number): number => a % b;

export function bigDiv(a: bigint, b: bigint): bigint {
  return a / b;
}
export function bigMod(a: bigint, b: bigint): bigint {
  const r = a % b;
  return r !== 0n && (r < 0n) !== (b < 0n) ? r + b : r;
}

export const INT_MIN = -2147483648;
export const INT_MAX = 2147483647;

export function valueToJson(v: Value): number | string {
  if (v instanceof Uint8Array) return vecToString(v);
  return v;
}

/** Display a value in messages: vectors as "0101", logic as '1'. */
export function showValue(v: Value, kind: 'logic' | 'vec' | 'other' = 'other', enumLits?: string[]): string {
  if (v instanceof Uint8Array) return `"${vecToString(v)}"`;
  if (kind === 'logic' && typeof v === 'number') return `'${LOGIC_CHARS[v]}'`;
  if (enumLits && typeof v === 'number') return enumLits[v] ?? String(v);
  return typeof v === 'string' ? JSON.stringify(v) : String(v);
}
