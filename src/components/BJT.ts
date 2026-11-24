import { Component } from '../core/Component';
import type { MNAMatrix, ComplexMNAMatrix } from '../solver/MNAMatrix';
import type { AcLoadContext, AcceptContext, InitContext, LoadContext, Phasor } from '../analysis/context';
import { junctionVcrit, pnjlim, safeExp } from '../solver/limiting';
import { depletionCharge } from './semi/junction';
import { SemiCore } from './semi/core';
import { BJT_PARAMS, describeValues, normalizeParams } from './semi/params';
import { parseSpiceModel, type ModelDiagnostic } from './semi/spiceModel';

/**
 * Gummel-Poon parameters (SPICE subset). Names are case-insensitive
 * (`bf`, `Bf`, `BF`) and accept unit strings. With every optional parameter
 * at its default the model reduces to the transport Ebers-Moll model.
 */
export interface BjtParams {
  Is?: number | string;
  Bf?: number | string;
  Nf?: number | string;
  Vaf?: number | string;
  Ikf?: number | string;
  Ise?: number | string;
  Ne?: number | string;
  Br?: number | string;
  Nr?: number | string;
  Var?: number | string;
  Ikr?: number | string;
  Isc?: number | string;
  Nc?: number | string;
  Rb?: number | string;
  Re?: number | string;
  Rc?: number | string;
  Cje?: number | string;
  Vje?: number | string;
  Mje?: number | string;
  Cjc?: number | string;
  Vjc?: number | string;
  Mjc?: number | string;
  Tf?: number | string;
  Tr?: number | string;
  Fc?: number | string;
  Vt?: number | string;
  [key: string]: number | string | undefined;
}

/** Result of the Gummel-Poon equations at (vbe, vbc), polarity-normalized. */
export interface GummelPoonPoint {
  /** Collector current (into the intrinsic collector). */
  cc: number;
  /** Base current (into the intrinsic base). */
  cb: number;
  dcc_dvbe: number;
  dcc_dvbc: number;
  dcb_dvbe: number;
  dcb_dvbc: number;
  /** Normalized base charge qb. */
  qb: number;
  /** B-E charge (depletion + Tf·cbe/qb) and partials. */
  qbe: number;
  dqbe_dvbe: number;
  dqbe_dvbc: number;
  /** B-C charge (depletion + Tr·cbc) and partial. */
  qbc: number;
  dqbc_dvbc: number;
}

// Local nodes: 0 c, 1 b, 2 e (pins), 3 c', 4 b', 5 e' (internal when Rc/Rb/Re > 0).
const C = 0, B = 1, E = 2, CI = 3, BI = 4, EI = 5;

/**
 * Bipolar junction transistor — SPICE Gummel-Poon subset (no temperature
 * scaling, no excess phase, constant Rb, all of Cjc on the internal base,
 * no substrate). Pins 'c', 'b', 'e' (aliases 'collector', 'base', 'emitter').
 * Both junctions use pn-junction limiting in Newton-Raphson.
 *
 *   cbe = Is(e^(vbe/(Nf·Vt)) − 1)          cbc = Is(e^(vbc/(Nr·Vt)) − 1)
 *   qb  = q1·(1 + √(1 + 4·q2))/2,  q1 = 1/(1 − vbc/Vaf − vbe/Var),  q2 = cbe/Ikf + cbc/Ikr
 *   ic  = (cbe − cbc)/qb − cbc/Br − Isc(e^(vbc/(Nc·Vt)) − 1)
 *   ib  = cbe/Bf + Ise(e^(vbe/(Ne·Vt)) − 1) + cbc/Br + Isc(e^(vbc/(Nc·Vt)) − 1)
 *   Qbe = Tf·cbe/qb + Qdep(vbe; Cje, Vje, Mje, Fc)     Qbc = Tr·cbc + Qdep(vbc; Cjc, Vjc, Mjc, Fc)
 */
