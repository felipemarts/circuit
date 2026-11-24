/**
 * Public VHDL API: compile sources into a design, instantiate an entity into
 * a DigitalCircuit, inspect its ports and decode its signals.
 */
import { Behavioral, Const, DigitalCircuit, Pull } from '../digital/circuit';
import type { DigitalSim } from '../digital/sim';
import type { Logic } from '../digital/logic';
import { ID_RE, NET_RE } from '../digital/netlist';
import type { ArchBody, DesignFile, EntityDecl, Mode } from './ast';
import { dedupeDiagnostics, VhdlError, vhdlDiagnostic } from './diagnostics';
import type { VhdlDiagnostic } from './diagnostics';
import { Elaborator } from './elab';
import type { DesignUnits, ElabResult, TopBinding } from './elab';
import { lex } from './lexer';
import { parseTokens } from './parser';
import { subtype as printSubtype, expr as printExpr } from './printer';
import { registerVhdlBehavior, VHDL_BEHAVIOR } from './runtime';
import { callerLoc, formatLoc, normalizeSources } from './source';
import type { SourceInfo, VhdlInput } from './source';
import { indexAt, typeName } from './types';
import type { VType } from './types';
import { vecToString } from './values';
import type { Value } from './values';

export interface VhdlCompileOptions {
  /**
   * Location of the code that holds inline VHDL text ('x.bench.ts:7'), used
   * in diagnostics of sources without a path. Default: the caller's location.
   */
  origin?: string;
}

export interface VhdlCompileResult {
  /** No error-severity diagnostics. */
  ok: boolean;
  /** Present when ok. */
  design?: VhdlDesign;
  /** Every diagnostic (errors and warnings), in source order. */
  diagnostics: VhdlDiagnostic[];
}

export interface VhdlGenericInfo {
  name: string;
  /** VHDL type as written ('natural', 'integer range 0 to 255', 'time'). */
  type: string;
  /** Default value as written in the source, if any. */
  default?: string;
}

export interface VhdlPortDecl {
  name: string;
  mode: Mode;
  /** VHDL type as written ('std_logic_vector(N - 1 downto 0)'). */
  type: string;
}

export interface VhdlEntityInfo {
  name: string;
  architectures: string[];
  generics: VhdlGenericInfo[];
  ports: VhdlPortDecl[];
  at?: string;
}

export type VhdlGenericValue = number | boolean | string;

export interface VhdlInstantiateOptions {
  /** Entity to instantiate. Default: the only top-level entity (one no other entity instantiates). */
  entity?: string;
  /** Architecture. Default: the last one compiled for the entity. */
  architecture?: string;
  /**
   * Generic values: integers as numbers, booleans as true/false, time as seconds
   * (number) or a string like '10 ns', std_logic as '0'/'1', vectors as "0101",
   * enumerations as the literal name.
   */
  generics?: Record<string, VhdlGenericValue>;
  /**
   * Port → net mapping. A string is a base name: std_logic/boolean ports use it
   * as is, vectors get `base[i]` per VHDL index i, integers/enums `base[k]` per
   * encoding bit k (LSB 0). An array lists the nets from the lowest index (or the
   * LSB) up. Unmapped ports get nets named `<id>__<port>…`.
   */
  ports?: Record<string, string | string[]>;
}

export type VhdlPortKind = 'std_logic' | 'vector' | 'integer' | 'boolean' | 'enum';

export interface VhdlPort {
  name: string;
  mode: Mode;
  /** Elaborated type ('unsigned(3 downto 0)', 'integer range 0 to 9'). */
  type: string;
  kind: VhdlPortKind;
  /** Number of nets. */
  width: number;
  /** Nets from the lowest index (vectors) or the LSB (integer/enum encodings) up. */
  nets: string[];
  /** Vectors: declared range. */
  range?: { left: number; right: number; dir: 'to' | 'downto' };
  /** signed vector, or integer range with negative values (two's complement). */
  signed?: boolean;
  /** Integer range. */
  low?: number;
  high?: number;
  /** Enumeration literals (lowercase), in encoding order. */
  literals?: string[];
}

export interface VhdlSignalInfo {
  /** Hierarchical name ('count', 'u1.carry', 'gen(2).t'). */
  name: string;
  type: string;
  kind: VhdlPortKind;
  nets: string[];
  port: boolean;
}

export type VhdlReadValue = Logic | string | number | boolean | undefined;

/** A compiled set of VHDL design units (one compilation unit, library work). */
export class VhdlDesign {
  /** Warnings from compilation (errors make compileVhdl fail instead). */
  readonly diagnostics: VhdlDiagnostic[];

