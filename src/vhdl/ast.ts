/**
 * VHDL abstract syntax tree (plain data). Identifiers are lowercased.
 * Every node carries `loc` (source index, line, col) for diagnostics.
 */
import type { Loc } from './source';

export interface DesignFile {
  units: DesignUnit[];
}

export type DesignUnit = EntityDecl | ArchBody;

export interface ContextItem {
  kind: 'library' | 'use';
  /** library: the library names; use: the dotted name parts ('ieee', 'std_logic_1164', 'all'). */
  names: string[];
  loc: Loc;
}

export type Mode = 'in' | 'out' | 'inout' | 'buffer';

export interface InterfaceDecl {
  names: string[];
  /** Ports only. */
  mode?: Mode;
  type: SubtypeInd;
  init?: Expr;
  loc: Loc;
}

/** A type mark with an optional constraint: std_logic_vector(7 downto 0), integer range 0 to 9. */
export interface SubtypeInd {
  name: string;
  /** Index constraint of an array type mark. */
  index?: RangeExpr[];
  /** `range a to b` constraint of a scalar type mark. */
  range?: RangeExpr;
  loc: Loc;
}

export type RangeExpr =
  | { kind: 'range'; left: Expr; dir: 'to' | 'downto'; right: Expr; loc: Loc }
  /** x'range / x'reverse_range */
  | { kind: 'attr-range'; prefix: Expr; attr: 'range' | 'reverse_range'; loc: Loc }
  /** A discrete subtype used as a range (for i in state_t loop / for i in natural range 0 to 3). */
  | { kind: 'subtype-range'; type: SubtypeInd; loc: Loc };

export interface EntityDecl {
  kind: 'entity';
  name: string;
  context: ContextItem[];
  generics: InterfaceDecl[];
  ports: InterfaceDecl[];
  /** Concurrent statements in the entity body (unsupported; kept for diagnostics). */
  stmts: ConcStmt[];
  loc: Loc;
}

export interface ArchBody {
  kind: 'architecture';
  name: string;
  entity: string;
  context: ContextItem[];
  decls: Decl[];
  stmts: ConcStmt[];
  loc: Loc;
}

// ── declarations ──

export type Decl =
  | { kind: 'signal'; names: string[]; type: SubtypeInd; init?: Expr; loc: Loc }
  | { kind: 'constant'; names: string[]; type: SubtypeInd; init?: Expr; loc: Loc }
  | { kind: 'variable'; names: string[]; type: SubtypeInd; init?: Expr; shared: boolean; loc: Loc }
  | { kind: 'enum-type'; name: string; literals: string[]; loc: Loc }
  | { kind: 'subtype'; name: string; type: SubtypeInd; loc: Loc }
  | { kind: 'component'; name: string; generics: InterfaceDecl[]; ports: InterfaceDecl[]; loc: Loc };

// ── concurrent statements ──

export type ConcStmt = ProcessStmt | ConcAssign | InstanceStmt | ForGenerate | IfGenerate | ConcAssert;

export interface ProcessStmt {
  kind: 'process';
  label?: string;
  /** null: no sensitivity list; 'all': process(all). */
  sensitivity: Expr[] | 'all' | null;
  decls: Decl[];
  body: SeqStmt[];
  loc: Loc;
}

export interface WaveElement {
  value: Expr | 'unaffected';
  after?: Expr;
  loc: Loc;
}

export interface Waveform {
  /** Delay mechanism prefix (transport / inertial / reject … inertial). */
  mechanism?: 'transport' | 'inertial' | 'reject';
  elements: WaveElement[];
  loc: Loc;
}

export interface CondWave {
  wave: Waveform;
  cond?: Expr;
}

export interface SelWave {
  wave: Waveform;
  choices: Choice[];
}

export type ConcAssign =
  | { kind: 'cassign'; form: 'simple'; label?: string; target: Expr; wave: Waveform; loc: Loc }
  | { kind: 'cassign'; form: 'cond'; label?: string; target: Expr; arms: CondWave[]; loc: Loc }
  | { kind: 'cassign'; form: 'sel'; label?: string; target: Expr; selector: Expr; matching: boolean; arms: SelWave[]; loc: Loc };