export class BJT extends Component {
  readonly kind: string = 'BJT';
  /** +1 NPN, −1 PNP. */
  readonly polarity: 1 | -1;
  /** Resolved model parameters (canonical names). */
  readonly params: Readonly<Record<string, number>>;
  /** Catalog part id when built by Part(id). */
  partId?: string;
  modelName?: string;
  modelDiagnostics: ModelDiagnostic[] = [];
  /** The verbatim `.model` card when built by fromModel() (carried by circuit documents to replay T005–T008). */
  modelCard?: string;

  /** @internal limited junction voltages of the last load */
  _vbe = 0;
  _vbc = 0;
  private readonly _core: SemiCore;
  private _firstInternal = -1;
  private readonly _internalCount: number;
  private _published: Record<string, number> = {};
  private readonly vcritBe: number;
  private readonly vcritBc: number;

  constructor(polarity: 1 | -1, params?: BjtParams, deviceName = polarity === 1 ? 'NPN' : 'PNP') {
    super();
    this.polarity = polarity;
    const { values } = normalizeParams(deviceName, BJT_PARAMS, params);
    this.params = values;
    this.vcritBe = junctionVcrit(values.Nf * values.Vt, values.Is);
    this.vcritBc = junctionVcrit(values.Nr * values.Vt, values.Is);
    for (const [name, alias] of [['collector', 'c'], ['base', 'b'], ['emitter', 'e']] as const) {
      const pin = this.addPin(name);
      this.pins.set(alias, pin); // canonical netlist names: c, b, e
    }
    this._internalCount = (values.Rc > 0 ? 1 : 0) + (values.Rb > 0 ? 1 : 0) + (values.Re > 0 ? 1 : 0);
    const hasQbe = values.Cje > 0 || values.Tf > 0;
    const hasQbc = values.Cjc > 0 || values.Tr > 0;
    const t = polarity;
    this._core = new SemiCore(this, 6, 2, ctx => {
      let vbe = t * (ctx.v(BI) - ctx.v(EI));
      let vbc = t * (ctx.v(BI) - ctx.v(CI));
      if (ctx.mode !== 'readout') {
        if (ctx.init === 'junction') {
          vbe = this.vcritBe;
          vbc = 0;
        } else if (ctx.limiting) {
          const a = pnjlim(vbe, this._vbe, values.Nf * values.Vt, this.vcritBe);
          const b = pnjlim(vbc, this._vbc, values.Nr * values.Vt, this.vcritBc);
          if (a.limited || b.limited) ctx.limited();
          vbe = a.value;
          vbc = b.value;
        }
        this._vbe = vbe;
        this._vbc = vbc;
      }
      const g = this.gummelPoon(vbe, vbc, ctx.gmin);
      ctx.branch(CI, EI, t, t * g.cc, [
        { p: BI, n: EI, d: g.dcc_dvbe, v0: vbe },
        { p: BI, n: CI, d: g.dcc_dvbc, v0: vbc },
      ]);
      ctx.branch(BI, EI, t, t * g.cb, [
        { p: BI, n: EI, d: g.dcb_dvbe, v0: vbe },
        { p: BI, n: CI, d: g.dcb_dvbc, v0: vbc },
      ]);
      if (hasQbe) {
        ctx.charge(0, BI, EI, t, g.qbe, [
          { p: BI, n: EI, d: g.dqbe_dvbe, v0: vbe },
          { p: BI, n: CI, d: g.dqbe_dvbc, v0: vbc },
        ]);
      }
      if (hasQbc) ctx.charge(1, BI, CI, t, g.qbc, [{ p: BI, n: CI, d: g.dqbc_dvbc, v0: vbc }]);
    });
    this._core.addResistor(C, CI, values.Rc);
    this._core.addResistor(B, BI, values.Rb);
    this._core.addResistor(E, EI, values.Re);
  }

