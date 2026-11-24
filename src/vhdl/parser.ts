/**
 * Hand-written recursive-descent parser for the supported VHDL subset.
 *
 * Error recovery: a syntax error aborts the current design unit (the first
 * error is exact: line:col of the offending token, what was expected and
 * what was found); parsing resumes at the next design unit, so independent
 * units still report their own first error. Constructs outside the subset
 * that are recognised syntactically (functions, packages, records, …) are
 * reported as V703 and skipped without aborting the unit.
 */
import type {
  ArchBody,
  Assoc,
  Choice,
  ConcAssign,
  ConcStmt,
  ContextItem,
  CondWave,
  Decl,
  DesignFile,
  DesignUnit,
  EntityDecl,
  Expr,
  InterfaceDecl,
  Mode,
  ProcessStmt,
  RangeExpr,
  SelWave,
  SeqStmt,
  SubtypeInd,
  WaveElement,
  Waveform,
} from './ast';
import type { Token } from './lexer';
import type { Loc } from './source';
import type { VhdlFix } from './diagnostics';

export interface ParseIssue {
  code: 'V701' | 'V703';
  message: string;
  loc: Loc;
  note?: string;
  fixes?: VhdlFix[];
  /** V703: the construct name. */
  construct?: string;
}

class ParseError extends Error {
  constructor(readonly issue: ParseIssue) {
    super(issue.message);
  }
}

export const TIME_UNITS: Record<string, number> = { fs: 1e-3, ps: 1, ns: 1e3, us: 1e6, ms: 1e9, sec: 1e12, min: 60e12, hr: 3600e12 };

const LOGICAL_OPS = new Set(['and', 'or', 'xor', 'xnor', 'nand', 'nor']);
const REL_OPS = new Set(['=', '/=', '<', '<=', '>', '>=', '?=', '?/=', '?<', '?<=', '?>', '?>=']);
const SHIFT_OPS = new Set(['sll', 'srl', 'sla', 'sra', 'rol', 'ror']);
const PARAM_ATTRS = new Set(['image', 'value', 'pos', 'val', 'succ', 'pred', 'leftof', 'rightof']);

/** Supported-subset summary used in V703 notes. */
export const SUPPORTED_SUMMARY =
  'supported: library/use (ieee.std_logic_1164, ieee.numeric_std), entity (generics, ports), architecture with signal/constant/enum type/subtype/component ' +
  'declarations, processes with a sensitivity list (or process(all), or a leading `wait until`), concurrent / conditional / selected assignments, ' +
  'if/case/for loops, variables, entity/component instantiation, for/if generate, assert/report';

/** 'array types' → plural, "'wait for' (time delays)" → singular. */
export function isPlural(construct: string): boolean {
  return /s$/.test(construct.replace(/\s*\([^)]*\)$/, ''));
}

const describe = (t: Token): string => (t.kind === 'eof' ? 'end of file' : t.kind === 'str' ? `"${t.text}"` : t.kind === 'char' ? `'${t.text}'` : `'${t.raw}'`);

export function parseTokens(tokens: Token[]): { file: DesignFile; issues: ParseIssue[] } {
  const p = new Parser(tokens);
  const file = p.designFile();
  return { file, issues: p.issues };
}

class Parser {
  pos = 0;
  issues: ParseIssue[] = [];
  constructor(private toks: Token[]) {}

  // ── token helpers ──

  get t(): Token {
    return this.toks[this.pos];
  }
  peek(k = 1): Token {
    return this.toks[Math.min(this.pos + k, this.toks.length - 1)];
  }
  next(): Token {
    const t = this.toks[this.pos];
    if (this.pos < this.toks.length - 1) this.pos++;
    return t;
  }
  isKw(w: string, t = this.t): boolean {
    return t.kind === 'kw' && t.text === w;
  }
  isOp(o: string, t = this.t): boolean {
    return t.kind === 'op' && t.text === o;
  }
  acceptKw(w: string): boolean {
    if (this.isKw(w)) {
      this.next();
      return true;
    }
    return false;
  }
  acceptOp(o: string): boolean {
    if (this.isOp(o)) {
      this.next();
      return true;
    }
    return false;
  }
  fail(message: string, t: Token = this.t, note?: string, fixes?: VhdlFix[]): never {
    throw new ParseError({ code: 'V701', message, loc: t.loc, note, fixes });
  }
  expectKw(w: string, context: string): Token {
    if (!this.isKw(w)) {
      this.fail(`expected '${w}' ${context}, found ${describe(this.t)}`, this.t, misplacedHint(this.t));
    }
    return this.next();
  }
  expectOp(o: string, context: string): Token {
    if (!this.isOp(o)) {
      const t = this.t;
      if (o === ';') {
        const prev = this.toks[this.pos - 1];
        this.fail(`expected ';' ${context}, found ${describe(t)}`, t, `every declaration and statement ends with ';'${prev ? ` (after ${describe(prev)} at line ${prev.loc.line})` : ''}`, [
          { kind: 'insert-text', confidence: 'mechanical', detail: `insert ';' before ${describe(t)}` },
        ]);
      }
      this.fail(`expected '${o}' ${context}, found ${describe(t)}`);
    }
    return this.next();
  }
  ident(context: string): string {
    const t = this.t;
    if (t.kind !== 'id') {
      if (t.kind === 'kw') this.fail(`expected an identifier ${context}, found reserved word '${t.text}'`, t, `'${t.text}' is a VHDL reserved word and cannot be used as a name; rename it (e.g. '${t.text}_s')`);
      this.fail(`expected an identifier ${context}, found ${describe(t)}`);
    }
    this.next();
    return t.text;
  }
  unsupported(construct: string, t: Token, note?: string, fixes?: VhdlFix[]): void {
    this.issues.push({
      code: 'V703',
      construct,
      message: `${construct} ${isPlural(construct) ? 'are' : 'is'} not supported by the CircuitsVibe VHDL subset`,
      loc: t.loc,
      note: note ? `${note}. ${SUPPORTED_SUMMARY}` : SUPPORTED_SUMMARY,
      fixes,
    });
  }

  /** Skip to the token after the next ';' (at paren depth 0). */
  skipStatement(): void {
    let depth = 0;
    while (this.t.kind !== 'eof') {
      const t = this.next();
      if (this.isOp('(', t)) depth++;
      else if (this.isOp(')', t)) depth = Math.max(0, depth - 1);
      else if (this.isOp(';', t) && depth === 0) return;
    }
  }

  /** Skip a construct closed by `end [kw…] [name];`, skipping nested end-if/end-loop/… pairs. */
  skipToEnd(own?: string): void {
    const nested = new Set(['if', 'loop', 'case', 'record', 'units', 'component', 'protected', 'generate', 'block', 'process']);
    while (this.t.kind !== 'eof') {
      const t = this.next();
      if (this.isKw('end', t)) {
        if (this.t.kind === 'kw' && nested.has(this.t.text) && this.t.text !== own) {
          this.next();
          continue;
        }
        this.skipStatement();
        return;
      }
    }
  }