export interface Assoc {
  formal?: Expr;
  actual: Expr | RangeExpr | { kind: 'open'; loc: Loc };
  loc: Loc;
}

export interface InstanceStmt {
  kind: 'instance';
  label: string;
  unit: { kind: 'entity'; library: string; name: string; arch?: string } | { kind: 'component'; name: string };
  generics: Assoc[];
  ports: Assoc[];
  loc: Loc;
}

export interface ForGenerate {
  kind: 'for-generate';
  label: string;
  param: string;
  range: RangeExpr;
  decls: Decl[];
  stmts: ConcStmt[];
  loc: Loc;
}

export interface IfGenerate {
  kind: 'if-generate';
  label: string;
  arms: { cond?: Expr; decls: Decl[]; stmts: ConcStmt[]; loc: Loc }[];
  loc: Loc;
}

export interface ConcAssert {
  kind: 'cassert';
  label?: string;
  cond: Expr;
  report?: Expr;
  severity?: Expr;
  loc: Loc;
}

// ── sequential statements ──

export type SeqStmt =
  | { kind: 'sassign'; target: Expr; wave: Waveform; loc: Loc; label?: string }
  /** VHDL-2008 sequential conditional signal assignment: t <= a when c else b; */
  | { kind: 'sassign-cond'; target: Expr; arms: CondWave[]; loc: Loc; label?: string }
  | { kind: 'vassign'; target: Expr; value: Expr; loc: Loc; label?: string }
  | { kind: 'if'; arms: { cond: Expr; body: SeqStmt[] }[]; else?: SeqStmt[]; loc: Loc; label?: string }
  | { kind: 'case'; expr: Expr; matching: boolean; arms: { choices: Choice[]; body: SeqStmt[]; loc: Loc }[]; loc: Loc; label?: string }
  | { kind: 'for'; label?: string; param: string; range: RangeExpr; body: SeqStmt[]; loc: Loc }
  | { kind: 'while'; label?: string; cond: Expr; body: SeqStmt[]; loc: Loc }
  | { kind: 'loop'; label?: string; body: SeqStmt[]; loc: Loc }
  | { kind: 'exit' | 'next'; loopLabel?: string; cond?: Expr; loc: Loc; label?: string }
  | { kind: 'null'; loc: Loc; label?: string }
  | { kind: 'wait'; on?: Expr[]; until?: Expr; for?: Expr; loc: Loc; label?: string }
  | { kind: 'assert'; cond?: Expr; report?: Expr; severity?: Expr; loc: Loc; label?: string }
  | { kind: 'return'; value?: Expr; loc: Loc; label?: string }
  | { kind: 'pcall'; call: Expr; loc: Loc; label?: string };

export type Choice = { kind: 'others'; loc: Loc } | { kind: 'expr'; expr: Expr; loc: Loc } | { kind: 'range'; range: RangeExpr; loc: Loc };

// ── expressions ──

export type Expr =
  | { kind: 'id'; name: string; loc: Loc }
  | { kind: 'call'; prefix: Expr; args: Assoc[]; loc: Loc }
  | { kind: 'attr'; prefix: Expr; attr: string; arg?: Expr; loc: Loc }
  | { kind: 'sel'; prefix: Expr; suffix: string; loc: Loc }
  | { kind: 'int'; value: number; raw: string; loc: Loc }
  | { kind: 'real'; value: number; raw: string; loc: Loc }
  | { kind: 'phys'; value: Expr; unit: string; loc: Loc }
  | { kind: 'char'; value: string; loc: Loc }
  | { kind: 'str'; value: string; loc: Loc }
  | { kind: 'bitstr'; value: string; raw: string; loc: Loc }
  | { kind: 'binary'; op: string; left: Expr; right: Expr; loc: Loc }
  | { kind: 'unary'; op: string; operand: Expr; loc: Loc }
  | { kind: 'paren'; expr: Expr; loc: Loc }
  | { kind: 'agg'; items: { choices?: Choice[]; value: Expr; loc: Loc }[]; loc: Loc }
  | { kind: 'qual'; type: string; expr: Expr; loc: Loc }
  | { kind: 'null-lit'; loc: Loc };

export type ExprOf<K extends Expr['kind']> = Extract<Expr, { kind: K }>;