  /** The Gummel-Poon equations (polarity-normalized voltages). Public for tests and tooling. */
  gummelPoon(vbe: number, vbc: number, gmin = 0): GummelPoonPoint {
    const p = this.params;
    const vt = p.Vt;
    const csat = p.Is;
    const vtn = p.Nf * vt;
    const evbe = safeExp(vbe / vtn);
    const cbe = csat * (evbe - 1) + gmin * vbe;
    const gbe = (csat * evbe) / vtn + gmin;
    let cben = 0;
    let gben = 0;
    if (p.Ise > 0) {
      const vte = p.Ne * vt;
      const e = safeExp(vbe / vte);
      cben = p.Ise * (e - 1);
      gben = (p.Ise * e) / vte;
    }
    const vtr = p.Nr * vt;
    const evbc = safeExp(vbc / vtr);
    const cbc = csat * (evbc - 1) + gmin * vbc;
    const gbc = (csat * evbc) / vtr + gmin;
    let cbcn = 0;
    let gbcn = 0;
    if (p.Isc > 0) {
      const vtc = p.Nc * vt;
      const e = safeExp(vbc / vtc);
      cbcn = p.Isc * (e - 1);
      gbcn = (p.Isc * e) / vtc;
    }
    const ovaf = Number.isFinite(p.Vaf) ? 1 / p.Vaf : 0;
    const ovar = Number.isFinite(p.Var) ? 1 / p.Var : 0;
    const oik = Number.isFinite(p.Ikf) ? 1 / p.Ikf : 0;
    const oikr = Number.isFinite(p.Ikr) ? 1 / p.Ikr : 0;
    // Base charge (Early effect + high injection).
    let denom = 1 - ovaf * vbc - ovar * vbe;
    let early = true;
    if (denom < 1e-3) {
      // Far outside any sane bias (|vbc| ≈ Vaf): hold q1 instead of dividing by ~0.
      denom = 1e-3;
      early = false;
    }
    const q1 = 1 / denom;
    let qb: number;
    let dqbdve: number;
    let dqbdvc: number;
    if (oik === 0 && oikr === 0) {
      qb = q1;
      dqbdve = early ? q1 * qb * ovar : 0;
      dqbdvc = early ? q1 * qb * ovaf : 0;
    } else {
      const q2 = oik * cbe + oikr * cbc;
      const arg = Math.max(0, 1 + 4 * q2);
      const sqarg = arg !== 0 ? Math.sqrt(arg) : 1;
      qb = (q1 * (1 + sqarg)) / 2;
      dqbdve = q1 * ((early ? qb * ovar : 0) + (oik * gbe) / sqarg);
      dqbdvc = q1 * ((early ? qb * ovaf : 0) + (oikr * gbc) / sqarg);
    }
    const cc = (cbe - cbc) / qb - cbc / p.Br - cbcn;
    const cb = cbe / p.Bf + cben + cbc / p.Br + cbcn;
    const dcc_dvbe = (gbe - ((cbe - cbc) * dqbdve) / qb) / qb;
    const dcc_dvbc = (-gbc - ((cbe - cbc) * dqbdvc) / qb) / qb - gbc / p.Br - gbcn;
    const dcb_dvbe = gbe / p.Bf + gben;
    const dcb_dvbc = gbc / p.Br + gbcn;

    // Charges.
    let qbe = 0;
    let dqbe_dvbe = 0;
    let dqbe_dvbc = 0;
    if (p.Tf > 0) {
      qbe = (p.Tf * cbe) / qb;
      dqbe_dvbe = (p.Tf * (gbe - (cbe * dqbdve) / qb)) / qb;
      dqbe_dvbc = (-p.Tf * cbe * dqbdvc) / (qb * qb);
    }
    const dbe = depletionCharge(vbe, p.Cje, p.Vje, p.Mje, p.Fc);
    qbe += dbe.q;
    dqbe_dvbe += dbe.c;
    const dbc = depletionCharge(vbc, p.Cjc, p.Vjc, p.Mjc, p.Fc);
    const qbc = p.Tr * cbc + dbc.q;
    const dqbc_dvbc = p.Tr * gbc + dbc.c;
    return { cc, cb, dcc_dvbe, dcc_dvbc, dcb_dvbe, dcb_dvbc, qb, qbe, dqbe_dvbe, dqbe_dvbc, qbc, dqbc_dvbc };
  }

