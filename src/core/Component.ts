import { Pin } from './Pin';
import type { MNAMatrix, ComplexMNAMatrix } from '../solver/MNAMatrix';
import type {
  AcLoadContext,
  AcceptContext,
  InitContext,
  LoadContext,
  Phasor,
  StepContext,
} from '../analysis/context';

/**
 * Base class of every circuit element.
 *
 * The analysis engine talks to devices through the protocol below. Only
 * `stamp(matrix)` is abstract: a component that implements nothing else is a
 * linear, memoryless DC element (that is how the visual editor's junction
 * markers work). Built-in devices implement `load(ctx)`, which sees the
 * Newton iterate, the analysis mode and the integration step.
 */
export abstract class Component {
  protected readonly pins: Map<string, Pin> = new Map();

  protected addPin(name: string): Pin {
    const pin = new Pin(this, name);
    this.pins.set(name, pin);
    return pin;
  }

  pin(name: string | number): Pin {
    const key = String(name);
    const p = this.pins.get(key);
    if (!p) {
      throw new Error(`Component has no pin "${key}". Available: ${[...this.pins.keys()].join(', ')}`);
    }
    return p;
  }

  allPins(): Pin[] {
    return [...this.pins.values()];
  }

  /**
   * All (name, pin) entries in registration order, including aliases
   * ('+'/'-', 'anode'/'cathode') that point at the same Pin object.
   */
  pinEntries(): [string, Pin][] {
    return [...this.pins.entries()];
  }

  /** Legacy stamping entry point: the DC/linear stamp of the element. */
  abstract stamp(matrix: MNAMatrix): void;

  /**
   * Stamp the element for one Newton iteration. The default forwards to the
   * legacy `stamp(matrix)` (after `setTime`), so stamp-only components keep
   * working in every analysis.
   */
  load(ctx: LoadContext): void {
    this.setTime(ctx.time);
    this.stamp(ctx.matrix);
  }

  isNonlinear(): boolean {
    return false;
  }

  // --- Branch unknowns (voltage sources, inductors) ---

  getVSourceCount(): number { return 0; }

  assignVSourceIndices(_startIndex: number): void {}

  // --- Transient protocol ---

  /** Next source corner strictly after `t` that the stepper must land on (Infinity: none). */
  nextBreakpoint(_t: number): number { return Infinity; }

  /** Largest step this element tolerates (e.g. a sine needs ≥ 25 points per period). */
  maxStepHint(): number { return Infinity; }

  /** Seed reactive states after the t = 0 solve. */
  initTransient(_ctx: InitContext): void {}

  /** Called once per step attempt before Newton (custom components run `onStep` here). */
  beginStep(_ctx: StepContext): void {}

  /** The step was accepted: commit per-step state. */
  acceptStep(_ctx: AcceptContext): void {}

  /** The step was rejected (Newton failure or truncation error): discard per-step state. */
  rejectStep(): void {}

  setTime(_t: number): void {}

  resetToDC(): void {}

  // --- AC small-signal protocol ---

  /** Whether this element provides a small-signal model (`acLoad`). */
  hasAcModel(): boolean { return false; }

  /** Stamp the small-signal admittances around the last DC operating point. */
  acLoad(_ctx: AcLoadContext): void {}

  /** Small-signal voltage across / current through the element, for AC probes. */
  acReadResults(_re: ArrayLike<number>, _im: ArrayLike<number>, _omega: number, _matrix: ComplexMNAMatrix): { voltage: Phasor; current: Phasor | null } | null {
    return null;
  }

  // --- Results ---

  readResults(_solution: ArrayLike<number>, _matrix: MNAMatrix): { voltage: number; current: number } | null { return null; }

  /** @internal Called by the solver after analysis with the readResults values */
  _setResults(_voltage: number, _current: number): void {}

  // --- Deprecated no-ops kept for API compatibility (pre-0.2 protocol) ---

  /** @deprecated superseded by beginStep/load; never called by the engine. */
  prepareTransientStep(_dt: number): void {}

  /** @deprecated superseded by acceptStep; never called by the engine. */
  updateState(_solution: ArrayLike<number>, _matrix: MNAMatrix): void {}

  /** @deprecated superseded by load(ctx); never called by the engine. */
  setOperatingPoint(_solution: ArrayLike<number>, _matrix: MNAMatrix): void {}

  /** @deprecated never called by the engine. */
  getOperatingVoltage(): number { return 0; }
}
