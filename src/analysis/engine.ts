import type { Circuit } from '../core/Circuit';
import type { Component } from '../core/Component';
import type { Node } from '../core/Node';
import { MNAMatrix, ComplexMNAMatrix } from '../solver/MNAMatrix';
import { luSolveInPlace, complexLuSolveInPlace, SingularMatrixError } from '../solver/LUSolver';
import { ReactiveState, integrateStep, lteRatio } from './integration';
import type { AcceptContext, InitContext, LoadContext } from './context';

/**
 * The analysis engine: one indexed MNA system per circuit, shared by the
 * operating point, DC sweep, AC and transient analyses.
 *
 * Unknown ordering is deterministic: when the circuit carries an ordering
 * (bench elaboration sets one — components by id, nets by name), matrix rows
 * follow it, so the same netlist always produces the same matrix and the
 * same floating-point results regardless of declaration order.
 */

// ─── Tolerances ──────────────────────────────────────────────────────────────

export const NEWTON_RELTOL = 1e-6;
export const NEWTON_VNTOL = 1e-9;
export const NEWTON_ABSTOL = 1e-12;
export const DC_MAX_ITERATIONS = 100;
export const TRAN_MAX_ITERATIONS = 50;
/** Conductance floor in parallel with every junction (SPICE GMIN). */
export const GMIN = 1e-12;

// ─── Errors & telemetry ──────────────────────────────────────────────────────

export interface WorstDevice {
  component: Component;
  /** |V(new iterate) − V(previous iterate)| on the last iteration. */
  deltaV: number;
  /** Device voltages over the last iterations (oldest first). */
  history: number[];
}

export type Strategy = 'newton' | 'gmin-stepping' | 'source-stepping';

export interface AttemptTelemetry {
  strategy: Strategy;
  iterations: number;
  converged: boolean;
  /** Continuation steps taken (gmin decades / source fractions). */
  steps?: number;
}

/** Telemetry captured when Newton-Raphson fails, so callers can name a culprit. */
export interface NRTelemetry {
  iterations: number;
  /** Component with the largest voltage delta on the final iteration. */
  worst: WorstDevice | null;
  /** Every strategy tried, in order (DC operating point). */
  attempts?: AttemptTelemetry[];
  /** Simulation time of the failing step (transient). */
  time?: number;
  /** Step size at which Newton finally gave up (transient). */
  step?: number;
  /** Why the last attempt failed. */
  reason?: 'nonconvergence' | 'singular' | 'non-finite';
}

export class ConvergenceError extends Error {
  readonly telemetry: NRTelemetry;

  constructor(message: string, telemetry: NRTelemetry) {
    super(message);
    this.name = 'ConvergenceError';
    this.telemetry = telemetry;
  }
}

/** The transient step was cut below the minimum by the truncation-error control. */
export class TimestepTooSmallError extends Error {
  readonly time: number;
  readonly step: number;
  readonly minStep: number;
  readonly culprit: Component | null;
  constructor(time: number, step: number, minStep: number, culprit: Component | null) {
    super(`timestep too small at t=${time}: step ${step} < minimum ${minStep}`);
    this.name = 'TimestepTooSmallError';
    this.time = time;
    this.step = step;
    this.minStep = minStep;
    this.culprit = culprit;
  }
}

/** A component in the circuit has no small-signal model. */
export class NoAcModelError extends Error {
  readonly components: Component[];
  constructor(components: Component[]) {
    super(`${components.length} component(s) have no AC small-signal model`);
    this.name = 'NoAcModelError';
    this.components = components;
  }
}

export interface OpTelemetry {
  method: 'linear' | 'newton-raphson';
  iterations: number;
  /** Convergence aids that had to be used (empty/absent when plain Newton converged). */
  aids?: Exclude<Strategy, 'newton'>[];
  attempts?: AttemptTelemetry[];
}