  /** Plain-JSON netlist params: every parameter that differs from its SPICE default. */
  describeParams(): Record<string, number | string> {
    return {
      ...describeValues(BJT_PARAMS, this.params as Record<string, number>),
      ...(this.modelName ? { model: this.modelName } : {}),
      ...(this.partId ? { part: this.partId } : {}),
    };
  }

  isNonlinear(): boolean {
    return true;
  }

  getInternalNodeCount(): number {
    return this._internalCount;
  }

  assignInternalNodes(first: number): void {
    this._firstInternal = first;
  }

  private refresh(): void {
    const nodes = this._core.nodes;
    nodes[C] = this.pin('c').node.index;
    nodes[B] = this.pin('b').node.index;
    nodes[E] = this.pin('e').node.index;
    let k = this._firstInternal;
    nodes[CI] = this.params.Rc > 0 ? k++ : nodes[C];
    nodes[BI] = this.params.Rb > 0 ? k++ : nodes[B];
    nodes[EI] = this.params.Re > 0 ? k++ : nodes[E];
  }

  stamp(_matrix: MNAMatrix): void {
    // Only reachable through the legacy entry point; the engine calls load(ctx).
  }

  load(ctx: LoadContext): void {
    this.refresh();
    this._core.load(ctx);
  }

  initTransient(ctx: InitContext): void {
    this.refresh();
    this._core.initTransient(ctx);
  }

  acceptStep(_ctx: AcceptContext): void {
    this._core.acceptStep();
  }

  resetToDC(): void {
    this._core.resetToDC();
  }

  hasAcModel(): boolean {
    return true;
  }

  acLoad(ctx: AcLoadContext): void {
    this.refresh();
    this._core.acLoad(ctx);
  }

  private terminalCurrents(I: ArrayLike<number>): { ic: number; ib: number; ie: number } {
    return { ic: I[C] + I[CI], ib: I[B] + I[BI], ie: I[E] + I[EI] };
  }

  /** All probe quantities from a solution vector. */
  private quantitiesAt(x: ArrayLike<number>): Record<string, number> {
    this.refresh();
    const n = this._core.nodes;
    const v = (k: number) => (n[k] > 0 ? x[n[k] - 1] : 0);
    const { ic, ib, ie } = this.terminalCurrents(this._core.evaluateAt(x));
    const vc = v(C);
    const vb = v(B);
    const ve = v(E);
    return {
      ic,
      ib,
      ie,
      vbe: vb - ve,
      vbc: vb - vc,
      vce: vc - ve,
      vcb: vc - vb,
      veb: ve - vb,
      p: vc * ic + vb * ib + ve * ie,
      i: ic,
      v: vc - ve,
    };
  }

  readResults(solution: ArrayLike<number>, _matrix: MNAMatrix): { voltage: number; current: number } {
    const q = this.quantitiesAt(solution);
    return { voltage: q.vce, current: q.ic };
  }

  setOperatingPoint(solution: ArrayLike<number>, _matrix: MNAMatrix): void {
    this._published = this.quantitiesAt(solution);
  }

  /** Collector-emitter voltage at the last published solution. */
  get voltage(): number {
    return this._published.vce ?? 0;
  }

  /** Collector current (into the collector pin) at the last published solution. */
  get current(): number {
    return this._published.ic ?? 0;
  }

  /**
   * Probe quantities ('Q1.<q>'): ic, ib, ie — currents INTO each pin (SPICE
   * convention: an NPN in forward-active has ic > 0, ib > 0, ie < 0); vbe,
   * vbc, vce, vcb, veb — pin voltage differences; p — dissipated power
   * Σ V·I; i = ic and v = vce.
   */
  probeQuantities(): string[] {
    return ['ic', 'ib', 'ie', 'vbe', 'vbc', 'vce', 'vcb', 'veb', 'p', 'i', 'v'];
  }

