import { Component } from './Component';
import { MNAMatrix } from '../solver/MNAMatrix';

export interface ComponentDef {
  name: string;
  pins: string[];
  params?: Record<string, { default: number; unit?: string }>;

  // Simulation
  stamp: (ctx: StampContext) => void;

  // Transient (optional)
  setup?: (state: Record<string, number>) => void;
  onStep?: (ctx: StampContext, dt: number) => void;

  // Nonlinear (optional)
  nonlinear?: boolean;

  // Visual rendering
  draw?: (ctx: CanvasRenderingContext2D, w: number, h: number) => void;
  label?: string;
  pinLayout?: Record<string, { dx: number; dy: number }>;
}

export interface StampContext {
  stampResistance(pin1: string, pin2: string, R: number): void;
  stampConductance(pin1: string, pin2: string, g: number): void;
  stampVoltageSource(pinPlus: string, pinMinus: string, vsIdx: number, v: number): void;
  stampCurrentSource(pinPlus: string, pinMinus: string, i: number): void;

  voltage(pin: string): number;

  params: Record<string, number>;
  state: Record<string, number>;
  time: number;
  dt: number;

  // Raw access for advanced users
  matrix: MNAMatrix;
  nodeIndex(pin: string): number;
}

export class CustomComponent extends Component {
  readonly kind: string;
  readonly _def: ComponentDef;
  readonly _params: Record<string, number>;
  readonly _state: Record<string, number> = {};
  private _time = 0;
  private _dt = 0;
  private _transient = false;
  private _lastSolution: number[] | null = null;
  private _lastMatrix: MNAMatrix | null = null;

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
  }

  // Make addPin public for CustomComponent
  public addPin(name: string) {
    return super.addPin(name);
  }

  private _createStampContext(matrix: MNAMatrix): StampContext {
    const self = this;
    return {
      stampResistance(pin1: string, pin2: string, R: number) {
        if (R <= 0) return;
        matrix.stampConductance(
          self.pin(pin1).node.index,
          self.pin(pin2).node.index,
          1 / R,
        );
      },
      stampConductance(pin1: string, pin2: string, g: number) {
        matrix.stampConductance(
          self.pin(pin1).node.index,
          self.pin(pin2).node.index,
          g,
        );
      },
      stampVoltageSource(pinPlus: string, pinMinus: string, vsIdx: number, v: number) {
        matrix.stampVoltageSource(
          self.pin(pinPlus).node.index,
          self.pin(pinMinus).node.index,
          vsIdx,
          v,
        );
      },
      stampCurrentSource(pinPlus: string, pinMinus: string, i: number) {
        matrix.stampCurrentSource(
          self.pin(pinPlus).node.index,
          self.pin(pinMinus).node.index,
          i,
        );
      },
      voltage(pin: string): number {
        if (self._lastSolution && self._lastMatrix) {
          const nodeIdx = self.pin(pin).node.index;
          return self._lastMatrix.getNodeVoltage(self._lastSolution, nodeIdx);
        }
        return 0;
      },
      params: self._params,
      state: self._state,
      time: self._time,
      dt: self._dt,
      matrix,
      nodeIndex(pin: string): number {
        return self.pin(pin).node.index;
      },
    };
  }

  stamp(matrix: MNAMatrix): void {
    const ctx = this._createStampContext(matrix);
    if (this._transient && this._def.onStep) {
      this._def.onStep(ctx, this._dt);
    }
    this._def.stamp(ctx);
  }

  isNonlinear(): boolean {
    return this._def.nonlinear ?? false;
  }

  setTime(t: number): void {
    this._time = t;
  }

  prepareTransientStep(dt: number): void {
    if (dt === 0) {
      this._transient = true;
      return;
    }
    this._dt = dt;
  }

  updateState(solution: number[], matrix: MNAMatrix): void {
    this._lastSolution = solution;
    this._lastMatrix = matrix;
  }

  setOperatingPoint(solution: number[], matrix: MNAMatrix): void {
    this._lastSolution = solution;
    this._lastMatrix = matrix;
  }

  getOperatingVoltage(): number {
    // For convergence check: return voltage across first two pins
    if (this._lastSolution && this._lastMatrix && this._def.pins.length >= 2) {
      const v1 = this._lastMatrix.getNodeVoltage(this._lastSolution, this.pin(this._def.pins[0]).node.index);
      const v2 = this._lastMatrix.getNodeVoltage(this._lastSolution, this.pin(this._def.pins[1]).node.index);
      return v1 - v2;
    }
    return 0;
  }

  resetToDC(): void {
    this._transient = false;
    this._time = 0;
    this._dt = 0;
  }

  readResults(solution: number[], matrix: MNAMatrix): { voltage: number; current: number } | null {
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
