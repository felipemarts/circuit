/**
 * Runtime of compiled VHDL processes: turns the JSON IR (ir.ts) into
 * closures once per component, and implements the digital engine's `Model`
 * with VHDL process semantics:
 *
 *   - the process resumes when a signal of its sensitivity list has an event
 *     (or any read signal for process(all)); at initialization every process
 *     runs once (except one that starts with `wait until`);
 *   - signal reads return the current (resolved) net values; signal
 *     assignments are buffered per driver and scheduled after the run —
 *     zero delay = next delta cycle; the last assignment to a driver within a
 *     run wins (VHDL inertial preemption);
 *   - variables update immediately and persist across activations;
 *   - `after` delays become per-transaction inertial delays; delayed
 *     assignments made during the power-on settle are scheduled at t = 0 + delay.
 *
 * The same closures evaluate static expressions during elaboration
 * (`evalStatic`), so constant folding and simulation can never disagree.
 */
import { hasBehavior, registerBehavior } from '../digital/behavior';
import type { Host, Model, ModelCtx } from '../digital/model';
import type { JsonValue } from '../digital/parts';
import { vhdlDiagnostic } from './diagnostics';
import type { VhdlFix } from './diagnostics';
import type { IrConst, IrExpr, IrSignal, IrStmt, IrTarget, ProcessConfig } from './ir';
import {
  allX,
  bigDiv,
  bigMod,
  bigToVec,
  boolOp,
  fits,
  idiv,
  imod,
  INT_MAX,
  INT_MIN,
  irem,
  isKnown,
  L0,
  L1,
  LOGIC_CHARS,
  LOGIC_TO_DRIVE,
  logicOp,
  LX,
  NET_TO_LOGIC,
  NOT_TABLE,
  resizeVec,
  shiftVec,
  vecFromString,
  vecToBig,
  vecToString,
} from './values';
import type { Value } from './values';

export const VHDL_BEHAVIOR = 'vhdl-process';

/** Register the VHDL process behavior with the digital engine (idempotent). */
export function registerVhdlBehavior(): void {
  if (!hasBehavior(VHDL_BEHAVIOR)) registerBehavior(VHDL_BEHAVIOR, createProcessModel);
}

// ── evaluation context ──

export interface RuntimeIssue {
  code: string;
  message: string;
  at?: string;
  severity?: 'error' | 'warning';
  evidence?: Record<string, unknown>;
}

interface Ctx {
  h: Host | null;
  init: boolean;
  /** net index per input */
  inNets: number[];
  /** previous net code per input */
  prev: Uint8Array;
  vars: Value[];
  issue(i: RuntimeIssue): void;
  // pending transactions
  pend: Int16Array;
  pendDelay: Float64Array;
  touched: number[];
}

type EFn = (c: Ctx) => Value;
type SFn = (c: Ctx) => number;

const X01 = [0, 1, 2, 3, 1, 1, 2, 3, 1];

export function constValue(v: IrConst): Value {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') return vecFromString(v);
  return v.str;
}

function num(c: Value): number {
  return c as number;
}

function vec(c: Value): Uint8Array {
  return c as Uint8Array;
}

const NOTES: Record<string, { note: string; fix: VhdlFix }> = {
  V750: {
    note: 'VHDL stops the simulation on an out-of-range index; here the access reads X (or is skipped for a write) and the simulation continues',
    fix: { kind: 'guard-index', confidence: 'suggested', detail: "keep the index inside the vector's range (check the counter width / loop bounds), or guard the access with an if" },
  },
  V751: {
    note: 'VHDL stops the simulation when a value leaves its subtype range; here the assignment is skipped (the target keeps its old value) and the simulation continues',
    fix: { kind: 'widen-range', confidence: 'suggested', detail: 'widen the subtype range, or wrap explicitly (e.g. if count = MAX then count <= 0; else count <= count + 1; end if;)' },
  },
  V752: {
    note: 'a VHDL assert/report statement in the design fired',
    fix: { kind: 'check-design', confidence: 'suggested', detail: 'read the assertion message: it states the condition the design author expected' },
  },
  V753: {
    note: "numeric_std treats U/X/Z/W/- bits as unknown: arithmetic returns all 'X', comparisons return false and to_integer returns 0 (warnings during the power-on settle are suppressed, as most simulators' 0 ns metavalue warnings are noise)",
    fix: { kind: 'initialize', confidence: 'suggested', detail: 'give the operand a defined value first: a reset branch, an initial value in the signal declaration, or a driven input' },
  },
  V754: {
    note: 'division or mod/rem by zero is an error in VHDL; here the result is 0 (integer) or all X (vector)',
    fix: { kind: 'guard-divisor', confidence: 'suggested', detail: 'guard the operation with if divisor /= 0' },
  },
  V755: {
    note: 'integer, enumeration and boolean signals are encoded on several nets; an X/Z bit on one of them (an undriven or contended input port) cannot be represented, so it reads as 0 / the first literal / false',
    fix: { kind: 'drive-input', confidence: 'suggested', detail: 'drive every bit of the port with a defined 0/1 from the testbench' },
  },
};

