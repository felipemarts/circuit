/**
 * Plain-JSON intermediate representation of one elaborated VHDL process.
 * It is the `config` of a digital `Behavioral` part (behavior 'vhdl-process'),
 * so a netlist containing VHDL logic still serializes and rebuilds exactly.
 * Everything is fully resolved: types are lowered to operation modes, all
 * lengths and slice offsets are static, names are indices.
 */

/** Encoded value: number (scalar) or a std_logic string ("01XZ…") for vectors, or { str } for text. */
export type IrConst = number | string | { str: string };

export type IrMode = 'i' | 't' | 'u' | 's' | 'ui' | 'iu' | 'si' | 'is';

export type IrExpr =
  | { o: 'k'; v: IrConst }
  | { o: 's'; s: number }
  | { o: 'v'; v: number }
  | { o: 'ev'; s: number }
  | { o: 'edge'; s: number; rise: boolean }
  /** element of a vector by index value: pos = asc ? i - left : left - i */
  | { o: 'el'; a: IrExpr; i: IrExpr; left: number; asc: boolean; len: number; at: string; what: string }
  /** static slice by position */
  | { o: 'sl'; a: IrExpr; off: number; len: number }
  | { o: 'not'; w: 'l' | 'v' | 'b'; a: IrExpr }
  | { o: 'log'; f: 'and' | 'or' | 'xor' | 'nand' | 'nor' | 'xnor'; w: 'l' | 'v' | 'b'; a: IrExpr; b: IrExpr }
  /** reduction operator (VHDL-2008 unary and/or/xor/…) on a vector → std_logic */
  | { o: 'red'; f: 'and' | 'or' | 'xor' | 'nand' | 'nor' | 'xnor'; a: IrExpr }
  /** comparisons → boolean. m: n = scalar numbers, arr = elementwise vector equality / dictionary order, u/s/ui/iu/si/is numeric_std */
  | { o: 'cmp'; f: '=' | '/=' | '<' | '<=' | '>' | '>='; m: 'n' | 'arr' | 'u' | 's' | 'ui' | 'iu' | 'si' | 'is'; a: IrExpr; b: IrExpr; at: string }
  | { o: 'ar'; f: '+' | '-' | '*' | '/' | 'mod' | 'rem' | '**'; m: IrMode; len: number; a: IrExpr; b: IrExpr; at: string }
  | { o: 'neg'; m: 'i' | 't' | 's'; a: IrExpr; at: string }
  | { o: 'abs'; m: 'i' | 't' | 's'; a: IrExpr; at: string }
  /** concatenation: sc = the part is a scalar std_logic */
  | { o: 'cat'; parts: { e: IrExpr; sc: boolean }[] }
  /** vector aggregate with static positions (items are std_logic scalars) */
  | { o: 'agg'; len: number; others?: IrExpr; items: { pos: number; e: IrExpr }[] }
  | { o: 'toU'; a: IrExpr; len: number; sgn: boolean; at: string }
  | { o: 'toI'; a: IrExpr; sgn: boolean; at: string }
  | { o: 'rsz'; a: IrExpr; len: number; sgn: boolean }
  | { o: 'sh'; f: 'l' | 'r' | 'rl' | 'rr'; a: IrExpr; n: IrExpr; arith: boolean }
  /** std_logic → boolean (VHDL-2008 condition operator ??) */
  | { o: 'qq'; a: IrExpr }
  /** integer subtype / enum conversion with a range check ('val, natural(x)) */
  | { o: 'rng'; a: IrExpr; lo: number; hi: number; at: string; what: string }
  /** string building for report messages */
  | { o: 'img'; a: IrExpr; k: 'i' | 'l' | 'v' | 'b' | 'e' | 't'; lits?: string[] }
  | { o: 'scat'; parts: IrExpr[] };

export type IrTarget =
  | { t: 's'; s: number; lo?: number; hi?: number }
  | { t: 'se'; s: number; i: IrExpr; left: number; asc: boolean; len: number; at: string }
  | { t: 'ss'; s: number; off: number; len: number }
  | { t: 'v'; v: number; lo?: number; hi?: number }
  | { t: 've'; v: number; i: IrExpr; left: number; asc: boolean; len: number; at: string }
  | { t: 'vs'; v: number; off: number; len: number };

export type IrStmt =
  | { k: 'sa'; t: IrTarget; e: IrExpr; d?: IrExpr; at: string; what: string }
  | { k: 'va'; t: IrTarget; e: IrExpr; at: string; what: string }
  | { k: 'if'; arms: [IrExpr, IrStmt[]][]; els?: IrStmt[] }
  /** m: n = scalar key, v = vector key (std_logic string) */
  | { k: 'case'; e: IrExpr; m: 'n' | 'v'; map: Record<string, number>; ranges: [number, number, number][]; others: number; arms: IrStmt[][]; at: string }
  | { k: 'for'; v: number; from: number; to: number; step: 1 | -1; id: number; body: IrStmt[] }
  | { k: 'exit' | 'next'; id: number; c?: IrExpr }
  /** sev: 0 note, 1 warning, 2 error, 3 failure */
  | { k: 'assert'; c?: IrExpr; msg?: IrExpr; sev: IrExpr; at: string };

/** One signal as seen by a process. */
export interface IrSignal {
  /** Hierarchical display name ('u1.count'). */
  n: string;
  /** l = std_logic, v = vector, i = integer, e = enum, b = boolean */
  k: 'l' | 'v' | 'i' | 'e' | 'b';
  /** Number of nets (vector length / encoding width). */
  w: number;
  /** Input index per net (read), or null when the process never reads it. */
  ins: number[] | null;
  /** Output index per net (-1 = not driven by this process), or null. */
  outs: number[] | null;
  /** Integer range (k = 'i'; signed encoding when lo < 0) / enum literal count via hi. */
  lo?: number;
  hi?: number;
  /** Initial value of the drivers (signal default). */
  init: IrConst;
  /** Enum literal names (k = 'e'), for messages. */
  lits?: string[];
}

export interface IrVar {
  n: string;
  init: IrConst;
}

export interface ProcessConfig {
  v: 1;
  /** Process display name ('u1.p_count'). */
  name: string;
  at: string;
  sigs: IrSignal[];
  /** Input indices whose change resumes the process, or 'all'. */
  sens: number[] | 'all';
  /** Process started with `wait until`: it does not run at initialization. */
  skipInit?: boolean;
  vars: IrVar[];
  body: IrStmt[];
  nIn: number;
  nOut: number;
}
