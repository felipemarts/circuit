import { Component } from '../core/Component';
import type { MNAMatrix, ComplexMNAMatrix } from '../solver/MNAMatrix';
import type { AcLoadContext, AcceptContext, InitContext, LoadContext, Phasor } from '../analysis/context';
import { fetlim, limvds } from '../solver/limiting';
import { Junction } from './semi/junction';
import { SemiCore, type EvalContext } from './semi/core';
import { DIODE_PARAMS, MOSFET_PARAMS, describeValues, normalizeParams } from './semi/params';
import { parseSpiceModel, type ModelDiagnostic } from './semi/spiceModel';
import type { DiodeParams } from './Diode';

/**
 * Level-1 (Shichman-Hodges) MOSFET parameters. Names are case-insensitive and
 * accept unit strings. Lumped convention by default (W = L = 1): Kp is then
 * the device's beta and Cgso/Cgdo are total capacitances in farads.
 */
export interface MosfetParams {
  Vto?: number | string;
  Kp?: number | string;
  Lambda?: number | string;
  Gamma?: number | string;
  Phi?: number | string;
  Rd?: number | string;
  Rs?: number | string;
  W?: number | string;
  L?: number | string;
  Ld?: number | string;
  Cgso?: number | string;
  Cgdo?: number | string;
  Cgbo?: number | string;
  Cbd?: number | string;
  Cbs?: number | string;
  Is?: number | string;
  Pb?: number | string;
  Mj?: number | string;
  Fc?: number | string;
  Vt?: number | string;
  /** Expose a 4th pin 'b' (bulk). Default false: bulk tied to the source. */
  bulkPin?: boolean;
  /**
   * Explicit source-drain body diode (power MOSFETs): a full diode model
   * (Is, n, Rs, Cjo, Tt, BV…) from the source/bulk to the drain pin, replacing
   * the Level-1 bulk-drain junction.
   */
  bodyDiode?: DiodeParams;
  [key: string]: number | string | boolean | DiodeParams | undefined;
}

// Local nodes: 0 d, 1 g, 2 s, 3 b (pins; b = s when tied), 4 d', 5 s' (internal when Rd/Rs > 0),
// 6 body-diode anode (internal when the body diode has Rs > 0).
const D = 0, G = 1, S = 2, BK = 3, DI = 4, SI = 5, BX = 6;

/** Drain current of the Level-1 equations in the normal mode (vds ≥ 0), normalized polarity. */
export interface Level1Point {
  id: number;
  gm: number;
  gds: number;
  gmbs: number;
  /** Threshold including the body effect. */
  von: number;
  region: 'cutoff' | 'triode' | 'saturation';
}

/**
 * MOSFET, SPICE Level 1 (Shichman-Hodges):
 *
 *   Vth = Vto + Gamma·(√(Phi − Vbs) − √Phi)            (N-channel frame; P mirrors it)
 *   beta = Kp·W/(L − 2·Ld)
 *   cutoff     Vgs ≤ Vth:            Id = 0
 *   triode     Vds < Vgs − Vth:      Id = beta·Vds·(Vgs − Vth − Vds/2)·(1 + Lambda·Vds)
 *   saturation Vds ≥ Vgs − Vth:      Id = beta/2·(Vgs − Vth)²·(1 + Lambda·Vds)
 *
 * Source/drain swap when Vds < 0. Rd/Rs as internal nodes; constant gate
 * capacitances Cgso·W, Cgdo·W, Cgbo·Leff (no Meyer intrinsic charge);
 * bulk-drain/bulk-source junctions (Is, Cbd/Cbs, Pb, Mj, Fc) or an explicit
 * body diode. Newton-Raphson uses fetlim on Vgs/Vgd, limvds on Vds and pnjlim
 * on the bulk junctions (SPICE MOS1).
 * Pins 'd', 'g', 's' (aliases 'drain', 'gate', 'source'), plus 'b' with bulkPin.
 */
export class MOSFET extends Component {
  readonly kind: string = 'MOSFET';
  /** +1 N-channel, −1 P-channel. */
  readonly polarity: 1 | -1;
  readonly params: Readonly<Record<string, number>>;
  readonly bulkPin: boolean;
  /** Resolved body-diode parameters (when an explicit body diode is modeled). */
  readonly bodyDiode: Readonly<Record<string, number>> | null;
  partId?: string;
  modelName?: string;
  modelDiagnostics: ModelDiagnostic[] = [];

