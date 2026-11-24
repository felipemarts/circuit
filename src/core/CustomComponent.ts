import { Component } from './Component';
import { MNAMatrix } from '../solver/MNAMatrix';
import { ReactiveState } from '../analysis/integration';
import { IC_CONDUCTANCE } from '../components/Capacitor';
import type {
  AcLoadContext,
  AcceptContext,
  InitContext,
  LoadContext,
  StepContext,
} from '../analysis/context';

export interface ComponentDef {
  name: string;
  pins: string[];
  params?: Record<string, { default: number; unit?: string }>;

  // Simulation
  stamp: (ctx: StampContext) => void;

  // Transient (optional)
  setup?: (state: Record<string, number>) => void;
  /**
   * Runs once per transient step attempt (and at t = 0), before stamping.
   * `ctx.state` changes made here are rolled back if the step is rejected, so
   * a retried step always starts from the last accepted state.
   */
  onStep?: (ctx: StampContext, dt: number) => void;

  // Nonlinear (optional)
  nonlinear?: boolean;

  /** Number of branch-current unknowns (for `stampVoltageSource`, index 0..branches-1). */
  branches?: number;

  /**
   * Small-signal model for AC analysis, linearized around the DC operating
   * point (`ctx.voltage(pin)` returns operating-point voltages). Without it,
   * an AC analysis of a circuit containing this component reports S204.
   */
  ac?: (ctx: AcStampContext) => void;

  // Visual rendering
  draw?: (ctx: CanvasRenderingContext2D, w: number, h: number) => void;
  label?: string;
  pinLayout?: Record<string, { dx: number; dy: number }>;
}

export interface StampContext {
  stampResistance(pin1: string, pin2: string, R: number): void;
  stampConductance(pin1: string, pin2: string, g: number): void;
  /** Ideal voltage source on branch `branch` (0..def.branches-1). */
  stampVoltageSource(pinPlus: string, pinMinus: string, branch: number, v: number): void;
  stampCurrentSource(pinPlus: string, pinMinus: string, i: number): void;
  /**
   * Linear capacitor between two pins. Open at DC; in transient it is
   * integrated by the engine exactly like a built-in Capacitor (trapezoidal
   * or BE, truncation-error step control, initial conditions); jωC in AC.
   * Call it the same number of times, in the same order, on every stamp.
   */
  stampCapacitance(pin1: string, pin2: string, C: number): void;
  /** Report that the component clamped its controlling voltage this iteration (blocks convergence). */
  limited(): void;

  voltage(pin: string): number;

  params: Record<string, number>;
  state: Record<string, number>;
  time: number;
  dt: number;
  /** 'dc' (operating point, DC sweep) or 'tran'. */
  mode: 'dc' | 'tran';

  // Raw access for advanced users
  matrix: MNAMatrix;
  nodeIndex(pin: string): number;
}

export interface AcStampContext {
  /** Angular frequency ω = 2πf. */
  omega: number;
  frequency: number;
  stampConductance(pin1: string, pin2: string, g: number): void;
  stampResistance(pin1: string, pin2: string, R: number): void;
  stampCapacitance(pin1: string, pin2: string, C: number): void;
  /** Complex admittance re + j·im between two pins. */
  stampAdmittance(pin1: string, pin2: string, re: number, im: number): void;
  /** gm·(V(inP) − V(inN)) flows out of outP through the device into outN. */
  stampTransconductance(outP: string, outN: string, inP: string, inN: string, gm: number): void;
  /** Operating-point voltage of a pin. */
  voltage(pin: string): number;
  params: Record<string, number>;
  state: Record<string, number>;
}

interface CapSlot {
  state: ReactiveState;
  p1: string;
  p2: string;
  C: number;
}

export class CustomComponent extends Component {
  readonly kind: string;
  readonly _def: ComponentDef;
  readonly _params: Record<string, number>;
  readonly _state: Record<string, number> = {};
  private _committed: Record<string, number> = {};
  private _time = 0;
  private _dt = 0;
  private _transient = false;
  private _lastSolution: ArrayLike<number> | null = null;
  private _lastMatrix: MNAMatrix | null = null;
  private _vsBase = -1;
  private _caps: CapSlot[] = [];

  constructor(def: ComponentDef, params?: Record<string, number>) {
    super();
    this.kind = def.name;
    this._def = def;

    // Create pins
    for (const pinName of def.pins) {
      this.addPin(pinName);
    }

    // Merge default params with user-provided params
    this._params = {};
    if (def.params) {
      for (const [key, spec] of Object.entries(def.params)) {
        this._params[key] = params?.[key] ?? spec.default;
      }
    }
    // Also copy any extra params not in defaults
    if (params) {
      for (const [key, val] of Object.entries(params)) {
        if (!(key in this._params)) {
          this._params[key] = val;
        }
      }
    }

    // Initialize state
    if (def.setup) {
      def.setup(this._state);
    }
    this._committed = { ...this._state };
  }