  /** Skip to the start of the next design unit (error recovery). */
  skipUnit(): void {
    while (this.t.kind !== 'eof') {
      const t = this.t;
      const prev = this.toks[this.pos - 1];
      const atStart = !prev || this.isOp(';', prev);
      if (atStart && t.kind === 'kw') {
        if (t.text === 'library' || t.text === 'use') return;
        if (t.text === 'entity' && this.peek().kind === 'id' && this.isKw('is', this.peek(2))) return;
        if (t.text === 'architecture' && this.peek().kind === 'id' && this.isKw('of', this.peek(2))) return;
        if ((t.text === 'package' || t.text === 'configuration' || t.text === 'context') && this.peek().kind !== 'op') return;
      }
      this.next();
    }
  }

  // ── design units ──

  designFile(): DesignFile {
    const units: DesignUnit[] = [];
    let context: ContextItem[] = [];
    while (this.t.kind !== 'eof') {
      const start = this.pos;
      try {
        const t = this.t;
        if (this.isKw('library')) {
          this.next();
          const names = [this.ident('after library')];
          while (this.acceptOp(',')) names.push(this.ident('in the library clause'));
          this.expectOp(';', 'after the library clause');
          context.push({ kind: 'library', names, loc: t.loc });
        } else if (this.isKw('use')) {
          this.next();
          for (;;) {
            const names = [this.ident('after use')];
            while (this.acceptOp('.')) {
              if (this.acceptKw('all')) {
                names.push('all');
                break;
              }
              names.push(this.ident('in the use clause'));
            }
            context.push({ kind: 'use', names, loc: t.loc });
            if (!this.acceptOp(',')) break;
          }
          this.expectOp(';', 'after the use clause');
        } else if (this.isKw('entity')) {
          units.push(this.entity(context));
          context = [];
        } else if (this.isKw('architecture')) {
          units.push(this.architecture(context));
          context = [];
        } else if (this.isKw('package') || this.isKw('configuration') || this.isKw('context')) {
          const what = this.isKw('package') ? (this.isKw('body', this.peek()) ? 'package bodies' : 'packages') : this.isKw('configuration') ? 'configurations' : 'context declarations';
          this.unsupported(what, t, what === 'configurations' ? 'the most recently compiled architecture of each entity is used' : 'put constants and types in the architecture declarative part, or pass them as generics');
          this.skipToEnd(this.next().text);
          context = [];
        } else {
          this.fail(`expected a design unit (library, use, entity or architecture), found ${describe(t)}`, t, t.kind === 'kw' && t.text === 'module' ? 'this looks like Verilog; write VHDL entity/architecture pairs' : undefined);
        }
      } catch (e) {
        if (!(e instanceof ParseError)) throw e;
        this.issues.push(e.issue);
        if (this.pos === start) this.next();
        this.skipUnit();
        context = [];
      }
    }
    return { units };
  }

  endOf(kw: string, name: string, context: string): void {
    this.expectKw('end', context);
    if (this.isKw(kw)) this.next();
    if (this.t.kind === 'id') {
      const t = this.next();
      if (t.text !== name) this.fail(`'end ${kw} ${t.raw}' does not match ${kw} '${name}'`, t, `the name after 'end' must repeat the ${kw} name`, [{ kind: 'replace-text', confidence: 'mechanical', detail: `write 'end ${kw} ${name};'` }]);
    }
    this.expectOp(';', `after 'end ${kw}'`);
  }

  entity(context: ContextItem[]): EntityDecl {
    const start = this.next();
    const name = this.ident("after 'entity'");
    this.expectKw('is', `after 'entity ${name}'`);
    let generics: InterfaceDecl[] = [];
    let ports: InterfaceDecl[] = [];
    if (this.isKw('generic')) {
      this.next();
      generics = this.interfaceList('generic');
      this.expectOp(';', 'after the generic clause');
    }
    if (this.isKw('port')) {
      this.next();
      ports = this.interfaceList('port');
      this.expectOp(';', 'after the port clause');
    }
    if (this.isKw('generic')) this.fail(`the generic clause must come before the port clause`, this.t);
    while (!this.isKw('end') && !this.isKw('begin') && this.t.kind !== 'eof') {
      this.unsupported('entity declarative items', this.t, 'declare signals and constants in the architecture instead');
      this.skipStatement();
    }
    const stmts: ConcStmt[] = [];
    if (this.isKw('begin')) {
      this.unsupported('entity statement parts', this.t, 'put concurrent statements (e.g. asserts) in the architecture');
      this.next();
      while (!this.isKw('end') && this.t.kind !== 'eof') this.skipStatement();
    }
    this.endOf('entity', name, `to close entity '${name}'`);
    return { kind: 'entity', name, context, generics, ports, stmts, loc: start.loc };
  }

  architecture(context: ContextItem[]): ArchBody {
    const start = this.next();
    const name = this.ident("after 'architecture'");
    this.expectKw('of', `after 'architecture ${name}'`);
    const entity = this.ident(`after 'architecture ${name} of'`);
    this.expectKw('is', `after 'architecture ${name} of ${entity}'`);
    const decls = this.declarations('architecture');
    this.expectKw('begin', `to start the statements of architecture '${name}'`);
    const stmts = this.concurrentStatements(['end']);
    this.endOf('architecture', name, `to close architecture '${name}'`);
    return { kind: 'architecture', name, entity, context, decls, stmts, loc: start.loc };
  }

  interfaceList(kind: 'port' | 'generic'): InterfaceDecl[] {
    this.expectOp('(', `after '${kind}'`);
    const out: InterfaceDecl[] = [];
    for (;;) {
      const t = this.t;
      if (kind === 'generic' && this.isKw('type')) {
        this.unsupported('generic types', t, 'generics must be integer, natural, positive, boolean or time constants');
        this.skipInterfaceItem();
      } else if (kind === 'generic' && (this.isKw('function') || this.isKw('procedure') || this.isKw('package'))) {
        this.unsupported(`generic ${t.text}s`, t);
        this.skipInterfaceItem();
      } else {
        if (kind === 'port' && this.isKw('signal')) this.next();
        if (kind === 'generic' && this.isKw('constant')) this.next();
        const names = [this.ident(`in the ${kind} list`)];
        while (this.acceptOp(',')) names.push(this.ident(`in the ${kind} list`));
        this.expectOp(':', `after the ${kind} name${names.length > 1 ? 's' : ''}`);
        let mode: Mode | undefined;
        if (this.t.kind === 'kw' && ['in', 'out', 'inout', 'buffer', 'linkage'].includes(this.t.text)) {
          const m = this.next();
          if (m.text === 'linkage') this.fail(`port mode 'linkage' is not supported`, m);
          mode = m.text as Mode;
        }
        if (kind === 'port' && !mode) mode = 'in';
        if (kind === 'generic' && mode && mode !== 'in') this.fail(`a generic cannot have mode '${mode}'`, t);
        const type = this.subtypeIndication();
        if (this.isKw('bus')) this.next();
        const init = this.acceptOp(':=') ? this.expression() : undefined;
        out.push({ names, ...(kind === 'port' ? { mode } : {}), type, ...(init ? { init } : {}), loc: t.loc });
      }
      if (this.acceptOp(';')) {
        if (this.isOp(')')) this.fail(`unexpected ';' before ')' in the ${kind} list`, this.toks[this.pos - 1], 'the last item of a port/generic list has no trailing semicolon', [
          { kind: 'delete-text', confidence: 'mechanical', detail: `remove the ';' before ')'` },
        ]);
        continue;
      }
      if (this.isOp(',')) this.fail(`expected ';' between ${kind} declarations, found ','`, this.t, `separate ${kind} declarations with ';' (commas only separate names that share a type)`);
      this.expectOp(')', `to close the ${kind} list`);
      return out;
    }
  }