  /** @internal limited voltages of the last load (normalized) */
  _vgs = 0;
  _vds = 0;
  _vbs = 0;
  _vbody = 0;
  _von = 0;
  private readonly _core: SemiCore;
  private _firstInternal = -1;
  private readonly _internalCount: number;
  private _published: Record<string, number> = {};
  private readonly beta: number;
  private readonly leff: number;
  private readonly bd: Junction;
  private readonly bs: Junction;
  private readonly body: Junction | null;
  private readonly bodyRs: number;

  constructor(polarity: 1 | -1, params?: MosfetParams, deviceName = polarity === 1 ? 'NMOS' : 'PMOS') {
    super();
    this.polarity = polarity;
    const { values } = normalizeParams(deviceName, MOSFET_PARAMS, params as Record<string, unknown>, ['bulkPin', 'bodyDiode']);
    this.params = values;
    const raw = (params ?? {}) as Record<string, unknown>;
    const bulkKey = Object.keys(raw).find(k => k.toLowerCase() === 'bulkpin');
    const bodyKey = Object.keys(raw).find(k => k.toLowerCase() === 'bodydiode');
    this.bulkPin = bulkKey ? raw[bulkKey] === true : false;
    if (bulkKey && typeof raw[bulkKey] !== 'boolean') throw new Error(`${deviceName} bulkPin must be true or false`);
    let body: Record<string, number> | null = null;
    if (bodyKey && raw[bodyKey] !== undefined) {
      if (typeof raw[bodyKey] !== 'object' || raw[bodyKey] === null) throw new Error(`${deviceName} bodyDiode must be an object of diode parameters`);
      body = normalizeParams(`${deviceName} bodyDiode`, DIODE_PARAMS, raw[bodyKey] as Record<string, unknown>).values;
    }
    this.bodyDiode = body;
    this.leff = values.L - 2 * values.Ld;
    if (!(this.leff > 0)) throw new Error(`${deviceName}: L − 2·Ld must be > 0 (L=${values.L}, Ld=${values.Ld})`);
    this.beta = (values.Kp * values.W) / this.leff;

    for (const [name, alias] of [['drain', 'd'], ['gate', 'g'], ['source', 's']] as const) {
      const pin = this.addPin(name);
      this.pins.set(alias, pin);
    }
    if (this.bulkPin) this.pins.set('b', this.addPin('bulk'));

    const jn = (cjo: number) => ({
      Is: values.Is, n: 1, Vt: values.Vt, Cjo: cjo, Vj: values.Pb, M: values.Mj, Fc: values.Fc, Tt: 0, BV: Infinity, IBV: 1e-3, Nbv: 1,
    });
    this.bd = new Junction(jn(values.Cbd));
    this.bs = new Junction(jn(values.Cbs));
    if (body) {
      this.body = new Junction({
        Is: body.Is, n: body.n, Vt: body.Vt,
        Cjo: body.Cjo > 0 ? body.Cjo : values.Cbd, Vj: body.Cjo > 0 ? body.Vj : values.Pb, M: body.Cjo > 0 ? body.M : values.Mj,
        Fc: body.Fc, Tt: body.Tt, BV: body.BV, IBV: body.IBV, Nbv: Number.isNaN(body.Nbv) ? body.n : body.Nbv,
      });
      this.bodyRs = body.Rs;
    } else {
      this.body = null;
      this.bodyRs = 0;
    }
    this._internalCount = (values.Rd > 0 ? 1 : 0) + (values.Rs > 0 ? 1 : 0) + (this.bodyRs > 0 ? 1 : 0);

    const t = polarity;
    const cgs = values.Cgso * values.W;
    const cgd = values.Cgdo * values.W;
    const cgb = values.Cgbo * this.leff;
    const vtoN = t * values.Vto;
    this._core = new SemiCore(this, 7, 5, ctx => this.evaluate(ctx, t, vtoN, cgs, cgd, cgb));
    this._core.addResistor(D, DI, values.Rd);
    this._core.addResistor(S, SI, values.Rs);
    this._core.addResistor(BK, BX, this.bodyRs);
  }

