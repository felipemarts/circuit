/**
 * Elaboration-time VHDL types of the supported subset.
 */
import { enumWidth, intWidth, INT_MAX, INT_MIN, LU } from './values';
import type { Value } from './values';

export type VecBase = 'slv' | 'sulv' | 'u' | 's';

export type VType =
  | { k: 'logic'; res: boolean }
  | { k: 'bool' }
  | { k: 'int'; lo: number; hi: number; asc: boolean; name: string }
  | { k: 'time' }
  | { k: 'enum'; name: string; lits: string[]; uid: number }
  | { k: 'vec'; base: VecBase; left: number; right: number; asc: boolean }
  | { k: 'uvec'; base: VecBase }
  | { k: 'str' }
  /** poisoned (an error was already reported) */
  | { k: 'err' };

export const T_LOGIC: VType = { k: 'logic', res: true };
export const T_ULOGIC: VType = { k: 'logic', res: false };
export const T_BOOL: VType = { k: 'bool' };
export const T_INT: VType = { k: 'int', lo: INT_MIN, hi: INT_MAX, asc: true, name: 'integer' };
export const T_NATURAL: VType = { k: 'int', lo: 0, hi: INT_MAX, asc: true, name: 'natural' };
export const T_POSITIVE: VType = { k: 'int', lo: 1, hi: INT_MAX, asc: true, name: 'positive' };
export const T_TIME: VType = { k: 'time' };
export const T_STR: VType = { k: 'str' };
export const T_ERR: VType = { k: 'err' };
export const T_SEVERITY: VType = { k: 'enum', name: 'severity_level', lits: ['note', 'warning', 'error', 'failure'], uid: -1 };

export const BASE_NAME: Record<VecBase, string> = { slv: 'std_logic_vector', sulv: 'std_ulogic_vector', u: 'unsigned', s: 'signed' };

export function vecLen(t: { left: number; right: number; asc: boolean }): number {
  return Math.max(0, t.asc ? t.right - t.left + 1 : t.left - t.right + 1);
}

export function vecOf(base: VecBase, len: number): VType {
  return { k: 'vec', base, left: len - 1, right: 0, asc: false };
}

/** Index of element position p (0 = leftmost). */
export function indexAt(t: { left: number; asc: boolean }, p: number): number {
  return t.asc ? t.left + p : t.left - p;
}

export function typeName(t: VType): string {
  switch (t.k) {
    case 'logic':
      return t.res ? 'std_logic' : 'std_ulogic';
    case 'bool':
      return 'boolean';
    case 'int':
      return t.name;
    case 'time':
      return 'time';
    case 'enum':
      return t.name;
    case 'vec':
      return `${BASE_NAME[t.base]}(${t.left} ${t.asc ? 'to' : 'downto'} ${t.right})`;
    case 'uvec':
      return BASE_NAME[t.base];
    case 'str':
      return 'string';
    case 'err':
      return '?';
  }
}

/** Types that may be the type of a signal (encodable on nets). */
export function isSignalType(t: VType): boolean {
  return t.k === 'logic' || t.k === 'bool' || t.k === 'int' || t.k === 'enum' || t.k === 'vec';
}

/** Number of nets a signal of this type occupies. */
export function netWidth(t: VType): number {
  switch (t.k) {
    case 'logic':
    case 'bool':
      return 1;
    case 'vec':
      return vecLen(t);
    case 'int':
      return intWidth(t.lo, t.hi);
    case 'enum':
      return enumWidth(t.lits.length);
    default:
      return 0;
  }
}

export function isResolved(t: VType): boolean {
  if (t.k === 'logic') return t.res;
  if (t.k === 'vec') return t.base !== 'sulv';
  return false;
}

export function defaultValue(t: VType): Value {
  switch (t.k) {
    case 'logic':
      return LU;
    case 'vec':
      return new Uint8Array(vecLen(t)).fill(LU);
    case 'int':
      return t.asc ? t.lo : t.hi;
    case 'bool':
    case 'enum':
    case 'time':
      return 0;
    case 'str':
      return '';
    default:
      return 0;
  }
}

export function sameVecFamily(a: VecBase, b: VecBase): boolean {
  if (a === b) return true;
  return (a === 'slv' || a === 'sulv') && (b === 'slv' || b === 'sulv');
}

/** Can a value of type v be assigned to an object of type t (ignoring vector lengths / int ranges)? */
export function compatible(t: VType, v: VType): boolean {
  if (t.k === 'err' || v.k === 'err') return true;
  switch (t.k) {
    case 'logic':
      return v.k === 'logic';
    case 'bool':
      return v.k === 'bool';
    case 'int':
      return v.k === 'int';
    case 'time':
      return v.k === 'time';
    case 'enum':
      return v.k === 'enum' && v.uid === t.uid;
    case 'vec':
    case 'uvec':
      return (v.k === 'vec' || v.k === 'uvec') && sameVecFamily(t.base, v.base);
    case 'str':
      return v.k === 'str';
  }
}