  skipInterfaceItem(): void {
    let depth = 0;
    while (this.t.kind !== 'eof') {
      if (this.isOp('(')) depth++;
      if (this.isOp(')')) {
        if (depth === 0) return;
        depth--;
      }
      if (this.isOp(';') && depth === 0) return;
      this.next();
    }
  }

  subtypeIndication(): SubtypeInd {
    const t = this.t;
    let name = this.typeMark();
    if (this.t.kind === 'id' && !this.isOp('(', this.peek()) && ['std_logic', 'std_ulogic', 'std_logic_vector', 'std_ulogic_vector'].includes(this.t.text)) {
      // resolution function name before the type mark: `resolved std_ulogic`
      this.unsupported('resolution functions in subtype indications', t);
      name = this.typeMark();
    }
    const out: SubtypeInd = { name, loc: t.loc };
    if (this.isOp('(')) {
      this.next();
      out.index = [this.range()];
      while (this.acceptOp(',')) out.index.push(this.range());
      this.expectOp(')', `to close the index constraint of ${name}`);
    }
    if (this.isKw('range')) {
      this.next();
      if (this.isOp('<>')) this.fail(`'range <>' (unconstrained) is not allowed here`, this.t);
      out.range = this.range();
    }
    return out;
  }

  typeMark(): string {
    let name = this.ident('as a type name');
    // ieee.std_logic_1164.std_logic
    while (this.isOp('.') && this.peek().kind === 'id') {
      this.next();
      name = this.next().text;
    }
    return name;
  }

  range(): RangeExpr {
    const t = this.t;
    const left = this.simpleExpression();
    if (this.isKw('to') || this.isKw('downto')) {
      const dir = this.next().text as 'to' | 'downto';
      const right = this.simpleExpression();
      return { kind: 'range', left, dir, right, loc: t.loc };
    }
    if (left.kind === 'attr' && (left.attr === 'range' || left.attr === 'reverse_range')) {
      return { kind: 'attr-range', prefix: left.prefix, attr: left.attr, loc: t.loc };
    }
    if (left.kind === 'id') {
      const type: SubtypeInd = { name: left.name, loc: left.loc };
      if (this.isKw('range')) {
        this.next();
        type.range = this.range();
      }
      return { kind: 'subtype-range', type, loc: t.loc };
    }
    this.fail(`expected a range ('a to b' or 'a downto b'), found ${describe(this.t)}`);
  }

  // ── declarations ──

  declarations(where: 'architecture' | 'process' | 'generate'): Decl[] {
    const decls: Decl[] = [];
    for (;;) {
      const t = this.t;
      if (t.kind !== 'kw') break;
      switch (t.text) {
        case 'signal': {
          if (where === 'process') this.fail(`signals cannot be declared inside a process`, t, 'declare the signal in the architecture, or use a variable', [
            { kind: 'move-declaration', confidence: 'suggested', detail: `move the signal declaration before the architecture's 'begin'` },
          ]);
          this.next();
          const names = this.nameList('signal');
          const type = this.subtypeIndication();
          if (this.isKw('register') || this.isKw('bus')) {
            this.unsupported('guarded signals (register/bus)', this.t);
            this.next();
          }
          const init = this.acceptOp(':=') ? this.expression() : undefined;
          this.expectOp(';', 'after the signal declaration');
          decls.push({ kind: 'signal', names, type, ...(init ? { init } : {}), loc: t.loc });
          continue;
        }
        case 'constant': {
          this.next();
          const names = this.nameList('constant');
          const type = this.subtypeIndication();
          const init = this.acceptOp(':=') ? this.expression() : undefined;
          this.expectOp(';', 'after the constant declaration');
          decls.push({ kind: 'constant', names, type, ...(init ? { init } : {}), loc: t.loc });
          continue;
        }
        case 'shared':
        case 'variable': {
          const shared = t.text === 'shared';
          if (shared) {
            this.unsupported('shared variables', t, 'communicate between processes through signals');
            this.skipStatement();
            continue;
          }
          if (where !== 'process') this.fail(`variables can only be declared inside a process`, t, 'declare a signal in the architecture instead');
          this.next();
          const names = this.nameList('variable');
          const type = this.subtypeIndication();
          const init = this.acceptOp(':=') ? this.expression() : undefined;
          this.expectOp(';', 'after the variable declaration');
          decls.push({ kind: 'variable', names, type, ...(init ? { init } : {}), shared, loc: t.loc });
          continue;
        }
        case 'type': {
          this.next();
          const name = this.ident("after 'type'");
          this.expectKw('is', `after 'type ${name}'`);
          if (this.isOp('(')) {
            this.next();
            const literals: string[] = [];
            for (;;) {
              const lt = this.t;
              if (lt.kind === 'char') {
                this.unsupported('character literals in enumeration types', lt, "use identifiers: type state_t is (IDLE, RUN)");
                this.next();
              } else literals.push(this.ident('as an enumeration literal'));
              if (!this.acceptOp(',')) break;
            }
            this.expectOp(')', `to close the literals of type ${name}`);
            this.expectOp(';', `after the declaration of type ${name}`);
            decls.push({ kind: 'enum-type', name, literals, loc: t.loc });
          } else {
            const what = this.isKw('array') ? 'array types' : this.isKw('record') ? 'record types' : this.isKw('range') ? 'integer type declarations' : this.isKw('access') ? 'access types' : this.isKw('file') ? 'file types' : this.isKw('protected') ? 'protected types' : `type definition '${this.t.raw}'`;
            this.unsupported(what, t, what === 'integer type declarations' ? `use a subtype: subtype ${name} is integer range …` : what === 'array types' ? 'use a std_logic_vector / unsigned signal per element, or several signals' : what === 'record types' ? 'use separate signals per field' : undefined);
            if (this.isKw('record') || this.isKw('protected')) this.skipToEnd(this.next().text);
            else this.skipStatement();
          }
          continue;
        }
        case 'subtype': {
          this.next();
          const name = this.ident("after 'subtype'");
          this.expectKw('is', `after 'subtype ${name}'`);
          const type = this.subtypeIndication();
          this.expectOp(';', `after the declaration of subtype ${name}`);
          decls.push({ kind: 'subtype', name, type, loc: t.loc });
          continue;
        }
        case 'component': {
          if (where === 'process') this.fail(`components cannot be declared inside a process`, t);
          this.next();
          const name = this.ident("after 'component'");
          this.acceptKw('is');
          let generics: InterfaceDecl[] = [];
          let ports: InterfaceDecl[] = [];
          if (this.acceptKw('generic')) {
            generics = this.interfaceList('generic');
            this.expectOp(';', 'after the generic clause');
          }
          if (this.acceptKw('port')) {
            ports = this.interfaceList('port');
            this.expectOp(';', 'after the port clause');
          }
          this.expectKw('end', `to close component '${name}'`);
          this.expectKw('component', `after 'end' (write 'end component;')`);
          if (this.t.kind === 'id') {
            const n = this.next();
            if (n.text !== name) this.fail(`'end component ${n.raw}' does not match component '${name}'`, n);
          }
          this.expectOp(';', "after 'end component'");
          decls.push({ kind: 'component', name, generics, ports, loc: t.loc });
          continue;
        }
        case 'function':
        case 'procedure':
        case 'pure':
        case 'impure': {
          const what = t.text === 'procedure' ? 'procedures' : 'functions';
          this.unsupported(`user-defined ${what}`, t, 'inline the logic in the process (a for loop or a variable usually does it), or put it in a separate entity');
          this.next();
          // declaration only (`function f(x) return t;`) or a body (`… is … begin … end;`)
          let depth = 0;
          while (this.t.kind !== 'eof') {
            if (this.isOp('(')) depth++;
            else if (this.isOp(')')) depth--;
            else if (depth === 0 && this.isOp(';')) {
              this.next();
              break;
            } else if (depth === 0 && this.isKw('is')) {
              this.next();
              this.skipToEnd();
              break;
            }
            this.next();
          }
          continue;
        }
        case 'alias':
        case 'attribute':
        case 'file':
        case 'group':
        case 'disconnect': {
          this.unsupported(t.text === 'file' ? 'file declarations (file I/O)' : `${t.text} declarations`, t, t.text === 'file' ? 'file I/O (textio) is testbench-only; drive inputs from the bench with sim.drive or a Stimulus' : undefined);
          this.skipStatement();
          continue;
        }
        case 'for': {
          if (where === 'architecture') {
            this.unsupported('configuration specifications (for … use …)', t, 'instantiate the entity directly: u1: entity work.name port map (…)');
            this.skipStatement();
            continue;
          }
          return decls;
        }
        case 'use': {
          this.unsupported('use clauses inside an architecture or process', t, 'put library/use clauses before the entity');
          this.skipStatement();
          continue;
        }
        default:
          return decls;
      }
    }
    return decls;
  }