  /** @internal */
  constructor(
    private readonly units: DesignUnits,
    diagnostics: VhdlDiagnostic[],
  ) {
    this.diagnostics = diagnostics;
  }

  /** Entities, sorted by name. */
  entities(): VhdlEntityInfo[] {
    return [...this.units.entities.values()]
      .sort((a, b) => (a.name < b.name ? -1 : 1))
      .map(e => {
        const at = formatLoc(this.units.sources, e.loc);
        return {
          name: e.name,
          architectures: (this.units.archs.get(e.name) ?? []).map(a => a.name),
          generics: e.generics.flatMap(g => g.names.map(n => ({ name: n, type: printSubtype(g.type), ...(g.init ? { default: printExpr(g.init) } : {}) }))),
          ports: e.ports.flatMap(p => p.names.map(n => ({ name: n, mode: p.mode ?? 'in', type: printSubtype(p.type) }))),
          ...(at ? { at } : {}),
        };
      });
  }

  /** Entities that no other compiled architecture instantiates, sorted. */
  topEntities(): string[] {
    const used = new Set<string>();
    const walk = (stmts: ArchBody['stmts']): void => {
      for (const s of stmts) {
        if (s.kind === 'instance') used.add(s.unit.name);
        else if (s.kind === 'for-generate') walk(s.stmts);
        else if (s.kind === 'if-generate') s.arms.forEach(a => walk(a.stmts));
      }
    };
    for (const list of this.units.archs.values()) for (const a of list) walk(a.stmts);
    return [...this.units.entities.keys()].filter(n => !used.has(n)).sort();
  }

  /**
   * Elaborate an entity without adding it to a circuit. Never throws for VHDL
   * errors: they come back as diagnostics (and `ok: false`).
   */
  elaborate(id: string, opts: VhdlInstantiateOptions = {}): { ok: boolean; result?: ElabResult; diagnostics: VhdlDiagnostic[] } {
    const diags: VhdlDiagnostic[] = [];
    const api = (message: string): { ok: false; diagnostics: VhdlDiagnostic[] } => ({
      ok: false,
      diagnostics: [vhdlDiagnostic('V721', { message, fixes: [] })],
    });
    if (typeof id !== 'string' || !ID_RE.test(id)) return api(`invalid instance id ${JSON.stringify(id)}: use letters/digits/underscore starting with a letter, e.g. 'U1'`);
    if (id.includes('__')) return api(`invalid instance id '${id}': '__' separates hierarchy levels in generated names`);
    let entity = opts.entity?.toLowerCase();
    if (!entity) {
      const tops = this.topEntities();
      if (tops.length !== 1) return api(`the design has ${tops.length} top-level entities (${tops.join(', ') || 'none'}); choose one with { entity: '…' }`);
      entity = tops[0];
    }
    if (!this.units.entities.has(entity)) return api(`no entity '${entity}' in the design (entities: ${[...this.units.entities.keys()].sort().join(', ')})`);
    const ports: Record<string, TopBinding> = {};
    for (const [k, v] of Object.entries(opts.ports ?? {})) {
      const names = Array.isArray(v) ? v : [v];
      for (const n of names) {
        if (typeof n !== 'string' || !NET_RE.test(n)) return api(`port '${k}': invalid net name ${JSON.stringify(n)} (letters, digits, '_' and [] for bus bits)`);
      }
      ports[k.toLowerCase()] = Array.isArray(v) ? [...v] : v;
    }
    const generics: Record<string, Value> = {};
    for (const [k, v] of Object.entries(opts.generics ?? {})) {
      if (typeof v !== 'number' && typeof v !== 'boolean' && typeof v !== 'string') return api(`generic '${k}': value must be a number, boolean or string, got ${JSON.stringify(v)}`);
      generics[k.toLowerCase()] = v as unknown as Value;
    }
    const el = new Elaborator(this.units);
    const result = el.elaborateTop(entity, { id, generics, ports, ...(opts.architecture ? { arch: opts.architecture.toLowerCase() } : {}) });
    diags.push(...el.diags);
    const all = dedupeDiagnostics(diags);
    const ok = !!result && !all.some(d => d.severity === 'error');
    return { ok, ...(result && ok ? { result } : {}), diagnostics: all };
  }