  // Make addPin public for CustomComponent
  public addPin(name: string) {
    return super.addPin(name);
  }

  private _nodeVoltage(pin: string): number {
    if (this._lastSolution && this._lastMatrix) {
      return this._lastMatrix.getNodeVoltage(this._lastSolution, this.pin(pin).node.index);
    }
    return 0;
  }

  private _createStampContext(matrix: MNAMatrix, load?: LoadContext): StampContext {
    const self = this;
    let capIndex = 0;
    return {
      stampResistance(pin1: string, pin2: string, R: number) {
        if (R <= 0) return;
        matrix.stampConductance(self.pin(pin1).node.index, self.pin(pin2).node.index, 1 / R);
      },
      stampConductance(pin1: string, pin2: string, g: number) {
        matrix.stampConductance(self.pin(pin1).node.index, self.pin(pin2).node.index, g);
      },
      stampVoltageSource(pinPlus: string, pinMinus: string, branch: number, v: number) {
        const count = self._def.branches ?? 0;
        if (!(branch >= 0 && branch < count)) {
          throw new Error(
            `${self.kind}: stampVoltageSource branch ${branch} out of range — declare branches: ${branch + 1} (or more) in defineComponent`,
          );
        }
        matrix.stampVoltageSource(
          self.pin(pinPlus).node.index,
          self.pin(pinMinus).node.index,
          self._vsBase + branch,
          v * (load?.srcFactor ?? 1),
        );
      },
      stampCurrentSource(pinPlus: string, pinMinus: string, i: number) {
        matrix.stampCurrentSource(self.pin(pinPlus).node.index, self.pin(pinMinus).node.index, i);
      },
      stampCapacitance(pin1: string, pin2: string, C: number) {
        const k = capIndex++;
        let slot = self._caps[k];
        if (!slot) {
          const created: CapSlot = { state: new ReactiveState(self, 1e-12, 1e-14), p1: pin1, p2: pin2, C };
          created.state.evaluate = x => {
            const a = self.pin(created.p1).node.index;
            const b = self.pin(created.p2).node.index;
            return created.C * ((a > 0 ? x[a - 1] : 0) - (b > 0 ? x[b - 1] : 0));
          };
          slot = created;
          self._caps[k] = slot;
        }
        slot.p1 = pin1;
        slot.p2 = pin2;
        slot.C = C;
        if (!load || load.mode !== 'tran' || !(C > 0)) return; // open at DC
        const n1 = self.pin(pin1).node.index;
        const n2 = self.pin(pin2).node.index;
        if (load.initial) {
          const vic = slot.state.hx[0] / C;
          matrix.stampConductance(n1, n2, IC_CONDUCTANCE);
          matrix.stampCurrentSource(n1, n2, IC_CONDUCTANCE * vic);
          return;
        }
        const v = load.v(n1) - load.v(n2);
        const { derivative, coeff } = load.integrate(slot.state, C * v);
        const geq = coeff * C;
        matrix.stampConductance(n1, n2, geq);
        matrix.stampCurrentSource(n1, n2, -(derivative - geq * v));
      },
      limited() {
        load?.limited();
      },
      voltage(pin: string): number {
        if (load) return load.v(self.pin(pin).node.index);
        return self._nodeVoltage(pin);
      },
      params: self._params,
      state: self._state,
      time: self._time,
      dt: self._dt,
      mode: load?.mode ?? (self._transient ? 'tran' : 'dc'),
      matrix,
      nodeIndex(pin: string): number {
        return self.pin(pin).node.index;
      },
    };
  }

  stamp(matrix: MNAMatrix): void {
    this._def.stamp(this._createStampContext(matrix));
  }

  load(ctx: LoadContext): void {
    this._transient = ctx.mode === 'tran';
    if (ctx.mode === 'dc') {
      this._time = 0;
      this._dt = 0;
    }
    this._def.stamp(this._createStampContext(ctx.matrix, ctx));
  }

  isNonlinear(): boolean {
    return this._def.nonlinear ?? false;
  }

  getVSourceCount(): number {
    return this._def.branches ?? 0;
  }

  assignVSourceIndices(startIndex: number): void {
    this._vsBase = startIndex;
  }

  setTime(t: number): void {
    this._time = t;
  }