  nameList(what: string): string[] {
    const names = [this.ident(`after '${what}'`)];
    while (this.acceptOp(',')) names.push(this.ident(`in the ${what} declaration`));
    this.expectOp(':', `after the ${what} name${names.length > 1 ? 's' : ''}`);
    return names;
  }

  // ── concurrent statements ──

  concurrentStatements(terminators: string[]): ConcStmt[] {
    const out: ConcStmt[] = [];
    while (!(this.t.kind === 'kw' && terminators.includes(this.t.text)) && this.t.kind !== 'eof') {
      const s = this.concurrentStatement();
      if (s) out.push(s);
    }
    return out;
  }

  concurrentStatement(): ConcStmt | undefined {
    const t = this.t;
    let label: string | undefined;
    if (t.kind === 'id' && this.isOp(':', this.peek())) {
      label = t.text;
      this.next();
      this.next();
    }
    const k = this.t;
    if (this.isKw('postponed')) {
      this.unsupported('postponed processes/statements', k);
      this.next();
    }
    if (this.isKw('process')) return this.process(label, t.loc);
    if (this.isKw('entity') || this.isKw('component') || this.isKw('configuration')) {
      if (!label) this.fail(`an instantiation needs a label: u1: ${k.text} …`, k);
      return this.instance(label, t.loc);
    }
    if (k.kind === 'id' && (this.isKw('port', this.peek()) || this.isKw('generic', this.peek())) && label) return this.instance(label, t.loc);
    if (this.isKw('for')) {
      if (!label) this.fail(`a for-generate needs a label: gen: for i in 0 to N-1 generate …`, k);
      return this.forGenerate(label, t.loc);
    }
    if (this.isKw('if')) {
      if (!label) this.fail(`an if statement outside a process must be an if-generate with a label (gen: if cond generate …)`, k, 'sequential if statements belong inside a process', [
        { kind: 'wrap-in-process', confidence: 'suggested', detail: 'move the if statement into a process(all) … end process; block' },
      ]);
      return this.ifGenerate(label, t.loc);
    }
    if (this.isKw('case')) {
      if (label && this.lookaheadGenerate()) {
        this.unsupported('case-generate statements', k, 'use if-generate');
        this.skipToEnd('generate');
        return undefined;
      }
      this.fail(`a case statement must be inside a process`, k, 'outside a process use a selected assignment: with sel select y <= a when "00", b when others;', [
        { kind: 'wrap-in-process', confidence: 'suggested', detail: 'move the case statement into a process(all) … end process; block' },
      ]);
    }
    if (this.isKw('block')) {
      this.unsupported('block statements', k, 'flatten the block into the architecture');
      this.skipToEnd('block');
      return undefined;
    }
    if (this.isKw('assert')) {
      this.next();
      const cond = this.expression();
      const report = this.acceptKw('report') ? this.expression() : undefined;
      const severity = this.acceptKw('severity') ? this.expression() : undefined;
      this.expectOp(';', 'after the assert statement');
      return { kind: 'cassert', ...(label ? { label } : {}), cond, ...(report ? { report } : {}), ...(severity ? { severity } : {}), loc: t.loc };
    }
    if (this.isKw('with')) return this.selectedAssign(label, t.loc);
    if (this.isKw('wait') || this.isKw('variable')) {
      this.fail(`'${k.text}' is only allowed inside a process`, k);
    }
    if (k.kind === 'id' || this.isOp('(')) {
      const target = this.isOp('(') ? this.primary() : this.name();
      if (this.isOp('<=')) {
        this.next();
        return this.condAssign(label, target, t.loc);
      }
      if (this.isOp(':=')) this.fail(`':=' assigns variables, which only exist inside a process; use '<=' for a concurrent signal assignment`, this.t, undefined, [
        { kind: 'replace-text', confidence: 'mechanical', detail: "replace ':=' with '<='" },
      ]);
      if (this.isOp(';')) {
        this.unsupported('concurrent procedure calls', k);
        this.next();
        return undefined;
      }
      this.fail(`expected '<=' after the assignment target, found ${describe(this.t)}`);
    }
    this.fail(`expected a concurrent statement (process, signal assignment, instantiation, generate), found ${describe(k)}`, k, misplacedHint(k));
  }

  lookaheadGenerate(): boolean {
    for (let k = this.pos; k < Math.min(this.toks.length, this.pos + 64); k++) {
      if (this.isKw('generate', this.toks[k])) return true;
      if (this.isKw('is', this.toks[k])) return false;
    }
    return false;
  }