// ── expressions ──

interface ProcInfo {
  sigs: IrSignal[];
  inNets: number[];
}

function readSignal(s: IrSignal, P: ProcInfo, sigIdx: number): EFn {
  if (!s.ins) throw new Error(`internal: signal ${s.n} read but not an input`);
  const nets = s.ins.map(i => P.inNets[i]);
  void sigIdx;
  switch (s.k) {
    case 'l': {
      const n = nets[0];
      return c => NET_TO_LOGIC[c.h!.read(n)];
    }
    case 'v':
      return c => {
        const v = new Uint8Array(nets.length);
        for (let k = 0; k < nets.length; k++) v[k] = NET_TO_LOGIC[c.h!.read(nets[k])];
        return v;
      };
    case 'b': {
      const n = nets[0];
      return c => {
        const x = c.h!.read(n);
        if (x > 1) {
          unknownBits(c, s);
          return 0;
        }
        return x;
      };
    }
    case 'i':
    case 'e': {
      const signed = s.k === 'i' && (s.lo ?? 0) < 0;
      const w = nets.length;
      return c => {
        let v = 0;
        let bad = false;
        for (let k = 0; k < w; k++) {
          const x = c.h!.read(nets[k]);
          if (x > 1) bad = true;
          else if (x === 1) v += 2 ** k;
        }
        if (bad) {
          unknownBits(c, s);
          return s.k === 'i' ? clampInt(0, s) : 0;
        }
        if (signed && v >= 2 ** (w - 1)) v -= 2 ** w;
        if (s.k === 'e' && v > (s.hi ?? 0)) {
          unknownBits(c, s);
          return 0;
        }
        return v;
      };
    }
  }
}

function clampInt(v: number, s: IrSignal): number {
  return Math.min(Math.max(v, s.lo ?? v), s.hi ?? v);
}

function unknownBits(c: Ctx, s: IrSignal): void {
  if (c.init) return;
  c.issue({
    code: 'V755',
    message: `${s.k === 'i' ? 'integer' : s.k === 'e' ? 'enumeration' : 'boolean'} signal '${s.n}' has X/Z bits on its nets; read as ${s.k === 'i' ? clampInt(0, s) : s.k === 'e' ? (s.lits?.[0] ?? 'the first literal') : 'false'}`,
    evidence: { signal: s.n },
  });
}