  /**
   * Elaborate an entity and add its processes to `circuit` as Behavioral parts
   * (ids `<id>__<label>`), plus Const drivers for undriven signals.
   * Throws VhdlError (with `.diagnostics`) on any VHDL error.
   */
  instantiate(circuit: DigitalCircuit, id: string, opts: VhdlInstantiateOptions = {}): VhdlInstance {
    if (!(circuit instanceof DigitalCircuit) && !(circuit && typeof (circuit as DigitalCircuit).add === 'function')) {
      throw new VhdlError([vhdlDiagnostic('V721', { message: 'instantiate(circuit, …): circuit must be a DigitalCircuit' })]);
    }
    const r = this.elaborate(id, opts);
    if (!r.ok || !r.result) throw new VhdlError(r.diagnostics);
    registerVhdlBehavior();
    const res = r.result;
    const components: string[] = [];
    try {
      for (const p of res.procs) {
        circuit.add(
          p.id,
          new Behavioral({ behavior: VHDL_BEHAVIOR, inputs: p.config.inPins, outputs: p.config.outPins, combPaths: p.combPaths, config: p.config as never }),
          p.wiring,
          p.at ? { at: p.at } : {},
        );
        components.push(p.id);
      }
      for (const k of res.consts) {
        const part = k.value === 6 ? new Pull(0) : k.value === 7 ? new Pull(1) : new Const(k.value === 2 ? 0 : k.value === 3 ? 1 : k.value === 4 ? 'Z' : 'X');
        circuit.add(k.id, part, { y: k.net }, k.at ? { at: k.at } : {});
        components.push(k.id);
      }
    } catch (e) {
      throw new VhdlError([vhdlDiagnostic('V721', { message: `cannot add VHDL instance '${id}' to the circuit: ${e instanceof Error ? e.message : String(e)}` })]);
    }
    return new VhdlInstance(id, res, components, r.diagnostics);
  }
}

const KIND = (t: VType): VhdlPortKind => (t.k === 'logic' ? 'std_logic' : t.k === 'vec' ? 'vector' : t.k === 'bool' ? 'boolean' : t.k === 'enum' ? 'enum' : 'integer');

/** Nets in "lowest index / LSB first" order from position-ordered nets. */
function lowFirst(t: VType, nets: string[]): string[] {
  if (t.k !== 'vec') return [...nets];
  const idx = nets.map((n, p) => [indexAt(t, p), n] as const);
  return idx.sort((a, b) => a[0] - b[0]).map(x => x[1]);
}

/** One elaborated VHDL entity inside a DigitalCircuit. */
export class VhdlInstance {
  readonly entity: string;
  readonly architecture: string;
  /** Generic values used (integers, booleans as true/false, time in seconds, vectors as strings). */
  readonly generics: Record<string, number | boolean | string>;
  readonly ports: VhdlPort[];
  readonly signals: VhdlSignalInfo[];
  /** Ids of the components added to the circuit. */
  readonly components: string[];
  /** Warnings (e.g. V717 incomplete sensitivity list). */
  readonly diagnostics: VhdlDiagnostic[];
  private readonly types = new Map<string, { t: VType; nets: string[] }>();

  /** @internal */
  constructor(
    readonly id: string,
    res: ElabResult,
    components: string[],
    diagnostics: VhdlDiagnostic[],
  ) {
    this.entity = res.entity;
    this.architecture = res.architecture;
    this.components = components;
    this.diagnostics = diagnostics;
    const ent = res;
    this.generics = {};
    for (const [k, v] of Object.entries(ent.generics)) this.generics[k] = v instanceof Uint8Array ? vecToString(v) : (v as number);
    this.ports = res.ports.map(p => {
      const t = p.t;
      const port: VhdlPort = { name: p.name, mode: p.mode, type: typeName(t), kind: KIND(t), width: p.nets.length, nets: lowFirst(t, p.nets) };
      if (t.k === 'vec') {
        port.range = { left: t.left, right: t.right, dir: t.asc ? 'to' : 'downto' };
        if (t.base === 's') port.signed = true;
      }
      if (t.k === 'int') {
        port.low = t.lo;
        port.high = t.hi;
        if (t.lo < 0) port.signed = true;
      }
      if (t.k === 'enum') port.literals = [...t.lits];
      return port;
    });
    this.signals = res.signals.map(s => ({ name: s.name, type: typeName(s.t), kind: KIND(s.t), nets: lowFirst(s.t, s.nets), port: s.port }));
    for (const s of res.signals) if (!this.types.has(s.name)) this.types.set(s.name, { t: s.t, nets: s.nets });
  }

