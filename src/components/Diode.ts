import { TwoTerminalComponent } from '../core/TwoTerminalComponent';
import type { MNAMatrix, ComplexMNAMatrix } from '../solver/MNAMatrix';
import type { AcLoadContext, AcceptContext, InitContext, LoadContext, Phasor } from '../analysis/context';
import { junctionVcrit, safeExp } from '../solver/limiting';
import { Junction } from './semi/junction';
import { SemiCore } from './semi/core';
import { DIODE_PARAMS, describeValues, normalizeParams } from './semi/params';
import { parseSpiceModel, type ModelDiagnostic } from './semi/spiceModel';

/**
 * Diode parameters (SPICE level 1). Names are case-insensitive and accept
 * unit strings ('0.5', '4p', '100n'); SPICE spellings work too (N, CJ0, PB, MJ).
 */
export interface DiodeParams {
  /** Saturation current (A). Default 1e-14. */
  Is?: number | string;
  /** Emission coefficient (ideality). Default 1. */
  n?: number | string;
  /** Thermal voltage (V). Default 0.02585. */
  Vt?: number | string;
  /** Series resistance (Ω), modeled with an internal node. Default 0. */
  Rs?: number | string;
  /** Zero-bias junction capacitance (F). Default 0. */
  Cjo?: number | string;
  /** Junction potential (V). Default 1. */
  Vj?: number | string;
  /** Grading coefficient. Default 0.5. */
  M?: number | string;
  /** Forward-bias depletion capacitance coefficient. Default 0.5. */
  Fc?: number | string;
  /** Transit time (s): diffusion charge Tt·Id. Default 0. */
  Tt?: number | string;
  /** Reverse breakdown voltage (V), e.g. a Zener's Vz. Default: none. */
  BV?: number | string;
  /** Reverse current at −BV (A), e.g. the Zener test current Izt. Default 1 mA. */
  IBV?: number | string;
  /** Breakdown emission coefficient. Default: n. */
  Nbv?: number | string;
  [key: string]: number | string | undefined;
}

/**
 * SPICE level-1 diode: Shockley current Is·(e^(V/(n·Vt)) − 1) with gmin in
 * parallel, optional series resistance Rs (internal node), depletion charge
 * (Cjo, Vj, M, Fc), diffusion charge Tt·Id and reverse breakdown (BV, IBV,
 * Nbv). Newton-Raphson uses pn-junction limiting on the forward exponential
 * and on the breakdown exponential.
 */
export class Diode extends TwoTerminalComponent {
  readonly kind: string = 'Diode';
  readonly Is: number;
  readonly n: number;
  readonly Vt: number;
  readonly Rs: number;
  readonly Cjo: number;
  readonly Vj: number;
  readonly M: number;
  readonly Fc: number;
  readonly Tt: number;
  /** Breakdown voltage (Infinity = no breakdown modeled). */
  readonly BV: number;
  readonly IBV: number;
  readonly Nbv: number;
  /** Catalog part id when built by Part(id). */
  partId?: string;
  /** Model name when built from a `.model` card. */
  modelName?: string;
  /** Problems found while parsing the `.model` card (reported by lint as T005–T008). */
  modelDiagnostics: ModelDiagnostic[] = [];

  /** @internal */
  readonly _junction: Junction;
  /** @internal junction voltage used by the last load (the linearization point) */
  _vd = 0;
  /** @internal small-signal conductance at the last load */
  _gd = 0;
  /** @internal small-signal capacitance at the last load */
  _cd = 0;
  private readonly _values: Record<string, number>;
  private readonly _core: SemiCore;
  private _internal = -1;
  private _published = { v: 0, i: 0 };