function compileExpr(e: IrExpr, P: ProcInfo): EFn {
  switch (e.o) {
    case 'k': {
      const v = constValue(e.v);
      return () => v;
    }
    case 's':
      return readSignal(P.sigs[e.s], P, e.s);
    case 'v': {
      const slot = e.v;
      return c => c.vars[slot];
    }
    case 'ev': {
      const s = P.sigs[e.s];
      const ins = s.ins!;
      const nets = ins.map(i => P.inNets[i]);
      return c => {
        if (c.init) return 0;
        for (let k = 0; k < ins.length; k++) if (c.h!.read(nets[k]) !== c.prev[ins[k]]) return 1;
        return 0;
      };
    }
    case 'edge': {
      const s = P.sigs[e.s];
      const k = s.ins![0];
      const net = P.inNets[k];
      const from = e.rise ? 0 : 1;
      const to = e.rise ? 1 : 0;
      return c => (!c.init && c.prev[k] === from && c.h!.read(net) === to ? 1 : 0);
    }
    case 'el': {
      const a = compileExpr(e.a, P);
      const i = compileExpr(e.i, P);
      const { left, asc, len, at, what } = e;
      return c => {
        const idx = num(i(c));
        const pos = asc ? idx - left : left - idx;
        if (pos < 0 || pos >= len) {
          c.issue({ code: 'V750', message: `index ${idx} is outside the range of ${what} (${asc ? `${left} to ${left + len - 1}` : `${left} downto ${left - len + 1}`}); read as 'X'`, at, evidence: { index: idx } });
          return LX;
        }
        return vec(a(c))[pos];
      };
    }
    case 'sl': {
      const a = compileExpr(e.a, P);
      const { off, len } = e;
      return c => vec(a(c)).slice(off, off + len);
    }
    case 'not': {
      const a = compileExpr(e.a, P);
      if (e.w === 'l') return c => NOT_TABLE[num(a(c))];
      if (e.w === 'b') return c => num(a(c)) ^ 1;
      return c => {
        const v = vec(a(c));
        const r = new Uint8Array(v.length);
        for (let k = 0; k < v.length; k++) r[k] = NOT_TABLE[v[k]];
        return r;
      };
    }
    case 'log': {
      const a = compileExpr(e.a, P);
      const b = compileExpr(e.b, P);
      const f = e.f;
      if (e.w === 'l') return c => logicOp(f, num(a(c)), num(b(c)));
      if (e.w === 'b') {
        // Short-circuit like VHDL for and/or/nand/nor on booleans.
        if (f === 'and') return c => (num(a(c)) ? num(b(c)) : 0);
        if (f === 'or') return c => (num(a(c)) ? 1 : num(b(c)));
        if (f === 'nand') return c => (num(a(c)) ? num(b(c)) ^ 1 : 1);
        if (f === 'nor') return c => (num(a(c)) ? 0 : num(b(c)) ^ 1);
        return c => boolOp(f, num(a(c)), num(b(c)));
      }
      return c => {
        const x = vec(a(c));
        const y = vec(b(c));
        const r = new Uint8Array(x.length);
        for (let k = 0; k < x.length; k++) r[k] = logicOp(f, x[k], y[k]);
        return r;
      };
    }
    case 'red': {
      const a = compileExpr(e.a, P);
      const f = e.f;
      const base = f === 'nand' ? 'and' : f === 'nor' ? 'or' : f === 'xnor' ? 'xor' : f;
      const inv = f !== base;
      return c => {
        const v = vec(a(c));
        let r = base === 'and' ? L1 : L0;
        for (let k = 0; k < v.length; k++) r = logicOp(base, r, v[k]);
        return inv ? NOT_TABLE[r] : r;
      };
    }
    case 'cmp':
      return compileCmp(e, P);
    case 'ar':
      return compileArith(e, P);
    case 'neg':
    case 'abs': {
      const a = compileExpr(e.a, P);
      const isAbs = e.o === 'abs';
      if (e.m === 'i' || e.m === 't') return c => (isAbs ? Math.abs(num(a(c))) : 0 - num(a(c)));
      const at = e.at;
      return c => {
        const v = vec(a(c));
        if (!isKnown(v)) {
          metavalue(c, isAbs ? 'abs' : 'unary -', at);
          return allX(v.length);
        }
        const x = vecToBig(v, true);
        return bigToVec(isAbs && x >= 0n ? x : -x, v.length);
      };
    }
    case 'cat': {
      const parts = e.parts.map(p => ({ f: compileExpr(p.e, P), sc: p.sc }));
      return c => {
        const vals = parts.map(p => p.f(c));
        let n = 0;
        for (let k = 0; k < vals.length; k++) n += parts[k].sc ? 1 : vec(vals[k]).length;
        const r = new Uint8Array(n);
        let o = 0;
        for (let k = 0; k < vals.length; k++) {
          if (parts[k].sc) r[o++] = num(vals[k]);
          else {
            r.set(vec(vals[k]), o);
            o += vec(vals[k]).length;
          }
        }
        return r;
      };
    }
    case 'agg': {
      const others = e.others ? compileExpr(e.others, P) : undefined;
      const items = e.items.map(it => ({ pos: it.pos, f: compileExpr(it.e, P) }));
      const len = e.len;
      return c => {
        const r = new Uint8Array(len);
        if (others) r.fill(num(others(c)));
        for (const it of items) r[it.pos] = num(it.f(c));
        return r;
      };
    }
    case 'toU': {
      const a = compileExpr(e.a, P);
      const { len, sgn, at } = e;
      return c => {
        const x = num(a(c));
        if (!sgn && x < 0) {
          c.issue({ code: 'V751', message: `to_unsigned(${x}, ${len}): the argument must be a natural (≥ 0)`, at, evidence: { value: x } });
          return bigToVec(BigInt(x), len);
        }
        const b = BigInt(x);
        if (!fits(b, len, sgn)) {
          c.issue({ code: 'V751', severity: 'warning', message: `${sgn ? 'to_signed' : 'to_unsigned'}(${x}, ${len}): value does not fit in ${len} bits — vector truncated`, at, evidence: { value: x, length: len } });
        }
        return bigToVec(b, len);
      };
    }
    case 'toI': {
      const a = compileExpr(e.a, P);
      const { sgn, at } = e;
      return c => {
        const v = vec(a(c));
        if (!isKnown(v)) {
          metavalue(c, 'to_integer', at, 'returning 0');
          return 0;
        }
        const x = vecToBig(v, sgn);
        if (x > BigInt(INT_MAX) || x < BigInt(INT_MIN)) {
          c.issue({ code: 'V751', message: `to_integer: value ${x} of a ${v.length}-bit vector exceeds the VHDL integer range; returning 0`, at });
          return 0;
        }
        return Number(x);
      };
    }
    case 'rsz': {
      const a = compileExpr(e.a, P);
      const { len, sgn } = e;
      return c => resizeVec(vec(a(c)), len, sgn);
    }
    case 'sh': {
      const a = compileExpr(e.a, P);
      const n = compileExpr(e.n, P);
      const { f, arith } = e;
      return c => shiftVec(vec(a(c)), num(n(c)), f, arith);
    }
    case 'qq': {
      const a = compileExpr(e.a, P);
      return c => (X01[num(a(c))] === 3 ? 1 : 0);
    }
    case 'rng': {
      const a = compileExpr(e.a, P);
      const { lo, hi, at, what } = e;
      return c => {
        const x = num(a(c));
        if (x < lo || x > hi) {
          c.issue({ code: 'V751', message: `${what}: value ${x} is outside ${lo} to ${hi}`, at, evidence: { value: x, low: lo, high: hi } });
          return Math.min(Math.max(x, lo), hi);
        }
        return x;
      };
    }
    case 'img': {
      const a = compileExpr(e.a, P);
      const { k, lits } = e;
      return c => {
        const v = a(c);
        switch (k) {
          case 'i':
            return String(v);
          case 'l':
            return `'${LOGIC_CHARS[num(v)]}'`;
          case 'v':
            return vecToString(vec(v));
          case 'b':
            return num(v) ? 'true' : 'false';
          case 'e':
            return lits?.[num(v)] ?? String(v);
          case 't': {
            const ps = num(v);
            return ps % 1000 === 0 ? `${ps / 1000} ns` : `${ps} ps`;
          }
        }
      };
    }
    case 'scat': {
      const parts = e.parts.map(p => compileExpr(p, P));
      return c => parts.map(p => String(p(c))).join('');
    }
  }
}

