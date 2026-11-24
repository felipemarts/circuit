/**
 * Shared numerical core of the semiconductor devices.
 *
 * A device is a small set of LOCAL nodes (its pins and internal nodes) with
 * nonlinear branch currents and charges between them. Each branch current
 * is written in the device's polarity-normalized frame: i = type·f(v₁…vₘ)
 * with vₘ = type·(V[pₘ] − V[nₘ]) (type = +1 for N devices, −1 for P), so a
 * PNP/PMOS reuses the NPN/NMOS equations unchanged. The core accumulates
 * the local Jacobian and the Newton equivalent currents, stamps them into the
 * MNA matrix, integrates the charges through the engine's ReactiveState (so
 * they take part in truncation-error control), keeps the operating-point
 * linearization for the AC stage, and evaluates terminal currents for probes.
 */
import type { Component } from '../../core/Component';
import { ReactiveState } from '../../analysis/integration';
import type { AcLoadContext, InitContext, LoadContext, Phasor } from '../../analysis/context';
import type { MNAMatrix } from '../../solver/MNAMatrix';

/** One controlling voltage of a branch: v = type·(V[p] − V[n]), its partial d and linearization point v0. */
export interface Ctrl {
  p: number;
  n: number;
  /** ∂f/∂v (for a charge: ∂q/∂v). */
  d: number;
  /** Value of v the branch was evaluated at (after limiting). */
  v0: number;
}

export interface EvalContext {
  /** 'dc' / 'tran' while stamping a Newton iteration; 'readout' when evaluating a solution. */
  readonly mode: 'dc' | 'tran' | 'readout';
  /** Newton initialization (load only): see LoadContext.init. */
  readonly init: 'junction' | 'guess' | 'none';
  /** Apply voltage limiting this iteration. */
  readonly limiting: boolean;
  readonly gmin: number;
  /** Voltage of local node k in the iterate / solution. */
  v(k: number): number;
  /** Report a limited controlling voltage (blocks convergence). */
  limited(): void;
  /** Nonlinear DC branch: real current i flows from local node a to b through the device. */
  branch(a: number, b: number, type: number, i: number, ctrls: Ctrl[]): void;
  /** Stored charge type·q on node a (−type·q on b) in slot `slot`; ctrls carry ∂q/∂v. */
  charge(slot: number, a: number, b: number, type: number, q: number, ctrls: Ctrl[]): void;
}

export type Evaluator = (ctx: EvalContext) => void;

export class SemiCore {
  readonly size: number;
  /** Matrix node index of each local node (refreshed before every use). */
  readonly nodes: Int32Array;
  private readonly G: Float64Array;
  private readonly C: Float64Array;
  private readonly rhs: Float64Array;
  private readonly I: Float64Array;
  private opG: Float64Array;
  private opC: Float64Array;
  /** Linear series resistances between local nodes. */
  readonly resistors: { a: number; b: number; g: number }[] = [];
  readonly states: ReactiveState[];
  private readonly q: Float64Array;
  private transient = false;
  private lastX: ArrayLike<number> | null = null;

  constructor(
    owner: Component,
    size: number,
    chargeSlots: number,
    private readonly evaluator: Evaluator,
  ) {
    this.size = size;
    this.nodes = new Int32Array(size);
    this.G = new Float64Array(size * size);
    this.C = new Float64Array(size * size);
    this.rhs = new Float64Array(size);
    this.I = new Float64Array(size);
    this.opG = new Float64Array(size * size);
    this.opC = new Float64Array(size * size);
    this.q = new Float64Array(chargeSlots);
    // chgtol 1e-14 C, abstol 1e-12 A (SPICE defaults), like Capacitor.
    this.states = Array.from({ length: chargeSlots }, () => new ReactiveState(owner, 1e-12, 1e-14));
    for (let s = 0; s < chargeSlots; s++) {
      this.states[s].evaluate = x => {
        this.evaluateAt(x);
        return this.q[s];
      };
    }
  }

  addResistor(a: number, b: number, r: number): void {
    if (r > 0) this.resistors.push({ a, b, g: 1 / r });
  }

  private clear(): void {
    this.G.fill(0);
    this.C.fill(0);
    this.rhs.fill(0);
    this.I.fill(0);
  }

  private context(
    mode: 'dc' | 'tran' | 'readout',
    v: (k: number) => number,
    opts: {
      init?: 'junction' | 'guess' | 'none';
      limiting?: boolean;
      gmin?: number;
      limited?: () => void;
      integrate?: LoadContext['integrate'];
      initial?: boolean;
    },
  ): EvalContext {
    const n = this.size;
    const { G, C, rhs, I } = this;
    const self = this;
    const stampBranch = (a: number, b: number, type: number, i: number, ctrls: Ctrl[], scale: number) => {
      I[a] += i;
      I[b] -= i;
      let lin = 0;
      for (const c of ctrls) {
        const d = c.d * scale;
        G[a * n + c.p] += d;
        G[a * n + c.n] -= d;
        G[b * n + c.p] -= d;
        G[b * n + c.n] += d;
        lin += d * c.v0;
      }
      const ieq = i - type * lin;
      rhs[a] -= ieq;
      rhs[b] += ieq;
    };
    return {
      mode,
      init: opts.init ?? 'none',
      limiting: opts.limiting ?? false,
      gmin: opts.gmin ?? 0,
      v,
      limited: opts.limited ?? (() => {}),
      branch(a, b, type, i, ctrls) {
        stampBranch(a, b, type, i, ctrls, 1);
      },
      charge(slot, a, b, type, q, ctrls) {
        self.q[slot] = q;
        if (mode === 'dc') {
          for (const c of ctrls) {
            C[a * n + c.p] += c.d;
            C[a * n + c.n] -= c.d;
            C[b * n + c.p] -= c.d;
            C[b * n + c.n] += c.d;
          }
          return;
        }
        if (mode === 'tran') {
          if (opts.initial || !opts.integrate) return; // t = 0 solve: charges open
          const { derivative, coeff } = opts.integrate(self.states[slot], q);
          stampBranch(a, b, type, type * derivative, ctrls, coeff);
          return;
        }
        // readout: the committed charge current of the last accepted step.
        if (self.transient) {
          const i = type * self.states[slot].hd[0];
          I[a] += i;
          I[b] -= i;
        }
      },
    };
  }