export interface NewtonParams {
  mode: 'dc' | 'tran';
  initial: boolean;
  time: number;
  h: number;
  method: 'be' | 'trap';
  srcFactor: number;
  gshunt: number;
  init: 'junction' | 'guess' | 'none';
  x0: Float64Array;
  maxIterations: number;
}

export interface NewtonResult {
  ok: boolean;
  x: Float64Array;
  iterations: number;
  reason?: 'nonconvergence' | 'singular' | 'non-finite';
  worst: WorstDevice | null;
}

const HISTORY_LENGTH = 8;

/** Optional deterministic ordering, keyed by stable names. */
export interface CircuitOrdering {
  componentKey: Map<Component, string>;
  nodeKey: Map<Node, string>;
}

function sortByKey<T>(items: T[], keys: Map<T, string> | undefined): T[] {
  if (!keys || keys.size === 0) return items;
  const indexed = items.map((item, i) => ({ item, i, key: keys.get(item) }));
  indexed.sort((a, b) => {
    if (a.key !== undefined && b.key !== undefined) return a.key < b.key ? -1 : a.key > b.key ? 1 : a.i - b.i;
    if (a.key !== undefined) return -1;
    if (b.key !== undefined) return 1;
    return a.i - b.i;
  });
  return indexed.map(e => e.item);
}

// ─── The system ──────────────────────────────────────────────────────────────

export class SimulationSystem {
  readonly components: Component[];
  readonly nonlinear: Component[];
  /** All nodes, ground first, then in index order. */
  readonly nodes: Node[];
  readonly nodeCount: number;
  readonly branchCount: number;
  readonly size: number;
  readonly matrix: MNAMatrix;
  readonly linear: boolean;
  /** Last operating-point solution (for AC). */
  opSolution: Float64Array | null = null;

  private stamp = 0;
  private touched: ReactiveState[] = [];
  private work: Float64Array[];
  private released = false;

  constructor(circuit: Circuit) {
    const { components, nodes } = circuit._discoverComponents();
    if (components.length === 0) throw new Error('No components connected to ground');
    const ordering = circuit._ordering;
    this.components = sortByKey(components, ordering?.componentKey);
    const ground = circuit.ground.node;
    const others = sortByKey(
      nodes.filter(n => n !== ground),
      ordering?.nodeKey,
    );
    ground.index = 0;
    others.forEach((n, i) => {
      n.index = i + 1;
    });
    this.nodes = [ground, ...others];
    this.nodeCount = others.length + 1;
    let branches = 0;
    for (const comp of this.components) {
      const count = comp.getVSourceCount();
      if (count > 0) {
        comp.assignVSourceIndices(branches);
        branches += count;
      }
    }
    this.branchCount = branches;
    this.size = this.nodeCount - 1 + branches;
    this.matrix = new MNAMatrix(this.nodeCount, branches);
    this.work = Array.from({ length: this.size }, () => new Float64Array(this.size));
    this.nonlinear = this.components.filter(c => c.isNonlinear());
    this.linear = this.nonlinear.length === 0;
  }

  /** Reset node indices so the circuit can be re-analyzed (or edited). */
  release(): void {
    if (this.released) return;
    this.released = true;
    for (const node of this.nodes) {
      if (node.index !== 0) node.index = -1;
    }
  }

  zeros(): Float64Array {
    return new Float64Array(this.size);
  }

  /** Push solution values into the components' voltage/current readouts. */
  publish(x: ArrayLike<number>): void {
    for (const comp of this.components) {
      const r = comp.readResults(x, this.matrix);
      if (r) comp._setResults(r.voltage, r.current);
    }
  }

  /** States integrated during the last converged iteration (component order). */
  get integratedStates(): ReactiveState[] {
    return this.touched;
  }