  constructor(params?: DiodeParams) {
    super();
    const { values } = normalizeParams('Diode', DIODE_PARAMS, params);
    this._values = values;
    this.Is = values.Is;
    this.n = values.n;
    this.Vt = values.Vt;
    this.Rs = values.Rs;
    this.Cjo = values.Cjo;
    this.Vj = values.Vj;
    this.M = values.M;
    this.Fc = values.Fc;
    this.Tt = values.Tt;
    this.BV = values.BV;
    this.IBV = values.IBV;
    this.Nbv = Number.isNaN(values.Nbv) ? values.n : values.Nbv;
    this._junction = new Junction({
      Is: this.Is,
      n: this.n,
      Vt: this.Vt,
      Cjo: this.Cjo,
      Vj: this.Vj,
      M: this.M,
      Fc: this.Fc,
      Tt: this.Tt,
      BV: this.BV,
      IBV: this.IBV,
      Nbv: this.Nbv,
    });

    // Named pin aliases: anode = pin 1, cathode = pin 2
    this.pins.set('anode', this.pin('1'));
    this.pins.set('cathode', this.pin('2'));

    // Local nodes: 0 anode pin, 1 cathode pin, 2 junction anode (internal when Rs > 0).
    const junction = this._junction;
    this._core = new SemiCore(this, 3, junction.hasCharge ? 1 : 0, ctx => {
      let vd = ctx.v(2) - ctx.v(1);
      if (ctx.mode !== 'readout') {
        if (ctx.init === 'junction') {
          vd = junction.vcrit;
        } else if (ctx.limiting) {
          const lim = junction.limit(vd, this._vd);
          if (lim.limited) {
            vd = lim.value;
            ctx.limited();
          }
        }
        this._vd = vd;
      }
      const e = junction.evaluate(vd, ctx.gmin);
      if (ctx.mode !== 'readout') {
        this._gd = e.g;
        this._cd = e.c;
      }
      ctx.branch(2, 1, 1, e.i, [{ p: 2, n: 1, d: e.g, v0: vd }]);
      if (junction.hasCharge) ctx.charge(0, 2, 1, 1, e.q, [{ p: 2, n: 1, d: e.c, v0: vd }]);
    });
    this._core.addResistor(0, 2, this.Rs);
  }

  /**
   * Build a diode from a SPICE `.model` card (type D). Never throws on card
   * problems: unknown parameters (T005), unsupported levels/types (T006),
   * malformed values (T007) and unmodeled SPICE parameters (T008) are
   * recorded in `modelDiagnostics` and reported by the lint stage.
   */
  static fromModel(card: string): Diode {
    const { params, name, diagnostics } = readDiodeCard(card);
    const d = new Diode(params);
    d.modelName = name;
    d.modelDiagnostics = diagnostics;
    return d;
  }

  get anode() { return this.pin('1'); }
  get cathode() { return this.pin('2'); }

  isNonlinear(): boolean {
    return true;
  }

  /** Critical voltage of the junction (where pnjlim starts limiting). */
  get vcrit(): number {
    return junctionVcrit(this.n * this.Vt, this.Is);
  }

  getOperatingVoltage(): number {
    return this._vd;
  }

  /** Junction current at junction voltage vd (forward exponential and breakdown, no gmin). */
  computeDiodeCurrent(vd: number): number {
    if (!this._junction.hasBreakdown) {
      const nVt = this.n * this.Vt;
      return this.Is * (safeExp(vd / nVt) - 1);
    }
    return this._junction.current(vd, 0).i;
  }

  /** Plain-JSON netlist params: Is, n, Vt always, every other parameter when it differs from its default. */
  describeParams(): Record<string, number | string> {
    return {
      ...describeValues(DIODE_PARAMS, this._values, ['Is', 'n', 'Vt']),
      ...(this.modelName ? { model: this.modelName } : {}),
      ...(this.partId ? { part: this.partId } : {}),
    };
  }

  /** @internal resolved parameter values (canonical names) */
  get _paramValues(): Readonly<Record<string, number>> {
    return this._values;
  }

  // --- internal node ---

  getInternalNodeCount(): number {
    return this.Rs > 0 ? 1 : 0;
  }