  /** Stamp one Newton iteration. `nodes` must be refreshed by the owner first. */
  load(ctx: LoadContext): void {
    this.lastX = null; // the buffers are about to be overwritten
    this.clear();
    const nodes = this.nodes;
    const mode = ctx.mode;
    this.evaluator(
      this.context(mode, k => ctx.v(nodes[k]), {
        init: ctx.init,
        limiting: ctx.init === 'none',
        gmin: ctx.gmin,
        limited: () => ctx.limited(),
        integrate: ctx.integrate,
        initial: ctx.initial,
      }),
    );
    const matrix = ctx.matrix;
    this.stampLinear(matrix);
    const n = this.size;
    for (let k = 0; k < n; k++) {
      const row = matrix.nodeRow(nodes[k]);
      if (row < 0) continue;
      for (let j = 0; j < n; j++) {
        const g = this.G[k * n + j];
        if (g !== 0) matrix.add(row, matrix.nodeRow(nodes[j]), g);
      }
      if (this.rhs[k] !== 0) matrix.addRHS(row, this.rhs[k]);
    }
    if (mode === 'dc') {
      this.opG.set(this.G);
      this.opC.set(this.C);
    }
  }

  private stampLinear(matrix: MNAMatrix): void {
    for (const r of this.resistors) matrix.stampConductance(this.nodes[r.a], this.nodes[r.b], r.g);
  }

  /**
   * Evaluate the device at a solution vector (no limiting, no gmin) and
   * return the current flowing INTO the device at each local node, including
   * the charge currents of the last accepted transient step.
   */
  evaluateAt(x: ArrayLike<number>): Float64Array {
    if (x === this.lastX) return this.I;
    this.clear();
    const nodes = this.nodes;
    this.evaluator(this.context('readout', k => (nodes[k] > 0 ? x[nodes[k] - 1] : 0), {}));
    this.lastX = x;
    return this.I;
  }

  /** Forget the cached readout (the solution vector may be reused in place). */
  invalidate(): void {
    this.lastX = null;
  }

  /** Seed the charge states from the t = 0 (or operating-point) solution. */
  initTransient(ctx: InitContext): void {
    this.lastX = null;
    this.transient = false;
    this.evaluateAt(ctx.x);
    for (let s = 0; s < this.states.length; s++) ctx.setState(this.states[s], this.q[s], 0);
    this.transient = true;
    this.lastX = null;
  }

  /** A new accepted point invalidates the cached readout. */
  acceptStep(): void {
    this.lastX = null;
  }

  resetToDC(): void {
    this.transient = false;
    this.lastX = null;
    for (const s of this.states) s.seed(0, 0);
  }

  get isTransient(): boolean {
    return this.transient;
  }

  /** Small-signal stamp: series resistances + (G + jωC) of the operating point. */
  acLoad(ctx: AcLoadContext): void {
    const m = ctx.matrix;
    const nodes = this.nodes;
    for (const r of this.resistors) m.stampAdmittance(nodes[r.a], nodes[r.b], r.g, 0);
    const n = this.size;
    for (let k = 0; k < n; k++) {
      const row = m.nodeRow(nodes[k]);
      if (row < 0) continue;
      for (let j = 0; j < n; j++) {
        const g = this.opG[k * n + j];
        const c = this.opC[k * n + j];
        if (g !== 0 || c !== 0) m.add(row, m.nodeRow(nodes[j]), g, ctx.omega * c);
      }
    }
  }

  /** Small-signal current phasor INTO the device at each local node. */
  acCurrents(re: ArrayLike<number>, im: ArrayLike<number>, omega: number): Phasor[] {
    const n = this.size;
    const nodes = this.nodes;
    const vr = (k: number) => (nodes[k] > 0 ? re[nodes[k] - 1] : 0);
    const vi = (k: number) => (nodes[k] > 0 ? im[nodes[k] - 1] : 0);
    const out: Phasor[] = [];
    for (let k = 0; k < n; k++) {
      let ir = 0;
      let ii = 0;
      for (let j = 0; j < n; j++) {
        const g = this.opG[k * n + j];
        const b = omega * this.opC[k * n + j];
        if (g === 0 && b === 0) continue;
        ir += g * vr(j) - b * vi(j);
        ii += g * vi(j) + b * vr(j);
      }
      out.push([ir, ii]);
    }
    return out;
  }

  /** Operating-point small-signal capacitance between local nodes (for tests / catalog). */
  opCapacitance(k: number, j: number): number {
    return this.opC[k * this.size + j];
  }

  /** Operating-point small-signal conductance entry. */
  opConductance(k: number, j: number): number {
    return this.opG[k * this.size + j];
  }
}