  newton(p: NewtonParams): NewtonResult {
    const n = this.size;
    const matrix = this.matrix;
    let x = Float64Array.from(p.x0);
    let noncon = 0;
    const self = this;
    const ctx: LoadContext & { x: Float64Array; init: 'junction' | 'guess' | 'none' } = {
      matrix,
      mode: p.mode,
      initial: p.initial,
      time: p.time,
      h: p.h,
      method: p.method,
      srcFactor: p.srcFactor,
      gmin: GMIN,
      x,
      init: p.init,
      v(nodeIndex: number): number {
        return nodeIndex > 0 ? ctx.x[nodeIndex - 1] : 0;
      },
      limited() {
        noncon++;
      },
      integrate(state: ReactiveState, value: number) {
        if (state._stamp !== self.stamp) {
          state._stamp = self.stamp;
          self.touched.push(state);
        }
        return integrateStep(state, value, p.h, p.method);
      },
    };
    const history = new Map<Component, number[]>();
    let worst: WorstDevice | null = null;
    const nodeRows = this.nodeCount - 1;

    for (let iter = 1; iter <= p.maxIterations; iter++) {
      matrix.clear();
      noncon = 0;
      this.stamp++;
      this.touched = [];
      const iterInit = iter === 1 ? p.init : 'none';
      ctx.init = iterInit;
      ctx.x = x;
      for (const comp of this.components) comp.load(ctx);
      if (p.gshunt > 0) for (let i = 0; i < nodeRows; i++) matrix.G[i][i] += p.gshunt;

      // Factor a copy (reused buffers; LU permutes the row references).
      const M = this.work;
      for (let i = 0; i < n; i++) M[i].set(matrix.G[i]);
      const xNew = Float64Array.from(matrix.z);
      try {
        luSolveInPlace(M, xNew);
      } catch (err) {
        if (err instanceof SingularMatrixError) {
          return { ok: false, x, iterations: iter, reason: 'singular', worst };
        }
        throw err;
      }
      let finite = true;
      for (let i = 0; i < n; i++) {
        if (!Number.isFinite(xNew[i])) {
          finite = false;
          break;
        }
      }
      if (!finite) {
        return { ok: false, x, iterations: iter, reason: 'non-finite', worst: worst ?? this.worstByMagnitude(x) };
      }
      if (this.linear) return { ok: true, x: xNew, iterations: iter, worst: null };

      // Convergence: every unknown settled, and no device limited its step.
      let converged = iterInit !== 'junction' && noncon === 0;
      if (converged) {
        for (let i = 0; i < n; i++) {
          const tol = NEWTON_RELTOL * Math.max(Math.abs(xNew[i]), Math.abs(x[i])) + (i < nodeRows ? NEWTON_VNTOL : NEWTON_ABSTOL);
          if (Math.abs(xNew[i] - x[i]) > tol) {
            converged = false;
            break;
          }
        }
      }
      // Culprit tracking: the nonlinear device whose voltage moved most.
      worst = null;
      for (const comp of this.nonlinear) {
        const before = comp.readResults(x, matrix);
        const after = comp.readResults(xNew, matrix);
        const vb = before ? before.voltage : 0;
        const va = after ? after.voltage : 0;
        const h = history.get(comp) ?? [];
        h.push(va);
        if (h.length > HISTORY_LENGTH) h.shift();
        history.set(comp, h);
        const deltaV = Math.abs(va - vb);
        if (!worst || deltaV > worst.deltaV) worst = { component: comp, deltaV, history: h };
      }
      x = xNew;
      if (converged) return { ok: true, x, iterations: iter, worst: null };
    }
    return {
      ok: false,
      x,
      iterations: p.maxIterations,
      reason: 'nonconvergence',
      worst: worst && { ...worst, history: [...worst.history] },
    };
  }

  private worstByMagnitude(x: Float64Array): WorstDevice | null {
    let worst: WorstDevice | null = null;
    for (const comp of this.nonlinear) {
      const r = comp.readResults(x, this.matrix);
      const v = Math.abs(r ? r.voltage : 0);
      if (!worst || v > worst.deltaV) worst = { component: comp, deltaV: v, history: [v] };
    }
    return worst;
  }