  assignInternalNodes(first: number): void {
    this._internal = first;
  }

  private refresh(): void {
    const nodes = this._core.nodes;
    nodes[0] = this._n1Index;
    nodes[1] = this._n2Index;
    nodes[2] = this.Rs > 0 ? this._internal : nodes[0];
  }

  /** Legacy stamp: linearized at the last junction voltage. */
  stamp(matrix: MNAMatrix): void {
    const e = this._junction.evaluate(this._vd, 1e-12);
    const ieq = e.i - e.g * this._vd;
    matrix.stampConductance(this._n1Index, this._n2Index, e.g);
    matrix.stampCurrentSource(this._n1Index, this._n2Index, -ieq);
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

  /** Small-signal: junction conductance + jω(Cj + Tt·gd) at the operating point, Rs in series. */
  acLoad(ctx: AcLoadContext): void {
    this.refresh();
    this._core.acLoad(ctx);
  }

  acReadResults(re: ArrayLike<number>, im: ArrayLike<number>, omega: number, _matrix?: ComplexMNAMatrix): { voltage: Phasor; current: Phasor } {
    this.refresh();
    const v = this.acVoltage(re, im);
    return { voltage: v, current: this._core.acCurrents(re, im, omega)[2] };
  }

  readResults(solution: ArrayLike<number>, matrix: MNAMatrix): { voltage: number; current: number } {
    this.refresh();
    const v1 = matrix.getNodeVoltage(solution, this._n1Index);
    const v2 = matrix.getNodeVoltage(solution, this._n2Index);
    const voltage = v1 - v2;
    const current = this._core.evaluateAt(solution)[2];
    return { voltage, current };
  }

  setOperatingPoint(solution: ArrayLike<number>, matrix: MNAMatrix): void {
    const r = this.readResults(solution, matrix);
    this._published = { v: r.voltage, i: r.current };
  }

  // --- probe quantities ---

  /** Probe quantities: '.i' (anode → cathode), '.v' (V(anode) − V(cathode)), '.p' (dissipated power v·i). */
  probeQuantities(): string[] {
    return ['i', 'v', 'p'];
  }

  /** Quantity at the last published solution (operating point). */
  quantity(name: string): number | undefined {
    const { v, i } = this._published;
    return name === 'i' ? i : name === 'v' ? v : name === 'p' ? v * i : undefined;
  }

  /** Quantity from a solution vector (transient samples, sweep points). */
  readQuantity(name: string, x: ArrayLike<number>, matrix: MNAMatrix): number | undefined {
    const r = this.readResults(x, matrix);
    return name === 'i' ? r.current : name === 'v' ? r.voltage : name === 'p' ? r.voltage * r.current : undefined;
  }

  /** Small-signal phasor of a quantity ('i', 'v'). */
  acQuantity(name: string, re: ArrayLike<number>, im: ArrayLike<number>, omega: number): Phasor | undefined {
    const r = this.acReadResults(re, im, omega);
    return name === 'i' ? r.current : name === 'v' ? r.voltage : undefined;
  }
}

/**
 * Parse a diode `.model` card. When the card has errors (T006/T007) the
 * params are undefined: the device is built with defaults and the lint stage
 * stops the run before anything is simulated.
 */
export function readDiodeCard(card: string): { params: DiodeParams | undefined; name: string | undefined; diagnostics: ModelDiagnostic[] } {
  const parsed = parseSpiceModel(card);
  const diagnostics = [...parsed.diagnostics];
  if (parsed.type && parsed.type !== 'D' && !diagnostics.some(d => d.code === 'T006')) {
    diagnostics.push({
      code: 'T006',
      severity: 'error',
      message: `.model ${parsed.name}: card type ${parsed.type} is not a diode (D) — use the matching device's fromModel`,
    });
  }
  const usable = !diagnostics.some(d => d.severity === 'error');
  return { params: usable ? (parsed.params as DiodeParams) : undefined, name: parsed.name || undefined, diagnostics };
}