function metavalue(c: Ctx, op: string, at: string, result = "result is 'X'"): void {
  if (c.init) return;
  c.issue({ code: 'V753', message: `${op}: an operand has metavalue (U/X/Z/W/-) bits; ${result}`, at });
}

function compileCmp(e: Extract<IrExpr, { o: 'cmp' }>, P: ProcInfo): EFn {
  const a = compileExpr(e.a, P);
  const b = compileExpr(e.b, P);
  const f = e.f;
  const test = (r: number): number => {
    switch (f) {
      case '=':
        return r === 0 ? 1 : 0;
      case '/=':
        return r !== 0 ? 1 : 0;
      case '<':
        return r < 0 ? 1 : 0;
      case '<=':
        return r <= 0 ? 1 : 0;
      case '>':
        return r > 0 ? 1 : 0;
      case '>=':
        return r >= 0 ? 1 : 0;
    }
  };
  if (e.m === 'n') return c => {
    const x = num(a(c));
    const y = num(b(c));
    return test(x < y ? -1 : x > y ? 1 : 0);
  };
  if (e.m === 'arr') {
    return c => {
      const x = vec(a(c));
      const y = vec(b(c));
      const n = Math.min(x.length, y.length);
      for (let k = 0; k < n; k++) if (x[k] !== y[k]) return test(x[k] < y[k] ? -1 : 1);
      return test(x.length === y.length ? 0 : x.length < y.length ? -1 : 1);
    };
  }
  const at = e.at;
  const m = e.m;
  const signed = m === 's' || m === 'si' || m === 'is';
  const metaResult = f === '/=' ? 1 : 0;
  return c => {
    const va = a(c);
    const vb = b(c);
    let x: bigint;
    let y: bigint;
    if (va instanceof Uint8Array) {
      if (!isKnown(va)) {
        metavalue(c, `"${f}"`, at, `returning ${metaResult ? 'true' : 'false'}`);
        return metaResult;
      }
      x = vecToBig(va, signed);
    } else x = BigInt(va as number);
    if (vb instanceof Uint8Array) {
      if (!isKnown(vb)) {
        metavalue(c, `"${f}"`, at, `returning ${metaResult ? 'true' : 'false'}`);
        return metaResult;
      }
      y = vecToBig(vb, signed);
    } else y = BigInt(vb as number);
    return test(x < y ? -1 : x > y ? 1 : 0);
  };
}