  /**
   * Solve a DC-type point (operating point, DC-sweep point, or the transient
   * initial point) with convergence aids: plain Newton → gmin stepping →
   * source stepping. Throws ConvergenceError naming the culprit when all fail.
   */
  solveDc(opts: {
    x0?: Float64Array;
    mode?: 'dc' | 'tran';
    initial?: boolean;
    maxIterations?: number;
  } = {}): { x: Float64Array; telemetry: OpTelemetry } {
    const mode = opts.mode ?? 'dc';
    const maxIterations = opts.maxIterations ?? DC_MAX_ITERATIONS;
    const base = {
      mode,
      initial: opts.initial ?? false,
      time: 0,
      h: 0,
      method: 'be' as const,
      maxIterations,
    };
    const attempts: AttemptTelemetry[] = [];
    let total = 0;
    const coldInit = (): 'junction' | 'guess' => (opts.x0 ? 'guess' : 'junction');

    // 1. Plain Newton.
    const plain = this.newton({ ...base, srcFactor: 1, gshunt: 0, init: coldInit(), x0: opts.x0 ?? this.zeros() });
    total += plain.iterations;
    if (plain.ok) {
      const telemetry: OpTelemetry = this.linear
        ? { method: 'linear', iterations: plain.iterations }
        : { method: 'newton-raphson', iterations: plain.iterations };
      return { x: plain.x, telemetry };
    }
    attempts.push({ strategy: 'newton', iterations: plain.iterations, converged: false });
    let lastFailure = plain;

    // 2. gmin stepping: a large shunt from every node to ground makes the
    //    system well-conditioned and nearly linear; relax it decade by decade.
    {
      let iterations = 0;
      let steps = 0;
      let x = opts.x0 ? Float64Array.from(opts.x0) : this.zeros();
      let init: 'junction' | 'guess' = coldInit();
      let g = 1e-2;
      let factor = 10;
      let ok = true;
      let lastGood: { g: number; x: Float64Array } | null = null;
      while (true) {
        const r = this.newton({ ...base, srcFactor: 1, gshunt: g, init, x0: x, maxIterations });
        iterations += r.iterations;
        steps++;
        if (r.ok) {
          lastGood = { g, x: r.x };
          x = r.x;
          init = 'guess';
          if (g === 0) break;
          const next = g / factor;
          g = next < 1e-12 ? 0 : next;
        } else {
          lastFailure = r;
          if (!lastGood || factor < 1.05 || steps > 200) {
            ok = false;
            break;
          }
          factor = Math.sqrt(factor);
          g = lastGood.g === 0 ? 0 : lastGood.g / factor;
          x = lastGood.x;
          if (g < 1e-12 && lastGood.g > 0) g = 0;
        }
      }
      total += iterations;
      attempts.push({ strategy: 'gmin-stepping', iterations, converged: ok, steps });
      if (ok) {
        return {
          x,
          telemetry: { method: 'newton-raphson', iterations: total, aids: ['gmin-stepping'], attempts },
        };
      }
    }

    // 3. Source stepping: ramp every independent source from 0 to its value.
    {
      let iterations = 0;
      let steps = 0;
      let x = this.zeros();
      let ok = false;
      let r0 = this.newton({ ...base, srcFactor: 0, gshunt: 0, init: 'junction', x0: x, maxIterations });
      iterations += r0.iterations;
      steps++;
      if (r0.ok) {
        x = r0.x;
        let f = 0;
        let step = 0.1;
        while (steps < 1000) {
          const target = Math.min(1, f + step);
          const r = this.newton({ ...base, srcFactor: target, gshunt: 0, init: 'guess', x0: x, maxIterations });
          iterations += r.iterations;
          steps++;
          if (r.ok) {
            x = r.x;
            f = target;
            if (f >= 1) {
              ok = true;
              break;
            }
            step = Math.min(step * 1.5, 0.5);
          } else {
            lastFailure = r;
            step /= 4;
            if (step < 1e-6) break;
          }
        }
      } else {
        lastFailure = r0;
      }
      total += iterations;
      attempts.push({ strategy: 'source-stepping', iterations, converged: ok, steps });
      if (ok) {
        return {
          x,
          telemetry: { method: 'newton-raphson', iterations: total, aids: ['gmin-stepping', 'source-stepping'], attempts },
        };
      }
    }

    const reason = plain.reason ?? lastFailure.reason;
    if (reason === 'singular' && lastFailure.reason === 'singular') {
      throw new SingularMatrixError(-1);
    }
    const worst = plain.worst ?? lastFailure.worst;
    throw new ConvergenceError(
      `Newton-Raphson did not converge (plain Newton, gmin stepping and source stepping all failed; ${total} iterations)`,
      { iterations: total, worst, attempts, reason: lastFailure.reason },
    );
  }