  /** Level-1 drain current in the normal mode (vds ≥ 0). Public for tests and tooling. */
  level1(vgs: number, vds: number, vbs: number): Level1Point {
    const p = this.params;
    const sphi = Math.sqrt(p.Phi);
    let sarg: number;
    let dsarg: number; // d sarg / d vbs
    if (vbs <= 0) {
      sarg = Math.sqrt(p.Phi - vbs);
      dsarg = -1 / (2 * sarg);
    } else {
      sarg = sphi - vbs / (2 * sphi);
      dsarg = -1 / (2 * sphi);
      if (sarg < 0) {
        sarg = 0;
        dsarg = 0;
      }
    }
    const von = this.polarity * p.Vto + p.Gamma * (sarg - sphi);
    const arg = -p.Gamma * dsarg; // d(−Vth)/d vbs
    const vgst = vgs - von;
    if (vgst <= 0) return { id: 0, gm: 0, gds: 0, gmbs: 0, von, region: 'cutoff' };
    const beta = this.beta;
    const betap = beta * (1 + p.Lambda * vds);
    if (vgst <= vds) {
      const id = (betap * vgst * vgst) / 2;
      const gm = betap * vgst;
      return { id, gm, gds: (p.Lambda * beta * vgst * vgst) / 2, gmbs: gm * arg, von, region: 'saturation' };
    }
    const id = betap * vds * (vgst - vds / 2);
    const gm = betap * vds;
    const gds = betap * (vgst - vds) + p.Lambda * beta * vds * (vgst - vds / 2);
    return { id, gm, gds, gmbs: gm * arg, von, region: 'triode' };
  }

  private evaluate(ctx: EvalContext, t: number, vtoN: number, cgs: number, cgd: number, cgb: number): void {
    const tied = !this.bulkPin;
    let vgs = t * (ctx.v(G) - ctx.v(SI));
    let vds = t * (ctx.v(DI) - ctx.v(SI));
    let vbs = tied ? t * (ctx.v(S) - ctx.v(SI)) : t * (ctx.v(BK) - ctx.v(SI));
    const bodyAnode = this.bodyRs > 0 ? BX : BK;
    let vbody = this.body ? t * (ctx.v(bodyAnode) - ctx.v(D)) : 0;
    if (ctx.mode !== 'readout') {
      if (ctx.init === 'junction') {
        vgs = vtoN;
        vds = 0;
        vbs = tied ? vbs : -1;
        vbody = 0;
      } else if (ctx.limiting) {
        let limited = false;
        const vgd = vgs - vds;
        const vgdOld = this._vgs - this._vds;
        if (this._vds >= 0) {
          const a = fetlim(vgs, this._vgs, this._von);
          vgs = a.value;
          const b = limvds(vgs - vgd, this._vds);
          vds = b.value;
          limited = a.limited || b.limited;
        } else {
          const a = fetlim(vgd, vgdOld, this._von);
          const b = limvds(-(vgs - a.value), -this._vds);
          vds = -b.value;
          vgs = a.value + vds;
          limited = a.limited || b.limited;
        }
        if (!tied || this.params.Rs > 0) {
          if (vds >= 0) {
            const c = this.bs.limit(vbs, this._vbs);
            vbs = c.value;
            limited = limited || c.limited;
          } else {
            const c = this.bd.limit(vbs - vds, this._vbs - this._vds);
            vbs = c.value + vds;
            limited = limited || c.limited;
          }
        }
        if (this.body) {
          const c = this.body.limit(vbody, this._vbody);
          vbody = c.value;
          limited = limited || c.limited;
        }
        if (limited) ctx.limited();
      }
      this._vgs = vgs;
      this._vds = vds;
      this._vbs = vbs;
      this._vbody = vbody;
    }
    // Channel (source/drain swap for vds < 0).
    const normal = vds >= 0;
    const X = normal ? DI : SI;
    const Y = normal ? SI : DI;
    const vgsm = normal ? vgs : vgs - vds;
    const vdsm = normal ? vds : -vds;
    const vbsm = normal ? vbs : vbs - vds;
    const ch = this.level1(vgsm, vdsm, vbsm);
    if (ctx.mode !== 'readout') this._von = ch.von;
    const bulkNode = tied ? S : BK;
    ctx.branch(X, Y, t, t * ch.id, [
      { p: G, n: Y, d: ch.gm, v0: vgsm },
      { p: X, n: Y, d: ch.gds, v0: vdsm },
      { p: bulkNode, n: Y, d: ch.gmbs, v0: vbsm },
    ]);
    // Bulk junctions (Level-1): bulk → d' and bulk → s'.
    const vbd = vbs - vds;
    if (!this.body) {
      const j = this.bd.evaluate(vbd, ctx.gmin);
      ctx.branch(bulkNode, DI, t, t * j.i, [{ p: bulkNode, n: DI, d: j.g, v0: vbd }]);
      if (this.bd.hasCharge) ctx.charge(3, bulkNode, DI, t, j.q, [{ p: bulkNode, n: DI, d: j.c, v0: vbd }]);
    } else {
      const j = this.body.evaluate(vbody, ctx.gmin);
      ctx.branch(bodyAnode, D, t, t * j.i, [{ p: bodyAnode, n: D, d: j.g, v0: vbody }]);
      if (this.body.hasCharge) ctx.charge(3, bodyAnode, D, t, j.q, [{ p: bodyAnode, n: D, d: j.c, v0: vbody }]);
    }
    {
      const j = this.bs.evaluate(vbs, ctx.gmin);
      ctx.branch(bulkNode, SI, t, t * j.i, [{ p: bulkNode, n: SI, d: j.g, v0: vbs }]);
      if (this.bs.hasCharge) ctx.charge(4, bulkNode, SI, t, j.q, [{ p: bulkNode, n: SI, d: j.c, v0: vbs }]);
    }
    // Constant gate capacitances (real-frame voltages: type = +1).
    const vg = ctx.v(G);
    if (cgs > 0) ctx.charge(0, G, SI, 1, cgs * (vg - ctx.v(SI)), [{ p: G, n: SI, d: cgs, v0: vg - ctx.v(SI) }]);
    if (cgd > 0) ctx.charge(1, G, DI, 1, cgd * (vg - ctx.v(DI)), [{ p: G, n: DI, d: cgd, v0: vg - ctx.v(DI) }]);
    if (cgb > 0) ctx.charge(2, G, bulkNode, 1, cgb * (vg - ctx.v(bulkNode)), [{ p: G, n: bulkNode, d: cgb, v0: vg - ctx.v(bulkNode) }]);
  }