function compileArith(e: Extract<IrExpr, { o: 'ar' }>, P: ProcInfo): EFn {
  const a = compileExpr(e.a, P);
  const b = compileExpr(e.b, P);
  const { f, m, len, at } = e;
  if (m === 'i' || m === 't') {
    const integer = m === 'i';
    return c => {
      const x = num(a(c));
      const y = num(b(c));
      switch (f) {
        case '+':
          return x + y;
        case '-':
          return x - y;
        case '*':
          return x * y + 0; // no -0
        case '**':
          return x ** y;
        default: {
          if (y === 0) {
            c.issue({ code: 'V754', message: `${f === '/' ? 'division' : f} by zero (${x} ${f} 0); result 0`, at });
            return 0;
          }
          if (f === '/') return (integer ? idiv(x, y) : x / y) + 0;
          return (f === 'mod' ? imod(x, y) : irem(x, y)) + 0;
        }
      }
    };
  }
  const signed = m === 's' || m === 'si' || m === 'is';
  // Integer operand of a mixed operation: numeric_std converts it to the vector's length first.
  const vlen = (v: Value, other: Value): number => (v instanceof Uint8Array ? v.length : (other as Uint8Array).length);
  return c => {
    const va = a(c);
    const vb = b(c);
    for (const v of [va, vb]) {
      if (v instanceof Uint8Array && !isKnown(v)) {
        metavalue(c, `"${f}"`, at);
        return allX(len);
      }
    }
    const conv = (v: Value, other: Value): bigint => {
      if (v instanceof Uint8Array) return vecToBig(v, signed);
      const n = vlen(v, other);
      return vecToBig(bigToVec(BigInt(v as number), n), signed);
    };
    const x = conv(va, vb);
    const y = conv(vb, va);
    let r: bigint;
    switch (f) {
      case '+':
        r = x + y;
        break;
      case '-':
        r = x - y;
        break;
      case '*':
        r = x * y;
        break;
      case '/':
      case 'mod':
      case 'rem':
        if (y === 0n) {
          c.issue({ code: 'V754', message: `${f === '/' ? 'division' : f} by zero in a numeric_std operation; result is all 'X'`, at });
          return allX(len);
        }
        r = f === '/' ? bigDiv(x, y) : f === 'mod' ? bigMod(x, y) : x % y;
        break;
      default:
        r = 0n;
    }
    return bigToVec(r, len);
  };
}

// ── statements ──

const CTRL_EXIT = 1;
const CTRL_NEXT = 2;
const ctrl = (kind: number, id: number): number => (id + 1) * 4 + kind;

interface StmtEnv {
  P: ProcInfo;
  sigs: IrSignal[];
}