  process(label: string | undefined, loc: Loc): ProcessStmt {
    this.next();
    let sensitivity: Expr[] | 'all' | null = null;
    if (this.acceptOp('(')) {
      if (this.acceptKw('all')) sensitivity = 'all';
      else {
        sensitivity = [this.name()];
        while (this.acceptOp(',')) sensitivity.push(this.name());
      }
      this.expectOp(')', 'to close the sensitivity list');
    }
    this.acceptKw('is');
    const decls = this.declarations('process');
    this.expectKw('begin', 'to start the process body');
    const body = this.sequentialStatements(['end']);
    this.expectKw('end', 'to close the process');
    if (this.isKw('postponed')) this.next();
    this.expectKw('process', "after 'end' (write 'end process;')");
    if (this.t.kind === 'id') {
      const n = this.next();
      if (n.text !== label) this.fail(`'end process ${n.raw}' does not match the process label${label ? ` '${label}'` : ' (the process has no label)'}`, n);
    }
    this.expectOp(';', "after 'end process'");
    return { kind: 'process', ...(label ? { label } : {}), sensitivity, decls, body, loc };
  }

  instance(label: string, loc: Loc): ConcStmt | undefined {
    const k = this.t;
    let unit: { kind: 'entity'; library: string; name: string; arch?: string } | { kind: 'component'; name: string };
    if (this.isKw('configuration')) {
      this.unsupported('configuration instantiation', k);
      this.skipStatement();
      return undefined;
    }
    if (this.acceptKw('entity')) {
      let lib = this.ident("after 'entity'");
      let name: string;
      if (this.acceptOp('.')) name = this.ident(`after '${lib}.'`);
      else {
        name = lib;
        lib = 'work';
      }
      let arch: string | undefined;
      if (this.acceptOp('(')) {
        arch = this.ident('as the architecture name');
        this.expectOp(')', 'after the architecture name');
      }
      unit = { kind: 'entity', library: lib, name, ...(arch ? { arch } : {}) };
    } else {
      this.acceptKw('component');
      unit = { kind: 'component', name: this.ident('as the component name') };
    }
    let generics: Assoc[] = [];
    let ports: Assoc[] = [];
    if (this.acceptKw('generic')) {
      this.expectKw('map', "after 'generic'");
      generics = this.assocList('generic map');
      if (this.isOp(';') && this.isKw('port', this.peek())) this.fail(`unexpected ';' between the generic map and the port map`, this.t, undefined, [
        { kind: 'delete-text', confidence: 'mechanical', detail: "remove the ';' after the generic map" },
      ]);
    }
    if (this.acceptKw('port')) {
      this.expectKw('map', "after 'port'");
      ports = this.assocList('port map');
    }
    this.expectOp(';', 'after the instantiation');
    return { kind: 'instance', label, unit, generics, ports, loc };
  }

  assocList(what: string): Assoc[] {
    this.expectOp('(', `after '${what}'`);
    const out: Assoc[] = [];
    for (;;) {
      out.push(this.assoc());
      if (this.acceptOp(',')) continue;
      if (this.isOp(';')) this.fail(`expected ',' between associations in the ${what}, found ';'`, this.t, 'associations are separated by commas', [
        { kind: 'replace-text', confidence: 'mechanical', detail: "replace ';' with ','" },
      ]);
      this.expectOp(')', `to close the ${what}`);
      return out;
    }
  }

  assoc(): Assoc {
    const t = this.t;
    if (this.isKw('open')) {
      this.next();
      return { actual: { kind: 'open', loc: t.loc }, loc: t.loc };
    }
    const first = this.expression();
    if (this.acceptOp('=>')) {
      const at = this.t;
      if (this.acceptKw('open')) return { formal: first, actual: { kind: 'open', loc: at.loc }, loc: t.loc };
      const actual = this.expressionOrRange();
      return { formal: first, actual, loc: t.loc };
    }
    if (this.isKw('to') || this.isKw('downto')) {
      const dir = this.next().text as 'to' | 'downto';
      const right = this.simpleExpression();
      return { actual: { kind: 'range', left: first, dir, right, loc: t.loc }, loc: t.loc };
    }
    if (first.kind === 'attr' && (first.attr === 'range' || first.attr === 'reverse_range')) {
      return { actual: { kind: 'attr-range', prefix: first.prefix, attr: first.attr, loc: first.loc }, loc: t.loc };
    }
    return { actual: first, loc: t.loc };
  }

  expressionOrRange(): Expr | RangeExpr {
    const t = this.t;
    const e = this.expression();
    if (this.isKw('to') || this.isKw('downto')) {
      const dir = this.next().text as 'to' | 'downto';
      return { kind: 'range', left: e, dir, right: this.simpleExpression(), loc: t.loc };
    }
    return e;
  }

  forGenerate(label: string, loc: Loc): ConcStmt {
    this.next();
    const param = this.ident("after 'for'");
    this.expectKw('in', `after 'for ${param}'`);
    const range = this.range();
    this.expectKw('generate', 'after the for-generate range');
    const { decls, stmts } = this.generateBody();
    this.expectKw('end', `to close generate '${label}'`);
    this.expectKw('generate', "after 'end' (write 'end generate;')");
    if (this.t.kind === 'id') {
      const n = this.next();
      if (n.text !== label) this.fail(`'end generate ${n.raw}' does not match the label '${label}'`, n);
    }
    this.expectOp(';', "after 'end generate'");
    return { kind: 'for-generate', label, param, range, decls, stmts, loc };
  }

  generateBody(): { decls: Decl[]; stmts: ConcStmt[] } {
    // Optional declarative part: decls … begin
    let decls: Decl[] = [];
    if (this.t.kind === 'kw' && ['signal', 'constant', 'type', 'subtype', 'component'].includes(this.t.text)) {
      decls = this.declarations('generate');
      this.expectKw('begin', 'after the generate declarations');
    } else this.acceptKw('begin');
    const stmts = this.concurrentStatements(['end', 'elsif', 'else']);
    return { decls, stmts };
  }

  ifGenerate(label: string, loc: Loc): ConcStmt {
    this.next();
    const arms: { cond?: Expr; decls: Decl[]; stmts: ConcStmt[]; loc: Loc }[] = [];
    let armLoc = loc;
    let cond: Expr | undefined = this.expression();
    for (;;) {
      this.expectKw('generate', 'after the if-generate condition');
      const body = this.generateBody();
      arms.push({ ...(cond ? { cond } : {}), ...body, loc: armLoc });
      armLoc = this.t.loc;
      if (this.acceptKw('elsif')) {
        cond = this.expression();
        continue;
      }
      if (this.acceptKw('else')) {
        cond = undefined;
        this.acceptKw('generate');
        const b = this.generateBody();
        arms.push({ ...b, loc: armLoc });
      }
      break;
    }
    this.expectKw('end', `to close generate '${label}'`);
    this.expectKw('generate', "after 'end' (write 'end generate;')");
    if (this.t.kind === 'id') this.next();
    this.expectOp(';', "after 'end generate'");
    return { kind: 'if-generate', label, arms, loc };
  }