  /** A port by name (case-insensitive). */
  port(name: string): VhdlPort {
    const p = this.ports.find(x => x.name === name.toLowerCase());
    if (!p) throw new Error(`VHDL instance '${this.id}' (${this.entity}) has no port '${name}'. Ports: ${this.ports.map(x => x.name).join(', ')}`);
    return p;
  }

  /** The net of a std_logic port, or of bit `index` (VHDL index / encoding bit) of a wider port. */
  net(port: string, index?: number): string {
    const p = this.port(port);
    if (index === undefined) {
      if (p.width !== 1) throw new Error(`port '${p.name}' has ${p.width} nets; pass the index: net('${p.name}', i)`);
      return p.nets[0];
    }
    const k = p.range ? index - Math.min(p.range.left, p.range.right) : index;
    const n = p.nets[k];
    if (n === undefined) throw new Error(`port '${p.name}' has no bit ${index}`);
    return n;
  }

  private lookup(name: string): { t: VType; nets: string[] } {
    const s = this.types.get(name.toLowerCase());
    if (!s) throw new Error(`VHDL instance '${this.id}' has no signal '${name}'. Signals: ${[...this.types.keys()].join(', ')}`);
    return s;
  }

  /**
   * Current value of a port or signal (hierarchical names like 'u1.carry'):
   * std_logic → 0 | 1 | 'X' | 'Z'; vector → string as declared ("0101", left to right);
   * integer → number; enumeration → literal; boolean → true/false. Integer, enum and
   * boolean reads are undefined while a bit is X/Z.
   */
  read(sim: DigitalSim, name: string): VhdlReadValue {
    const { t, nets } = this.lookup(name);
    const vals = nets.map(n => sim.value(n));
    switch (t.k) {
      case 'logic':
        return vals[0];
      case 'vec':
        return vals.map(v => (v === 0 ? '0' : v === 1 ? '1' : v)).join('');
      case 'bool':
        return vals[0] === 1 ? true : vals[0] === 0 ? false : undefined;
      default: {
        const n = decodeBits(vals, t.k === 'int' && t.lo < 0);
        if (n === undefined) return undefined;
        return t.k === 'enum' ? t.lits[n] : n;
      }
    }
  }

  /** Numeric value of a vector (unsigned, or two's complement for signed) or integer; undefined while a bit is X/Z. */
  readNumber(sim: DigitalSim, name: string): number | undefined {
    const { t, nets } = this.lookup(name);
    const vals = nets.map(n => sim.value(n));
    if (t.k === 'vec') return decodeBits([...vals].reverse(), t.base === 's');
    if (t.k === 'int' || t.k === 'enum') return decodeBits(vals, t.k === 'int' && t.lo < 0);
    if (t.k === 'logic' || t.k === 'bool') return vals[0] === 0 || vals[0] === 1 ? vals[0] : undefined;
    return undefined;
  }
}

/** LSB-first logic values → number. */
function decodeBits(vals: Logic[], signed: boolean): number | undefined {
  let n = 0;
  for (let k = 0; k < vals.length; k++) {
    if (vals[k] !== 0 && vals[k] !== 1) return undefined;
    if (vals[k] === 1) n += 2 ** k;
  }
  if (signed && vals.length > 0 && vals[vals.length - 1] === 1) n -= 2 ** vals.length;
  return n;
}

// ── compile ──

