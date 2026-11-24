/**
 * Elaboration: entity + architecture + generic values → flat list of
 * processes (each lowered to the JSON IR of ir.ts) and per-bit nets.
 *
 *   - every signal becomes one net per bit: std_logic/boolean `name`, vectors
 *     `name[i]` (i = VHDL index), integers/enums `name[k]` (k = bit of the
 *     binary encoding, LSB 0; two's complement when the range has negatives);
 *   - nets get the instance path as prefix (`U1__count[3]`, `U1__u1__carry`);
 *   - every process, concurrent assignment and concurrent assert becomes one
 *     behavioral component; sub-entities are flattened (their ports alias the
 *     actual signal's nets); for/if-generate are unrolled.
 *
 * Every user error becomes a V7xx diagnostic at its VHDL source location.
 * Elaboration never throws for user errors; it poisons the offending
 * expression (type 'err') so one mistake reports once.
 */
import type {
  ArchBody,
  Assoc,
  Choice,
  ConcStmt,
  ContextItem,
  Decl,
  EntityDecl,
  Expr,
  InterfaceDecl,
  Mode,
  ProcessStmt,
  RangeExpr,
  SeqStmt,
  SubtypeInd,
  Waveform,
} from './ast';
import { vhdlDiagnostic } from './diagnostics';
import type { VhdlDiagnostic, VhdlFix } from './diagnostics';
import type { IrConst, IrExpr, IrSignal, IrStmt, IrTarget, IrVar, ProcessConfig } from './ir';
import { isPlural, TIME_UNITS, SUPPORTED_SUMMARY } from './parser';
import { range as printRange, expr as printExpr } from './printer';
import { constValue, evalStatic } from './runtime';
import type { RuntimeIssue } from './runtime';
import { formatLoc } from './source';
import type { Loc, SourceInfo } from './source';
import {
  BASE_NAME,
  compatible,
  defaultValue,
  indexAt,
  isResolved,
  isSignalType,
  netWidth,
  sameVecFamily,
  T_BOOL,
  T_ERR,
  T_INT,
  T_LOGIC,
  T_NATURAL,
  T_POSITIVE,
  T_SEVERITY,
  T_STR,
  T_TIME,
  T_ULOGIC,
  typeName,
  vecLen,
  vecOf,
} from './types';
import type { VecBase, VType } from './types';
import { INT_MAX, INT_MIN, LOGIC_CHARS, vecFromString, vecToString } from './values';
import type { Value } from './values';

// ── public results ──

export interface ElabProc {
  /** Component id in the digital circuit (`U1__u1__p_count`). */
  id: string;
  /** Display name (`u1.p_count`). */
  name: string;
  at?: string;
  config: ProcessConfig & { inPins: string[]; outPins: string[] };
  /** pin → net */
  wiring: Record<string, string>;
  combPaths: [string, string, number][];
}

export interface ElabConst {
  id: string;
  net: string;
  /** std_logic code of the constant level. */
  value: number;
  at?: string;
}

export interface ElabPort {
  name: string;
  mode: Mode;
  t: VType;
  /** Nets in element-position order (vectors: left to right; integers/enums: LSB first). */
  nets: string[];
  hasDefault: boolean;
}

export interface ElabSignal {
  name: string;
  t: VType;
  nets: string[];
  port: boolean;
}

export interface ElabResult {
  entity: string;
  architecture: string;
  generics: Record<string, Value>;
  procs: ElabProc[];
  consts: ElabConst[];
  ports: ElabPort[];
  signals: ElabSignal[];
  diagnostics: VhdlDiagnostic[];
}

export interface DesignUnits {
  sources: SourceInfo[];
  entities: Map<string, EntityDecl>;
  archs: Map<string, ArchBody[]>;
}

/**
 * What a top-level port is bound to: a base net name (expanded per bit like
 * signals), or explicit nets from the lowest index / LSB up.
 */
export type TopBinding = string | string[];

// ── internals ──

interface ESig {
  /** hierarchical display name */
  name: string;
  /** local VHDL name (pin names) */
  local: string;
  t: VType;
  nets: string[];
  init: Value;
  mode?: Mode;
  isPort: boolean;
  /** top-level port (driven from outside when mode in/inout) */
  top: boolean;
  loc: Loc;
}

type Sym =
  | { k: 'const'; name: string; t: VType; v: Value; generic?: boolean }
  | { k: 'sig'; sig: ESig }
  | { k: 'var'; name: string; t: VType; slot: number; loop?: boolean }
  | { k: 'type'; name: string; t: VType }
  | { k: 'lit'; name: string; t: VType; idx: number }
  | { k: 'comp'; name: string; generics: InterfaceDecl[]; ports: InterfaceDecl[]; loc: Loc }
  | { k: 'fn'; name: string }
  | { k: 'lib'; name: string };

class Scope {
  map = new Map<string, Sym>();
  constructor(readonly parent?: Scope) {}
  get(n: string): Sym | undefined {
    for (let s: Scope | undefined = this; s; s = s.parent) {
      const v = s.map.get(n);
      if (v) return v;
    }
    return undefined;
  }
  names(): string[] {
    const out = new Set<string>();
    for (let s: Scope | undefined = this; s; s = s.parent) for (const k of s.map.keys()) out.add(k);
    return [...out];
  }
}

interface Prefix {
  net: string;
  comp: string;
  disp: string;
}

interface TExpr {
  t: VType;
  ir: IrExpr;
}

const ERR: TExpr = { t: T_ERR, ir: { o: 'k', v: 0 } };

const IEEE_1164 = new Set(['std_logic', 'std_ulogic', 'std_logic_vector', 'std_ulogic_vector', 'rising_edge', 'falling_edge', 'to_x01', 'is_x', 'to_stdlogicvector', 'to_bitvector', 'resolved']);
const IEEE_NUMERIC = new Set(['unsigned', 'signed', 'to_unsigned', 'to_signed', 'to_integer', 'resize', 'shift_left', 'shift_right', 'rotate_left', 'rotate_right', 'std_match', 'to_01']);
const ARITH_NAMES: Record<string, string> = {
  conv_integer: 'to_integer(unsigned(x)) (or signed)',
  conv_std_logic_vector: 'std_logic_vector(to_unsigned(n, width))',
  conv_unsigned: 'to_unsigned(n, width) or resize(x, width)',
  conv_signed: 'to_signed(n, width) or resize(x, width)',
  ext: 'resize(unsigned(x), width)',
  sxt: 'resize(signed(x), width)',
};
const UNSUPPORTED_NAMES: Record<string, string> = {
  bit: "type 'bit' — use std_logic",
  bit_vector: "type 'bit_vector' — use std_logic_vector",
  character: "type 'character'",
  real: "type 'real' — use integers or fixed-width unsigned/signed",
  now: "'now' (simulation time is testbench-only; use a counter clocked by the design clock)",
  std_match: "std_match — compare with '=' or mask the don't-care bits",
  to_01: 'to_01',
  is_x: "is_x — compare each bit with '0'/'1' instead",
  to_x01: 'to_x01',
  to_stdlogicvector: 'to_stdlogicvector (bit_vector conversion)',
  to_bitvector: 'to_bitvector',
  minimum: 'minimum/maximum — write an if statement',
  maximum: 'minimum/maximum — write an if statement',
  file_open: 'file I/O',
  readline: 'file I/O (textio)',
  writeline: 'file I/O (textio)',
  read: 'file I/O (textio)',
  write: 'file I/O (textio)',
};

const toConst = (v: Value): IrConst => (v instanceof Uint8Array ? vecToString(v) : typeof v === 'string' ? { str: v } : v);

function levenshtein(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      // adjacent transposition counts as one edit ('cuont' → 'count')
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  return d[a.length][b.length];
}

function containsEdge(ir: IrExpr): boolean {
  switch (ir.o) {
    case 'ev':
    case 'edge':
      return true;
    case 'k':
    case 's':
    case 'v':
      return false;
    default:
      for (const v of Object.values(ir)) {
        if (v && typeof v === 'object') {
          if (Array.isArray(v)) {
            for (const x of v) if (x && typeof x === 'object' && ('o' in x ? containsEdge(x as IrExpr) : 'e' in x && containsEdge((x as { e: IrExpr }).e))) return true;
          } else if ('o' in v && containsEdge(v as IrExpr)) return true;
        }
      }
      return false;
  }
}

function bitSuffix(t: VType, k: number): string {
  if (t.k === 'logic' || t.k === 'bool') return '';
  if (t.k === 'vec') return `[${indexAt(t, k)}]`;
  return `[${k}]`;
}

function netsFor(base: string, t: VType): string[] {
  const n = netWidth(t);
  return Array.from({ length: n }, (_, k) => `${base}${bitSuffix(t, k)}`);
}

function sigKind(t: VType): IrSignal['k'] {
  switch (t.k) {
    case 'logic':
      return 'l';
    case 'vec':
      return 'v';
    case 'bool':
      return 'b';
    case 'enum':
      return 'e';
    default:
      return 'i';
  }
}

/** Process compilation state. */
class PC {
  sigs: IrSignal[] = [];
  sigIdx = new Map<ESig, number>();
  inPins: string[] = [];
  inNets: string[] = [];
  inIdx = new Map<string, number>();
  outPins: string[] = [];
  outNets: string[] = [];
  outIdx = new Map<string, number>();
  pins = new Set<string>();
  vars: IrVar[] = [];
  loops: { label?: string; id: number }[] = [];
  loopCount = 0;
  guard = 0;
  combOut = new Map<number, number>();
  unguardedReads = new Map<ESig, Loc>();
  drivenSigs = new Set<ESig>();
  constructor(
    readonly name: string,
    readonly id: string,
  ) {}

  private uniquePin(p: string): string {
    let name = p;
    for (let n = 2; this.pins.has(name); n++) name = `${p}#${n}`;
    this.pins.add(name);
    return name;
  }

  sig(s: ESig): number {
    let i = this.sigIdx.get(s);
    if (i === undefined) {
      i = this.sigs.length;
      this.sigIdx.set(s, i);
      const t = s.t;
      const ir: IrSignal = { n: s.name, k: sigKind(t), w: s.nets.length, ins: null, outs: null, init: toConst(s.init) };
      if (t.k === 'int') {
        ir.lo = t.lo;
        ir.hi = t.hi;
      }
      if (t.k === 'enum') {
        ir.hi = t.lits.length - 1;
        ir.lits = t.lits;
      }
      this.sigs.push(ir);
    }
    return i;
  }

  read(s: ESig): number {
    const i = this.sig(s);
    const ir = this.sigs[i];
    if (!ir.ins) {
      ir.ins = s.nets.map((net, k) => {
        let x = this.inIdx.get(net);
        if (x === undefined) {
          x = this.inNets.length;
          this.inIdx.set(net, x);
          this.inNets.push(net);
          this.inPins.push(this.uniquePin(`in:${s.local}${bitSuffix(s.t, k)}`));
        }
        return x;
      });
    }
    return i;
  }

  drive(s: ESig, positions: number[] | 'all'): number[] {
    const i = this.sig(s);
    const ir = this.sigs[i];
    if (!ir.outs) ir.outs = new Array(s.nets.length).fill(-1);
    const outs = ir.outs;
    const list = positions === 'all' ? s.nets.map((_, k) => k) : positions;
    this.drivenSigs.add(s);
    return list.map(k => {
      if (outs[k] < 0) {
        const net = s.nets[k];
        let x = this.outIdx.get(net);
        if (x === undefined) {
          x = this.outNets.length;
          this.outIdx.set(net, x);
          this.outNets.push(net);
          this.outPins.push(this.uniquePin(`${s.local}${bitSuffix(s.t, k)}`));
        }
        outs[k] = x;
      }
      return outs[k];
    });
  }
}

export class Elaborator {
  diags: VhdlDiagnostic[] = [];
  private procs: ElabProc[] = [];
  private consts: ElabConst[] = [];
  private netDrivers = new Map<string, Set<string>>();
  private netOwner = new Map<string, ESig>();
  private ownerSigs: ESig[] = [];
  private usedIds = new Set<string>();
  private enumUid = 0;
  private stack: string[] = [];
  private allSignals: ElabSignal[] = [];
  private ctxChecked = new Set<object>();

  constructor(private units: DesignUnits) {}

  // ── diagnostics ──

  at(loc: Loc | undefined): string | undefined {
    return formatLoc(this.units.sources, loc);
  }

  err(code: string, loc: Loc | undefined, message: string, extra: { note?: string; fixes?: VhdlFix[]; severity?: 'error' | 'warning'; evidence?: Record<string, unknown>; subject?: VhdlDiagnostic['subject'] } = {}): void {
    const at = this.at(loc);
    this.diags.push(vhdlDiagnostic(code, { message, ...extra, ...(at ? { at } : {}) }));
  }

  unsupported(loc: Loc, construct: string, note?: string, fixes?: VhdlFix[]): void {
    this.err('V703', loc, `${construct} ${isPlural(construct) ? 'are' : 'is'} not supported by the CircuitsVibe VHDL subset`, {
      note: note ? `${note}. ${SUPPORTED_SUMMARY}` : SUPPORTED_SUMMARY,
      evidence: { construct },
      ...(fixes ? { fixes } : {}),
    });
  }

  // ── entry ──

  elaborateTop(entityName: string, opts: { id: string; generics: Record<string, Value>; ports: Record<string, TopBinding>; arch?: string; genericLoc?: Loc }): ElabResult | undefined {
    const ent = this.units.entities.get(entityName);
    if (!ent) return undefined;
    const arch = this.pickArch(ent, opts.arch, ent.loc);
    if (!arch) return undefined;
    const prefix: Prefix = { net: `${opts.id}__`, comp: `${opts.id}__`, disp: '' };
    const genericValues = new Map<string, { v: Value; loc?: Loc }>();
    for (const [k, v] of Object.entries(opts.generics)) genericValues.set(k, { v });
    const res = this.instEntity(ent, arch, prefix, genericValues, { top: opts.ports });
    if (!res) return undefined;
    this.finish();
    return {
      entity: ent.name,
      architecture: arch.name,
      generics: res.generics,
      procs: this.procs,
      consts: this.consts,
      ports: res.ports,
      signals: this.allSignals,
      diagnostics: this.diags,
    };
  }

  pickArch(ent: EntityDecl, name: string | undefined, loc: Loc): ArchBody | undefined {
    const list = this.units.archs.get(ent.name) ?? [];
    if (list.length === 0) {
      this.err('V723', loc, `entity '${ent.name}' has no architecture`, {
        note: 'an entity only declares the interface; its behavior is in an architecture body',
        fixes: [{ kind: 'add-architecture', confidence: 'suggested', detail: `add: architecture rtl of ${ent.name} is begin … end architecture;` }],
      });
      return undefined;
    }
    if (name) {
      const a = list.find(x => x.name === name);
      if (!a) {
        this.err('V709', loc, `entity '${ent.name}' has no architecture '${name}' (available: ${list.map(x => x.name).join(', ')})`);
        return undefined;
      }
      return a;
    }
    return list[list.length - 1];
  }

  /** Undriven nets get a constant at their initial value; unresolved multi-driver check. */
  private finish(): void {
    for (const s of this.ownerSigs) {
      s.nets.forEach((net, k) => {
        const drivers = this.netDrivers.get(net);
        if (drivers && drivers.size > 0) {
          if (drivers.size > 1 && !isResolved(s.t)) {
            this.err('V714', s.loc, `${typeName(s.t)} signal '${s.name}' is driven by ${drivers.size} processes (${[...drivers].sort().join(', ')}); only resolved types (std_logic, std_logic_vector, unsigned, signed) may have several drivers`, {
              note: 'each process that assigns a signal is a driver of it; an unresolved type has no rule to combine several drivers, so VHDL rejects the design',
              fixes: [
                { kind: 'single-driver', confidence: 'suggested', detail: `assign '${s.local}' from one process only (merge the processes or use separate signals)` },
              ],
              subject: { nets: [net] },
            });
          }
          return;
        }
        if (s.top && (s.mode === 'in' || s.mode === 'inout')) return;
        const level = this.bitInit(s, k);
        const id = this.uniqueId(`${s.nets[k].replace(/\[(\d+)\]/g, '_$1').replace(/\[-(\d+)\]/g, '_m$1').replace(/[^A-Za-z0-9_]/g, '_')}__init`);
        this.consts.push({ id, net, value: level, ...(this.at(s.loc) ? { at: this.at(s.loc) } : {}) });
      });
    }
  }

  private bitInit(s: ESig, k: number): number {
    const v = s.init;
    switch (s.t.k) {
      case 'logic':
        return v as number;
      case 'vec':
        return (v as Uint8Array)[k];
      case 'bool':
        return (v as number) ? 3 : 2;
      default: {
        let x = v as number;
        if (x < 0) x += 2 ** s.nets.length;
        return Math.floor(x / 2 ** k) % 2 ? 3 : 2;
      }
    }
  }

  private uniqueId(base: string): string {
    let id = base.replace(/^[^A-Za-z]+/, 'x');
    for (let n = 2; this.usedIds.has(id); n++) id = `${base}_${n}`;
    this.usedIds.add(id);
    return id;
  }

  // ── context clauses ──