function compileBlock(body: IrStmt[], env: StmtEnv): SFn {
  const fns = body.map(s => compileStmt(s, env));
  if (fns.length === 1) return fns[0];
  return c => {
    for (let k = 0; k < fns.length; k++) {
      const r = fns[k](c);
      if (r !== 0) return r;
    }
    return 0;
  };
}

function pend(c: Ctx, o: number, drive: number, delay: number): void {
  if (c.pend[o] === -1) c.touched.push(o);
  c.pend[o] = drive;
  c.pendDelay[o] = delay;
}

/** Drive codes per net of a signal value. */
function encode(s: IrSignal, v: Value, out: (k: number, drive: number) => void): void {
  switch (s.k) {
    case 'l':
      out(0, LOGIC_TO_DRIVE[v as number]);
      return;
    case 'v': {
      const x = v as Uint8Array;
      for (let k = 0; k < x.length; k++) out(k, LOGIC_TO_DRIVE[x[k]]);
      return;
    }
    case 'b':
      out(0, (v as number) ? 9 : 8);
      return;
    case 'i':
    case 'e': {
      let x = v as number;
      if (x < 0) x += 2 ** s.w;
      for (let k = 0; k < s.w; k++) out(k, Math.floor(x / 2 ** k) % 2 ? 9 : 8);
      return;
    }
  }
}

function compileTargetWrite(t: IrTarget, env: StmtEnv, at: string, what: string): (c: Ctx, v: Value, delay: number) => void {
  if (t.t === 's' || t.t === 'se' || t.t === 'ss') {
    const s = env.sigs[t.s];
    const outs = s.outs!;
    if (t.t === 's') {
      const { lo, hi } = t;
      return (c, v, d) => {
        if (lo !== undefined && ((v as number) < lo || (v as number) > hi!)) {
          c.issue({ code: 'V751', message: `${what}: value ${v as number} is outside ${lo} to ${hi}; assignment skipped`, at, evidence: { value: v, low: lo, high: hi } });
          return;
        }
        encode(s, v, (k, drive) => pend(c, outs[k], drive, d));
      };
    }
    if (t.t === 'ss') {
      const { off, len } = t;
      return (c, v, d) => {
        const x = v as Uint8Array;
        for (let k = 0; k < len; k++) pend(c, outs[off + k], LOGIC_TO_DRIVE[x[k]], d);
      };
    }
    const idx = compileExpr(t.i, env.P);
    const { left, asc, len } = t;
    return (c, v, d) => {
      const i = idx(c) as number;
      const pos = asc ? i - left : left - i;
      if (pos < 0 || pos >= len) {
        c.issue({ code: 'V750', message: `index ${i} is outside the range of ${s.n} (${asc ? `${left} to ${left + len - 1}` : `${left} downto ${left - len + 1}`}); assignment skipped`, at, evidence: { index: i } });
        return;
      }
      pend(c, outs[pos], LOGIC_TO_DRIVE[v as number], d);
    };
  }
  // variables
  const slot = t.v;
  if (t.t === 'v') {
    const { lo, hi } = t;
    return (c, v) => {
      if (lo !== undefined && ((v as number) < lo || (v as number) > hi!)) {
        c.issue({ code: 'V751', message: `${what}: value ${v as number} is outside ${lo} to ${hi}; assignment skipped`, at, evidence: { value: v, low: lo, high: hi } });
        return;
      }
      c.vars[slot] = v;
    };
  }
  if (t.t === 'vs') {
    const { off, len } = t;
    return (c, v) => {
      const cur = (c.vars[slot] as Uint8Array).slice();
      cur.set((v as Uint8Array).subarray(0, len), off);
      c.vars[slot] = cur;
    };
  }
  const idx = compileExpr(t.i, env.P);
  const { left, asc, len } = t;
  return (c, v) => {
    const i = idx(c) as number;
    const pos = asc ? i - left : left - i;
    if (pos < 0 || pos >= len) {
      c.issue({ code: 'V750', message: `index ${i} is outside the range of ${what} (${asc ? `${left} to ${left + len - 1}` : `${left} downto ${left - len + 1}`}); assignment skipped`, at, evidence: { index: i } });
      return;
    }
    const cur = (c.vars[slot] as Uint8Array).slice();
    cur[pos] = v as number;
    c.vars[slot] = cur;
  };
}