  waveform(): Waveform {
    const t = this.t;
    let mechanism: Waveform['mechanism'];
    if (this.acceptKw('transport')) mechanism = 'transport';
    else if (this.isKw('reject')) {
      this.next();
      this.expression();
      this.expectKw('inertial', "after 'reject <time>'");
      mechanism = 'reject';
    } else if (this.acceptKw('inertial')) mechanism = 'inertial';
    const elements: WaveElement[] = [];
    for (;;) {
      const et = this.t;
      if (this.acceptKw('unaffected')) {
        elements.push({ value: 'unaffected', loc: et.loc });
      } else if (this.isKw('null')) {
        this.next();
        elements.push({ value: { kind: 'null-lit', loc: et.loc }, loc: et.loc });
      } else {
        const value = this.expression();
        const after = this.acceptKw('after') ? this.expression() : undefined;
        elements.push({ value, ...(after ? { after } : {}), loc: et.loc });
      }
      if (!this.acceptOp(',')) break;
    }
    return { ...(mechanism ? { mechanism } : {}), elements, loc: t.loc };
  }

  condAssign(label: string | undefined, target: Expr, loc: Loc): ConcAssign {
    const wave = this.waveform();
    if (!this.isKw('when')) {
      this.expectOp(';', 'after the signal assignment');
      return { kind: 'cassign', form: 'simple', ...(label ? { label } : {}), target, wave, loc };
    }
    const arms = this.condArms(wave);
    return { kind: 'cassign', form: 'cond', ...(label ? { label } : {}), target, arms, loc };
  }

  condArms(first: Waveform): CondWave[] {
    const arms: CondWave[] = [];
    let wave = first;
    for (;;) {
      if (this.acceptKw('when')) {
        const cond = this.expression();
        arms.push({ wave, cond });
        if (this.acceptKw('else')) {
          wave = this.waveform();
          continue;
        }
        this.expectOp(';', 'after the conditional assignment');
        return arms;
      }
      arms.push({ wave });
      this.expectOp(';', 'after the conditional assignment');
      return arms;
    }
  }

  selectedAssign(label: string | undefined, loc: Loc): ConcAssign {
    this.next();
    const selector = this.expression();
    this.expectKw('select', `after 'with <expression>'`);
    const matching = this.acceptOp('?');
    const target = this.name();
    this.expectOp('<=', 'after the selected assignment target');
    const arms: SelWave[] = [];
    for (;;) {
      const wave = this.waveform();
      this.expectKw('when', 'after the selected value');
      const choices = this.choices();
      arms.push({ wave, choices });
      if (this.acceptOp(',')) continue;
      if (this.isOp(';')) break;
      if (this.isKw('else')) this.fail(`a selected assignment separates alternatives with ',' (not 'else')`, this.t, undefined, [
        { kind: 'replace-text', confidence: 'mechanical', detail: "replace 'else' with ','" },
      ]);
      this.expectOp(';', 'after the selected assignment');
    }
    this.expectOp(';', 'after the selected assignment');
    return { kind: 'cassign', form: 'sel', ...(label ? { label } : {}), target, selector, matching, arms, loc };
  }

  choices(): Choice[] {
    const out: Choice[] = [];
    for (;;) {
      const t = this.t;
      if (this.acceptKw('others')) out.push({ kind: 'others', loc: t.loc });
      else {
        const e = this.simpleExpression();
        if (this.isKw('to') || this.isKw('downto')) {
          const dir = this.next().text as 'to' | 'downto';
          out.push({ kind: 'range', range: { kind: 'range', left: e, dir, right: this.simpleExpression(), loc: t.loc }, loc: t.loc });
        } else out.push({ kind: 'expr', expr: e, loc: t.loc });
      }
      if (!this.acceptOp('|')) return out;
    }
  }

  // ── sequential statements ──

  sequentialStatements(terminators: string[]): SeqStmt[] {
    const out: SeqStmt[] = [];
    while (!(this.t.kind === 'kw' && terminators.includes(this.t.text)) && this.t.kind !== 'eof') {
      out.push(this.sequentialStatement());
    }
    return out;
  }

