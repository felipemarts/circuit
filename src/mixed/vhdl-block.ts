/**
 * VHDL blocks as bench components.
 *
 *   import counter from '<bench dir>/counter.vhd';   // the bench loader reads the file
 *   const u2 = tb.add('U2', new VhdlBlock({ source: counter, entity: 'counter', generics: { N: 4 }, family: 'HC', vcc: 5 }));
 *   u2.pin('clk').connect(...); u2.pin('q[0]').connect(...);
 *
 * Pins are named after the entity's ports, one per bit: std_logic / boolean
 * ports by name ('clk'), vectors 'q[i]' per VHDL index, integer / enumeration
 * ports 'n[k]' per encoding bit (LSB 0). Case-insensitive; 'q(0)' works too.
 *
 * Electrically a VHDL block is a generic logic element (like the logic
 * primitives): on a pure-digital net (only primitives / VHDL blocks) it is
 * simulated by the event engine alone; where a pin meets an analog net it is
 * bridged with the levels of a logic family (`family`, default 'HC') at an
 * ideal supply `vcc` (default 5 V) referenced to tb.gnd — it has no supply
 * pins (think of a CPLD whose power is not part of the bench).
 */
import { Component } from '../core/Component';
import type { Pin } from '../core/Pin';
import type { MNAMatrix } from '../solver/MNAMatrix';
import type { AcLoadContext, LoadContext } from '../analysis/context';
import type { ParamValue } from '../schema/types';
import { parseValue } from '../core/units';
import { DigitalCircuit } from '../digital/circuit';
import { compileVhdl } from '../vhdl/design';
import type { VhdlDiagnostic } from '../vhdl/diagnostics';
import type { VhdlGenericValue, VhdlPort } from '../vhdl/design';
import type { VhdlSource } from '../vhdl/source';
import { OutputStage, PIN_LEAK } from './device';
import type { FamilyName } from './families';
import { benchCallerFile } from './mcu';

export interface VhdlBlockOptions {
  /** VHDL: a `.vhd` import ({ kind: 'vhdl-source', text, path }), several of them, or inline text. */
  source: VhdlSource | VhdlSource[] | string;
  /** Entity to instantiate (default: the only top-level entity). */
  entity?: string;
  /** Architecture (default: the last one compiled). */
  architecture?: string;
  /** Generic values: integers, booleans, time in seconds or '10 ns', std_logic '1', vectors "0101". */
  generics?: Record<string, VhdlGenericValue>;
  /** Logic family of the analog bridge (default 'HC'). */
  family?: FamilyName;
  /** Ideal supply the bridged levels are referenced to (default 5 V). */
  vcc?: number | string;
}

/** One port of the block with its pin names (lowest index / LSB first). */
export interface VhdlBlockPort {
  name: string;
  mode: 'in' | 'out' | 'inout' | 'buffer';
  kind: VhdlPort['kind'];
  type: string;
  pins: string[];
}

const FAMILIES: FamilyName[] = ['HC', 'HCT', 'CD4000'];

function pinKey(name: string): string {
  return name.trim().toLowerCase().replace(/\((\d+)\)/g, '[$1]').replace(/\s+/g, '');
}

/** Pin names of an elaborated port, lowest index (vectors) / LSB (integers, enums) first. */
export function portPinNames(p: VhdlPort): string[] {
  if (p.width === 1 && (p.kind === 'std_logic' || p.kind === 'boolean')) return [p.name];
  if (p.kind === 'vector' && p.range) {
    const low = Math.min(p.range.left, p.range.right);
    return Array.from({ length: p.width }, (_, k) => `${p.name}[${low + k}]`);
  }
  return Array.from({ length: p.width }, (_, k) => `${p.name}[${k}]`);
}

export class VhdlBlock extends Component {
  readonly kind = 'VhdlBlock' as const;
  /** Sources with a path (files) — embedded in circuit documents — or one inline text. */
  readonly sources: VhdlSource[];
  readonly inlineText?: string;
  readonly entity?: string;
  readonly architecture?: string;
  readonly generics: Record<string, VhdlGenericValue>;
  readonly family: FamilyName;
  readonly vcc: number;
  /** Ports (empty when the VHDL does not compile: the lint reports V7xx and any pin name is accepted). */
  readonly ports: VhdlBlockPort[] = [];
  /** The VHDL did not compile / elaborate at construction (pins are created on demand). */
  readonly broken: boolean;
  /** @internal constructor-time diagnostics (re-derived with the bench location at elaboration). */
  readonly _constructDiagnostics: VhdlDiagnostic[];
  /** @internal pins on analog nets (mixed elaboration). */
  _bridged = new Set<string>();
  /** @internal output stages by pin name. */
  _stages = new Map<string, OutputStage>();
  private readonly byKey = new Map<string, Pin>();
  private readonly modeOf = new Map<string, VhdlBlockPort['mode']>();