  private context(items: ContextItem[], key: object): { s1164: boolean; numeric: boolean } {
    let ieee = false;
    let s1164 = false;
    let numeric = false;
    const report = !this.ctxChecked.has(key);
    this.ctxChecked.add(key);
    for (const c of items) {
      if (c.kind === 'library') {
        for (const n of c.names) {
          if (n === 'ieee') ieee = true;
          else if (n !== 'work' && n !== 'std' && report)
            this.err('V708', c.loc, `library '${n}' is not available`, { note: 'only the ieee, std and work libraries exist here; every design unit is compiled into work' });
        }
        continue;
      }
      const [lib, pkg, item] = c.names;
      if (lib === 'ieee') {
        if (!ieee && report)
          this.err('V707', c.loc, `'use ieee.${pkg ?? ''}…' needs 'library ieee;' first`, {
            fixes: [{ kind: 'insert-text', confidence: 'mechanical', detail: "add 'library ieee;' before the use clause", patch: 'library ieee;' }],
          });
        if (pkg === 'std_logic_1164') s1164 = true;
        else if (pkg === 'numeric_std') numeric = true;
        else if (report) {
          const vendor = ['std_logic_arith', 'std_logic_unsigned', 'std_logic_signed', 'std_logic_misc'].includes(pkg ?? '');
          this.err('V708', c.loc, `package ieee.${pkg} is not supported`, {
            note: vendor
              ? `ieee.${pkg} is a non-standard Synopsys package; the IEEE standard equivalent is ieee.numeric_std (unsigned/signed types with to_unsigned, to_integer, resize)`
              : 'supported packages: ieee.std_logic_1164 and ieee.numeric_std',
            fixes: vendor
              ? [{ kind: 'replace-text', confidence: 'mechanical', detail: `replace 'use ieee.${pkg}.all;' with 'use ieee.numeric_std.all;' and convert arithmetic to unsigned/signed`, patch: 'use ieee.numeric_std.all;' }]
              : [],
          });
        }
        void item;
      } else if (lib === 'std') {
        if (pkg !== 'standard' && report)
          this.err('V708', c.loc, `package std.${pkg} is not supported`, {
            note: pkg === 'textio' ? 'file I/O (textio) is testbench-only; drive inputs from the bench (sim.drive, Stimulus) and check outputs with measurements' : 'only std.standard is available',
          });
      } else if (lib === 'work') {
        if (pkg !== 'all' && report)
          this.err('V708', c.loc, `package work.${pkg} is not available (packages are not supported)`, {
            note: 'declare constants and types in the architecture, or pass values as generics; entities in work are visible without a use clause',
            fixes: [{ kind: 'delete-text', confidence: 'suggested', detail: `remove 'use work.${pkg}…' and move the package's declarations into the architecture` }],
          });
      } else if (report) this.err('V708', c.loc, `library '${lib}' is not available`);
    }
    return { s1164, numeric };
  }

  private rootScope(ctx: { s1164: boolean; numeric: boolean }): Scope {
    const s = new Scope();
    const type = (name: string, t: VType): void => void s.map.set(name, { k: 'type', name, t });
    type('integer', T_INT);
    type('natural', T_NATURAL);
    type('positive', T_POSITIVE);
    type('boolean', T_BOOL);
    type('time', T_TIME);
    type('string', T_STR);
    type('severity_level', T_SEVERITY);
    s.map.set('true', { k: 'lit', name: 'true', t: T_BOOL, idx: 1 });
    s.map.set('false', { k: 'lit', name: 'false', t: T_BOOL, idx: 0 });
    T_SEVERITY.k === 'enum' && T_SEVERITY.lits.forEach((l, i) => s.map.set(l, { k: 'lit', name: l, t: T_SEVERITY, idx: i }));
    s.map.set('to_string', { k: 'fn', name: 'to_string' });
    for (const lib of ['ieee', 'std', 'work']) s.map.set(lib, { k: 'lib', name: lib });
    if (ctx.s1164) {
      type('std_logic', T_LOGIC);
      type('std_ulogic', T_ULOGIC);
      type('std_logic_vector', { k: 'uvec', base: 'slv' });
      type('std_ulogic_vector', { k: 'uvec', base: 'sulv' });
      s.map.set('rising_edge', { k: 'fn', name: 'rising_edge' });
      s.map.set('falling_edge', { k: 'fn', name: 'falling_edge' });
    }
    if (ctx.numeric) {
      type('unsigned', { k: 'uvec', base: 'u' });
      type('signed', { k: 'uvec', base: 's' });
      for (const f of ['to_unsigned', 'to_signed', 'to_integer', 'resize', 'shift_left', 'shift_right', 'rotate_left', 'rotate_right']) s.map.set(f, { k: 'fn', name: f });
    }
    return s;
  }