  quantity(name: string): number | undefined {
    return this._published[name];
  }

  readQuantity(name: string, x: ArrayLike<number>, _matrix: MNAMatrix): number | undefined {
    return this.quantitiesAt(x)[name];
  }

  acQuantity(name: string, re: ArrayLike<number>, im: ArrayLike<number>, omega: number): Phasor | undefined {
    this.refresh();
    const n = this._core.nodes;
    const vp = (k: number): Phasor => (n[k] > 0 ? [re[n[k] - 1], im[n[k] - 1]] : [0, 0]);
    const sub = (a: Phasor, b: Phasor): Phasor => [a[0] - b[0], a[1] - b[1]];
    const add = (a: Phasor, b: Phasor): Phasor => [a[0] + b[0], a[1] + b[1]];
    const I = this._core.acCurrents(re, im, omega);
    switch (name) {
      case 'ic':
      case 'i':
        return add(I[C], I[CI]);
      case 'ib':
        return add(I[B], I[BI]);
      case 'ie':
        return add(I[E], I[EI]);
      case 'vbe':
        return sub(vp(B), vp(E));
      case 'vbc':
        return sub(vp(B), vp(C));
      case 'vce':
      case 'v':
        return sub(vp(C), vp(E));
      case 'vcb':
        return sub(vp(C), vp(B));
      case 'veb':
        return sub(vp(E), vp(B));
      default:
        return undefined;
    }
  }

  acReadResults(re: ArrayLike<number>, im: ArrayLike<number>, omega: number, _matrix: ComplexMNAMatrix): { voltage: Phasor; current: Phasor } {
    return { voltage: this.acQuantity('vce', re, im, omega)!, current: this.acQuantity('ic', re, im, omega)! };
  }
}

function fromCard(card: string, expected: 'NPN' | 'PNP'): { params: BjtParams | undefined; name: string | undefined; diagnostics: ModelDiagnostic[] } {
  const parsed = parseSpiceModel(card);
  const diagnostics = [...parsed.diagnostics];
  if (parsed.type && parsed.type !== expected && !diagnostics.some(d => d.code === 'T006')) {
    diagnostics.push({
      code: 'T006',
      severity: 'error',
      message: `.model ${parsed.name}: card type ${parsed.type} does not match ${expected}.fromModel — use ${
        parsed.type === 'NPN' || parsed.type === 'PNP' ? `${parsed.type}.fromModel` : "the matching device's fromModel"
      }`,
    });
  }
  const usable = !diagnostics.some(d => d.severity === 'error');
  return { params: usable ? (parsed.params as BjtParams) : undefined, name: parsed.name || undefined, diagnostics };
}

/** NPN transistor: `new NPN({ bf: 100 })` (generic, free parameters) or `Part('2N3904')`. */
export class NPN extends BJT {
  override readonly kind: string = 'NPN';
  constructor(params?: BjtParams) {
    super(1, params, 'NPN');
  }
  /** Build from a SPICE `.model <name> NPN(...)` card (problems → T005–T008 at lint). */
  static fromModel(card: string): NPN {
    const { params, name, diagnostics } = fromCard(card, 'NPN');
    const q = new NPN(params);
    q.modelName = name;
    q.modelDiagnostics = diagnostics;
    q.modelCard = card;
    return q;
  }
}

/** PNP transistor: `new PNP({ bf: 100 })` or `Part('2N3906')`. Same equations with every voltage and current negated. */
export class PNP extends BJT {
  override readonly kind: string = 'PNP';
  constructor(params?: BjtParams) {
    super(-1, params, 'PNP');
  }
  static fromModel(card: string): PNP {
    const { params, name, diagnostics } = fromCard(card, 'PNP');
    const q = new PNP(params);
    q.modelName = name;
    q.modelDiagnostics = diagnostics;
    q.modelCard = card;
    return q;
  }
}