function compileStmt(s: IrStmt, env: StmtEnv): SFn {
  switch (s.k) {
    case 'sa': {
      const e = compileExpr(s.e, env.P);
      const d = s.d ? compileExpr(s.d, env.P) : undefined;
      const write = compileTargetWrite(s.t, env, s.at, s.what);
      const at = s.at;
      return c => {
        const v = e(c);
        let delay = 0;
        if (d) {
          delay = Math.round(d(c) as number);
          if (delay < 0) {
            c.issue({ code: 'V751', message: `negative delay (${delay} ps) in a signal assignment; using 0`, at });
            delay = 0;
          }
        }
        write(c, v, delay);
        return 0;
      };
    }
    case 'va': {
      const e = compileExpr(s.e, env.P);
      const write = compileTargetWrite(s.t, env, s.at, s.what);
      return c => {
        write(c, e(c), 0);
        return 0;
      };
    }
    case 'if': {
      const arms = s.arms.map(([cond, body]) => [compileExpr(cond, env.P), compileBlock(body, env)] as const);
      const els = s.els ? compileBlock(s.els, env) : undefined;
      return c => {
        for (let k = 0; k < arms.length; k++) if (arms[k][0](c)) return arms[k][1](c);
        return els ? els(c) : 0;
      };
    }
    case 'case': {
      const e = compileExpr(s.e, env.P);
      const arms = s.arms.map(b => compileBlock(b, env));
      const map = new Map(Object.entries(s.map));
      const { ranges, others, m } = s;
      return c => {
        const v = e(c);
        const key = m === 'v' ? vecToString(v as Uint8Array) : String(v);
        let arm = map.get(key);
        if (arm === undefined && m === 'n') {
          const x = v as number;
          for (const [lo, hi, a] of ranges) {
            if (x >= lo && x <= hi) {
              arm = a;
              break;
            }
          }
        }
        if (arm === undefined) arm = others;
        return arm >= 0 ? arms[arm](c) : 0;
      };
    }
    case 'for': {
      const body = compileBlock(s.body, env);
      const { v, from, to, step, id } = s;
      const myExit = ctrl(CTRL_EXIT, id);
      const myNext = ctrl(CTRL_NEXT, id);
      return c => {
        for (let i = from; step > 0 ? i <= to : i >= to; i += step) {
          c.vars[v] = i;
          const r = body(c);
          if (r === 0 || r === myNext) continue;
          if (r === myExit) break;
          return r;
        }
        return 0;
      };
    }
    case 'exit':
    case 'next': {
      const code = ctrl(s.k === 'exit' ? CTRL_EXIT : CTRL_NEXT, s.id);
      if (!s.c) return () => code;
      const cond = compileExpr(s.c, env.P);
      return c => (cond(c) ? code : 0);
    }
    case 'assert': {
      const cond = s.c ? compileExpr(s.c, env.P) : undefined;
      const msg = s.msg ? compileExpr(s.msg, env.P) : undefined;
      const sev = compileExpr(s.sev, env.P);
      const at = s.at;
      return c => {
        if (cond && cond(c)) return 0;
        const level = sev(c) as number;
        const text = msg ? String(msg(c)) : 'Assertion violation.';
        c.issue({
          code: 'V752',
          severity: level >= 2 ? 'error' : 'warning',
          message: `${cond ? 'assertion' : 'report'} (${['note', 'warning', 'error', 'failure'][level]}): ${text}`,
          at,
          evidence: { severity: ['note', 'warning', 'error', 'failure'][level], message: text },
        });
        return 0;
      };
    }
  }
}

// ── static evaluation (elaboration) ──

/** Evaluate an expression that reads no signals or variables. Issues are returned, not thrown. */
export function evalStatic(e: IrExpr, issues: RuntimeIssue[]): Value {
  const f = compileExpr(e, { sigs: [], inNets: [] });
  const c: Ctx = {
    h: null,
    init: false,
    inNets: [],
    prev: new Uint8Array(0),
    vars: [],
    issue: i => issues.push(i),
    pend: new Int16Array(0),
    pendDelay: new Float64Array(0),
    touched: [],
  };
  return f(c);
}

// ── the Model ──

export function initDrives(s: IrSignal): number[] {
  const out: number[] = new Array(s.w).fill(10);
  encode(s, constValue(s.init), (k, d) => (out[k] = d));
  return out;
}