  beginStep(ctx: StepContext): void {
    // Roll back to the last accepted state, then run the per-step program.
    for (const key of Object.keys(this._state)) {
      if (!(key in this._committed)) delete this._state[key];
    }
    Object.assign(this._state, this._committed);
    this._transient = true;
    this._time = ctx.time;
    this._dt = ctx.h;
    if (this._def.onStep) {
      const matrix = this._lastMatrix ?? new MNAMatrix(1, 0);
      this._def.onStep(this._createStampContext(matrix), ctx.h);
    }
  }

  initTransient(ctx: InitContext): void {
    for (const slot of this._caps) {
      const v = ctx.v(this.pin(slot.p1).node.index) - ctx.v(this.pin(slot.p2).node.index);
      if (ctx.fromOp) ctx.setState(slot.state, slot.C * v, 0);
      else ctx.setState(slot.state, slot.state.hx[0], IC_CONDUCTANCE * (v - slot.state.hx[0] / slot.C));
    }
    this._lastSolution = ctx.x;
    this._lastMatrix = ctx.matrix;
    this._committed = { ...this._state };
  }

  acceptStep(ctx: AcceptContext): void {
    this._lastSolution = ctx.x;
    this._lastMatrix = ctx.matrix;
    this._committed = { ...this._state };
  }

  rejectStep(): void {
    for (const key of Object.keys(this._state)) {
      if (!(key in this._committed)) delete this._state[key];
    }
    Object.assign(this._state, this._committed);
  }

  /** @deprecated kept for API compatibility; the engine passes the iterate through load(ctx). */
  updateState(solution: ArrayLike<number>, matrix: MNAMatrix): void {
    this._lastSolution = solution;
    this._lastMatrix = matrix;
  }

  /** @deprecated kept for API compatibility. */
  setOperatingPoint(solution: ArrayLike<number>, matrix: MNAMatrix): void {
    this._lastSolution = solution;
    this._lastMatrix = matrix;
  }

  getOperatingVoltage(): number {
    // Voltage across the first two pins at the last solution
    if (this._lastSolution && this._lastMatrix && this._def.pins.length >= 2) {
      return this._nodeVoltage(this._def.pins[0]) - this._nodeVoltage(this._def.pins[1]);
    }
    return 0;
  }

  resetToDC(): void {
    this._transient = false;
    this._time = 0;
    this._dt = 0;
    for (const slot of this._caps) slot.state.seed(0, 0);
  }

  hasAcModel(): boolean {
    return typeof this._def.ac === 'function';
  }

  acLoad(ctx: AcLoadContext): void {
    if (!this._def.ac) return;
    const self = this;
    const node = (pin: string) => self.pin(pin).node.index;
    const m = ctx.matrix;
    this._def.ac({
      omega: ctx.omega,
      frequency: ctx.frequency,
      stampConductance(a, b, g) {
        m.stampAdmittance(node(a), node(b), g, 0);
      },
      stampResistance(a, b, R) {
        if (R > 0) m.stampAdmittance(node(a), node(b), 1 / R, 0);
      },
      stampCapacitance(a, b, C) {
        m.stampAdmittance(node(a), node(b), 0, ctx.omega * C);
      },
      stampAdmittance(a, b, re, im) {
        m.stampAdmittance(node(a), node(b), re, im);
      },
      stampTransconductance(outP, outN, inP, inN, gm) {
        m.stampTransconductance(node(outP), node(outN), node(inP), node(inN), gm);
      },
      voltage: (pin: string) => self._nodeVoltage(pin),
      params: self._params,
      state: self._state,
    });
  }

  /** Remember the operating point (for AC `voltage(pin)` and legacy readers). */
  setSolution(solution: ArrayLike<number>, matrix: MNAMatrix): void {
    this._lastSolution = solution;
    this._lastMatrix = matrix;
  }

  readResults(solution: ArrayLike<number>, matrix: MNAMatrix): { voltage: number; current: number } | null {
    this._lastSolution = solution;
    this._lastMatrix = matrix;
    if (this._def.pins.length >= 2) {
      const v1 = matrix.getNodeVoltage(solution, this.pin(this._def.pins[0]).node.index);
      const v2 = matrix.getNodeVoltage(solution, this.pin(this._def.pins[1]).node.index);
      return { voltage: v1 - v2, current: 0 };
    }
    return null;
  }
}

/**
 * Define a custom component type.
 * Returns a constructor function that creates CustomComponent instances.
 */
export function defineComponent(def: ComponentDef): {
  new (params?: Record<string, number>): CustomComponent;
  _componentDef: ComponentDef;
} {
  const ComponentClass = class extends CustomComponent {
    static _componentDef = def;
    constructor(params?: Record<string, number>) {
      super(def, params);
    }
  };

  // Set a readable name for debugging
  Object.defineProperty(ComponentClass, 'name', { value: def.name });

  return ComponentClass;
}