  constructor(opts: VhdlBlockOptions) {
    super();
    if (opts === null || typeof opts !== 'object') throw new Error(`VhdlBlock(options): options must be an object { source, entity?, generics?, family?, vcc? }`);
    for (const k of Object.keys(opts)) {
      if (!['source', 'entity', 'architecture', 'generics', 'family', 'vcc'].includes(k)) {
        throw new Error(`VhdlBlock: unknown option '${k}'. Valid options: source, entity, architecture, generics, family, vcc`);
      }
    }
    const src = opts.source;
    if (typeof src === 'string') {
      this.inlineText = src;
      this.sources = [];
    } else {
      const list = Array.isArray(src) ? src : [src];
      if (list.length === 0) throw new Error('VhdlBlock: source is empty');
      for (const s of list) {
        if (!s || typeof s !== 'object' || typeof s.text !== 'string') {
          throw new Error(`VhdlBlock: source must be a .vhd import (import counter from './counter.vhd'), an array of them, or VHDL text`);
        }
        if (typeof s.path !== 'string' || s.path === '') {
          throw new Error('VhdlBlock: a source object needs its path (use the .vhd import, or pass the VHDL text as a string)');
        }
      }
      this.sources = list.map(s => ({ kind: 'vhdl-source' as const, text: s.text, path: s.path!.replace(/\\/g, '/') }));
    }
    if (opts.entity !== undefined && typeof opts.entity !== 'string') throw new Error('VhdlBlock: entity must be a string');
    if (opts.architecture !== undefined && typeof opts.architecture !== 'string') throw new Error('VhdlBlock: architecture must be a string');
    this.architecture = opts.architecture;
    const generics: Record<string, VhdlGenericValue> = {};
    // Sorted keys: netlist params are canonical (a document rebuild yields the same order).
    for (const [k, v] of Object.entries(opts.generics ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      if (typeof v !== 'number' && typeof v !== 'boolean' && typeof v !== 'string') throw new Error(`VhdlBlock: generic '${k}' must be a number, boolean or string`);
      generics[k] = v;
    }
    this.generics = generics;
    const fam = (opts.family ?? 'HC') as FamilyName;
    if (!FAMILIES.includes(fam)) throw new Error(`VhdlBlock: family must be one of ${FAMILIES.map(f => `'${f}'`).join(', ')}, got ${JSON.stringify(opts.family)}`);
    this.family = fam;
    this.vcc = opts.vcc === undefined ? 5 : parseValue(opts.vcc, 'VhdlBlock vcc');
    if (!(this.vcc > 0)) throw new Error(`VhdlBlock: vcc must be > 0, got ${this.vcc}`);

    // Ports (and so pins) need the elaborated entity: generics size the vectors.
    const r = compileVhdl(this.input(), { origin: benchCallerFile() });
    let diags: VhdlDiagnostic[] = [...r.diagnostics];
    let entity = opts.entity;
    let broken = !r.ok || !r.design;
    if (!broken) {
      try {
        const inst = r.design!.instantiate(new DigitalCircuit(), 'VHDL', { ...(entity ? { entity } : {}), ...(this.architecture ? { architecture: this.architecture } : {}), generics });
        entity = inst.entity;
        for (const p of inst.ports) {
          const port: VhdlBlockPort = { name: p.name, mode: p.mode as VhdlBlockPort['mode'], kind: p.kind, type: p.type, pins: portPinNames(p) };
          this.ports.push(port);
          for (const name of port.pins) {
            const pin = this.addPin(name);
            this.byKey.set(pinKey(name), pin);
            this.modeOf.set(name, port.mode);
          }
        }
      } catch (err) {
        broken = true;
        const ds = (err as { diagnostics?: VhdlDiagnostic[] }).diagnostics;
        if (ds) diags = [...diags, ...ds];
        else throw err;
      }
    }
    this.entity = entity;
    this.broken = broken;
    this._constructDiagnostics = diags;
  }

  /** @internal VHDL input for compileVhdl. */
  input(): VhdlSource[] | string {
    return this.inlineText ?? this.sources.map(s => ({ ...s }));
  }

  /** Pin by port bit ('clk', 'q[0]', 'Q(0)'). With VHDL that does not compile, any name is accepted (the lint reports the error). */
  pin(name: string | number): Pin {
    const key = pinKey(String(name));
    const p = this.byKey.get(key);
    if (p) return p;
    if (this.broken) {
      const created = this.addPin(key);
      this.byKey.set(key, created);
      this.modeOf.set(key, 'in');
      return created;
    }
    throw new Error(`VhdlBlock (${this.entity}) has no pin '${name}'. Pins: ${this.ports.flatMap(p => p.pins).join(', ')}`);
  }

  /** @internal lenient pin set (broken VHDL): a document may list any pin. */
  get _lenientPins(): boolean {
    return this.broken;
  }

  /** Port mode of a pin. */
  modeOfPin(name: string): VhdlBlockPort['mode'] {
    return this.modeOf.get(name) ?? 'in';
  }

  describeParams(): Record<string, ParamValue> {
    const paths = this.sources.map(s => s.path!);
    return {
      ...(this.inlineText !== undefined ? { text: this.inlineText } : { source: paths.length === 1 ? paths[0] : paths }),
      ...(this.entity !== undefined ? { entity: this.entity } : {}),
      ...(this.architecture !== undefined ? { architecture: this.architecture } : {}),
      ...(Object.keys(this.generics).length > 0 ? { generics: { ...this.generics } } : {}),
      family: this.family,
      vcc: this.vcc,
    };
  }

  /** VHDL files to embed in a circuit document. */
  sourceFiles(): { path: string; language: string; text: string }[] {
    return this.sources.map(s => ({ path: s.path!, language: 'vhdl', text: s.text }));
  }

  load(ctx: LoadContext): void {
    const m = ctx.matrix;
    for (const [name, pin] of this.pins) {
      const n = pin.node.index;
      if (!this._bridged.has(name)) {
        // Pure-digital net: decoupled dummy unknown held at 0 V.
        m.stampConductance(n, 0, 1);
        continue;
      }
      m.stampConductance(n, 0, PIN_LEAK);
      const st = this._stages.get(name);
      if (!st) continue;
      const e = st.eAt(ctx);
      if (e <= 0) continue;
      const s = st.sAt(ctx);
      const gUp = (e * s) / st.rHigh;
      const gDn = (e * (1 - s)) / st.rLow;
      m.stampConductance(n, 0, gUp + gDn);
      m.stampCurrentSource(n, 0, gUp * this.vcc);
    }
  }

  hasAcModel(): boolean {
    return true;
  }

  acLoad(ctx: AcLoadContext): void {
    const m = ctx.matrix;
    for (const [name, pin] of this.pins) {
      const n = pin.node.index;
      if (!this._bridged.has(name)) {
        m.stampAdmittance(n, 0, 1, 0);
        continue;
      }
      const st = this._stages.get(name);
      const g = st && st.e.to > 0 ? (st.e.to * st.s.to) / st.rHigh + (st.e.to * (1 - st.s.to)) / st.rLow : 0;
      m.stampAdmittance(n, 0, PIN_LEAK + g, 0);
    }
  }

  /** Legacy entry point: the device stamps through load(ctx). */
  stamp(_matrix: MNAMatrix): void {}
}

/** Rebuild a VHDL block from its netlist params and the document's sources. */
export function buildVhdlComponent(type: string, params: Record<string, ParamValue>, sources: { path: string; text: string }[] | undefined): VhdlBlock | undefined {
  if (type !== 'VhdlBlock') return undefined;
  const opts: VhdlBlockOptions = { source: '' };
  if (typeof params.text === 'string') opts.source = params.text;
  else {
    const paths = typeof params.source === 'string' ? [params.source] : Array.isArray(params.source) ? params.source : undefined;
    if (!paths || paths.some(p => typeof p !== 'string')) throw new Error(`VhdlBlock: param 'source' must be a source path (or a list of them), or 'text' the VHDL`);
    opts.source = (paths as string[]).map(p => {
      const s = (sources ?? []).find(x => x.path === p);
      if (!s) throw new Error(`VhdlBlock: VHDL source '${p}' is not among the document's sources`);
      return { kind: 'vhdl-source' as const, text: s.text, path: p };
    });
  }
  if (params.entity !== undefined) opts.entity = params.entity as string;
  if (params.architecture !== undefined) opts.architecture = params.architecture as string;
  if (params.generics !== undefined) opts.generics = JSON.parse(JSON.stringify(params.generics)) as Record<string, VhdlGenericValue>;
  if (params.family !== undefined) opts.family = params.family as FamilyName;
  if (params.vcc !== undefined) opts.vcc = params.vcc as number;
  return new VhdlBlock(opts);
}