  /** DC operating point; remembers the solution for AC analysis. */
  operatingPoint(x0?: Float64Array): { x: Float64Array; telemetry: OpTelemetry } {
    const r = this.solveDc({ x0 });
    this.opSolution = r.x;
    return r;
  }

  /** Components without a small-signal model. */
  componentsWithoutAcModel(): Component[] {
    return this.components.filter(c => !c.hasAcModel());
  }

  /**
   * AC small-signal solution at frequency f (Hz), linearized around the last
   * operating point (call operatingPoint() first).
   */
  acSolve(frequency: number): { re: Float64Array; im: Float64Array; matrix: ComplexMNAMatrix } {
    const missing = this.componentsWithoutAcModel();
    if (missing.length > 0) throw new NoAcModelError(missing);
    const matrix = new ComplexMNAMatrix(this.nodeCount, this.branchCount);
    const omega = 2 * Math.PI * frequency;
    const ctx = { matrix, omega, frequency };
    for (const comp of this.components) comp.acLoad(ctx);
    const re = matrix.re.map(r => Float64Array.from(r));
    const im = matrix.im.map(r => Float64Array.from(r));
    const bRe = Float64Array.from(matrix.zRe);
    const bIm = Float64Array.from(matrix.zIm);
    complexLuSolveInPlace(re, im, bRe, bIm);
    return { re: bRe, im: bIm, matrix };
  }

  // ─── Transient ─────────────────────────────────────────────────────────────

  /** Earliest source breakpoint strictly after t. */
  nextBreakpoint(t: number): number {
    let bp = Infinity;
    for (const comp of this.components) {
      const b = comp.nextBreakpoint(t);
      if (b < bp && b > t) bp = b;
    }
    return bp;
  }

  maxStepHint(): number {
    let h = Infinity;
    for (const comp of this.components) h = Math.min(h, comp.maxStepHint());
    return h;
  }

  /** Accept a converged transient step: commit integrated states, notify components. */
  commitStep(x: Float64Array, time: number): void {
    for (const s of this.touched) {
      s.finalize(x);
      s.commit();
    }
    const matrix = this.matrix;
    const ctx: AcceptContext = {
      x,
      matrix,
      time,
      v: (nodeIndex: number) => (nodeIndex > 0 ? x[nodeIndex - 1] : 0),
    };
    for (const comp of this.components) comp.acceptStep(ctx);
  }

  rejectStep(): void {
    for (const comp of this.components) comp.rejectStep();
  }

  /** Seed reactive states from the t = 0 solution. */
  initTransientStates(x: Float64Array, fromOp: boolean): void {
    const ctx: InitContext = {
      x,
      matrix: this.matrix,
      fromOp,
      v: (nodeIndex: number) => (nodeIndex > 0 ? x[nodeIndex - 1] : 0),
      setState: (state, value, derivative) => state.seed(value, derivative),
    };
    for (const comp of this.components) comp.initTransient(ctx);
  }
}