  sequentialStatement(): SeqStmt {
    const t = this.t;
    let label: string | undefined;
    if (t.kind === 'id' && this.isOp(':', this.peek())) {
      label = t.text;
      this.next();
      this.next();
    }
    const k = this.t;
    const L = label ? { label } : {};
    if (k.kind === 'id' && ['elseif', 'elif', 'endif', 'endcase', 'endloop', 'elseif'].includes(k.text)) {
      const fix = k.text.startsWith('else') || k.text === 'elif' ? 'elsif' : `end ${k.text.slice(3)}`;
      this.fail(`'${k.raw}' is not VHDL; write '${fix}'`, k, undefined, [{ kind: 'replace-text', confidence: 'mechanical', detail: `replace '${k.raw}' with '${fix}'` }]);
    }
    if (k.kind === 'kw') {
      switch (k.text) {
        case 'if': {
          this.next();
          const arms: { cond: Expr; body: SeqStmt[] }[] = [];
          let cond = this.expression();
          let elseBody: SeqStmt[] | undefined;
          for (;;) {
            this.expectKw('then', 'after the if condition');
            const body = this.sequentialStatements(['elsif', 'else', 'end']);
            arms.push({ cond, body });
            if (this.acceptKw('elsif')) {
              cond = this.expression();
              continue;
            }
            if (this.acceptKw('else')) {
              if (this.isKw('if')) {
                // `else if` is legal but needs its own `end if`; parse it as a nested if.
              }
              elseBody = this.sequentialStatements(['end']);
            }
            break;
          }
          this.expectKw('end', 'to close the if statement');
          this.expectKw('if', "after 'end' (write 'end if;')");
          if (this.t.kind === 'id') this.next();
          this.expectOp(';', "after 'end if'");
          return { kind: 'if', arms, ...(elseBody ? { else: elseBody } : {}), loc: k.loc, ...L };
        }
        case 'case': {
          this.next();
          const matching = this.acceptOp('?');
          const expr = this.expression();
          this.expectKw('is', 'after the case expression');
          const arms: { choices: Choice[]; body: SeqStmt[]; loc: Loc }[] = [];
          while (this.isKw('when')) {
            const wt = this.next();
            const choices = this.choices();
            this.expectOp('=>', 'after the case choices');
            const body = this.sequentialStatements(['when', 'end']);
            arms.push({ choices, body, loc: wt.loc });
          }
          if (arms.length === 0) this.fail(`a case statement needs at least one 'when' alternative`, this.t);
          this.expectKw('end', 'to close the case statement');
          this.expectKw('case', "after 'end' (write 'end case;')");
          this.acceptOp('?');
          if (this.t.kind === 'id') this.next();
          this.expectOp(';', "after 'end case'");
          return { kind: 'case', expr, matching, arms, loc: k.loc, ...L };
        }
        case 'for':
        case 'while':
        case 'loop': {
          let head: { kind: 'for'; param: string; range: RangeExpr } | { kind: 'while'; cond: Expr } | { kind: 'loop' } = { kind: 'loop' };
          if (this.acceptKw('for')) {
            const param = this.ident("after 'for'");
            this.expectKw('in', `after 'for ${param}'`);
            head = { kind: 'for', param, range: this.range() };
          } else if (this.acceptKw('while')) {
            head = { kind: 'while', cond: this.expression() };
          }
          this.expectKw('loop', head.kind === 'for' ? 'after the for range' : 'after the while condition');
          const body = this.sequentialStatements(['end']);
          this.expectKw('end', 'to close the loop');
          this.expectKw('loop', "after 'end' (write 'end loop;')");
          if (this.t.kind === 'id') {
            const n = this.next();
            if (n.text !== label) this.fail(`'end loop ${n.raw}' does not match the loop label${label ? ` '${label}'` : ''}`, n);
          }
          this.expectOp(';', "after 'end loop'");
          return { ...head, ...L, body, loc: k.loc } as SeqStmt;
        }
        case 'exit':
        case 'next': {
          this.next();
          const loopLabel = this.t.kind === 'id' ? this.next().text : undefined;
          const cond = this.acceptKw('when') ? this.expression() : undefined;
          this.expectOp(';', `after '${k.text}'`);
          return { kind: k.text as 'exit' | 'next', ...(loopLabel ? { loopLabel } : {}), ...(cond ? { cond } : {}), loc: k.loc, ...L };
        }
        case 'null':
          this.next();
          this.expectOp(';', "after 'null'");
          return { kind: 'null', loc: k.loc, ...L };
        case 'wait': {
          this.next();
          let on: Expr[] | undefined;
          if (this.acceptKw('on')) {
            on = [this.name()];
            while (this.acceptOp(',')) on.push(this.name());
          }
          const until = this.acceptKw('until') ? this.expression() : undefined;
          const forE = this.acceptKw('for') ? this.expression() : undefined;
          this.expectOp(';', 'after the wait statement');
          return { kind: 'wait', ...(on ? { on } : {}), ...(until ? { until } : {}), ...(forE ? { for: forE } : {}), loc: k.loc, ...L };
        }
        case 'assert':
        case 'report': {
          this.next();
          const cond = k.text === 'assert' ? this.expression() : undefined;
          const report = k.text === 'report' ? this.expression() : this.acceptKw('report') ? this.expression() : undefined;
          const severity = this.acceptKw('severity') ? this.expression() : undefined;
          this.expectOp(';', `after the ${k.text} statement`);
          return { kind: 'assert', ...(cond ? { cond } : {}), ...(report ? { report } : {}), ...(severity ? { severity } : {}), loc: k.loc, ...L };
        }
        case 'return': {
          this.next();
          const value = this.isOp(';') ? undefined : this.expression();
          this.expectOp(';', "after 'return'");
          return { kind: 'return', ...(value ? { value } : {}), loc: k.loc, ...L };
        }
        case 'with':
          this.fail(`a selected assignment (with … select) must be outside a process in this subset`, k, 'inside a process use a case statement', [
            { kind: 'rewrite', confidence: 'suggested', detail: 'rewrite as: case sel is when "00" => y <= a; … when others => y <= d; end case;' },
          ]);
          break;
        case 'process':
          this.fail(`a process cannot be nested inside a process (missing 'end process;' before this?)`, k);
          break;
        case 'signal':
        case 'variable':
        case 'constant':
          this.fail(`declarations must come before 'begin' of the process`, k, undefined, [
            { kind: 'move-declaration', confidence: 'mechanical', detail: `move this ${k.text} declaration between 'process' and 'begin'` },
          ]);
          break;
        case 'elsif':
        case 'else':
        case 'when':
          this.fail(`unexpected '${k.text}' (no matching if/case is open here)`, k);
          break;
        default:
          break;
      }
    }
    if (k.kind === 'id' || this.isOp('(')) {
      const target = this.isOp('(') ? this.primary() : this.name();
      if (this.acceptOp('<=')) {
        const wave = this.waveform();
        if (this.isKw('when')) {
          const arms = this.condArms(wave);
          return { kind: 'sassign-cond', target, arms, loc: k.loc, ...L };
        }
        this.expectOp(';', 'after the signal assignment');
        return { kind: 'sassign', target, wave, loc: k.loc, ...L };
      }
      if (this.acceptOp(':=')) {
        const value = this.expression();
        if (this.isKw('when')) this.fail(`conditional variable assignments (:= … when … else) are not supported`, this.t, 'use an if statement');
        this.expectOp(';', 'after the variable assignment');
        return { kind: 'vassign', target, value, loc: k.loc, ...L };
      }
      if (this.isOp('=')) {
        this.fail(`'=' is a comparison; assign signals with '<=' and variables with ':='`, this.t, undefined, [
          { kind: 'replace-text', confidence: 'suggested', detail: "replace '=' with '<=' (signal) or ':=' (variable)" },
        ]);
      }
      if (this.acceptOp(';')) return { kind: 'pcall', call: target, loc: k.loc, ...L };
      this.fail(`expected '<=' or ':=' after ${describe(k)}, found ${describe(this.t)}`);
    }
    this.fail(`expected a sequential statement, found ${describe(k)}`, k, misplacedHint(k));
  }

  // ── expressions ──

  expression(): Expr {
    const t = this.t;
    if (this.isOp('??')) {
      this.next();
      return { kind: 'unary', op: '??', operand: this.primary(), loc: t.loc };
    }
    let left = this.relation();
    let op: string | undefined;
    while (this.t.kind === 'kw' && LOGICAL_OPS.has(this.t.text)) {
      const ot = this.next();
      if (op && (op !== ot.text || op === 'nand' || op === 'nor')) {
        this.fail(
          op === ot.text ? `'${op}' is not associative: '${op}' chains need parentheses` : `mixing '${op}' and '${ot.text}' needs parentheses`,
          ot,
          "VHDL gives all logical operators the same precedence and forbids mixing them without parentheses: write (a and b) or c",
          [{ kind: 'add-parentheses', confidence: 'mechanical', detail: `parenthesize the '${op}' part before '${ot.text}'` }],
        );
      }
      op = ot.text;
      const right = this.relation();
      left = { kind: 'binary', op: ot.text, left, right, loc: ot.loc };
    }
    return left;
  }

  relation(): Expr {
    const left = this.shiftExpression();
    if (this.t.kind === 'op' && REL_OPS.has(this.t.text)) {
      const ot = this.next();
      const right = this.shiftExpression();
      if (this.t.kind === 'op' && REL_OPS.has(this.t.text)) this.fail(`relational operators cannot be chained: use parentheses or 'and'`, this.t);
      return { kind: 'binary', op: ot.text, left, right, loc: ot.loc };
    }
    if (this.isOp('==')) this.fail(`'==' is not VHDL; use '='`, this.t);
    return left;
  }

  shiftExpression(): Expr {
    const left = this.simpleExpression();
    if (this.t.kind === 'kw' && SHIFT_OPS.has(this.t.text)) {
      const ot = this.next();
      const right = this.simpleExpression();
      return { kind: 'binary', op: ot.text, left, right, loc: ot.loc };
    }
    return left;
  }

  simpleExpression(): Expr {
    const t = this.t;
    let left: Expr;
    if (this.isOp('+') || this.isOp('-')) {
      const ot = this.next();
      left = { kind: 'unary', op: ot.text, operand: this.term(), loc: ot.loc };
    } else left = this.term();
    while (this.isOp('+') || this.isOp('-') || this.isOp('&')) {
      const ot = this.next();
      if (this.isOp('+') || this.isOp('-')) {
        this.fail(`a sign cannot follow the '${ot.text}' operator directly; write ${ot.text} (${this.t.text}…)`, this.t, 'VHDL only allows a unary sign at the start of an expression', [
          { kind: 'add-parentheses', confidence: 'mechanical', detail: `parenthesize the signed operand: a ${ot.text} (-b)` },
        ]);
      }
      const right = this.term();
      left = { kind: 'binary', op: ot.text, left, right, loc: ot.loc };
    }
    void t;
    return left;
  }