  private undeclared(name: string, loc: Loc, sc: Scope, what = 'name'): void {
    if (IEEE_1164.has(name) && !sc.get('std_logic')) {
      this.err('V707', loc, `'${name}' is declared in ieee.std_logic_1164, which is not visible here`, {
        note: 'std_logic and friends come from the IEEE library; every design unit that uses them needs the context clause',
        fixes: [{ kind: 'insert-text', confidence: 'mechanical', detail: 'add before the entity: library ieee; use ieee.std_logic_1164.all;', patch: 'library ieee;\nuse ieee.std_logic_1164.all;' }],
      });
      return;
    }
    if (IEEE_NUMERIC.has(name) && !sc.get('unsigned') && !UNSUPPORTED_NAMES[name]) {
      this.err('V707', loc, `'${name}' is declared in ieee.numeric_std, which is not visible here`, {
        fixes: [{ kind: 'insert-text', confidence: 'mechanical', detail: 'add before the entity: use ieee.numeric_std.all;', patch: 'use ieee.numeric_std.all;' }],
      });
      return;
    }
    if (ARITH_NAMES[name]) {
      this.err('V708', loc, `'${name}' comes from the non-standard ieee.std_logic_arith package, which is not supported`, {
        fixes: [{ kind: 'rewrite', confidence: 'suggested', detail: `use the numeric_std equivalent: ${ARITH_NAMES[name]}` }],
      });
      return;
    }
    if (UNSUPPORTED_NAMES[name]) {
      this.unsupported(loc, UNSUPPORTED_NAMES[name]);
      return;
    }
    const cands = sc
      .names()
      .filter(n => !['ieee', 'std', 'work'].includes(n))
      .map(n => [n, levenshtein(n, name)] as const)
      .filter(([n, d]) => d <= (name.length <= 3 ? 1 : 2) && d < name.length && n !== name)
      .sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1));
    this.err('V704', loc, `${what} '${name}' is not declared${cands.length ? ` — did you mean '${cands[0][0]}'?` : ''}`, {
      note: 'VHDL names must be declared before use (signals and constants in the architecture, variables in the process, ports in the entity); names are case-insensitive',
      fixes: cands.length
        ? [{ kind: 'rename', confidence: 'suggested', detail: `replace '${name}' with '${cands[0][0]}'` }]
        : [{ kind: 'declare', confidence: 'suggested', detail: `declare '${name}' (e.g. signal ${name} : std_logic;) before 'begin'` }],
    });
  }

  // ── static evaluation ──

  private mk(t: VType, ir: IrExpr, parts: TExpr[], loc: Loc): TExpr {
    if (t.k === 'err' || parts.some(p => p.t.k === 'err')) return ERR;
    if (parts.length > 0 && parts.every(p => p.ir.o === 'k')) {
      const issues: RuntimeIssue[] = [];
      const v = evalStatic(ir, issues);
      for (const i of issues) {
        if (i.code === 'V753') continue;
        this.err('V719', loc, `static expression: ${i.message}`, { ...(i.severity ? { severity: i.severity } : {}) });
      }
      return { t, ir: { o: 'k', v: toConst(v) } };
    }
    return { t, ir };
  }

  private staticValue(te: TExpr): Value | undefined {
    return te.ir.o === 'k' ? constValue(te.ir.v) : undefined;
  }

  /** Compile an expression that must be static (no signals/variables). */
  private staticExpr(e: Expr, sc: Scope, what: string, exp?: VType): { t: VType; v: Value } | undefined {
    const te = this.cx(e, sc, null, exp);
    if (te.t.k === 'err') return undefined;
    const v = this.staticValue(te);
    if (v === undefined) {
      this.err('V713', e.loc, `${what} must be static (a literal, constant, generic or loop/generate parameter), but '${printExpr(e)}' is not`, {
        note: 'widths, slice bounds, loop bounds and generic values are fixed at elaboration; they cannot depend on signals or variables',
      });
      return undefined;
    }
    return { t: te.t, v };
  }

  private staticInt(e: Expr, sc: Scope, what: string): number | undefined {
    const r = this.staticExpr(e, sc, what);
    if (!r) return undefined;
    if (r.t.k !== 'int') {
      this.err('V705', e.loc, `${what} must be an integer, found ${typeName(r.t)}`);
      return undefined;
    }
    return r.v as number;
  }

  // ── types ──

  private typeMark(name: string, sc: Scope, loc: Loc): VType {
    const s = sc.get(name);
    if (!s) {
      this.undeclared(name, loc, sc, 'type');
      return T_ERR;
    }
    if (s.k !== 'type') {
      this.err('V705', loc, `'${name}' is not a type`);
      return T_ERR;
    }
    return s.t;
  }

  /** Static range of a range expression: bounds, direction, element type. */
  staticRange(r: RangeExpr, sc: Scope, pc: PC | null): { left: number; right: number; asc: boolean; t: VType } | undefined {
    if (r.kind === 'range') {
      const l = this.staticExpr(r.left, sc, 'a range bound');
      const rr = this.staticExpr(r.right, sc, 'a range bound', l?.t);
      if (!l || !rr) return undefined;
      if (l.t.k === 'enum' && rr.t.k === 'enum' && l.t.uid === rr.t.uid) return { left: l.v as number, right: rr.v as number, asc: r.dir === 'to', t: l.t };
      if (l.t.k !== 'int' || rr.t.k !== 'int') {
        this.err('V705', r.loc, `range bounds must be integers, found ${typeName(l.t)} ${r.dir} ${typeName(rr.t)}`);
        return undefined;
      }
      return { left: l.v as number, right: rr.v as number, asc: r.dir === 'to', t: T_INT };
    }
    if (r.kind === 'attr-range') {
      const t = this.typeOfName(r.prefix, sc, pc);
      if (!t) return undefined;
      if (t.k !== 'vec') {
        this.err('V705', r.loc, `'${r.attr} needs an array prefix, '${printExpr(r.prefix)}' is ${typeName(t)}`);
        return undefined;
      }
      return r.attr === 'range' ? { left: t.left, right: t.right, asc: t.asc, t: T_INT } : { left: t.right, right: t.left, asc: !t.asc, t: T_INT };
    }
    const t = this.subtype(r.type, sc);
    if (t.k === 'int') return { left: t.asc ? t.lo : t.hi, right: t.asc ? t.hi : t.lo, asc: t.asc, t };
    if (t.k === 'enum') return { left: 0, right: t.lits.length - 1, asc: true, t };
    if (t.k === 'bool') return { left: 0, right: 1, asc: true, t };
    if (t.k !== 'err') this.err('V705', r.loc, `'${r.type.name}' is not a discrete type and cannot be used as a range`);
    return undefined;
  }

  /** Type of a name without reading it (for 'range / 'length on signals). */
  private typeOfName(e: Expr, sc: Scope, pc: PC | null): VType | undefined {
    if (e.kind === 'id') {
      const s = sc.get(e.name);
      if (!s) {
        this.undeclared(e.name, e.loc, sc);
        return undefined;
      }
      if (s.k === 'sig') return s.sig.t;
      if (s.k === 'var' || s.k === 'const' || s.k === 'type') return s.t;
      this.err('V705', e.loc, `'${e.name}' has no type here`);
      return undefined;
    }
    const te = this.cx(e, sc, pc);
    return te.t.k === 'err' ? undefined : te.t;
  }

  subtype(ind: SubtypeInd, sc: Scope): VType {
    const base = this.typeMark(ind.name, sc, ind.loc);
    if (base.k === 'err') return T_ERR;
    if (ind.index) {
      if (base.k !== 'uvec') {
        this.err('V705', ind.loc, `${typeName(base)} cannot take an index constraint`, base.k === 'vec' ? { note: `'${ind.name}' is already constrained` } : {});
        return T_ERR;
      }
      if (ind.index.length !== 1) {
        this.unsupported(ind.loc, 'multi-dimensional arrays');
        return T_ERR;
      }
      const r = this.staticRange(ind.index[0], sc, null);
      if (!r) return T_ERR;
      if (r.t.k !== 'int') {
        this.err('V705', ind.loc, `vector indices must be integers`);
        return T_ERR;
      }
      return { k: 'vec', base: base.base, left: r.left, right: r.right, asc: r.asc };
    }
    if (ind.range) {
      if (base.k !== 'int') {
        this.unsupported(ind.loc, `range constraints on ${typeName(base)}`);
        return T_ERR;
      }
      const r = this.staticRange(ind.range, sc, null);
      if (!r) return T_ERR;
      const lo = Math.min(r.left, r.right);
      const hi = Math.max(r.left, r.right);
      if ((r.asc && r.left > r.right) || (!r.asc && r.left < r.right)) {
        this.err('V719', ind.loc, `null range ${r.left} ${r.asc ? 'to' : 'downto'} ${r.right} for ${ind.name}`, { note: 'the subtype would have no values' });
        return T_ERR;
      }
      if (lo < base.lo || hi > base.hi) {
        this.err('V719', ind.loc, `range ${r.left} ${r.asc ? 'to' : 'downto'} ${r.right} is outside ${typeName(base)} (${base.lo} to ${base.hi})`);
        return T_ERR;
      }
      return { k: 'int', lo, hi, asc: r.asc, name: `${base.name === 'integer' || base.name === 'natural' || base.name === 'positive' ? base.name : 'integer'} range ${r.left} ${r.asc ? 'to' : 'downto'} ${r.right}` };
    }
    return base;
  }

  /** Type of a signal/variable/constant/port declaration; reports unconstrained arrays. */
  private objectType(ind: SubtypeInd, sc: Scope, what: string, allowUnconstrained = false): VType {
    const t = this.subtype(ind, sc);
    if (t.k === 'uvec' && !allowUnconstrained) {
      this.err('V705', ind.loc, `${what} of type ${typeName(t)} needs an index constraint, e.g. ${ind.name}(7 downto 0)`, {
        fixes: [{ kind: 'add-constraint', confidence: 'suggested', detail: `write ${ind.name}(N-1 downto 0)` }],
      });
      return T_ERR;
    }
    if (t.k === 'str' && what !== 'constant') {
      this.unsupported(ind.loc, `${what}s of type string`, 'strings are only supported in report messages');
      return T_ERR;
    }
    return t;
  }

  // ── assignment checks ──

  private checkAssign(target: VType, v: TExpr, loc: Loc, what: string): boolean {
    if (target.k === 'err' || v.t.k === 'err') return false;
    if (!compatible(target, v.t)) {
      this.err('V705', loc, `type mismatch: cannot assign ${typeName(v.t)} to ${what} of type ${typeName(target)}`, this.mismatchHelp(target, v.t));
      return false;
    }
    if (target.k === 'vec' && v.t.k === 'vec' && vecLen(target) !== vecLen(v.t)) {
      const tl = vecLen(target);
      const vl = vecLen(v.t);
      const fixes: VhdlFix[] = [];
      if ((target.base === 'u' || target.base === 's') && (v.t.base === 'u' || v.t.base === 's')) fixes.push({ kind: 'resize', confidence: 'mechanical', detail: `wrap the value in resize(…, ${tl})` });
      else if (vl > tl) fixes.push({ kind: 'slice', confidence: 'suggested', detail: `assign a ${tl}-bit slice of the value, e.g. x(${tl - 1} downto 0)` });
      else fixes.push({ kind: 'extend', confidence: 'suggested', detail: `extend the value to ${tl} bits, e.g. (${tl - vl - 1} downto 0 => '0') & x, or resize(unsigned(x), ${tl})` });
      this.err('V706', loc, `length mismatch: ${what} has ${tl} bits (${typeName(target)}) but the value has ${vl} bits (${typeName(v.t)})`, {
        note: 'VHDL assigns arrays element by element from the left; both sides must have the same number of elements',
        evidence: { targetLength: tl, valueLength: vl },
        fixes,
      });
      return false;
    }
    if (target.k === 'int' && v.ir.o === 'k') {
      const x = constValue(v.ir.v) as number;
      if (x < target.lo || x > target.hi) {
        this.err('V719', loc, `value ${x} is outside the range of ${what} (${typeName(target)})`);
        return false;
      }
    }
    return true;
  }

  private mismatchHelp(target: VType, v: VType): { note?: string; fixes?: VhdlFix[] } {
    if (target.k === 'vec' && v.k === 'vec') {
      return {
        note: 'std_logic_vector, unsigned and signed are distinct types; VHDL needs an explicit conversion between them',
        fixes: [{ kind: 'convert', confidence: 'mechanical', detail: `wrap the value in ${BASE_NAME[target.base]}(…)` }],
      };
    }
    if (target.k === 'vec' && v.k === 'int') {
      return {
        note: 'an integer is not a vector',
        fixes: [
          {
            kind: 'convert',
            confidence: 'mechanical',
            detail:
              target.base === 'u' || target.base === 's'
                ? `use to_${target.base === 's' ? 'signed' : 'unsigned'}(value, ${vecLen(target)})`
                : `use std_logic_vector(to_unsigned(value, ${vecLen(target)})) — or (others => '0') for zero`,
          },
        ],
      };
    }
    if (target.k === 'int' && v.k === 'vec') {
      return { fixes: [{ kind: 'convert', confidence: 'mechanical', detail: v.base === 'u' || v.base === 's' ? 'use to_integer(value)' : 'use to_integer(unsigned(value))' }] };
    }
    if (target.k === 'logic' && v.k === 'vec') return { note: "a std_logic is one bit: use a character literal like '1', or index one bit of the vector, e.g. x(0)" };
    if (target.k === 'vec' && v.k === 'logic') return { note: 'a vector needs an array value: a string literal "0101", (others => \'0\') or a concatenation' };
    if (target.k === 'logic' && v.k === 'bool') return { fixes: [{ kind: 'convert', confidence: 'mechanical', detail: "write: x <= '1' when condition else '0';" }] };
    if (target.k === 'bool' && v.k === 'logic') return { fixes: [{ kind: 'convert', confidence: 'mechanical', detail: "compare the bit: (x = '1')" }] };
    return {};
  }

  // ── expressions ──

  private isContextual(e: Expr): boolean {
    return e.kind === 'str' || e.kind === 'bitstr' || e.kind === 'agg' || (e.kind === 'paren' && this.isContextual(e.expr));
  }

  cx(e: Expr, sc: Scope, pc: PC | null, exp?: VType): TExpr {
    switch (e.kind) {
      case 'int':
        return { t: T_INT, ir: { o: 'k', v: e.value } };
      case 'real':
        this.unsupported(e.loc, 'real (floating-point) values', 'use integers, or fixed-width unsigned/signed arithmetic; reals are only allowed in time literals like 1.5 ns');
        return ERR;
      case 'phys': {
        const v = e.value.kind === 'int' || e.value.kind === 'real' ? e.value.value : 0;
        return { t: T_TIME, ir: { o: 'k', v: v * TIME_UNITS[e.unit] } };
      }
      case 'char': {
        const code = LOGIC_CHARS.indexOf(e.value);
        if (code < 0) {
          const up = e.value.toUpperCase();
          const fix = LOGIC_CHARS.includes(up) ? up : undefined;
          this.err('V720', e.loc, `'${e.value}' is not a std_logic value${fix ? ` (std_logic literals are case-sensitive: write '${fix}')` : ''}`, {
            note: "std_logic values are 'U', 'X', '0', '1', 'Z', 'W', 'L', 'H' and '-'",
            ...(fix ? { fixes: [{ kind: 'replace-text', confidence: 'mechanical' as const, detail: `replace '${e.value}' with '${fix}'` }] } : {}),
          });
          return ERR;
        }
        return { t: T_LOGIC, ir: { o: 'k', v: code } };
      }
      case 'str':
      case 'bitstr':
        return this.stringLiteral(e.value, e.kind === 'bitstr', e.loc, exp);
      case 'id':
        return this.idExpr(e.name, e.loc, sc, pc, exp);
      case 'sel': {
        const s = this.selectedName(e, sc);
        if (s === undefined) return ERR;
        return this.idExpr(s, e.loc, sc, pc, exp);
      }
      case 'paren':
        return this.cx(e.expr, sc, pc, exp);
      case 'call':
        return this.call(e, sc, pc, exp);
      case 'attr':
        return this.attribute(e, sc, pc, exp);
      case 'binary':
        return this.binary(e, sc, pc, exp);
      case 'unary':
        return this.unary(e, sc, pc, exp);
      case 'agg':
        return this.aggregate(e, sc, pc, exp);
      case 'qual': {
        const t = this.typeMark(e.type, sc, e.loc);
        if (t.k === 'err') return ERR;
        const v = this.cx(e.expr, sc, pc, t);
        if (v.t.k === 'err') return ERR;
        if (!compatible(t, v.t)) {
          this.err('V705', e.loc, `qualified expression ${e.type}'(…) has type ${typeName(v.t)}`);
          return ERR;
        }
        if (t.k === 'vec' && v.t.k === 'vec' && vecLen(t) !== vecLen(v.t)) {
          this.err('V706', e.loc, `qualified expression: ${typeName(t)} has ${vecLen(t)} bits but the value has ${vecLen(v.t)}`);
          return ERR;
        }
        return { t: t.k === 'vec' ? t : v.t.k === 'vec' && t.k === 'uvec' ? { ...v.t, base: t.base } : v.t, ir: v.ir };
      }
      case 'null-lit':
        this.unsupported(e.loc, "'null' values");
        return ERR;
    }
  }

  private selectedName(e: Extract<Expr, { kind: 'sel' }>, sc: Scope): string | undefined {
    // ieee.numeric_std.to_unsigned, work.pkg.x, std.standard.integer
    let p: Expr = e.prefix;
    while (p.kind === 'sel') p = p.prefix;
    if (p.kind === 'id' && ['ieee', 'std', 'work'].includes(p.name)) return e.suffix;
    if (p.kind === 'id' && !sc.get(p.name)) {
      this.undeclared(p.name, p.loc, sc);
      return undefined;
    }
    this.unsupported(e.loc, 'record fields and selected names', 'use separate signals instead of records');
    return undefined;
  }

  private stringLiteral(value: string, bitstr: boolean, loc: Loc, exp?: VType): TExpr {
    if (exp && exp.k === 'str' && !bitstr) return { t: T_STR, ir: { o: 'k', v: { str: value } } };
    if (exp && exp.k !== 'vec' && exp.k !== 'uvec' && exp.k !== 'err') {
      if (exp.k === 'logic' && value.length === 1)
        this.err('V705', loc, `"${value}" is a string (a vector); a std_logic needs a character literal '${value}'`, {
          fixes: [{ kind: 'replace-text', confidence: 'mechanical', detail: `replace "${value}" with '${value}'` }],
        });
      else this.err('V705', loc, `a string literal "${value}" cannot be a value of type ${typeName(exp)}`);
      return ERR;
    }
    for (const ch of value) {
      if (!LOGIC_CHARS.includes(ch)) {
        const up = ch.toUpperCase();
        this.err('V720', loc, `"${value}" is not a std_logic vector literal: '${ch}' is not a std_logic value${LOGIC_CHARS.includes(up) ? ` (write '${up}')` : ''}`, {
          note: "vector literals may only contain U X 0 1 Z W L H -; for hex use x\"…\", for numbers use to_unsigned(n, width)",
        });
        return ERR;
      }
    }
    const base: VecBase = exp && (exp.k === 'vec' || exp.k === 'uvec') ? exp.base : 'slv';
    const n = value.length;
    const t: VType = exp && exp.k === 'vec' && vecLen(exp) === n ? exp : { k: 'vec', base, left: 0, right: n - 1, asc: true };
    return { t, ir: { o: 'k', v: value } };
  }

  private idExpr(name: string, loc: Loc, sc: Scope, pc: PC | null, exp?: VType): TExpr {
    if (exp && exp.k === 'enum') {
      const i = exp.lits.indexOf(name);
      const s0 = sc.get(name);
      if (i >= 0 && (!s0 || s0.k === 'lit')) return { t: exp, ir: { o: 'k', v: i } };
    }
    const s = sc.get(name);
    if (!s) {
      this.undeclared(name, loc, sc);
      return ERR;
    }
    switch (s.k) {
      case 'const':
        return { t: s.t, ir: { o: 'k', v: toConst(s.v) } };
      case 'lit':
        return { t: s.t, ir: { o: 'k', v: s.idx } };
      case 'var':
        if (!pc) return this.notStatic(name, loc);
        return { t: s.t, ir: { o: 'v', v: s.slot } };
      case 'sig': {
        if (!pc) return this.notStatic(name, loc);
        const i = pc.read(s.sig);
        if (pc.guard === 0 && !pc.unguardedReads.has(s.sig)) pc.unguardedReads.set(s.sig, loc);
        return { t: s.sig.t, ir: { o: 's', s: i } };
      }
      case 'type':
        this.err('V705', loc, `'${name}' is a type, not a value`, { note: `use ${name}'(…) to qualify an expression or ${name}(x) to convert` });
        return ERR;
      case 'fn':
        this.err('V705', loc, `function '${name}' needs arguments: ${name}(…)`);
        return ERR;
      case 'comp':
        this.err('V705', loc, `'${name}' is a component, not a value`);
        return ERR;
      case 'lib':
        this.err('V705', loc, `'${name}' is a library, not a value`);
        return ERR;
    }
  }

  private notStatic(name: string, loc: Loc): TExpr {
    this.err('V713', loc, `'${name}' is a signal or variable, but this expression must be static (a literal, constant, generic or loop/generate parameter)`, {
      note: 'widths, ranges, initial values, generic values and port-map constants are fixed at elaboration and cannot depend on signals',
    });
    return ERR;
  }

  private cond(e: Expr, sc: Scope, pc: PC | null): TExpr {
    const te = this.cx(e, sc, pc, T_BOOL);
    if (te.t.k === 'err') return ERR;
    if (te.t.k === 'bool') return te;
    if (te.t.k === 'logic') return this.mk(T_BOOL, { o: 'qq', a: te.ir }, [te], e.loc);
    this.err('V705', e.loc, `a condition must be boolean, found ${typeName(te.t)}`, {
      fixes: te.t.k === 'vec' ? [{ kind: 'compare', confidence: 'suggested', detail: `compare explicitly, e.g. ${printExpr(e)} = "${'0'.repeat(vecLen(te.t))}"` }] : te.t.k === 'int' ? [{ kind: 'compare', confidence: 'suggested', detail: `compare explicitly, e.g. ${printExpr(e)} /= 0` }] : [],
    });
    return ERR;
  }

  private assocArgs(e: Extract<Expr, { kind: 'call' }>, names: string[], fn: string): (Expr | RangeExpr)[] | undefined {
    const out: (Expr | RangeExpr | undefined)[] = [];
    let named = false;
    for (const a of e.args) {
      if (a.actual.kind === 'open') {
        this.err('V705', a.loc, `'open' is not an argument of ${fn}`);
        return undefined;
      }
      if (a.formal) {
        named = true;
        const f = a.formal.kind === 'id' ? names.indexOf(a.formal.name) : -1;
        if (f < 0) {
          this.err('V704', a.loc, `${fn} has no parameter '${printExpr(a.formal)}' (parameters: ${names.join(', ')})`);
          return undefined;
        }
        out[f] = a.actual as Expr;
      } else {
        if (named) {
          this.err('V701', a.loc, `positional arguments must come before named ones`);
          return undefined;
        }
        out.push(a.actual as Expr);
      }
    }
    if (out.length !== names.length || out.some(x => x === undefined)) {
      this.err('V705', e.loc, `${fn} takes ${names.length} argument${names.length > 1 ? 's' : ''} (${names.join(', ')}), got ${e.args.length}`);
      return undefined;
    }
    return out as (Expr | RangeExpr)[];
  }

  private asExpr(a: Expr | RangeExpr, fn: string): Expr | undefined {
    if (a.kind === 'range' || a.kind === 'attr-range' || a.kind === 'subtype-range') {
      this.err('V705', a.loc, `${fn}: a range is not a valid argument here`);
      return undefined;
    }
    return a as Expr;
  }

  private call(e: Extract<Expr, { kind: 'call' }>, sc: Scope, pc: PC | null, exp?: VType): TExpr {
    let pname: string | undefined;
    if (e.prefix.kind === 'id') pname = e.prefix.name;
    else if (e.prefix.kind === 'sel') {
      pname = this.selectedName(e.prefix, sc);
      if (pname === undefined) return ERR;
    }
    if (pname !== undefined) {
      const s = sc.get(pname);
      if (!s) {
        this.undeclared(pname, e.prefix.loc, sc, IEEE_NUMERIC.has(pname) || IEEE_1164.has(pname) ? 'name' : 'function or signal');
        return ERR;
      }
      if (s.k === 'type') return this.conversion(s.t, pname, e, sc, pc);
      if (s.k === 'fn') return this.builtin(pname, e, sc, pc, exp);
    }
    // indexing / slicing of an array value
    const prefix = this.cx(e.prefix, sc, pc);
    if (prefix.t.k === 'err') return ERR;
    if (prefix.t.k !== 'vec') {
      this.err('V705', e.loc, `'${printExpr(e.prefix)}' is ${typeName(prefix.t)}, not an array; it cannot be indexed`, prefix.t.k === 'int' ? { note: 'user-defined functions are not supported' } : {});
      return ERR;
    }
    if (e.args.length !== 1 || e.args[0].formal) {
      this.err('V705', e.loc, `'${printExpr(e.prefix)}' takes one index or one slice range`);
      return ERR;
    }
    return this.indexOrSlice(prefix, e.args[0].actual as Expr | RangeExpr, sc, pc, printExpr(e.prefix), e.loc);
  }

  private indexOrSlice(prefix: TExpr, arg: Expr | RangeExpr, sc: Scope, pc: PC | null, what: string, loc: Loc): TExpr {
    const t = prefix.t as Extract<VType, { k: 'vec' }>;
    const len = vecLen(t);
    if (arg.kind === 'range' || arg.kind === 'attr-range' || arg.kind === 'subtype-range') {
      const r = this.staticRange(arg, sc, pc);
      if (!r) return ERR;
      const sl = this.sliceOf(t, r, loc, what);
      if (!sl) return ERR;
      return this.mk({ k: 'vec', base: t.base, left: r.left, right: r.right, asc: r.asc }, { o: 'sl', a: prefix.ir, off: sl.off, len: sl.len }, [prefix], loc);
    }
    const idx = this.cx(arg as Expr, sc, pc);
    if (idx.t.k === 'err') return ERR;
    if (idx.t.k !== 'int') {
      this.err('V705', arg.loc, `an index must be an integer, found ${typeName(idx.t)}`, idx.t.k === 'vec' ? { fixes: [{ kind: 'convert', confidence: 'mechanical', detail: `use to_integer(${idx.t.base === 'u' || idx.t.base === 's' ? '' : 'unsigned('}${printExpr(arg as Expr)}${idx.t.base === 'u' || idx.t.base === 's' ? '' : ')'})` }] } : {});
      return ERR;
    }
    if (idx.ir.o === 'k') {
      const i = constValue(idx.ir.v) as number;
      const pos = t.asc ? i - t.left : t.left - i;
      if (pos < 0 || pos >= len) {
        this.err('V719', arg.loc, `index ${i} is outside the range of ${what} (${t.left} ${t.asc ? 'to' : 'downto'} ${t.right})`);
        return ERR;
      }
    }
    return this.mk(T_LOGIC, { o: 'el', a: prefix.ir, i: idx.ir, left: t.left, asc: t.asc, len, at: this.at(loc) ?? '', what }, [prefix, idx], loc);
  }

  private sliceOf(t: { left: number; right: number; asc: boolean }, r: { left: number; right: number; asc: boolean }, loc: Loc, what: string): { off: number; len: number } | undefined {
    const n = Math.max(0, r.asc ? r.right - r.left + 1 : r.left - r.right + 1);
    if (n === 0) {
      this.err('V719', loc, `null slice ${r.left} ${r.asc ? 'to' : 'downto'} ${r.right} of ${what}`);
      return undefined;
    }
    if (r.asc !== t.asc) {
      this.err('V719', loc, `slice direction '${r.asc ? 'to' : 'downto'}' does not match ${what} (${t.left} ${t.asc ? 'to' : 'downto'} ${t.right})`, {
        fixes: [{ kind: 'replace-text', confidence: 'mechanical', detail: `write ${what}(${r.right} ${t.asc ? 'to' : 'downto'} ${r.left})` }],
      });
      return undefined;
    }
    const lo = Math.min(t.left, t.right);
    const hi = Math.max(t.left, t.right);
    if (Math.min(r.left, r.right) < lo || Math.max(r.left, r.right) > hi) {
      this.err('V719', loc, `slice ${r.left} ${r.asc ? 'to' : 'downto'} ${r.right} is outside the range of ${what} (${t.left} ${t.asc ? 'to' : 'downto'} ${t.right})`);
      return undefined;
    }
    return { off: t.asc ? r.left - t.left : t.left - r.left, len: n };
  }

  private conversion(t: VType, name: string, e: Extract<Expr, { kind: 'call' }>, sc: Scope, pc: PC | null): TExpr {
    if (e.args.length !== 1 || e.args[0].formal || e.args[0].actual.kind === 'open') {
      this.err('V705', e.loc, `type conversion ${name}(…) takes exactly one value`);
      return ERR;
    }
    const arg = e.args[0].actual;
    if (arg.kind === 'range' || arg.kind === 'attr-range' || arg.kind === 'subtype-range') {
      this.err('V705', e.loc, `${name}(${printRange(arg as RangeExpr)}) is a constrained subtype, not a value here`);
      return ERR;
    }
    const v = this.cx(arg as Expr, sc, pc, t.k === 'uvec' || t.k === 'vec' ? t : undefined);
    if (v.t.k === 'err') return ERR;
    if ((t.k === 'uvec' || t.k === 'vec') && v.t.k === 'vec') {
      const nt: VType = t.k === 'vec' ? t : { ...v.t, base: t.base };
      if (t.k === 'vec' && vecLen(t) !== vecLen(v.t)) {
        this.err('V706', e.loc, `conversion to ${typeName(t)}: the value has ${vecLen(v.t)} bits`);
        return ERR;
      }
      return { t: nt, ir: v.ir };
    }
    if (t.k === 'int' && v.t.k === 'int') {
      if (t.lo === INT_MIN && t.hi === INT_MAX) return { t: T_INT, ir: v.ir };
      return this.mk(t, { o: 'rng', a: v.ir, lo: t.lo, hi: t.hi, at: this.at(e.loc) ?? '', what: `${name}(…)` }, [v], e.loc);
    }
    if (t.k === 'logic' && v.t.k === 'logic') return { t, ir: v.ir };
    if (t.k === 'bool' && v.t.k === 'bool') return v;
    if (t.k === 'int' && v.t.k === 'vec')
      this.err('V705', e.loc, `cannot convert ${typeName(v.t)} to ${name} with a type conversion`, {
        fixes: [{ kind: 'convert', confidence: 'mechanical', detail: v.t.base === 'u' || v.t.base === 's' ? `use to_integer(${printExpr(arg as Expr)})` : `use to_integer(unsigned(${printExpr(arg as Expr)}))` }],
      });
    else if ((t.k === 'uvec' || t.k === 'vec') && v.t.k === 'int')
      this.err('V705', e.loc, `cannot convert an integer to ${name} with a type conversion`, {
        fixes: [{ kind: 'convert', confidence: 'mechanical', detail: t.base === 'u' || t.base === 's' ? `use to_${t.base === 's' ? 'signed' : 'unsigned'}(${printExpr(arg as Expr)}, width)` : `use std_logic_vector(to_unsigned(${printExpr(arg as Expr)}, width))` }],
      });
    else this.err('V705', e.loc, `cannot convert ${typeName(v.t)} to ${name}`);
    return ERR;
  }

  private sigArg(a: Expr, fn: string, sc: Scope, pc: PC | null): ESig | undefined {
    if (a.kind !== 'id') {
      this.err('V705', a.loc, `${fn} needs a signal name`);
      return undefined;
    }
    const s = sc.get(a.name);
    if (!s) {
      this.undeclared(a.name, a.loc, sc);
      return undefined;
    }
    if (s.k !== 'sig') {
      this.err('V705', a.loc, `${fn}(${a.name}): '${a.name}' is not a signal`, { note: `${fn} looks at an event on a signal; variables and constants have no events` });
      return undefined;
    }
    if (!pc) {
      this.notStatic(a.name, a.loc);
      return undefined;
    }
    return s.sig;
  }

  private builtin(name: string, e: Extract<Expr, { kind: 'call' }>, sc: Scope, pc: PC | null, exp?: VType): TExpr {
    const at = this.at(e.loc) ?? '';
    switch (name) {
      case 'rising_edge':
      case 'falling_edge': {
        const args = this.assocArgs(e, ['s'], name);
        if (!args) return ERR;
        const a = this.asExpr(args[0], name);
        if (!a) return ERR;
        const sig = this.sigArg(a, name, sc, pc);
        if (!sig) return ERR;
        if (sig.t.k !== 'logic') {
          this.err('V705', a.loc, `${name} needs a std_logic signal, '${a.kind === 'id' ? a.name : ''}' is ${typeName(sig.t)}`);
          return ERR;
        }
        const i = pc!.read(sig);
        return { t: T_BOOL, ir: { o: 'edge', s: i, rise: name === 'rising_edge' } };
      }
      case 'to_unsigned':
      case 'to_signed': {
        const args = this.assocArgs(e, ['arg', 'size'], name);
        if (!args) return ERR;
        const a0 = this.asExpr(args[0], name);
        const a1 = this.asExpr(args[1], name);
        if (!a0 || !a1) return ERR;
        const v = this.cx(a0, sc, pc);
        if (v.t.k === 'err') return ERR;
        if (v.t.k !== 'int') {
          this.err('V705', a0.loc, `${name} converts an integer, found ${typeName(v.t)}`, v.t.k === 'vec' ? { note: `to change a vector's width use resize(x, n); to change its type use ${name === 'to_signed' ? 'signed' : 'unsigned'}(x)` } : {});
          return ERR;
        }
        const len = this.sizeArg(a1, sc, pc, name);
        if (len === undefined) return ERR;
        const sgn = name === 'to_signed';
        return this.mk(vecOf(sgn ? 's' : 'u', len), { o: 'toU', a: v.ir, len, sgn, at }, [v], e.loc);
      }
      case 'to_integer': {
        const args = this.assocArgs(e, ['arg'], name);
        if (!args) return ERR;
        const a0 = this.asExpr(args[0], name);
        if (!a0) return ERR;
        const v = this.cx(a0, sc, pc);
        if (v.t.k === 'err') return ERR;
        if (v.t.k !== 'vec' || (v.t.base !== 'u' && v.t.base !== 's')) {
          this.err('V705', a0.loc, `to_integer takes unsigned or signed, found ${typeName(v.t)}`, v.t.k === 'vec' ? { fixes: [{ kind: 'convert', confidence: 'mechanical', detail: `use to_integer(unsigned(${printExpr(a0)})) (or signed(…) for two's complement)` }] } : {});
          return ERR;
        }
        if (vecLen(v.t) > 32 || (v.t.base === 'u' && vecLen(v.t) > 31)) {
          // still allowed; runtime reports values beyond the integer range
        }
        return this.mk(T_INT, { o: 'toI', a: v.ir, sgn: v.t.base === 's', at }, [v], e.loc);
      }
      case 'resize': {
        const args = this.assocArgs(e, ['arg', 'new_size'], name);
        if (!args) return ERR;
        const a0 = this.asExpr(args[0], name);
        const a1 = this.asExpr(args[1], name);
        if (!a0 || !a1) return ERR;
        const v = this.cx(a0, sc, pc);
        if (v.t.k === 'err') return ERR;
        if (v.t.k !== 'vec' || (v.t.base !== 'u' && v.t.base !== 's')) {
          this.err('V705', a0.loc, `resize takes unsigned or signed, found ${typeName(v.t)}`, v.t.k === 'vec' ? { fixes: [{ kind: 'convert', confidence: 'mechanical', detail: `use std_logic_vector(resize(unsigned(${printExpr(a0)}), n))` }] } : {});
          return ERR;
        }
        const len = this.sizeArg(a1, sc, pc, name);
        if (len === undefined) return ERR;
        return this.mk(vecOf(v.t.base, len), { o: 'rsz', a: v.ir, len, sgn: v.t.base === 's' }, [v], e.loc);
      }
      case 'shift_left':
      case 'shift_right':
      case 'rotate_left':
      case 'rotate_right': {
        const args = this.assocArgs(e, ['arg', 'count'], name);
        if (!args) return ERR;
        const a0 = this.asExpr(args[0], name);
        const a1 = this.asExpr(args[1], name);
        if (!a0 || !a1) return ERR;
        const v = this.cx(a0, sc, pc);
        const n = this.cx(a1, sc, pc);
        if (v.t.k === 'err' || n.t.k === 'err') return ERR;
        if (v.t.k !== 'vec' || (v.t.base !== 'u' && v.t.base !== 's')) {
          this.err('V705', a0.loc, `${name} takes unsigned or signed, found ${typeName(v.t)}`, v.t.k === 'vec' ? { fixes: [{ kind: 'convert', confidence: 'mechanical', detail: `use std_logic_vector(${name}(unsigned(${printExpr(a0)}), n))` }] } : {});
          return ERR;
        }
        if (n.t.k !== 'int') {
          this.err('V705', a1.loc, `${name}: the shift count must be a natural, found ${typeName(n.t)}`);
          return ERR;
        }
        const f = name === 'shift_left' ? 'l' : name === 'shift_right' ? 'r' : name === 'rotate_left' ? 'rl' : 'rr';
        return this.mk(vecOf(v.t.base, vecLen(v.t)), { o: 'sh', f, a: v.ir, n: n.ir, arith: v.t.base === 's' }, [v, n], e.loc);
      }
      case 'to_string': {
        const args = this.assocArgs(e, ['value'], name);
        if (!args) return ERR;
        const a0 = this.asExpr(args[0], name);
        if (!a0) return ERR;
        const v = this.cx(a0, sc, pc);
        return this.image(v, a0.loc);
      }
    }
    void exp;
    this.unsupported(e.loc, `function '${name}'`);
    return ERR;
  }

  private sizeArg(a: Expr, sc: Scope, pc: PC | null, fn: string): number | undefined {
    // size may be an integer or (VHDL-2008) a vector whose length is used
    const te = this.cx(a, sc, pc);
    if (te.t.k === 'err') return undefined;
    if (te.t.k === 'vec') return vecLen(te.t);
    if (te.t.k !== 'int') {
      this.err('V705', a.loc, `${fn}: the size must be a natural, found ${typeName(te.t)}`);
      return undefined;
    }
    const v = this.staticValue(te);
    if (v === undefined) {
      this.err('V713', a.loc, `${fn}: the size must be static (a literal, constant, generic or x'length)`, { note: 'vector widths are fixed at elaboration' });
      return undefined;
    }
    if ((v as number) < 0) {
      this.err('V719', a.loc, `${fn}: negative size ${v}`);
      return undefined;
    }
    return v as number;
  }

  private image(v: TExpr, loc: Loc): TExpr {
    if (v.t.k === 'err') return ERR;
    const k = v.t.k === 'int' ? 'i' : v.t.k === 'logic' ? 'l' : v.t.k === 'vec' ? 'v' : v.t.k === 'bool' ? 'b' : v.t.k === 'enum' ? 'e' : v.t.k === 'time' ? 't' : undefined;
    if (v.t.k === 'str') return v;
    if (!k) {
      this.err('V705', loc, `cannot convert ${typeName(v.t)} to a string`);
      return ERR;
    }
    return this.mk(T_STR, { o: 'img', a: v.ir, k, ...(v.t.k === 'enum' ? { lits: v.t.lits } : {}) }, [v], loc);
  }

  private attribute(e: Extract<Expr, { kind: 'attr' }>, sc: Scope, pc: PC | null, exp?: VType): TExpr {
    const attr = e.attr;
    let sym: Sym | undefined;
    let pname: string | undefined;
    if (e.prefix.kind === 'id') {
      pname = e.prefix.name;
      sym = sc.get(pname);
      if (!sym) {
        this.undeclared(pname, e.prefix.loc, sc);
        return ERR;
      }
    }
    if (attr === 'event') {
      if (!sym || sym.k !== 'sig') {
        this.err('V705', e.loc, `'event needs a signal prefix`);
        return ERR;
      }
      if (!pc) return this.notStatic(pname!, e.loc);
      const i = pc.read(sym.sig);
      return { t: T_BOOL, ir: { o: 'ev', s: i } };
    }
    if (['last_value', 'last_event', 'last_active', 'stable', 'quiet', 'delayed', 'transaction', 'active', 'driving', 'driving_value'].includes(attr)) {
      this.unsupported(e.loc, `signal attribute '${attr}`, attr === 'last_value' ? "use rising_edge(clk) / falling_edge(clk) for edges" : undefined);
      return ERR;
    }
    // type/object attributes
    let t: VType | undefined;
    if (sym) {
      if (sym.k === 'sig') t = sym.sig.t;
      else if (sym.k === 'var' || sym.k === 'const' || sym.k === 'type' || sym.k === 'lit') t = sym.t;
    } else {
      const te = this.cx(e.prefix, sc, pc);
      if (te.t.k === 'err') return ERR;
      t = te.t;
    }
    if (!t || t.k === 'err') {
      this.err('V705', e.loc, `'${attr} is not valid for '${printExpr(e.prefix)}'`);
      return ERR;
    }
    const isType = sym?.k === 'type';
    const k = (v: number): TExpr => ({ t: T_INT, ir: { o: 'k', v } });
    if (t.k === 'vec') {
      switch (attr) {
        case 'length':
          return k(vecLen(t));
        case 'left':
          return k(t.left);
        case 'right':
          return k(t.right);
        case 'high':
          return k(Math.max(t.left, t.right));
        case 'low':
          return k(Math.min(t.left, t.right));
        case 'ascending':
          return { t: T_BOOL, ir: { o: 'k', v: t.asc ? 1 : 0 } };
        case 'range':
        case 'reverse_range':
          this.err('V705', e.loc, `'${attr} is a range; use it where a range is expected (for i in x'range loop, or x(y'range))`);
          return ERR;
      }
    }
    if (t.k === 'uvec' && attr === 'length') {
      this.err('V705', e.loc, `${typeName(t)} is unconstrained and has no 'length`);
      return ERR;
    }
    if (t.k === 'int' && (isType || sym?.k !== 'lit')) {
      switch (attr) {
        case 'high':
          return k(t.hi);
        case 'low':
          return k(t.lo);
        case 'left':
          return k(t.asc ? t.lo : t.hi);
        case 'right':
          return k(t.asc ? t.hi : t.lo);
      }
      if (isType && attr === 'image' && e.arg) return this.image(this.cx(e.arg, sc, pc, t), e.loc);
    }
    if ((t.k === 'enum' || t.k === 'bool') && isType) {
      const n = t.k === 'enum' ? t.lits.length : 2;
      const lit = (i: number): TExpr => ({ t, ir: { o: 'k', v: i } });
      switch (attr) {
        case 'left':
        case 'low':
          return lit(0);
        case 'right':
        case 'high':
          return lit(n - 1);
      }
      if (e.arg) {
        if (attr === 'pos') {
          const v = this.cx(e.arg, sc, pc, t);
          if (v.t.k === 'err') return ERR;
          if (!compatible(t, v.t)) {
            this.err('V705', e.arg.loc, `${pname}'pos needs a ${pname} value, found ${typeName(v.t)}`);
            return ERR;
          }
          return { t: T_INT, ir: v.ir };
        }
        if (attr === 'val') {
          const v = this.cx(e.arg, sc, pc);
          if (v.t.k === 'err') return ERR;
          if (v.t.k !== 'int') {
            this.err('V705', e.arg.loc, `${pname}'val needs an integer position, found ${typeName(v.t)}`);
            return ERR;
          }
          return this.mk(t, { o: 'rng', a: v.ir, lo: 0, hi: n - 1, at: this.at(e.loc) ?? '', what: `${pname}'val` }, [v], e.loc);
        }
        if (attr === 'succ' || attr === 'pred') {
          const v = this.cx(e.arg, sc, pc, t);
          if (v.t.k === 'err') return ERR;
          const step: TExpr = { t: T_INT, ir: { o: 'k', v: 1 } };
          const moved = this.mk(T_INT, { o: 'ar', f: attr === 'succ' ? '+' : '-', m: 'i', len: 0, a: v.ir, b: step.ir, at: '' }, [v, step], e.loc);
          return this.mk(t, { o: 'rng', a: moved.ir, lo: 0, hi: n - 1, at: this.at(e.loc) ?? '', what: `${pname}'${attr}` }, [moved], e.loc);
        }
        if (attr === 'image') return this.image(this.cx(e.arg, sc, pc, t), e.loc);
      }
    }
    if (isType && attr === 'image' && e.arg) return this.image(this.cx(e.arg, sc, pc, t), e.loc);
    void exp;
    this.unsupported(e.loc, `attribute '${attr} on ${typeName(t)}`, "supported attributes: 'event (signals), 'length 'left 'right 'high 'low 'range 'reverse_range 'ascending (vectors), 'high 'low 'left 'right 'image (integer types), 'pos 'val 'succ 'pred 'image 'left 'right (enumerations)");
    return ERR;
  }

  private pair(l: Expr, r: Expr, sc: Scope, pc: PC | null): [TExpr, TExpr] {
    if (this.isContextual(l) && !this.isContextual(r)) {
      const b = this.cx(r, sc, pc);
      const a = this.cx(l, sc, pc, b.t.k === 'err' ? undefined : b.t);
      return [a, b];
    }
    const a = this.cx(l, sc, pc);
    const b = this.cx(r, sc, pc, a.t.k === 'err' ? undefined : a.t);
    return [a, b];
  }

  private binary(e: Extract<Expr, { kind: 'binary' }>, sc: Scope, pc: PC | null, exp?: VType): TExpr {
    const op = e.op;
    if (op === '&') return this.concat(e, sc, pc, exp);
    if (op.startsWith('?')) {
      this.unsupported(e.loc, `matching operator '${op}'`, "use '=' and friends");
      return ERR;
    }
    if (['and', 'or', 'xor', 'xnor', 'nand', 'nor'].includes(op)) {
      const [a, b] = this.pair(e.left, e.right, sc, pc);
      if (a.t.k === 'err' || b.t.k === 'err') return ERR;
      const f = op as 'and';
      if (a.t.k === 'logic' && b.t.k === 'logic') return this.mk(T_LOGIC, { o: 'log', f, w: 'l', a: a.ir, b: b.ir }, [a, b], e.loc);
      if (a.t.k === 'bool' && b.t.k === 'bool') return this.mk(T_BOOL, { o: 'log', f, w: 'b', a: a.ir, b: b.ir }, [a, b], e.loc);
      if (a.t.k === 'vec' && b.t.k === 'vec' && sameVecFamily(a.t.base, b.t.base)) {
        if (vecLen(a.t) !== vecLen(b.t)) {
          this.err('V706', e.loc, `'${op}' on vectors of different lengths (${vecLen(a.t)} and ${vecLen(b.t)} bits)`);
          return ERR;
        }
        return this.mk(a.t, { o: 'log', f, w: 'v', a: a.ir, b: b.ir }, [a, b], e.loc);
      }
      const mixBool = (a.t.k === 'bool' && b.t.k === 'logic') || (a.t.k === 'logic' && b.t.k === 'bool');
      this.err('V705', e.loc, `'${op}' cannot combine ${typeName(a.t)} and ${typeName(b.t)}`, mixBool
        ? { note: "a comparison like (a = '1') is boolean while a signal like a is std_logic; VHDL does not mix them", fixes: [{ kind: 'compare', confidence: 'mechanical', detail: "compare the std_logic operand with '1' so both sides are boolean, e.g. (en = '1') and (count = 3)" }] }
        : a.t.k === 'vec' && b.t.k === 'vec' ? { fixes: [{ kind: 'convert', confidence: 'mechanical', detail: `convert one operand so both are ${BASE_NAME[a.t.base]}` }] } : {});
      return ERR;
    }
    if (['=', '/=', '<', '<=', '>', '>='].includes(op)) {
      const [a, b] = this.pair(e.left, e.right, sc, pc);
      if (a.t.k === 'err' || b.t.k === 'err') return ERR;
      const f = op as '=';
      const at = this.at(e.loc) ?? '';
      const ordered = op !== '=' && op !== '/=';
      const ta = a.t;
      const tb = b.t;
      const sameScalar =
        (ta.k === 'logic' && tb.k === 'logic') ||
        (ta.k === 'bool' && tb.k === 'bool') ||
        (ta.k === 'int' && tb.k === 'int') ||
        (ta.k === 'time' && tb.k === 'time') ||
        (ta.k === 'str' && tb.k === 'str' && !ordered) ||
        (ta.k === 'enum' && tb.k === 'enum' && ta.uid === tb.uid);
      if (sameScalar) return this.mk(T_BOOL, { o: 'cmp', f, m: 'n', a: a.ir, b: b.ir, at }, [a, b], e.loc);
      if (ta.k === 'vec' && tb.k === 'vec') {
        const na = ta.base === 'u' || ta.base === 's';
        const nb = tb.base === 'u' || tb.base === 's';
        if (!na && !nb) {
          if (vecLen(ta) !== vecLen(tb) && !ordered) {
            this.err('V706', e.loc, `comparing std_logic_vectors of different lengths (${vecLen(ta)} and ${vecLen(tb)} bits) is always ${op === '=' ? 'false' : 'true'}`, {
              severity: 'warning',
              note: 'array equality is element by element; vectors of different lengths are never equal',
            });
          }
          return this.mk(T_BOOL, { o: 'cmp', f, m: 'arr', a: a.ir, b: b.ir, at }, [a, b], e.loc);
        }
        if (ta.base === tb.base) return this.mk(T_BOOL, { o: 'cmp', f, m: ta.base as 'u', a: a.ir, b: b.ir, at }, [a, b], e.loc);
        this.err('V705', e.loc, `'${op}' cannot compare ${typeName(ta)} with ${typeName(tb)}`, { fixes: [{ kind: 'convert', confidence: 'mechanical', detail: `convert one side, e.g. ${na ? BASE_NAME[ta.base] : BASE_NAME[tb.base]}(…)` }] });
        return ERR;
      }
      if (ta.k === 'vec' && tb.k === 'int' && (ta.base === 'u' || ta.base === 's')) return this.mk(T_BOOL, { o: 'cmp', f, m: ta.base === 'u' ? 'ui' : 'si', a: a.ir, b: b.ir, at }, [a, b], e.loc);
      if (ta.k === 'int' && tb.k === 'vec' && (tb.base === 'u' || tb.base === 's')) return this.mk(T_BOOL, { o: 'cmp', f, m: tb.base === 'u' ? 'iu' : 'is', a: a.ir, b: b.ir, at }, [a, b], e.loc);
      const vecInt = (ta.k === 'vec' && tb.k === 'int') || (ta.k === 'int' && tb.k === 'vec');
      const logicVec = (ta.k === 'logic' && tb.k === 'vec') || (ta.k === 'vec' && tb.k === 'logic');
      this.err('V705', e.loc, `'${op}' cannot compare ${typeName(ta)} with ${typeName(tb)}`, vecInt
        ? { note: 'std_logic_vector has no numeric meaning in ieee.numeric_std', fixes: [{ kind: 'convert', confidence: 'mechanical', detail: `compare as a number: unsigned(${printExpr(ta.k === 'vec' ? e.left : e.right)}) ${op} ${printExpr(ta.k === 'vec' ? e.right : e.left)}` }] }
        : logicVec ? { note: "a single bit compares with a character literal ('1'), a vector with a string literal (\"0101\")" } : {});
      return ERR;
    }
    if (['sll', 'srl', 'rol', 'ror', 'sla', 'sra'].includes(op)) {
      const a = this.cx(e.left, sc, pc);
      const b = this.cx(e.right, sc, pc);
      if (a.t.k === 'err' || b.t.k === 'err') return ERR;
      if (op === 'sla' || op === 'sra') {
        this.unsupported(e.loc, `operator '${op}'`, 'use shift_left / shift_right from numeric_std');
        return ERR;
      }
      if (a.t.k !== 'vec' || b.t.k !== 'int') {
        this.err('V705', e.loc, `'${op}' shifts a vector by an integer, found ${typeName(a.t)} ${op} ${typeName(b.t)}`);
        return ERR;
      }
      const f = op === 'sll' ? 'l' : op === 'srl' ? 'r' : op === 'rol' ? 'rl' : 'rr';
      return this.mk(a.t, { o: 'sh', f, a: a.ir, n: b.ir, arith: false }, [a, b], e.loc);
    }
    // arithmetic
    const [a, b] = this.pair(e.left, e.right, sc, pc);
    if (a.t.k === 'err' || b.t.k === 'err') return ERR;
    return this.arith(op as '+', a, b, e);
  }

  private arith(f: '+' | '-' | '*' | '/' | 'mod' | 'rem' | '**', a: TExpr, b: TExpr, e: Extract<Expr, { kind: 'binary' }>): TExpr {
    const at = this.at(e.loc) ?? '';
    const ta = a.t;
    const tb = b.t;
    const node = (t: VType, m: Extract<IrExpr, { o: 'ar' }>['m']): TExpr => this.mk(t, { o: 'ar', f, m, len: t.k === 'vec' ? vecLen(t) : 0, a: a.ir, b: b.ir, at }, [a, b], e.loc);
    if (ta.k === 'int' && tb.k === 'int') return node(T_INT, 'i');
    if (f === '**') {
      this.err('V705', e.loc, `'**' is only supported on integers`);
      return ERR;
    }
    if (ta.k === 'time' || tb.k === 'time') {
      if (ta.k === 'time' && tb.k === 'time') {
        if (f === '+' || f === '-') return node(T_TIME, 't');
        if (f === '/') return node(T_INT, 'i');
      }
      if (ta.k === 'time' && tb.k === 'int' && (f === '*' || f === '/')) return node(T_TIME, 't');
      if (ta.k === 'int' && tb.k === 'time' && f === '*') return node(T_TIME, 't');
      this.err('V705', e.loc, `'${f}' is not defined for ${typeName(ta)} and ${typeName(tb)}`);
      return ERR;
    }
    const num = (t: VType): t is Extract<VType, { k: 'vec' }> => t.k === 'vec' && (t.base === 'u' || t.base === 's');
    if (num(ta) && num(tb)) {
      if (ta.base !== tb.base) {
        this.err('V705', e.loc, `'${f}' cannot mix ${BASE_NAME[ta.base]} and ${BASE_NAME[tb.base]}`, { fixes: [{ kind: 'convert', confidence: 'suggested', detail: `convert the unsigned operand: signed('0' & x) keeps its value` }] });
        return ERR;
      }
      const la = vecLen(ta);
      const lb = vecLen(tb);
      const len = f === '*' ? la + lb : f === '/' ? la : f === 'mod' || f === 'rem' ? lb : Math.max(la, lb);
      return node(vecOf(ta.base, len), ta.base as 'u');
    }
    if (num(ta) && tb.k === 'int') {
      const la = vecLen(ta);
      return node(vecOf(ta.base, f === '*' ? 2 * la : la), ta.base === 'u' ? 'ui' : 'si');
    }
    if (ta.k === 'int' && num(tb)) {
      const lb = vecLen(tb);
      return node(vecOf(tb.base, f === '*' ? 2 * lb : lb), tb.base === 'u' ? 'iu' : 'is');
    }
    const slv = (t: VType): boolean => t.k === 'vec' && (t.base === 'slv' || t.base === 'sulv');
    if (slv(ta) || slv(tb)) {
      const which = slv(ta) ? e.left : e.right;
      this.err('V705', e.loc, `'${f}' is not defined for std_logic_vector (it has no numeric meaning in ieee.numeric_std)`, {
        note: 'ieee.std_logic_unsigned (which made this work) is a non-standard package and is not supported',
        fixes: [{ kind: 'convert', confidence: 'mechanical', detail: `do the arithmetic on unsigned: std_logic_vector(unsigned(${printExpr(which)}) ${f} …), or declare the signal as unsigned` }],
      });
      return ERR;
    }
    this.err('V705', e.loc, `'${f}' is not defined for ${typeName(ta)} and ${typeName(tb)}`, ta.k === 'logic' || tb.k === 'logic' ? { note: "for one-bit logic use 'and', 'or', 'xor'" } : {});
    return ERR;
  }

  private concat(e: Extract<Expr, { kind: 'binary' }>, sc: Scope, pc: PC | null, exp?: VType): TExpr {
    const flat: Expr[] = [];
    const walk = (x: Expr): void => {
      if (x.kind === 'binary' && x.op === '&') {
        walk(x.left);
        walk(x.right);
      } else flat.push(x);
    };
    walk(e);
    // string concatenation (report messages)
    if (exp && exp.k === 'str') {
      const parts = flat.map(p => this.cx(p, sc, pc, T_STR));
      if (parts.some(p => p.t.k === 'err')) return ERR;
      for (let i = 0; i < parts.length; i++) {
        if (parts[i].t.k !== 'str') {
          this.err('V705', flat[i].loc, `cannot concatenate ${typeName(parts[i].t)} into a string`, { fixes: [{ kind: 'convert', confidence: 'mechanical', detail: `use integer'image(x) / to_string(x)` }] });
          return ERR;
        }
      }
      return this.mk(T_STR, { o: 'scat', parts: parts.map(p => p.ir) }, parts, e.loc);
    }
    const typed = flat.map(p => (this.isContextual(p) ? undefined : this.cx(p, sc, pc)));
    if (typed.some(t => t && t.t.k === 'err')) return ERR;
    let base: VecBase | undefined;
    for (let i = 0; i < flat.length; i++) {
      const t = typed[i]?.t;
      if (t && t.k === 'vec') {
        if (base && !sameVecFamily(base, t.base)) {
          this.err('V705', flat[i].loc, `'&' cannot mix ${BASE_NAME[base]} and ${BASE_NAME[t.base]}`, { fixes: [{ kind: 'convert', confidence: 'mechanical', detail: `convert the operands to one type first` }] });
          return ERR;
        }
        base ??= t.base;
      }
      if (t && t.k === 'str') {
        this.err('V705', flat[i].loc, `strings can only be concatenated in report messages`);
        return ERR;
      }
    }
    base ??= exp && (exp.k === 'vec' || exp.k === 'uvec') ? exp.base : 'slv';
    const parts: TExpr[] = [];
    for (let i = 0; i < flat.length; i++) {
      const te = typed[i] ?? this.cx(flat[i], sc, pc, { k: 'uvec', base });
      if (te.t.k === 'err') return ERR;
      if (te.t.k !== 'logic' && te.t.k !== 'vec') {
        this.err('V705', flat[i].loc, `'&' concatenates std_logic and vectors, found ${typeName(te.t)}`, te.t.k === 'int' ? { fixes: [{ kind: 'convert', confidence: 'mechanical', detail: 'convert with to_unsigned(n, width)' }] } : {});
        return ERR;
      }
      parts.push(te);
    }
    const len = parts.reduce((n, p) => n + (p.t.k === 'logic' ? 1 : vecLen(p.t as Extract<VType, { k: 'vec' }>)), 0);
    return this.mk(vecOf(base, len), { o: 'cat', parts: parts.map(p => ({ e: p.ir, sc: p.t.k === 'logic' })) }, parts, e.loc);
  }

  private unary(e: Extract<Expr, { kind: 'unary' }>, sc: Scope, pc: PC | null, exp?: VType): TExpr {
    if (e.op === '??') {
      const v = this.cx(e.operand, sc, pc);
      if (v.t.k === 'err') return ERR;
      if (v.t.k !== 'logic') {
        this.err('V705', e.loc, `'??' converts std_logic to boolean, found ${typeName(v.t)}`);
        return ERR;
      }
      return this.mk(T_BOOL, { o: 'qq', a: v.ir }, [v], e.loc);
    }
    const v = this.cx(e.operand, sc, pc, e.op === 'not' ? exp : undefined);
    if (v.t.k === 'err') return ERR;
    const at = this.at(e.loc) ?? '';
    switch (e.op) {
      case 'not':
        if (v.t.k === 'logic') return this.mk(v.t, { o: 'not', w: 'l', a: v.ir }, [v], e.loc);
        if (v.t.k === 'bool') return this.mk(T_BOOL, { o: 'not', w: 'b', a: v.ir }, [v], e.loc);
        if (v.t.k === 'vec') return this.mk(v.t, { o: 'not', w: 'v', a: v.ir }, [v], e.loc);
        break;
      case '-':
      case 'abs':
        if (v.t.k === 'int' || v.t.k === 'time') return this.mk(v.t, { o: e.op === '-' ? 'neg' : 'abs', m: v.t.k === 'int' ? 'i' : 't', a: v.ir, at }, [v], e.loc);
        if (v.t.k === 'vec' && v.t.base === 's') return this.mk(vecOf('s', vecLen(v.t)), { o: e.op === '-' ? 'neg' : 'abs', m: 's', a: v.ir, at }, [v], e.loc);
        break;
      case '+':
        if (v.t.k === 'int' || v.t.k === 'time' || (v.t.k === 'vec' && (v.t.base === 'u' || v.t.base === 's'))) return v;
        break;
      default:
        // VHDL-2008 reduction operators
        if (v.t.k === 'vec') return this.mk(T_LOGIC, { o: 'red', f: e.op as 'and', a: v.ir }, [v], e.loc);
        break;
    }
    this.err('V705', e.loc, `unary '${e.op}' is not defined for ${typeName(v.t)}`, e.op === '-' && v.t.k === 'vec' && v.t.base === 'u' ? { note: 'unsigned values cannot be negated; use signed' } : {});
    return ERR;
  }

  private aggregate(e: Extract<Expr, { kind: 'agg' }>, sc: Scope, pc: PC | null, exp?: VType): TExpr {
    if (!exp || (exp.k !== 'vec' && exp.k !== 'uvec')) {
      if (exp && exp.k === 'err') return ERR;
      this.err('V705', e.loc, exp ? `an aggregate cannot be a value of type ${typeName(exp)}` : `the type of this aggregate is unknown here; qualify it, e.g. unsigned'(others => '0')`, {
        note: exp ? 'aggregates (… => …) build vectors in this subset' : 'VHDL takes the type of an aggregate from its context (the assignment target or the other operand)',
      });
      return ERR;
    }
    const items: { pos: number; e: IrExpr }[] = [];
    const parts: TExpr[] = [];
    let others: TExpr | undefined;
    const positional = e.items.filter(i => !i.choices);
    const named = e.items.filter(i => i.choices);
    if (positional.length > 0 && named.some(i => !i.choices!.every(c => c.kind === 'others'))) {
      this.err('V705', e.loc, `an aggregate cannot mix positional and named elements (except a final others)`);
      return ERR;
    }
    let t: Extract<VType, { k: 'vec' }>;
    if (exp.k === 'vec') t = exp;
    else {
      if (named.length > 0 && positional.length === 0) {
        if (named.some(i => i.choices!.some(c => c.kind === 'others'))) {
          this.err('V705', e.loc, `'others' needs a constrained context; the target type ${typeName(exp)} has no length here`);
          return ERR;
        }
      }
      if (positional.length > 0) t = { k: 'vec', base: exp.base, left: 0, right: positional.length - 1, asc: true };
      else {
        // named choices only: the range spans the choices (ascending)
        const idx: number[] = [];
        for (const it of named)
          for (const c of it.choices!) {
            if (c.kind === 'expr') {
              const v = this.staticInt(c.expr, sc, 'an aggregate choice');
              if (v === undefined) return ERR;
              idx.push(v);
            } else if (c.kind === 'range') {
              const r = this.staticRange(c.range, sc, pc);
              if (!r) return ERR;
              idx.push(r.left, r.right);
            }
          }
        t = { k: 'vec', base: exp.base, left: Math.min(...idx), right: Math.max(...idx), asc: true };
      }
    }
    const len = vecLen(t);
    const elem = (x: Expr): TExpr | undefined => {
      const v = this.cx(x, sc, pc, T_LOGIC);
      if (v.t.k === 'err') return undefined;
      if (v.t.k !== 'logic') {
        if (v.t.k === 'vec') this.unsupported(x.loc, 'vector elements inside aggregates', "use concatenation: a & b");
        else this.err('V705', x.loc, `aggregate elements of ${typeName(t)} must be std_logic, found ${typeName(v.t)}`);
        return undefined;
      }
      parts.push(v);
      return v;
    };
    const covered = new Uint8Array(len);
    if (positional.length > 0) {
      if (positional.length > len || (positional.length < len && !named.length)) {
        this.err('V706', e.loc, `aggregate has ${positional.length} elements but ${typeName(t)} has ${len}`);
        return ERR;
      }
      for (let p = 0; p < positional.length; p++) {
        const v = elem(positional[p].value);
        if (!v) return ERR;
        items.push({ pos: p, e: v.ir });
        covered[p] = 1;
      }
    }
    for (const it of named) {
      for (const c of it.choices!) {
        if (c.kind === 'others') {
          if (others) {
            this.err('V718', c.loc, `'others' appears twice in the aggregate`);
            return ERR;
          }
          const v = elem(it.value);
          if (!v) return ERR;
          others = v;
          continue;
        }
        const v = elem(it.value);
        if (!v) return ERR;
        let lo: number;
        let hi: number;
        if (c.kind === 'expr') {
          const i = this.staticInt(c.expr, sc, 'an aggregate choice');
          if (i === undefined) return ERR;
          lo = hi = i;
        } else {
          const r = this.staticRange(c.range, sc, pc);
          if (!r) return ERR;
          lo = Math.min(r.left, r.right);
          hi = Math.max(r.left, r.right);
        }
        for (let i = lo; i <= hi; i++) {
          const pos = t.asc ? i - t.left : t.left - i;
          if (pos < 0 || pos >= len) {
            this.err('V719', c.loc, `aggregate index ${i} is outside ${typeName(t)}`);
            return ERR;
          }
          if (covered[pos]) {
            this.err('V718', c.loc, `aggregate index ${i} is given twice`);
            return ERR;
          }
          covered[pos] = 1;
          items.push({ pos, e: v.ir });
        }
      }
    }
    if (!others && covered.some(x => x === 0)) {
      const missing: number[] = [];
      covered.forEach((x, p) => x === 0 && missing.push(indexAt(t, p)));
      this.err('V718', e.loc, `aggregate does not give a value for index${missing.length > 1 ? 'es' : ''} ${missing.slice(0, 8).join(', ')}${missing.length > 8 ? ', …' : ''}`, {
        fixes: [{ kind: 'add-others', confidence: 'mechanical', detail: "add a final 'others => '0''" }],
      });
      return ERR;
    }
    items.sort((a, b) => a.pos - b.pos);
    if (others && items.length === 0) return this.mk(t, { o: 'agg', len, others: others.ir, items: [] }, [others], e.loc);
    return this.mk(t, { o: 'agg', len, ...(others ? { others: others.ir } : {}), items }, parts, e.loc);
  }

  // ── declarations ──

  private declare(sc: Scope, name: string, sym: Sym, loc: Loc): void {
    const prev = sc.map.get(name);
    if (prev) {
      this.err('V715', loc, `'${name}' is already declared in this scope`, { note: 'VHDL names are case-insensitive: Count and count are the same name' });
      return;
    }
    sc.map.set(name, sym);
  }

  private initValue(t: VType, init: Expr | undefined, sc: Scope, what: string): Value {
    if (!init || t.k === 'err') return defaultValue(t);
    const te = this.cx(init, sc, null, t);
    if (te.t.k === 'err') return defaultValue(t);
    const v = this.staticValue(te);
    if (v === undefined) {
      this.err('V713', init.loc, `the initial value of ${what} must be static`);
      return defaultValue(t);
    }
    if (!this.checkAssign(t, te, init.loc, what)) return defaultValue(t);
    return v;
  }

  private declarations(decls: Decl[], sc: Scope, prefix: Prefix, pc: PC | null): void {
    for (const d of decls) {
      switch (d.kind) {
        case 'signal': {
          const t = this.objectType(d.type, sc, 'a signal');
          if (t.k !== 'err' && !isSignalType(t)) {
            this.unsupported(d.loc, `signals of type ${typeName(t)}`);
            continue;
          }
          for (const name of d.names) {
            const init = this.initValue(t, d.init, sc, `signal '${name}'`);
            if (t.k === 'err') {
              this.declare(sc, name, { k: 'const', name, t: T_ERR, v: 0 }, d.loc);
              continue;
            }
            const sig = this.newSignal(`${prefix.disp}${name}`, name, t, netsFor(`${prefix.net}${name}`, t), init, d.loc, {});
            this.declare(sc, name, { k: 'sig', sig }, d.loc);
          }
          break;
        }
        case 'constant': {
          let t = this.objectType(d.type, sc, 'constant', true);
          for (const name of d.names) {
            if (!d.init) {
              this.unsupported(d.loc, 'deferred constants (constant without a value)');
              continue;
            }
            const te = t.k === 'err' ? ERR : this.cx(d.init, sc, null, t);
            let v: Value = 0;
            if (te.t.k !== 'err') {
              const sv = this.staticValue(te);
              if (sv === undefined) this.err('V713', d.init.loc, `the value of constant '${name}' must be static`);
              else if (t.k === 'uvec' && compatible(t, te.t)) {
                t = { ...(te.t as Extract<VType, { k: 'vec' }>), base: t.base };
                v = sv;
              } else if (this.checkAssign(t, te, d.init.loc, `constant '${name}'`)) v = sv;
              else t = T_ERR;
            } else t = T_ERR;
            this.declare(sc, name, { k: 'const', name, t, v }, d.loc);
          }
          break;
        }
        case 'variable': {
          if (!pc) break;
          const t = this.objectType(d.type, sc, 'a variable');
          for (const name of d.names) {
            const init = this.initValue(t, d.init, sc, `variable '${name}'`);
            const slot = pc.vars.length;
            pc.vars.push({ n: name, init: toConst(init) });
            this.declare(sc, name, { k: 'var', name, t, slot }, d.loc);
          }
          break;
        }
        case 'enum-type': {
          const uid = ++this.enumUid;
          const t: VType = { k: 'enum', name: d.name, lits: d.literals, uid };
          const seen = new Set<string>();
          for (const l of d.literals) {
            if (seen.has(l)) this.err('V715', d.loc, `enumeration literal '${l}' appears twice in type ${d.name}`);
            seen.add(l);
          }
          this.declare(sc, d.name, { k: 'type', name: d.name, t }, d.loc);
          d.literals.forEach((l, i) => {
            const prev = sc.map.get(l);
            if (prev && prev.k !== 'lit') this.err('V715', d.loc, `enumeration literal '${l}' hides another declaration`);
            sc.map.set(l, { k: 'lit', name: l, t, idx: i });
          });
          break;
        }
        case 'subtype': {
          const t = this.subtype(d.type, sc);
          if (t.k === 'int') this.declare(sc, d.name, { k: 'type', name: d.name, t: { ...t, name: `${d.name} (${t.name})` } }, d.loc);
          else this.declare(sc, d.name, { k: 'type', name: d.name, t }, d.loc);
          break;
        }
        case 'component':
          this.declare(sc, d.name, { k: 'comp', name: d.name, generics: d.generics, ports: d.ports, loc: d.loc }, d.loc);
          break;
      }
    }
  }

  private newSignal(name: string, local: string, t: VType, nets: string[], init: Value, loc: Loc, o: { mode?: Mode; isPort?: boolean; top?: boolean; owner?: boolean }): ESig {
    const sig: ESig = { name, local, t, nets, init, ...(o.mode ? { mode: o.mode } : {}), isPort: !!o.isPort, top: !!o.top, loc };
    if (o.owner !== false) {
      let owns = false;
      for (const n of nets) {
        if (!this.netOwner.has(n)) {
          this.netOwner.set(n, sig);
          owns = true;
        }
      }
      if (owns) this.ownerSigs.push(sig);
    }
    this.allSignals.push({ name, t, nets, port: !!o.isPort });
    return sig;
  }

  // ── entity instances ──

  private instEntity(
    ent: EntityDecl,
    arch: ArchBody,
    prefix: Prefix,
    genericValues: Map<string, { v: Value; loc?: Loc; t?: VType }>,
    ports: { top: Record<string, TopBinding> } | { child: Map<string, PortActual>; instLoc: Loc },
  ): { ports: ElabPort[]; generics: Record<string, Value> } | undefined {
    if (this.stack.includes(ent.name)) {
      this.err('V722', 'child' in ports ? ports.instLoc : ent.loc, `entity '${ent.name}' instantiates itself (${[...this.stack, ent.name].join(' → ')})`, {
        note: 'recursive hierarchy would never end; use a for-generate with a static count instead',
      });
      return undefined;
    }
    this.stack.push(ent.name);
    try {
      const ctx1 = this.context(ent.context, ent);
      const ctx2 = this.context(arch.context, arch);
      const sc = new Scope(this.rootScope({ s1164: ctx1.s1164 || ctx2.s1164, numeric: ctx1.numeric || ctx2.numeric }));
      const generics: Record<string, Value> = {};
      for (const g of ent.generics) {
        const t = this.objectType(g.type, sc, 'a generic', true);
        for (const name of g.names) {
          const given = genericValues.get(name);
          let v: Value | undefined;
          let gt = t;
          if (given !== undefined) {
            if (given.t) {
              if (t.k !== 'err' && !compatible(t, given.t)) {
                this.err('V711', given.loc ?? g.loc, `generic '${name}' of ${ent.name} is ${typeName(t)}, the value is ${typeName(given.t)}`);
              } else v = given.v;
              if (t.k === 'uvec' && given.t.k === 'vec') gt = { ...given.t, base: t.base };
            } else {
              v = this.jsGeneric(t, given.v, name, ent, g.loc);
              // like a string literal in an unconstrained context: index range 0 to n-1
              if (v instanceof Uint8Array && t.k === 'uvec') gt = { k: 'vec', base: t.base, left: 0, right: v.length - 1, asc: true };
            }
            if (v !== undefined && t.k === 'int' && ((v as number) < t.lo || (v as number) > t.hi)) {
              this.err('V711', given.loc ?? g.loc, `generic '${name}' = ${v as number} is outside ${typeName(t)}`);
              v = undefined;
            }
          } else if (g.init) {
            const r = this.staticExpr(g.init, sc, `the default of generic '${name}'`, t);
            if (r && this.checkAssign(t, { t: r.t, ir: { o: 'k', v: toConst(r.v) } }, g.init.loc, `generic '${name}'`)) {
              v = r.v;
              if (t.k === 'uvec' && r.t.k === 'vec') gt = { ...r.t, base: t.base };
            }
          } else {
            this.err('V711', 'child' in ports ? ports.instLoc : g.loc, `generic '${name}' of entity '${ent.name}' has no value: it has no default and none was given`, {
              fixes: [
                'child' in ports
                  ? { kind: 'add-generic', confidence: 'suggested', detail: `add generic map (${name} => …) to the instantiation` }
                  : { kind: 'add-generic', confidence: 'suggested', detail: `pass it: instantiateVhdl(c, id, design, { generics: { ${name}: … } }) — or give it a default in the entity (${name} : … := …)` },
              ],
            });
          }
          if (v === undefined) {
            this.declare(sc, name, { k: 'const', name, t: T_ERR, v: 0, generic: true }, g.loc);
            continue;
          }
          generics[name] = v;
          this.declare(sc, name, { k: 'const', name, t: gt, v, generic: true }, g.loc);
        }
      }
      for (const name of genericValues.keys()) {
        if (!ent.generics.some(g => g.names.includes(name))) {
          const loc = genericValues.get(name)!.loc;
          this.err(loc ? 'V711' : 'V721', loc ?? ent.loc, `entity '${ent.name}' has no generic '${name}'${ent.generics.length ? ` (generics: ${ent.generics.flatMap(g => g.names).join(', ')})` : ''}`);
        }
      }
      // ports
      const elabPorts: ElabPort[] = [];
      const portNames = ent.ports.flatMap(p => p.names);
      if ('top' in ports) {
        for (const name of Object.keys(ports.top)) {
          if (!portNames.includes(name)) this.err('V721', ent.loc, `entity '${ent.name}' has no port '${name}' (ports: ${portNames.join(', ') || 'none'})`);
        }
      }
      for (const p of ent.ports) {
        const t = this.objectType(p.type, sc, 'a port');
        if (t.k !== 'err' && !isSignalType(t)) {
          this.unsupported(p.loc, `ports of type ${typeName(t)}`);
          continue;
        }
        for (const name of p.names) {
          if (t.k === 'err') {
            this.declare(sc, name, { k: 'const', name, t: T_ERR, v: 0 }, p.loc);
            continue;
          }
          const mode = p.mode ?? 'in';
          const init = this.initValue(t, p.init, sc, `port '${name}'`);
          const width = netWidth(t);
          let nets: string[];
          let owner = true;
          let top = false;
          if ('top' in ports) {
            top = true;
            const b = ports.top[name];
            if (b === undefined) {
              nets = netsFor(`${prefix.net}${name}`, t);
              // an unmapped input with a default value is tied to it; without one it stays an external net
              if (mode === 'in' && p.init) {
                this.constDrive(nets, t, init, `${prefix.comp}${name}`, p.loc);
                top = false;
              }
            }
            else if (typeof b === 'string') nets = netsFor(b, t);
            else if (b.length !== width) {
              this.err('V721', p.loc, `port '${name}' (${typeName(t)}) has ${width} net${width > 1 ? 's' : ''}, but ${b.length} were mapped`);
              nets = netsFor(`${prefix.net}${name}`, t);
            } else if (t.k === 'vec') {
              const low = Math.min(t.left, t.right);
              nets = b.map((_, p2) => b[indexAt(t, p2) - low]);
            } else nets = [...b];
            if (new Set(nets).size !== nets.length) this.err('V721', p.loc, `port '${name}': the same net is mapped to two bits`);
          } else {
            const a = ports.child.get(name);
            if (!a || a.kind === 'open') {
              if (mode === 'in' && !p.init) {
                this.err('V710', ports.instLoc, `input port '${name}' of '${ent.name}' is not connected and has no default value`, {
                  fixes: [{ kind: 'connect-port', confidence: 'suggested', detail: `add '${name} => <signal>' to the port map (or give the port a default: ${name} : in … := '0')` }],
                });
              }
              nets = netsFor(`${prefix.net}${name}`, t);
              if (mode === 'in') this.constDrive(nets, t, init, `${prefix.comp}${name}`, p.loc);
            } else if (a.kind === 'const') {
              nets = netsFor(`${prefix.net}${name}`, t);
              if (!compatible(t, a.t) || (t.k === 'vec' && a.t.k === 'vec' && vecLen(t) !== vecLen(a.t))) {
                this.err(t.k === 'vec' && a.t.k === 'vec' && compatible(t, a.t) ? 'V706' : 'V705', a.loc, `port '${name}' of '${ent.name}' is ${typeName(t)}, the constant is ${typeName(a.t)}`);
              } else this.constDrive(nets, t, a.v, `${prefix.comp}${name}`, a.loc);
            } else {
              owner = false;
              nets = a.nets;
              const at = a.t;
              const ok =
                compatible(t, at) &&
                !(t.k === 'vec' && at.k === 'vec' && vecLen(t) !== vecLen(at)) &&
                !(t.k === 'int' && at.k === 'int' && (netWidth(t) !== netWidth(at) || (t.lo < 0) !== (at.lo < 0)));
              if (!ok) {
                const lenOnly = t.k === 'vec' && at.k === 'vec' && compatible(t, at);
                this.err(lenOnly ? 'V706' : 'V710', a.loc, `port '${name}' of '${ent.name}' is ${typeName(t)} but '${a.text}' is ${typeName(at)}`, {
                  note: t.k === 'int' ? 'integer ports are carried on nets; the actual signal must have the same range' : 'a port and its actual must have the same type and length',
                  ...(t.k === 'vec' && at.k === 'vec' && !compatible(t, at) ? { fixes: [{ kind: 'convert', confidence: 'suggested', detail: `declare '${a.text}' as ${BASE_NAME[t.base]}, or use an intermediate signal` }] } : {}),
                });
                nets = netsFor(`${prefix.net}${name}`, t);
                owner = true;
              } else if ((mode === 'out' || mode === 'inout' || mode === 'buffer') && a.mode === 'in') {
                this.err('V710', a.loc, `output port '${name}' of '${ent.name}' drives '${a.text}', which is an input port of the enclosing entity`);
              }
            }
          }
          const sig = this.newSignal(`${prefix.disp}${name}`, name, t, nets, init, p.loc, { mode, isPort: true, top, owner });
          this.declare(sc, name, { k: 'sig', sig }, p.loc);
          elabPorts.push({ name, mode, t, nets, hasDefault: !!p.init });
        }
      }
      if ('child' in ports) {
        for (const [name, a] of ports.child) if (!portNames.includes(name)) this.err('V710', a.loc, `entity '${ent.name}' has no port '${name}' (ports: ${portNames.join(', ')})`);
      }
      this.declarations(arch.decls, sc, prefix, null);
      this.concurrent(arch.stmts, sc, prefix);
      return { ports: elabPorts, generics };
    } finally {
      this.stack.pop();
    }
  }

  private jsGeneric(t: VType, v: Value, name: string, ent: EntityDecl, loc: Loc): Value | undefined {
    const bad = (expect: string): undefined => {
      this.err('V721', loc, `generic '${name}' of '${ent.name}' expects ${expect}, got ${JSON.stringify(v)}`);
      return undefined;
    };
    switch (t.k) {
      case 'int':
        return typeof v === 'number' && Number.isInteger(v) ? v : bad(`an integer (${typeName(t)})`);
      case 'bool':
        return typeof v === 'boolean' ? (v ? 1 : 0) : typeof v === 'number' && (v === 0 || v === 1) ? v : bad('true or false');
      case 'time': {
        if (typeof v === 'number' && Number.isFinite(v)) return v * 1e12;
        if (typeof v === 'string') {
          const m = v.trim().match(/^([0-9.eE+-]+)\s*(fs|ps|ns|us|ms|sec|s)$/) ?? v.trim().match(/^([0-9.eE+-]+)\s*([fpnum]?)s?$/);
          if (m) {
            const unit = m[2] === 's' || m[2] === '' ? 'sec' : m[2].length === 1 ? `${m[2]}s` : m[2];
            if (TIME_UNITS[unit] !== undefined) return Number(m[1]) * TIME_UNITS[unit];
          }
        }
        return bad("a time (seconds as a number, or a string like '10 ns' / '10n')");
      }
      case 'logic': {
        const s = typeof v === 'number' ? String(v) : typeof v === 'string' ? v : '';
        const c = LOGIC_CHARS.indexOf(s);
        return s.length === 1 && c >= 0 ? c : bad("a std_logic character ('0', '1', …)");
      }
      case 'vec':
      case 'uvec': {
        if (typeof v === 'string' && /^[UX01ZWLH-]*$/.test(v) && (t.k === 'uvec' || v.length === vecLen(t))) return vecFromString(v);
        return bad(`a std_logic string${t.k === 'vec' ? ` of ${vecLen(t)} characters` : ''}`);
      }
      case 'enum':
        return typeof v === 'string' && t.lits.includes(v.toLowerCase()) ? t.lits.indexOf(v.toLowerCase()) : bad(`one of ${t.lits.join(', ')}`);
      case 'err':
        return undefined;
      default:
        return bad(typeName(t));
    }
  }

  private constDrive(nets: string[], t: VType, v: Value, base: string, loc: Loc): void {
    const sig: ESig = { name: base, local: base, t, nets, init: v, isPort: false, top: false, loc };
    nets.forEach((net, k) => {
      const id = this.uniqueId(`${net.replace(/\[(\d+)\]/g, '_$1').replace(/\[-(\d+)\]/g, '_m$1').replace(/[^A-Za-z0-9_]/g, '_')}__const`);
      this.consts.push({ id, net, value: this.bitInit(sig, k), ...(this.at(loc) ? { at: this.at(loc) } : {}) });
      const set = this.netDrivers.get(net) ?? new Set<string>();
      set.add(id);
      this.netDrivers.set(net, set);
    });
  }

  // ── concurrent statements ──

  private concurrent(stmts: ConcStmt[], sc: Scope, prefix: Prefix): void {
    for (const s of stmts) {
      switch (s.kind) {
        case 'process':
          this.process(s, sc, prefix);
          break;
        case 'cassign':
          this.concurrentAssign(s, sc, prefix);
          break;
        case 'cassert': {
          const pc = new PC(`${prefix.disp}${s.label ?? `assert@${s.loc.line}`}`, this.compId(prefix, s.label ?? `assert_${s.loc.line}`));
          const body = this.assertStmt({ kind: 'assert', cond: s.cond, ...(s.report ? { report: s.report } : {}), ...(s.severity ? { severity: s.severity } : {}), loc: s.loc }, new Scope(sc), pc);
          this.emitProcess(pc, body, 'all', s.loc);
          break;
        }
        case 'instance':
          this.instance(s, sc, prefix);
          break;
        case 'for-generate': {
          const r = this.staticRange(s.range, sc, null);
          if (!r) break;
          if (r.t.k !== 'int') {
            this.unsupported(s.loc, 'for-generate over non-integer ranges');
            break;
          }
          const step = r.asc ? 1 : -1;
          let count = 0;
          for (let i = r.left; r.asc ? i <= r.right : i >= r.right; i += step) {
            if (++count > 4096) {
              this.err('V719', s.loc, `for-generate '${s.label}' has more than 4096 iterations`);
              break;
            }
            const inner = new Scope(sc);
            inner.map.set(s.param, { k: 'const', name: s.param, t: T_INT, v: i });
            const tag = i < 0 ? `m${-i}` : String(i);
            const p: Prefix = { net: `${prefix.net}${s.label}[${i}]__`, comp: `${prefix.comp}${s.label}_${tag}__`, disp: `${prefix.disp}${s.label}(${i}).` };
            this.declarations(s.decls, inner, p, null);
            this.concurrent(s.stmts, inner, p);
          }
          break;
        }
        case 'if-generate': {
          for (const arm of s.arms) {
            let take = true;
            if (arm.cond) {
              const c = this.cond(arm.cond, sc, null);
              if (c.t.k === 'err') break;
              if (c.ir.o !== 'k') {
                this.err('V713', arm.cond.loc, `an if-generate condition must be static`);
                break;
              }
              take = constValue(c.ir.v) === 1;
            }
            if (take) {
              const inner = new Scope(sc);
              const p: Prefix = { net: `${prefix.net}${s.label}__`, comp: `${prefix.comp}${s.label}__`, disp: `${prefix.disp}${s.label}.` };
              this.declarations(arm.decls, inner, p, null);
              this.concurrent(arm.stmts, inner, p);
              break;
            }
          }
          break;
        }
      }
    }
  }

  private compId(prefix: Prefix, local: string): string {
    return this.uniqueId(`${prefix.comp}${local}`);
  }

  private concurrentAssign(s: Extract<ConcStmt, { kind: 'cassign' }>, sc: Scope, prefix: Prefix): void {
    const local = s.label ?? `assign_${s.loc.line}`;
    const pc = new PC(`${prefix.disp}${s.label ?? `assign@${s.loc.line}`}`, this.compId(prefix, local));
    const psc = new Scope(sc);
    let body: IrStmt[];
    if (s.form === 'simple') body = this.signalAssign(s.target, s.wave, psc, pc, s.loc);
    else if (s.form === 'cond') body = this.condWaves(s.target, s.arms, psc, pc, s.loc);
    else {
      if (s.matching) {
        this.unsupported(s.loc, 'matching selected assignments (select?)');
        return;
      }
      body = this.caseStmt(
        s.selector,
        s.arms.map(a => ({ choices: a.choices, loc: a.wave.loc, compile: () => this.signalAssign(s.target, a.wave, psc, pc, a.wave.loc) })),
        psc,
        pc,
        s.loc,
        'selected assignment',
      );
    }
    this.emitProcess(pc, body, 'all', s.loc);
  }

  private condWaves(target: Expr, arms: { wave: Waveform; cond?: Expr }[], sc: Scope, pc: PC, loc: Loc): IrStmt[] {
    const irArms: [IrExpr, IrStmt[]][] = [];
    let els: IrStmt[] | undefined;
    for (const a of arms) {
      if (a.cond) {
        const c = this.cond(a.cond, sc, pc);
        const guarded = containsEdge(c.ir);
        if (guarded) pc.guard++;
        const body = this.signalAssign(target, a.wave, sc, pc, a.wave.loc);
        if (guarded) pc.guard--;
        irArms.push([c.ir, body]);
      } else {
        els = this.signalAssign(target, a.wave, sc, pc, a.wave.loc);
        break;
      }
    }
    void loc;
    if (irArms.length === 0) return els ?? [];
    return [{ k: 'if', arms: irArms, ...(els ? { els } : {}) }];
  }

  private instance(s: Extract<ConcStmt, { kind: 'instance' }>, sc: Scope, prefix: Prefix): void {
    let ent: EntityDecl | undefined;
    let archName: string | undefined;
    let compPorts: InterfaceDecl[] | undefined;
    if (s.unit.kind === 'entity') {
      if (s.unit.library !== 'work') {
        this.err('V709', s.loc, `library '${s.unit.library}' is not available; instantiate from work: entity work.${s.unit.name}`);
        return;
      }
      ent = this.units.entities.get(s.unit.name);
      archName = s.unit.arch;
      if (!ent) {
        this.unknownEntity(s.unit.name, s.loc);
        return;
      }
    } else {
      const sym = sc.get(s.unit.name);
      if (!sym || sym.k !== 'comp') {
        const exists = this.units.entities.has(s.unit.name);
        this.err(exists ? 'V704' : 'V709', s.loc, exists ? `component '${s.unit.name}' is not declared in this architecture` : `there is no entity or component '${s.unit.name}'`, {
          note: exists ? `instantiating by component name needs a component declaration; direct entity instantiation does not` : undefined,
          fixes: exists
            ? [{ kind: 'rewrite', confidence: 'mechanical', detail: `write '${s.label}: entity work.${s.unit.name} port map (…)' (or declare 'component ${s.unit.name} … end component;')` }]
            : this.entitySuggestion(s.unit.name),
        });
        return;
      }
      ent = this.units.entities.get(s.unit.name);
      if (!ent) {
        this.unknownEntity(s.unit.name, s.loc, `component '${s.unit.name}' is declared but no entity '${s.unit.name}' was compiled`);
        return;
      }
      compPorts = sym.ports;
      const entPorts = new Set(ent.ports.flatMap(p => p.names));
      for (const p of sym.ports.flatMap(x => x.names)) if (!entPorts.has(p)) this.err('V710', sym.loc, `component '${s.unit.name}' declares port '${p}', which entity '${ent.name}' does not have`);
    }
    const arch = this.pickArch(ent, archName, s.loc);
    if (!arch) return;
    // generic map
    const genericValues = new Map<string, { v: Value; loc?: Loc; t?: VType }>();
    const gnames = ent.generics.flatMap(g => g.names);
    s.generics.forEach((a, i) => {
      const name = a.formal ? (a.formal.kind === 'id' ? a.formal.name : undefined) : gnames[i];
      if (name === undefined) {
        this.err('V711', a.loc, a.formal ? `invalid generic formal '${printExpr(a.formal)}'` : `too many generic values for '${ent!.name}' (it has ${gnames.length})`);
        return;
      }
      if (genericValues.has(name)) {
        this.err('V711', a.loc, `generic '${name}' is associated twice`);
        return;
      }
      if (a.actual.kind === 'open') return;
      if (a.actual.kind === 'range' || a.actual.kind === 'attr-range' || a.actual.kind === 'subtype-range') {
        this.err('V711', a.loc, `a generic value cannot be a range`);
        return;
      }
      const r = this.staticExpr(a.actual as Expr, sc, `the value of generic '${name}'`);
      if (r) genericValues.set(name, { v: r.v, loc: a.loc, t: r.t });
    });
    // port map
    const pnames = (compPorts ?? ent.ports).flatMap(p => p.names);
    const child = new Map<string, PortActual>();
    let positional = true;
    s.ports.forEach((a, i) => {
      let name: string | undefined;
      if (a.formal) {
        positional = false;
        if (a.formal.kind !== 'id') {
          this.unsupported(a.loc, 'partial or converted port associations (formal(i) => …)', 'connect the whole port to a signal and slice that signal');
          return;
        }
        name = a.formal.name;
      } else {
        if (!positional) {
          this.err('V710', a.loc, `positional port associations must come before named ones`);
          return;
        }
        name = pnames[i];
        if (name === undefined) {
          this.err('V710', a.loc, `too many port associations for '${ent!.name}' (it has ${pnames.length} ports)`);
          return;
        }
      }
      if (child.has(name)) {
        this.err('V710', a.loc, `port '${name}' is associated twice`);
        return;
      }
      const act = this.portActual(a, sc, prefix);
      if (act) child.set(name, act);
    });
    const p: Prefix = { net: `${prefix.net}${s.label}__`, comp: `${prefix.comp}${s.label}__`, disp: `${prefix.disp}${s.label}.` };
    this.instEntity(ent, arch, p, genericValues, { child, instLoc: s.loc });
  }

  private unknownEntity(name: string, loc: Loc, message?: string): void {
    this.err('V709', loc, message ?? `entity '${name}' is not in the compiled sources`, {
      note: 'every entity used must be compiled together: pass all VHDL sources to compileVhdl([…]) or put them in one text',
      fixes: this.entitySuggestion(name),
    });
  }

  private entitySuggestion(name: string): VhdlFix[] {
    const c = [...this.units.entities.keys()].map(n => [n, levenshtein(n, name)] as const).sort((a, b) => a[1] - b[1])[0];
    if (c && c[1] <= Math.max(2, Math.floor(name.length / 3))) return [{ kind: 'rename', confidence: 'suggested', detail: `did you mean entity '${c[0]}'?` }];
    return [{ kind: 'add-source', confidence: 'suggested', detail: `compile the file that declares entity ${name} together with this one` }];
  }

  private portActual(a: Assoc, sc: Scope, prefix: Prefix): PortActual | undefined {
    if (a.actual.kind === 'open') return { kind: 'open', loc: a.loc };
    if (a.actual.kind === 'range' || a.actual.kind === 'attr-range' || a.actual.kind === 'subtype-range') {
      this.err('V710', a.loc, `a port actual cannot be a range`);
      return undefined;
    }
    const e = a.actual as Expr;
    const text = printExpr(e);
    // signal name, element or static slice
    const base = e.kind === 'call' && e.prefix.kind === 'id' ? e.prefix : e.kind === 'id' ? e : undefined;
    if (base) {
      const sym = sc.get(base.name);
      if (sym && sym.k === 'sig') {
        const sig = sym.sig;
        if (e.kind === 'id') return { kind: 'nets', nets: sig.nets, t: sig.t, loc: a.loc, text, ...(sig.mode ? { mode: sig.mode } : {}) };
        const call = e as Extract<Expr, { kind: 'call' }>;
        if (sig.t.k !== 'vec' || call.args.length !== 1) {
          this.err('V710', a.loc, `'${text}' is not a valid port actual`);
          return undefined;
        }
        const arg = call.args[0].actual;
        const t = sig.t;
        if (arg.kind === 'range' || arg.kind === 'attr-range' || arg.kind === 'subtype-range') {
          const r = this.staticRange(arg as RangeExpr, sc, null);
          if (!r) return undefined;
          const sl = this.sliceOf(t, r, a.loc, base.name);
          if (!sl) return undefined;
          return { kind: 'nets', nets: sig.nets.slice(sl.off, sl.off + sl.len), t: { k: 'vec', base: t.base, left: r.left, right: r.right, asc: r.asc }, loc: a.loc, text, ...(sig.mode ? { mode: sig.mode } : {}) };
        }
        if (arg.kind === 'open') return undefined;
        const i = this.staticInt(arg as Expr, sc, 'a port-map index');
        if (i === undefined) return undefined;
        const pos = t.asc ? i - t.left : t.left - i;
        if (pos < 0 || pos >= vecLen(t)) {
          this.err('V719', a.loc, `index ${i} is outside the range of ${base.name}`);
          return undefined;
        }
        return { kind: 'nets', nets: [sig.nets[pos]], t: T_LOGIC, loc: a.loc, text, ...(sig.mode ? { mode: sig.mode } : {}) };
      }
    }
    // static expression (constant input)
    const before = this.diags.length;
    const te = this.cx(e, sc, null);
    if (te.t.k === 'err') {
      if (this.diags.length > before && this.diags.slice(before).every(d => d.code === 'V713')) {
        this.diags.length = before;
        this.unsupported(a.loc, 'expressions in port maps', 'assign the expression to a signal and connect that signal');
      }
      return undefined;
    }
    if (te.ir.o !== 'k') {
      this.unsupported(a.loc, 'expressions in port maps', 'assign the expression to a signal and connect that signal');
      return undefined;
    }
    void prefix;
    return { kind: 'const', v: constValue(te.ir.v), t: te.t, loc: a.loc };
  }

  // ── processes ──

  private process(s: ProcessStmt, sc: Scope, prefix: Prefix): void {
    const local = s.label ?? `process_${s.loc.line}`;
    const pc = new PC(`${prefix.disp}${s.label ?? `process@${s.loc.line}`}`, this.compId(prefix, local));
    const psc = new Scope(sc);
    this.declarations(s.decls, psc, prefix, pc);
    let body = s.body;
    let sens: number[] | 'all' = 'all';
    let skipInit = false;
    const waits = this.findWaits(body);
    if (s.sensitivity === null) {
      const first = body[0];
      if (first && first.kind === 'wait' && first.until && !first.on && !first.for && waits.length === 1) {
        // `wait until cond;` at the top ≡ sensitivity on the condition's signals + if cond.
        skipInit = true;
        const c = this.cond(first.until, psc, pc);
        const condSigs = pc.sigs.map((x, i) => (x.ins ? i : -1)).filter(i => i >= 0);
        const ins = new Set<number>();
        for (const i of condSigs) for (const k of pc.sigs[i].ins!) ins.add(k);
        sens = [...ins].sort((a, b) => a - b);
        const guarded = containsEdge(c.ir);
        if (guarded) pc.guard++;
        const rest = this.seq(body.slice(1), psc, pc);
        if (guarded) pc.guard--;
        this.emitProcess(pc, [{ k: 'if', arms: [[c.ir, rest]] }], sens, s.loc, skipInit);
        return;
      }
      if (waits.length === 0) {
        this.err('V716', s.loc, `process ${s.label ? `'${s.label}' ` : ''}has no sensitivity list and no wait statement — it would loop forever at time 0`, {
          note: 'a VHDL process runs until it suspends; without a sensitivity list or a wait it never suspends',
          fixes: [{ kind: 'add-sensitivity', confidence: 'mechanical', detail: 'add a sensitivity list: process(clk) for clocked logic, process(all) for combinational logic' }],
        });
        return;
      }
      for (const w of waits) this.waitUnsupported(w);
      return;
    }
    if (waits.length > 0) {
      this.err('V703', waits[0].loc, `a process with a sensitivity list cannot contain wait statements`, {
        note: 'VHDL forbids wait in a process that has a sensitivity list',
        fixes: [{ kind: 'delete-text', confidence: 'suggested', detail: 'remove the wait (the sensitivity list already resumes the process) or remove the sensitivity list' }],
      });
      return;
    }
    if (s.sensitivity !== 'all') {
      const ins = new Set<number>();
      for (const e of s.sensitivity) {
        const name = e.kind === 'id' ? e.name : e.kind === 'call' && e.prefix.kind === 'id' ? e.prefix.name : undefined;
        const sym = name ? psc.get(name) : undefined;
        if (!name || !sym) {
          if (name) this.undeclared(name, e.loc, psc);
          else this.err('V705', e.loc, `the sensitivity list may only contain signal names`);
          continue;
        }
        if (sym.k !== 'sig') {
          this.err('V705', e.loc, `'${name}' in the sensitivity list is not a signal`);
          continue;
        }
        const i = pc.read(sym.sig);
        for (const k of pc.sigs[i].ins!) ins.add(k);
      }
      sens = [...ins].sort((a, b) => a - b);
    }
    const ir = this.seq(body, psc, pc);
    if (s.sensitivity !== 'all') this.checkSensitivity(pc, s, psc);
    body = [];
    this.emitProcess(pc, ir, sens, s.loc, skipInit);
  }

  private checkSensitivity(pc: PC, s: ProcessStmt, sc: Scope): void {
    const listed = new Set<ESig>();
    for (const e of s.sensitivity as Expr[]) {
      const name = e.kind === 'id' ? e.name : e.kind === 'call' && e.prefix.kind === 'id' ? e.prefix.name : undefined;
      const sym = name ? sc.get(name) : undefined;
      if (sym && sym.k === 'sig') listed.add(sym.sig);
    }
    const missing = [...pc.unguardedReads.entries()].filter(([sig]) => !listed.has(sig));
    if (missing.length === 0) return;
    const names = missing.map(([sig]) => sig.local);
    this.err('V717', s.loc, `process ${s.label ? `'${s.label}' ` : ''}reads ${names.map(n => `'${n}'`).join(', ')} outside a clock edge, but ${names.length > 1 ? 'they are' : 'it is'} not in the sensitivity list`, {
      note: 'the process does not wake up when these signals change, so simulation shows stale values while synthesized hardware would react immediately (simulation/synthesis mismatch)',
      fixes: [
        { kind: 'add-sensitivity', confidence: 'mechanical', detail: `add ${names.join(', ')} to the sensitivity list, or use process(all)` },
      ],
      evidence: { missing: names, firstRead: this.at(missing[0][1]) },
    });
  }

  private findWaits(body: SeqStmt[]): Extract<SeqStmt, { kind: 'wait' }>[] {
    const out: Extract<SeqStmt, { kind: 'wait' }>[] = [];
    const walk = (b: SeqStmt[]): void => {
      for (const s of b) {
        if (s.kind === 'wait') out.push(s);
        else if (s.kind === 'if') {
          s.arms.forEach(a => walk(a.body));
          if (s.else) walk(s.else);
        } else if (s.kind === 'case') s.arms.forEach(a => walk(a.body));
        else if (s.kind === 'for' || s.kind === 'while' || s.kind === 'loop') walk(s.body);
      }
    };
    walk(body);
    return out;
  }

  private waitUnsupported(w: Extract<SeqStmt, { kind: 'wait' }>): void {
    if (w.for) this.unsupported(w.loc, "'wait for' (time delays in a process)", "describe timing with 'after' delays in signal assignments, a counter on the design clock, or drive inputs from the bench (Clock/Stimulus/sim.drive)", [
      { kind: 'rewrite', confidence: 'suggested', detail: 'for a clock use a Clock part in the bench; for a delay use y <= x after 10 ns;' },
    ]);
    else if (w.on) this.unsupported(w.loc, "'wait on'", 'use a sensitivity list: process(a, b)');
    else if (w.until) this.unsupported(w.loc, "'wait until' except as the single first statement of a process without sensitivity list");
    else this.unsupported(w.loc, "a bare 'wait;' (suspend forever)", 'testbench-style one-shot processes are not supported; drive stimuli from the bench');
  }

  private emitProcess(pc: PC, body: IrStmt[], sens: number[] | 'all', loc: Loc, skipInit = false): void {
    if (pc.inPins.length + pc.outPins.length === 0) return;
    const config: ProcessConfig & { inPins: string[]; outPins: string[] } = {
      v: 1,
      name: pc.name,
      at: this.at(loc) ?? '',
      sigs: pc.sigs,
      sens,
      ...(skipInit ? { skipInit: true } : {}),
      vars: pc.vars,
      body,
      nIn: pc.inPins.length,
      nOut: pc.outPins.length,
      inPins: pc.inPins,
      outPins: pc.outPins,
    };
    const wiring: Record<string, string> = {};
    pc.inPins.forEach((p, i) => (wiring[p] = pc.inNets[i]));
    pc.outPins.forEach((p, i) => (wiring[p] = pc.outNets[i]));
    const sensIn = sens === 'all' ? pc.inPins.map((_, i) => i) : sens;
    const combPaths: [string, string, number][] = [];
    const outs = [...pc.combOut.entries()].sort((a, b) => a[0] - b[0]);
    for (const i of sensIn) for (const [o, d] of outs) combPaths.push([pc.inPins[i], pc.outPins[o], d * 1e-12]);
    for (const net of pc.outNets) {
      const set = this.netDrivers.get(net) ?? new Set<string>();
      set.add(pc.name);
      this.netDrivers.set(net, set);
    }
    const at = this.at(loc);
    this.procs.push({ id: pc.id, name: pc.name, ...(at ? { at } : {}), config, wiring, combPaths });
  }

  // ── sequential statements ──

  private seq(body: SeqStmt[], sc: Scope, pc: PC): IrStmt[] {
    const out: IrStmt[] = [];
    for (const s of body) out.push(...this.stmt(s, sc, pc));
    return out;
  }

  private stmt(s: SeqStmt, sc: Scope, pc: PC): IrStmt[] {
    switch (s.kind) {
      case 'sassign':
        return this.signalAssign(s.target, s.wave, sc, pc, s.loc);
      case 'sassign-cond':
        return this.condWaves(s.target, s.arms, sc, pc, s.loc);
      case 'vassign':
        return this.varAssign(s.target, s.value, sc, pc, s.loc);
      case 'if': {
        const arms: [IrExpr, IrStmt[]][] = [];
        for (const a of s.arms) {
          const c = this.cond(a.cond, sc, pc);
          const guarded = containsEdge(c.ir);
          if (guarded) pc.guard++;
          const body = this.seq(a.body, sc, pc);
          if (guarded) pc.guard--;
          arms.push([c.ir, body]);
        }
        const els = s.else ? this.seq(s.else, sc, pc) : undefined;
        return [{ k: 'if', arms, ...(els ? { els } : {}) }];
      }
      case 'case':
        if (s.matching) {
          this.unsupported(s.loc, "matching case statements (case?)", "use when others, or compare explicitly in if statements");
          return [];
        }
        return this.caseStmt(
          s.expr,
          s.arms.map(a => ({ choices: a.choices, loc: a.loc, compile: () => this.seq(a.body, sc, pc) })),
          sc,
          pc,
          s.loc,
          'case statement',
        );
      case 'for': {
        const r = this.staticRange(s.range, sc, pc);
        if (!r) return [];
        const inner = new Scope(sc);
        const slot = pc.vars.length;
        pc.vars.push({ n: s.param, init: r.left });
        const lt: VType = r.t.k === 'int' ? { k: 'int', lo: Math.min(r.left, r.right), hi: Math.max(r.left, r.right), asc: r.asc, name: 'integer' } : r.t;
        inner.map.set(s.param, { k: 'var', name: s.param, t: lt, slot, loop: true });
        const id = pc.loopCount++;
        pc.loops.push({ ...(s.label ? { label: s.label } : {}), id });
        const n = Math.max(0, r.asc ? r.right - r.left + 1 : r.left - r.right + 1);
        if (n > 1e6) this.err('V719', s.loc, `for loop with ${n} iterations`, { severity: 'warning', note: 'every iteration runs on each activation of the process' });
        const body = this.seq(s.body, inner, pc);
        pc.loops.pop();
        if (n === 0) return [];
        return [{ k: 'for', v: slot, from: r.left, to: r.right, step: r.asc ? 1 : -1, id, body }];
      }
      case 'while':
      case 'loop':
        this.unsupported(s.loc, s.kind === 'while' ? 'while loops' : "bare 'loop' statements", 'use a for loop with static bounds (exit when … is allowed inside it)');
        return [];
      case 'exit':
      case 'next': {
        const loop = s.loopLabel ? [...pc.loops].reverse().find(l => l.label === s.loopLabel) : pc.loops[pc.loops.length - 1];
        if (!loop) {
          this.err('V701', s.loc, s.loopLabel ? `'${s.kind} ${s.loopLabel}': no enclosing loop is labeled '${s.loopLabel}'` : `'${s.kind}' outside a loop`);
          return [];
        }
        const c = s.cond ? this.cond(s.cond, sc, pc) : undefined;
        return [{ k: s.kind, id: loop.id, ...(c ? { c: c.ir } : {}) }];
      }
      case 'null':
        return [];
      case 'wait':
        this.waitUnsupported(s);
        return [];
      case 'assert':
        return this.assertStmt(s, sc, pc);
      case 'return':
        this.err('V701', s.loc, `'return' is only allowed in a function or procedure`);
        return [];
      case 'pcall': {
        const name = s.call.kind === 'id' ? s.call.name : s.call.kind === 'call' && s.call.prefix.kind === 'id' ? s.call.prefix.name : printExpr(s.call);
        if (['readline', 'writeline', 'read', 'write', 'file_open', 'file_close', 'deallocate', 'finish', 'stop'].includes(name)) this.unsupported(s.loc, `'${name}' (file I/O / simulation control)`);
        else this.unsupported(s.loc, `procedure calls ('${name}')`, 'inline the procedure body in the process');
        return [];
      }
    }
  }

  private assertStmt(s: Extract<SeqStmt, { kind: 'assert' }>, sc: Scope, pc: PC): IrStmt[] {
    const c = s.cond ? this.cond(s.cond, sc, pc) : undefined;
    let msg: TExpr | undefined;
    if (s.report) {
      msg = this.cx(s.report, sc, pc, T_STR);
      if (msg.t.k !== 'str' && msg.t.k !== 'err') {
        this.err('V705', s.report.loc, `a report message must be a string, found ${typeName(msg.t)}`, { fixes: [{ kind: 'convert', confidence: 'mechanical', detail: "use integer'image(x) or to_string(x)" }] });
        msg = undefined;
      }
    }
    let sev: TExpr = { t: T_SEVERITY, ir: { o: 'k', v: s.cond ? 2 : 0 } };
    if (s.severity) {
      const v = this.cx(s.severity, sc, pc, T_SEVERITY);
      if (v.t.k !== 'err') {
        if (!compatible(T_SEVERITY, v.t)) this.err('V705', s.severity.loc, `severity must be note, warning, error or failure`);
        else sev = v;
      }
    }
    if (c && c.t.k === 'err') return [];
    if (c && c.ir.o === 'k' && constValue(c.ir.v) === 1) return [];
    return [{ k: 'assert', ...(c ? { c: c.ir } : {}), ...(msg && msg.t.k === 'str' ? { msg: msg.ir } : {}), sev: sev.ir, at: this.at(s.loc) ?? '' }];
  }

  private caseStmt(selector: Expr, arms: { choices: Choice[]; loc: Loc; compile: () => IrStmt[] }[], sc: Scope, pc: PC, loc: Loc, what: string): IrStmt[] {
    const sel = this.cx(selector, sc, pc);
    if (sel.t.k === 'err') return [];
    const t = sel.t;
    if (!(t.k === 'logic' || t.k === 'bool' || t.k === 'int' || t.k === 'enum' || t.k === 'vec')) {
      this.err('V705', selector.loc, `a ${what} cannot select on ${typeName(t)}`);
      return [];
    }
    const map: Record<string, number> = {};
    const ranges: [number, number, number][] = [];
    let others = -1;
    const bodies: IrStmt[][] = [];
    let intCount = 0;
    const seenInt = new Set<number>();
    arms.forEach((arm, ai) => {
      for (const c of arm.choices) {
        if (c.kind === 'others') {
          if (others >= 0) this.err('V718', c.loc, `'when others' appears twice`);
          else if (ai !== arms.length - 1 || arm.choices.length > 1) this.err('V718', c.loc, `'others' must be the last choice, alone`);
          others = ai;
          continue;
        }
        if (c.kind === 'range') {
          if (t.k !== 'int' && t.k !== 'enum') {
            this.err('V718', c.loc, `a range choice needs an integer or enumeration selector`);
            continue;
          }
          const r = this.staticRange(c.range, sc, pc);
          if (!r) continue;
          const lo = Math.min(r.left, r.right);
          const hi = Math.max(r.left, r.right);
          for (const [a, b] of ranges) if (lo <= b && hi >= a) this.err('V718', c.loc, `choice range ${lo} to ${hi} overlaps another choice`);
          for (let v = lo; v <= hi && v - lo < 1e6; v++) {
            if (seenInt.has(v)) this.err('V718', c.loc, `choice ${v} is covered twice`);
            seenInt.add(v);
          }
          ranges.push([lo, hi, ai]);
          intCount += hi - lo + 1;
          continue;
        }
        const v = this.staticExpr(c.expr, sc, `a ${what} choice`, t);
        if (!v) continue;
        if (!compatible(t, v.t)) {
          this.err('V705', c.loc, `choice of type ${typeName(v.t)} does not match the selector type ${typeName(t)}`, t.k === 'logic' && v.t.k === 'vec' ? { fixes: [{ kind: 'replace-text', confidence: 'mechanical', detail: `use a character literal: '${printExpr(c.expr).replace(/"/g, '')}'` }] } : {});
          continue;
        }
        if (t.k === 'vec' && v.t.k === 'vec' && vecLen(t) !== vecLen(v.t)) {
          this.err('V706', c.loc, `choice "${vecToString(v.v as Uint8Array)}" has ${vecLen(v.t)} bits, the selector has ${vecLen(t)}`);
          continue;
        }
        const key = v.v instanceof Uint8Array ? vecToString(v.v) : String(v.v);
        if (key in map || (t.k === 'int' && seenInt.has(v.v as number))) {
          this.err('V718', c.loc, `choice ${t.k === 'vec' ? `"${key}"` : t.k === 'enum' ? t.lits[v.v as number] : t.k === 'logic' ? `'${LOGIC_CHARS[v.v as number]}'` : t.k === 'bool' ? (v.v ? 'true' : 'false') : key} appears twice`);
          continue;
        }
        if (t.k === 'int' && ((v.v as number) < t.lo || (v.v as number) > t.hi)) this.err('V718', c.loc, `choice ${key} is outside the selector range (${typeName(t)})`, { severity: 'warning' });
        if (t.k === 'int') {
          seenInt.add(v.v as number);
          intCount++;
        }
        map[key] = ai;
      }
      bodies.push(arm.compile());
    });
    if (others < 0) {
      let missing: string | undefined;
      if (t.k === 'enum' || t.k === 'bool') {
        const lits = t.k === 'enum' ? t.lits : ['false', 'true'];
        const miss = lits.filter((_, i) => !(String(i) in map) && !ranges.some(([a, b]) => i >= a && i <= b));
        if (miss.length) missing = miss.join(', ');
      } else if (t.k === 'int') {
        if (t.hi - t.lo + 1 > intCount || t.hi - t.lo > 1e6) missing = `values of ${typeName(t)} (${t.hi - t.lo + 1 - Math.min(intCount, t.hi - t.lo + 1)} not covered)`;
      } else if (t.k === 'logic') {
        const miss = [...LOGIC_CHARS].filter((_, i) => !(String(i) in map));
        if (miss.length) missing = `'${miss.join("', '")}'`;
      } else missing = `the other ${vecLen(t)}-bit values (std_logic has 9 values per bit, including X, Z, U, -)`;
      if (missing) {
        this.err('V718', loc, `the ${what} does not cover ${missing}`, {
          note: 'VHDL requires every possible selector value to be covered; for std_logic-based selectors that is only possible with others',
          fixes: [{ kind: 'add-others', confidence: 'mechanical', detail: `add a final 'when others => ${what === 'case statement' ? 'null;' : "<default value>"}'` }],
        });
      }
    }
    return [{ k: 'case', e: sel.ir, m: t.k === 'vec' ? 'v' : 'n', map, ranges, others, arms: bodies, at: this.at(loc) ?? '' }];
  }

  private resolveTarget(target: Expr, sc: Scope, pc: PC, kind: 'signal' | 'variable', loc: Loc): { ir: IrTarget; t: VType; what: string; positions: number[] | 'all'; sig?: ESig } | undefined {
    const baseExpr = target.kind === 'call' ? target.prefix : target;
    if (target.kind === 'agg') {
      this.unsupported(target.loc, 'aggregate assignment targets ((a, b) <= …)', 'assign each signal separately, or assign a concatenated signal and slice it');
      return undefined;
    }
    if (baseExpr.kind !== 'id') {
      if (baseExpr.kind === 'sel') this.unsupported(target.loc, 'record field targets');
      else this.err('V712', target.loc, `'${printExpr(target)}' cannot be assigned`);
      return undefined;
    }
    const name = baseExpr.name;
    const sym = sc.get(name);
    if (!sym) {
      this.undeclared(name, baseExpr.loc, sc);
      return undefined;
    }
    let t: VType;
    let what: string;
    if (sym.k === 'sig') {
      if (kind === 'variable') {
        this.err('V712', loc, `'${name}' is a signal: assign it with '<=' (':=' is for variables)`, {
          note: "signals update after the process suspends (next delta cycle); variables update immediately",
          fixes: [{ kind: 'replace-text', confidence: 'mechanical', detail: `write ${printExpr(target)} <= …;` }],
        });
        return undefined;
      }
      if (sym.sig.mode === 'in') {
        this.err('V712', loc, `'${name}' is an input port and cannot be assigned`, {
          fixes: [{ kind: 'change-mode', confidence: 'suggested', detail: `declare '${name}' as out (or inout), or assign a different signal` }],
        });
        return undefined;
      }
      t = sym.sig.t;
      what = `signal '${sym.sig.local}'`;
    } else if (sym.k === 'var') {
      if (sym.loop) {
        this.err('V712', loc, `loop parameter '${name}' cannot be assigned`);
        return undefined;
      }
      if (kind === 'signal') {
        this.err('V712', loc, `'${name}' is a variable: assign it with ':=' ('<=' is for signals)`, {
          fixes: [{ kind: 'replace-text', confidence: 'mechanical', detail: `write ${printExpr(target)} := …;` }],
        });
        return undefined;
      }
      t = sym.t;
      what = `variable '${name}'`;
    } else if (sym.k === 'const') {
      if (sym.t.k === 'err') return undefined;
      this.err('V712', loc, `'${name}' is a ${sym.generic ? 'generic' : 'constant'} and cannot be assigned`);
      return undefined;
    } else {
      this.err('V712', loc, `'${name}' cannot be assigned`);
      return undefined;
    }
    if (t.k === 'err') return undefined;
    const isSig = sym.k === 'sig';
    const sigIdx = isSig ? pc.sig(sym.sig) : -1;
    if (target.kind === 'id') {
      const range = t.k === 'int' ? { lo: t.lo, hi: t.hi } : {};
      return {
        ir: isSig ? { t: 's', s: sigIdx, ...range } : { t: 'v', v: (sym as Extract<Sym, { k: 'var' }>).slot, ...range },
        t,
        what,
        positions: 'all',
        ...(isSig ? { sig: sym.sig } : {}),
      };
    }
    if (target.kind !== 'call' || target.args.length !== 1 || target.args[0].formal || t.k !== 'vec') {
      this.err('V712', target.loc, t.k === 'vec' ? `'${printExpr(target)}' is not a valid target` : `'${name}' is ${typeName(t)}, not an array; it cannot be indexed`);
      return undefined;
    }
    const arg = target.args[0].actual;
    const len = vecLen(t);
    if (arg.kind === 'range' || arg.kind === 'attr-range' || arg.kind === 'subtype-range') {
      const r = this.staticRange(arg as RangeExpr, sc, pc);
      if (!r) return undefined;
      const sl = this.sliceOf(t, r, target.loc, name);
      if (!sl) return undefined;
      const st: VType = { k: 'vec', base: t.base, left: r.left, right: r.right, asc: r.asc };
      const positions = Array.from({ length: sl.len }, (_, k) => sl.off + k);
      return {
        ir: isSig ? { t: 'ss', s: sigIdx, off: sl.off, len: sl.len } : { t: 'vs', v: (sym as Extract<Sym, { k: 'var' }>).slot, off: sl.off, len: sl.len },
        t: st,
        what: `${what}(${printRange(arg as RangeExpr)})`,
        positions,
        ...(isSig ? { sig: sym.sig } : {}),
      };
    }
    if (arg.kind === 'open') return undefined;
    const idx = this.cx(arg as Expr, sc, pc);
    if (idx.t.k === 'err') return undefined;
    if (idx.t.k !== 'int') {
      this.err('V705', arg.loc, `an index must be an integer, found ${typeName(idx.t)}`, idx.t.k === 'vec' ? { fixes: [{ kind: 'convert', confidence: 'mechanical', detail: `use to_integer(…)` }] } : {});
      return undefined;
    }
    let positions: number[] | 'all' = 'all';
    if (idx.ir.o === 'k') {
      const i = constValue(idx.ir.v) as number;
      const pos = t.asc ? i - t.left : t.left - i;
      if (pos < 0 || pos >= len) {
        this.err('V719', arg.loc, `index ${i} is outside the range of ${name} (${t.left} ${t.asc ? 'to' : 'downto'} ${t.right})`);
        return undefined;
      }
      positions = [pos];
    }
    const at = this.at(target.loc) ?? '';
    return {
      ir: isSig ? { t: 'se', s: sigIdx, i: idx.ir, left: t.left, asc: t.asc, len, at } : { t: 've', v: (sym as Extract<Sym, { k: 'var' }>).slot, i: idx.ir, left: t.left, asc: t.asc, len, at },
      t: T_LOGIC,
      what: `${what}(${printExpr(arg as Expr)})`,
      positions,
      ...(isSig ? { sig: sym.sig } : {}),
    };
  }

  private signalAssign(target: Expr, wave: Waveform, sc: Scope, pc: PC, loc: Loc): IrStmt[] {
    if (wave.mechanism === 'transport' || wave.mechanism === 'reject') {
      this.unsupported(wave.loc, wave.mechanism === 'transport' ? "'transport' delays" : "'reject … inertial' delays", "plain 'after' delays are inertial and supported: y <= x after 5 ns;");
      return [];
    }
    if (wave.elements.length > 1) {
      this.unsupported(wave.elements[1].loc, "multi-element waveforms (y <= '1', '0' after 10 ns)", 'generate waveforms in the bench (Stimulus / Clock), or with a counter in the design');
      return [];
    }
    const el = wave.elements[0];
    if (el.value === 'unaffected') return [];
    if (el.value.kind === 'null-lit') {
      this.unsupported(el.loc, 'null transactions (guarded signals)');
      return [];
    }
    const tgt = this.resolveTarget(target, sc, pc, 'signal', loc);
    const value = this.cx(el.value, sc, pc, tgt?.t);
    let delay: TExpr | undefined;
    if (el.after) {
      delay = this.cx(el.after, sc, pc, T_TIME);
      if (delay.t.k !== 'err' && delay.t.k !== 'time') {
        this.err('V705', el.after.loc, `an 'after' delay must be a time, found ${typeName(delay.t)}`, delay.t.k === 'int' ? { fixes: [{ kind: 'add-unit', confidence: 'mechanical', detail: `add a unit: after ${printExpr(el.after)} ns` }] } : {});
        delay = undefined;
      } else if (delay.t.k === 'err') delay = undefined;
      else if (delay.ir.o === 'k' && (constValue(delay.ir.v) as number) < 0) {
        this.err('V719', el.after.loc, `negative delay in 'after'`);
        delay = undefined;
      } else if (delay.ir.o === 'k' && (constValue(delay.ir.v) as number) === 0) delay = undefined;
    }
    if (!tgt || value.t.k === 'err') return [];
    if (!this.checkAssign(tgt.t, value, el.loc, tgt.what)) return [];
    const outs = pc.drive(tgt.sig!, tgt.positions);
    if (pc.guard === 0) {
      const d = delay && delay.ir.o === 'k' ? (constValue(delay.ir.v) as number) : 0;
      for (const o of outs) pc.combOut.set(o, Math.min(pc.combOut.get(o) ?? Infinity, d));
    }
    return [{ k: 'sa', t: tgt.ir, e: value.ir, ...(delay ? { d: delay.ir } : {}), at: this.at(loc) ?? '', what: tgt.what }];
  }

  private varAssign(target: Expr, valueE: Expr, sc: Scope, pc: PC, loc: Loc): IrStmt[] {
    const tgt = this.resolveTarget(target, sc, pc, 'variable', loc);
    const value = this.cx(valueE, sc, pc, tgt?.t);
    if (!tgt || value.t.k === 'err') return [];
    if (!this.checkAssign(tgt.t, value, valueE.loc, tgt.what)) return [];
    return [{ k: 'va', t: tgt.ir, e: value.ir, at: this.at(loc) ?? '', what: tgt.what }];
  }
}

type PortActual =
  | { kind: 'open'; loc: Loc }
  | { kind: 'const'; v: Value; t: VType; loc: Loc }
  | { kind: 'nets'; nets: string[]; t: VType; loc: Loc; text: string; mode?: Mode };