// ─── Transient engine ────────────────────────────────────────────────────────

export interface TransientOptions {
  tstop: number;
  /** Initial step (and the fixed step when adaptive is false). */
  dt: number;
  /** Step ceiling (adaptive). Default: dt. */
  maxStep?: number;
  /** Default 'trap'. BE is always used for the first step after t = 0 and after each breakpoint. */
  method?: 'trap' | 'be';
  /** Default true. false = fixed step dt on a uniform grid (legacy). */
  adaptive?: boolean;
  /** 'zero' (default): capacitors at 0 V, inductors at 0 A at t = 0. 'op': start from the DC operating point. */
  ic?: 'zero' | 'op';
  /** Relative LTE tolerance (default 1e-3). */
  reltol?: number;
  /** LTE overestimation allowance (default 1). */
  trtol?: number;
  /** Minimum step before giving up (default maxStep·1e-9). */
  minStep?: number;
  /** Total step-attempt budget (default 5,000,000). */
  maxSteps?: number;
  /** @internal test hook: disable the BE restart after breakpoints. */
  beAfterBreakpoint?: boolean;
}

export interface TranTelemetry {
  method: 'trap' | 'be';
  adaptive: boolean;
  acceptedSteps: number;
  rejectedSteps: number;
  /** Rejections caused by Newton failures (step cut by 8 and retried). */
  newtonFailures: number;
  /** Rejections caused by the local-truncation-error control. */
  lteRejections: number;
  minStep: number;
  maxStepTaken: number;
  newtonIterations: number;
  breakpoints: number;
  ic: 'zero' | 'op';
}

export type PointSink = (t: number, x: Float64Array) => void;

export class TransientEngine {
  readonly system: SimulationSystem;
  x: Float64Array;
  time = 0;
  readonly telemetry: TranTelemetry;
  private times = new Float64Array(4);
  private points = 0;
  private forceBE = true;

  constructor(system: SimulationSystem, method: 'trap' | 'be' = 'trap', adaptive = false, ic: 'zero' | 'op' = 'zero') {
    this.system = system;
    this.x = system.zeros();
    this.telemetry = {
      method,
      adaptive,
      acceptedSteps: 0,
      rejectedSteps: 0,
      newtonFailures: 0,
      lteRejections: 0,
      minStep: Infinity,
      maxStepTaken: 0,
      newtonIterations: 0,
      breakpoints: 0,
      ic,
    };
  }

  /** Solve the t = 0 point (zero state or the operating point). */
  start(ic: 'zero' | 'op', x0?: Float64Array): Float64Array {
    const sys = this.system;
    if (ic === 'op') {
      const op = x0 ? { x: x0 } : sys.operatingPoint();
      this.x = Float64Array.from(op.x);
      sys.initTransientStates(this.x, true);
    } else {
      for (const comp of sys.components) comp.resetToDC();
      for (const comp of sys.components) comp.beginStep({ time: 0, h: 0, method: 'be' });
      const r = sys.solveDc({ mode: 'tran', initial: true });
      this.x = r.x;
      sys.initTransientStates(this.x, false);
    }
    sys.commitStep(this.x, 0);
    sys.publish(this.x);
    this.time = 0;
    this.times.fill(0);
    this.points = 1;
    this.forceBE = true;
    return this.x;
  }

  /** One step attempt to `target`. Returns the Newton result; does not commit. */
  private attempt(target: number, h: number, method: 'trap' | 'be'): NewtonResult {
    const sys = this.system;
    for (const comp of sys.components) comp.beginStep({ time: target, h, method });
    const r = sys.newton({
      mode: 'tran',
      initial: false,
      time: target,
      h,
      method,
      srcFactor: 1,
      gshunt: 0,
      init: 'none',
      x0: this.x,
      maxIterations: TRAN_MAX_ITERATIONS,
    });
    this.telemetry.newtonIterations += r.iterations;
    // The last load saw the previous iterate: re-evaluate the integrated
    // quantities at the converged solution before LTE and commit.
    if (r.ok) for (const s of sys.integratedStates) s.finalize(r.x);
    return r;
  }