  term(): Expr {
    let left = this.factor();
    while (this.isOp('*') || this.isOp('/') || this.isKw('mod') || this.isKw('rem')) {
      const ot = this.next();
      const right = this.factor();
      left = { kind: 'binary', op: ot.text, left, right, loc: ot.loc };
    }
    return left;
  }

  factor(): Expr {
    const t = this.t;
    if (this.isKw('abs') || this.isKw('not')) {
      this.next();
      return { kind: 'unary', op: t.text, operand: this.primary(), loc: t.loc };
    }
    if (t.kind === 'kw' && LOGICAL_OPS.has(t.text)) {
      // VHDL-2008 unary reduction operators: and v, or v, xor v
      this.next();
      return { kind: 'unary', op: t.text, operand: this.primary(), loc: t.loc };
    }
    const base = this.primary();
    if (this.isOp('**')) {
      const ot = this.next();
      const exp = this.primary();
      return { kind: 'binary', op: '**', left: base, right: exp, loc: ot.loc };
    }
    return base;
  }

  primary(): Expr {
    const t = this.t;
    switch (t.kind) {
      case 'int':
      case 'real': {
        this.next();
        const lit: Expr = t.kind === 'int' ? { kind: 'int', value: t.value!, raw: t.raw, loc: t.loc } : { kind: 'real', value: t.value!, raw: t.raw, loc: t.loc };
        if (this.t.kind === 'id' && this.t.text in TIME_UNITS) {
          const u = this.next();
          return { kind: 'phys', value: lit, unit: u.text, loc: t.loc };
        }
        return lit;
      }
      case 'char':
        this.next();
        return { kind: 'char', value: t.text, loc: t.loc };
      case 'str':
        this.next();
        return { kind: 'str', value: t.text, loc: t.loc };
      case 'bitstr':
        this.next();
        return { kind: 'bitstr', value: t.text, raw: t.raw, loc: t.loc };
      case 'id':
        return this.name();
      case 'op':
        if (t.text === '(') return this.aggregateOrParen();
        break;
      case 'kw':
        if (t.text === 'null') {
          this.next();
          return { kind: 'null-lit', loc: t.loc };
        }
        if (t.text === 'new') this.fail(`allocators ('new') are not supported`, t);
        break;
      default:
        break;
    }
    if (this.isOp(')') || this.isOp(';') || t.kind === 'eof') this.fail(`expected an expression, found ${describe(t)}`, t);
    this.fail(`expected an expression, found ${describe(t)}`, t, misplacedHint(t));
  }

  aggregateOrParen(): Expr {
    const open = this.next();
    const items: { choices?: Choice[]; value: Expr; loc: Loc }[] = [];
    for (;;) {
      const it = this.t;
      let choices: Choice[] | undefined;
      let value: Expr;
      if (this.isKw('others')) {
        choices = this.choices();
        this.expectOp('=>', "after 'others'");
        value = this.expression();
      } else {
        const first = this.expression();
        if (this.isOp('=>') || this.isOp('|') || this.isKw('to') || this.isKw('downto')) {
          choices = [];
          let e: Expr = first;
          for (;;) {
            if (this.isKw('to') || this.isKw('downto')) {
              const dir = this.next().text as 'to' | 'downto';
              const right = this.simpleExpression();
              choices.push({ kind: 'range', range: { kind: 'range', left: e, dir, right, loc: e.loc }, loc: e.loc });
            } else choices.push({ kind: 'expr', expr: e, loc: e.loc });
            if (!this.acceptOp('|')) break;
            if (this.isKw('others')) {
              choices.push({ kind: 'others', loc: this.next().loc });
              break;
            }
            e = this.simpleExpression();
          }
          this.expectOp('=>', 'after the aggregate choices');
          value = this.expression();
        } else value = first;
      }
      items.push({ ...(choices ? { choices } : {}), value, loc: it.loc });
      if (this.acceptOp(',')) continue;
      this.expectOp(')', 'to close the parenthesized expression or aggregate');
      break;
    }
    if (items.length === 1 && !items[0].choices) return { kind: 'paren', expr: items[0].value, loc: open.loc };
    return { kind: 'agg', items, loc: open.loc };
  }

  /** name ::= identifier { (args) | .suffix | 'attribute | '(qualified) } */
  name(): Expr {
    const t = this.t;
    if (t.kind !== 'id') this.ident('as a name');
    this.next();
    let e: Expr = { kind: 'id', name: t.text, loc: t.loc };
    for (;;) {
      if (this.isOp('(')) {
        const at = this.next();
        const args: Assoc[] = [];
        if (this.isOp(')')) this.fail(`empty parentheses are not allowed after '${t.raw}'`, this.t);
        for (;;) {
          args.push(this.assoc());
          if (!this.acceptOp(',')) break;
        }
        this.expectOp(')', `to close the argument list of '${t.raw}'`);
        e = { kind: 'call', prefix: e, args, loc: at.loc };
        continue;
      }
      if (this.isOp('.')) {
        const dt = this.next();
        if (this.acceptKw('all')) {
          e = { kind: 'sel', prefix: e, suffix: 'all', loc: dt.loc };
          continue;
        }
        const s = this.t;
        if (s.kind !== 'id' && s.kind !== 'kw') this.fail(`expected a name after '.', found ${describe(s)}`, s);
        this.next();
        e = { kind: 'sel', prefix: e, suffix: s.text, loc: dt.loc };
        continue;
      }
      if (this.isOp("'")) {
        const tick = this.next();
        if (this.isOp('(')) {
          if (e.kind !== 'id') this.fail(`a qualified expression needs a type name before the tick`, tick);
          const inner = this.aggregateOrParen();
          e = { kind: 'qual', type: e.name, expr: inner.kind === 'paren' ? inner.expr : inner, loc: tick.loc };
          continue;
        }
        const a = this.t;
        if (a.kind !== 'id' && !(a.kind === 'kw' && (a.text === 'range' || a.text === 'reverse_range'))) {
          this.fail(`expected an attribute name after "'", found ${describe(a)}`, a);
        }
        this.next();
        let arg: Expr | undefined;
        if (PARAM_ATTRS.has(a.text) && this.isOp('(')) {
          this.next();
          arg = this.expression();
          this.expectOp(')', `to close the argument of '${a.text}`);
        }
        e = { kind: 'attr', prefix: e, attr: a.text, ...(arg ? { arg } : {}), loc: tick.loc };
        continue;
      }
      return e;
    }
  }
}

function misplacedHint(t: Token): string | undefined {
  if (t.kind === 'kw' && t.text === 'begin') return "a 'begin' is only allowed once per architecture or process (check for a missing 'end')";
  if (t.kind === 'kw' && t.text === 'end') return "this 'end' closes nothing that is open here (check the matching 'end if' / 'end process')";
  return undefined;
}