class VhdlProcessModel implements Model {
  private c: Ctx;
  private run: SFn;
  private sens: number[] | null;
  private outDrv: number[];
  private started = false;
  private stash = new Map<number, [number, number]>();

  constructor(
    private cfg: ProcessConfig & { inPins: string[]; outPins: string[] },
    private ctx: ModelCtx,
  ) {
    const inNets = cfg.inPins.map(p => {
      const n = ctx.inputs[p];
      if (n === undefined) throw new Error(`vhdl-process ${cfg.name}: missing input pin '${p}'`);
      return n;
    });
    this.outDrv = cfg.outPins.map(p => {
      const d = ctx.outputs[p];
      if (d === undefined) throw new Error(`vhdl-process ${cfg.name}: missing output pin '${p}'`);
      return d;
    });
    const P: ProcInfo = { sigs: cfg.sigs, inNets };
    this.run = compileBlock(cfg.body, { P, sigs: cfg.sigs });
    this.sens = cfg.sens === 'all' ? null : cfg.sens;
    const nOut = cfg.outPins.length;
    this.c = {
      h: null,
      init: true,
      inNets,
      prev: new Uint8Array(inNets.length),
      vars: cfg.vars.map(v => constValue(v.init)),
      issue: i => this.report(i),
      pend: new Int16Array(nOut).fill(-1),
      pendDelay: new Float64Array(nOut),
      touched: [],
    };
  }

  private report(i: RuntimeIssue): void {
    const h = this.c.h;
    if (!h) return;
    const n = NOTES[i.code];
    h.report(
      vhdlDiagnostic(i.code, {
        ...(i.severity ? { severity: i.severity } : {}),
        message: `${this.cfg.name}: ${i.message}`,
        subject: { components: [this.ctx.id] },
        time: h.time,
        ...(n ? { note: n.note } : {}),
        evidence: { process: this.cfg.name, ...(i.evidence ?? {}) },
        fixes: n ? [n.fix] : [],
        ...(i.at ? { at: i.at } : {}),
      }),
    );
  }

  reset(h: Host): void {
    for (const s of this.cfg.sigs) {
      if (!s.outs) continue;
      const drives = initDrives(s);
      s.outs.forEach((o, k) => {
        if (o >= 0) h.out(this.outDrv[o], drives[k]);
      });
    }
  }

  evaluate(h: Host): void {
    const c = this.c;
    c.h = h;
    c.init = h.initializing;
    const ins = c.inNets;
    if (!this.started) {
      for (let k = 0; k < ins.length; k++) c.prev[k] = h.read(ins[k]);
      this.started = true;
      if (this.cfg.skipInit) return;
    } else {
      let trigger = this.sens === null;
      if (!trigger) {
        const sens = this.sens!;
        for (let k = 0; k < sens.length; k++) {
          if (h.read(ins[sens[k]]) !== c.prev[sens[k]]) {
            trigger = true;
            break;
          }
        }
      }
      if (!trigger) {
        for (let k = 0; k < ins.length; k++) c.prev[k] = h.read(ins[k]);
        return;
      }
    }
    this.run(c);
    for (let k = 0; k < ins.length; k++) c.prev[k] = h.read(ins[k]);
    this.flush(h);
  }

  private flush(h: Host): void {
    const c = this.c;
    for (const o of c.touched) {
      const drive = c.pend[o];
      const delay = c.pendDelay[o];
      c.pend[o] = -1;
      if (h.initializing) {
        if (delay > 0) {
          this.stash.set(o, [drive, delay]);
          continue;
        }
        this.stash.delete(o);
      }
      h.out(this.outDrv[o], drive, delay);
    }
    c.touched.length = 0;
  }

  start(h: Host): void {
    for (const [o, [drive, delay]] of [...this.stash.entries()].sort((a, b) => a[0] - b[0])) h.out(this.outDrv[o], drive, delay);
    this.stash.clear();
  }
}

export function createProcessModel(config: JsonValue, ctx: ModelCtx): Model {
  const cfg = config as unknown as ProcessConfig & { inPins: string[]; outPins: string[] };
  if (!cfg || cfg.v !== 1) throw new Error(`vhdl-process: unsupported config version`);
  return new VhdlProcessModel(cfg, ctx);
}