  private accept(target: number, h: number, x: Float64Array): void {
    this.system.commitStep(x, target);
    this.x = x;
    for (let k = 3; k > 0; k--) this.times[k] = this.times[k - 1];
    this.times[0] = target;
    this.points = Math.min(this.points + 1, 4);
    this.time = target;
    this.telemetry.acceptedSteps++;
    if (h < this.telemetry.minStep) this.telemetry.minStep = h;
    if (h > this.telemetry.maxStepTaken) this.telemetry.maxStepTaken = h;
  }

  private nrFailure(r: NewtonResult, target: number, h: number): ConvergenceError {
    return new ConvergenceError(`Newton-Raphson did not converge at t=${target} (step cut to ${h})`, {
      iterations: r.iterations,
      worst: r.worst,
      time: target,
      step: h,
      reason: r.reason,
    });
  }

  /**
   * Advance by exactly `h` (fixed-step / interactive use). On a Newton
   * failure the interval is subdivided into BE substeps before giving up.
   */
  advance(h: number, method: 'trap' | 'be' = 'be', depth = 0): void {
    const target = this.time + h;
    const useMethod = this.forceBE ? 'be' : method;
    const r = this.attempt(target, h, useMethod);
    if (r.ok) {
      this.accept(target, h, r.x);
      this.forceBE = false;
      return;
    }
    this.system.rejectStep();
    this.telemetry.rejectedSteps++;
    this.telemetry.newtonFailures++;
    if (depth >= 4) throw this.nrFailure(r, target, h);
    const start = this.time;
    for (let k = 1; k <= 8; k++) {
      this.forceBE = true;
      const tk = k === 8 ? target : start + (h * k) / 8;
      this.advance(tk - this.time, 'be', depth + 1);
    }
    this.forceBE = true;
  }

  /** Force BE on the next step (a discontinuity happened inside the last one). */
  markDiscontinuity(): void {
    this.forceBE = true;
    this.points = 1;
  }

  /**
   * Fixed-step run on the grid k·dt, k = 0..ceil(tstop/dt). Output stays on
   * the uniform grid; a source corner inside a grid step is landed on with an
   * internal (unrecorded) substep, and the step after a corner uses BE.
   */
  runFixed(opts: TransientOptions, sink: PointSink): void {
    const method = opts.method ?? 'trap';
    const dt = opts.dt;
    const n = Math.ceil(opts.tstop / dt);
    const beRestart = opts.beAfterBreakpoint !== false;
    this.start(opts.ic ?? 'zero');
    sink(0, this.x);
    let nextBp = this.system.nextBreakpoint(0);
    for (let k = 1; k <= n; k++) {
      const target = k * dt;
      // Land on every corner inside (time, target).
      while (nextBp < target && target - nextBp > dt * 1e-9) {
        if (nextBp - this.time > dt * 1e-9) this.advance(nextBp - this.time, method);
        this.time = nextBp;
        this.telemetry.breakpoints++;
        if (beRestart) this.forceBE = true;
        nextBp = this.system.nextBreakpoint(nextBp);
      }
      this.advance(target - this.time, method);
      this.time = target;
      if (nextBp <= target * (1 + 1e-12)) {
        this.telemetry.breakpoints++;
        if (beRestart) this.forceBE = true;
        nextBp = this.system.nextBreakpoint(target * (1 + 1e-12));
      }
      sink(target, this.x);
    }
  }