export function compileVhdl(input: VhdlInput, opts: VhdlCompileOptions = {}): VhdlCompileResult {
  const origin = opts.origin ?? callerLoc();
  const sources = normalizeSources(input, origin);
  const diags: VhdlDiagnostic[] = [];
  const entities = new Map<string, EntityDecl>();
  const archs = new Map<string, ArchBody[]>();
  const pendingArchs: ArchBody[] = [];
  let syntaxErrors = false;
  sources.forEach((s, i) => {
    const { file, issues } = parseSource(s, i, sources);
    for (const d of issues) {
      diags.push(d);
      if (d.code === 'V701' || d.code === 'V702') syntaxErrors = true;
    }
    for (const u of file.units) {
      if (u.kind === 'entity') {
        if (entities.has(u.name)) {
          diags.push(
            vhdlDiagnostic('V715', {
              message: `entity '${u.name}' is declared twice`,
              note: `the first declaration is at ${formatLoc(sources, entities.get(u.name)!.loc)}`,
              ...(formatLoc(sources, u.loc) ? { at: formatLoc(sources, u.loc) } : {}),
            }),
          );
          continue;
        }
        entities.set(u.name, u);
      } else pendingArchs.push(u);
    }
  });
  for (const a of pendingArchs) {
    if (!entities.has(a.entity)) {
      if (!syntaxErrors) {
        const at = formatLoc(sources, a.loc);
        diags.push(vhdlDiagnostic('V709', { message: `architecture '${a.name}' is for entity '${a.entity}', which is not in the compiled sources`, ...(at ? { at } : {}), note: 'compile the entity declaration together with its architecture' }));
      }
      continue;
    }
    const list = archs.get(a.entity) ?? [];
    if (list.some(x => x.name === a.name)) {
      const at = formatLoc(sources, a.loc);
      diags.push(vhdlDiagnostic('V715', { message: `architecture '${a.name}' of '${a.entity}' is declared twice`, ...(at ? { at } : {}) }));
      continue;
    }
    list.push(a);
    archs.set(a.entity, list);
  }
  if (entities.size === 0 && !syntaxErrors && !diags.some(d => d.severity === 'error')) {
    diags.push(vhdlDiagnostic('V709', { message: 'no entity declaration found in the VHDL source', note: 'a design needs at least one entity … end entity; plus an architecture for it' }));
  }
  const units: DesignUnits = { sources, entities, archs };
  if (!syntaxErrors) {
    // Semantic check of every entity whose generics all have defaults.
    for (const ent of [...entities.values()].sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (!ent.generics.every(g => g.init)) continue;
      const el = new Elaborator(units);
      if ((archs.get(ent.name) ?? []).length === 0) {
        el.pickArch(ent, undefined, ent.loc);
      } else el.elaborateTop(ent.name, { id: 'chk', generics: {}, ports: {} });
      diags.push(...el.diags);
    }
  }
  const all = dedupeDiagnostics(diags);
  const ok = !all.some(d => d.severity === 'error');
  return { ok, ...(ok ? { design: new VhdlDesign(units, all) } : {}), diagnostics: all };
}

/** compileVhdl that throws VhdlError on errors. */
export function compileVhdlOrThrow(input: VhdlInput, opts: VhdlCompileOptions = {}): VhdlDesign {
  const r = compileVhdl(input, { origin: opts.origin ?? callerLoc() });
  if (!r.ok || !r.design) throw new VhdlError(r.diagnostics);
  return r.design;
}

/**
 * Compile (if given source) and instantiate in one call:
 *   const u1 = instantiateVhdl(c, 'U1', counterVhd, { generics: { N: 4 }, ports: { clk: 'CLK', q: 'Q' } });
 * Throws VhdlError on any VHDL error.
 */
export function instantiateVhdl(circuit: DigitalCircuit, id: string, design: VhdlDesign | VhdlInput, opts: VhdlInstantiateOptions = {}): VhdlInstance {
  const d = design instanceof VhdlDesign ? design : compileVhdlOrThrow(design, { origin: callerLoc() });
  return d.instantiate(circuit, id, opts);
}

/** Parse only (no elaboration): the AST plus syntax diagnostics. For tooling and tests. */
export function parseVhdl(input: VhdlInput, opts: VhdlCompileOptions = {}): { files: DesignFile[]; diagnostics: VhdlDiagnostic[] } {
  const sources = normalizeSources(input, opts.origin ?? callerLoc());
  const files: DesignFile[] = [];
  const diagnostics: VhdlDiagnostic[] = [];
  sources.forEach((s, i) => {
    const r = parseSource(s, i, sources);
    files.push(r.file);
    diagnostics.push(...r.issues);
  });
  return { files, diagnostics };
}

function parseSource(s: SourceInfo, i: number, sources: SourceInfo[]): { file: DesignFile; issues: VhdlDiagnostic[] } {
  const issues: VhdlDiagnostic[] = [];
  const { tokens, errors } = lex(s.text, i);
  for (const e of errors) {
    const at = formatLoc(sources, e.loc);
    issues.push(vhdlDiagnostic('V702', { message: e.message, ...(at ? { at } : {}), ...(e.note ? { note: e.note } : {}), evidence: { line: e.loc.line, col: e.loc.col } }));
  }
  if (errors.length > 0) return { file: { units: [] }, issues };
  const { file, issues: pi } = parseTokens(tokens);
  for (const p of pi) {
    const at = formatLoc(sources, p.loc);
    issues.push(
      vhdlDiagnostic(p.code, {
        message: p.message,
        ...(at ? { at } : {}),
        ...(p.note ? { note: p.note } : {}),
        evidence: { line: p.loc.line, col: p.loc.col, ...(p.construct ? { construct: p.construct } : {}) },
        fixes: p.fixes ?? [],
      }),
    );
  }
  return { file, issues };
}