  /** Plain-JSON netlist params: non-default values, bulkPin and the body diode when present. */
  describeParams(): Record<string, number | string | boolean | Record<string, number>> {
    return {
      ...describeValues(MOSFET_PARAMS, this.params as Record<string, number>),
      ...(this.bulkPin ? { bulkPin: true } : {}),
      ...(this.bodyDiode ? { bodyDiode: describeValues(DIODE_PARAMS, this.bodyDiode as Record<string, number>, ['Is', 'n']) } : {}),
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
    const n = this._core.nodes;
    n[D] = this.pin('d').node.index;
    n[G] = this.pin('g').node.index;
    n[S] = this.pin('s').node.index;
    n[BK] = this.bulkPin ? this.pin('b').node.index : n[S];
    let k = this._firstInternal;
    n[DI] = this.params.Rd > 0 ? k++ : n[D];
    n[SI] = this.params.Rs > 0 ? k++ : n[S];
    n[BX] = this.bodyRs > 0 ? k++ : n[BK];
  }

  stamp(_matrix: MNAMatrix): void {}

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

  private currents(I: ArrayLike<number>): { id: number; ig: number; is: number; ib: number } {
    if (this.bulkPin) return { id: I[D] + I[DI], ig: I[G], is: I[S] + I[SI], ib: I[BK] + I[BX] };
    return { id: I[D] + I[DI], ig: I[G], is: I[S] + I[SI] + I[BK] + I[BX], ib: 0 };
  }

  private quantitiesAt(x: ArrayLike<number>): Record<string, number> {
    this.refresh();
    const n = this._core.nodes;
    const v = (k: number) => (n[k] > 0 ? x[n[k] - 1] : 0);
    const c = this.currents(this._core.evaluateAt(x));
    const vd = v(D);
    const vg = v(G);
    const vs = v(S);
    const vb = v(BK);
    const q: Record<string, number> = {
      id: c.id,
      ig: c.ig,
      is: c.is,
      vgs: vg - vs,
      vds: vd - vs,
      vgd: vg - vd,
      vbs: vb - vs,
      p: vd * c.id + vg * c.ig + vs * c.is + (this.bulkPin ? vb * c.ib : 0),
      i: c.id,
      v: vd - vs,
    };
    if (this.bulkPin) q.ib = c.ib;
    return q;
  }

  readResults(solution: ArrayLike<number>, _matrix: MNAMatrix): { voltage: number; current: number } {
    const q = this.quantitiesAt(solution);
    return { voltage: q.vds, current: q.id };
  }

  setOperatingPoint(solution: ArrayLike<number>, _matrix: MNAMatrix): void {
    this._published = this.quantitiesAt(solution);
  }

  /** Drain-source voltage at the last published solution. */
  get voltage(): number {
    return this._published.vds ?? 0;
  }

  /** Drain current (into the drain pin) at the last published solution. */
  get current(): number {
    return this._published.id ?? 0;
  }

  /** Operating region at the last load (normalized frame). */
  get region(): Level1Point['region'] {
    const normal = this._vds >= 0;
    return this.level1(normal ? this._vgs : this._vgs - this._vds, Math.abs(this._vds), normal ? this._vbs : this._vbs - this._vds).region;
  }

  /**
   * Probe quantities ('M1.<q>'): id, ig, is (and ib with bulkPin) — currents
   * INTO each pin; vgs, vds, vgd, vbs; p — dissipated power; i = id, v = vds.
   */
  probeQuantities(): string[] {
    return ['id', 'ig', 'is', ...(this.bulkPin ? ['ib'] : []), 'vgs', 'vds', 'vgd', 'vbs', 'p', 'i', 'v'];
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
    const sum = (...ps: Phasor[]): Phasor => ps.reduce((a, b) => [a[0] + b[0], a[1] + b[1]], [0, 0] as Phasor);
    const I = this._core.acCurrents(re, im, omega);
    switch (name) {
      case 'id':
      case 'i':
        return sum(I[D], I[DI]);
      case 'ig':
        return I[G];
      case 'is':
        return this.bulkPin ? sum(I[S], I[SI]) : sum(I[S], I[SI], I[BK], I[BX]);
      case 'ib':
        return this.bulkPin ? sum(I[BK], I[BX]) : undefined;
      case 'vgs':
        return sub(vp(G), vp(S));
      case 'vds':
      case 'v':
        return sub(vp(D), vp(S));
      case 'vgd':
        return sub(vp(G), vp(D));
      case 'vbs':
        return sub(vp(BK), vp(S));
      default:
        return undefined;
    }
  }

  acReadResults(re: ArrayLike<number>, im: ArrayLike<number>, omega: number, _matrix: ComplexMNAMatrix): { voltage: Phasor; current: Phasor } {
    return { voltage: this.acQuantity('vds', re, im, omega)!, current: this.acQuantity('id', re, im, omega)! };
  }
}

function fromCard(card: string, expected: 'NMOS' | 'PMOS'): { params: MosfetParams | undefined; name: string | undefined; diagnostics: ModelDiagnostic[] } {
  const parsed = parseSpiceModel(card);
  const diagnostics = [...parsed.diagnostics];
  if (parsed.type && parsed.type !== expected && !diagnostics.some(d => d.code === 'T006')) {
    diagnostics.push({
      code: 'T006',
      severity: 'error',
      message: `.model ${parsed.name}: card type ${parsed.type} does not match ${expected}.fromModel — use ${
        parsed.type === 'NMOS' || parsed.type === 'PMOS' ? `${parsed.type}.fromModel` : "the matching device's fromModel"
      }`,
    });
  }
  const usable = !diagnostics.some(d => d.severity === 'error');
  return { params: usable ? (parsed.params as MosfetParams) : undefined, name: parsed.name || undefined, diagnostics };
}

/** Instance parameters accepted by fromModel (override the card). */
export type MosfetInstance = Pick<MosfetParams, 'W' | 'L' | 'bulkPin' | 'bodyDiode'>;

/** N-channel MOSFET: `new NMOS({ vto: 2, kp: '50m' })` or `Part('2N7000')`. */
export class NMOS extends MOSFET {
  override readonly kind: string = 'NMOS';
  constructor(params?: MosfetParams) {
    super(1, params, 'NMOS');
  }
  /** Build from a `.model <name> NMOS(...)` card; instance W/L/bulkPin/bodyDiode override it. */
  static fromModel(card: string, instance: MosfetInstance = {}): NMOS {
    const { params, name, diagnostics } = fromCard(card, 'NMOS');
    const m = new NMOS({ ...(params ?? {}), ...instance });
    m.modelName = name;
    m.modelDiagnostics = diagnostics;
    return m;
  }
}

/** P-channel MOSFET (enhancement: Vto < 0): `new PMOS({ vto: -2, kp: '20m' })` or `Part('IRF9540N')`. */
export class PMOS extends MOSFET {
  override readonly kind: string = 'PMOS';
  constructor(params?: MosfetParams) {
    super(-1, params, 'PMOS');
  }
  static fromModel(card: string, instance: MosfetInstance = {}): PMOS {
    const { params, name, diagnostics } = fromCard(card, 'PMOS');
    const m = new PMOS({ ...(params ?? {}), ...instance });
    m.modelName = name;
    m.modelDiagnostics = diagnostics;
    return m;
  }
}