  /** Adaptive run: LTE step control, breakpoints landed exactly, BE restarts. */
  runAdaptive(opts: TransientOptions, sink: PointSink): void {
    const sys = this.system;
    const method = opts.method ?? 'trap';
    const tstop = opts.tstop;
    const maxStep = Math.min(opts.maxStep ?? opts.dt, sys.maxStepHint(), tstop);
    const hmin = Math.max(opts.minStep ?? maxStep * 1e-9, tstop * 1e-15);
    const reltol = opts.reltol ?? 1e-4;
    const trtol = opts.trtol ?? 1;
    const budget = opts.maxSteps ?? 5_000_000;
    const beRestart = opts.beAfterBreakpoint !== false;

    this.start(opts.ic ?? 'zero');
    sink(0, this.x);
    let nextBp = Math.min(sys.nextBreakpoint(0), tstop);
    let h = Math.min(opts.dt, maxStep, nextBp < tstop ? Math.max(0.1 * nextBp, hmin) : Infinity);
    let lastCulprit: Component | null = null;
    let attempts = 0;

    while (this.time < tstop) {
      if (++attempts > budget) throw new TimestepTooSmallError(this.time, h, hmin, lastCulprit);
      let hStep = Math.min(h, maxStep);
      let target = this.time + hStep;
      let landing = false;
      if (target >= nextBp || nextBp - target < hmin) {
        target = nextBp;
        landing = true;
      } else if (this.time + 2 * hStep > nextBp) {
        target = this.time + (nextBp - this.time) / 2;
      }
      hStep = target - this.time;
      if (!(hStep > 0) || this.time + hStep === this.time) {
        throw new TimestepTooSmallError(this.time, hStep, hmin, lastCulprit);
      }
      const useMethod: 'trap' | 'be' = this.forceBE && beRestart ? 'be' : method;
      const r = this.attempt(target, hStep, useMethod);
      if (!r.ok) {
        sys.rejectStep();
        this.telemetry.rejectedSteps++;
        this.telemetry.newtonFailures++;
        h = hStep / 8;
        this.forceBE = true;
        if (h < hmin) throw this.nrFailure(r, target, hStep);
        continue;
      }
      // Truncation-error control.
      let worstRatio = 0;
      let order: 1 | 2 = useMethod === 'trap' ? 2 : 1;
      let estimated = false;
      let culprit: Component | null = null;
      for (const state of sys.integratedStates) {
        const est = lteRatio(state, target, this.times, this.points, useMethod === 'trap' ? 2 : 1, { reltol, trtol });
        if (!est) continue;
        estimated = true;
        if (est.ratio > worstRatio) {
          worstRatio = est.ratio;
          order = est.order;
          culprit = state.owner;
        }
      }
      if (estimated && worstRatio > 1) {
        sys.rejectStep();
        this.telemetry.rejectedSteps++;
        this.telemetry.lteRejections++;
        lastCulprit = culprit;
        h = hStep * Math.max(0.125, 0.9 * Math.pow(worstRatio, -1 / (order + 1)));
        if (h < hmin) throw new TimestepTooSmallError(target, h, hmin, culprit);
        continue;
      }
      let hNext: number;
      if (estimated) {
        const grow = worstRatio > 0 ? 0.9 * Math.pow(worstRatio, -1 / (order + 1)) : 2;
        hNext = hStep * Math.min(2, Math.max(0.5, grow));
      } else {
        hNext = hStep * (this.points >= 2 ? 1.5 : 1);
      }
      this.accept(target, hStep, r.x);
      sink(target, this.x);
      if (landing) {
        if (target >= tstop) break;
        this.telemetry.breakpoints++;
        this.forceBE = true;
        this.points = 1;
        nextBp = Math.min(sys.nextBreakpoint(target), tstop);
        h = Math.min(hNext, opts.dt, Math.max(0.1 * (nextBp - target), hmin));
      } else {
        this.forceBE = false;
        h = hNext;
      }
    }
    this.time = tstop;
  }
}
