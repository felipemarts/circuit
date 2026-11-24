import type { MNAMatrix, ComplexMNAMatrix } from '../solver/MNAMatrix';
import type { ReactiveState } from './integration';

/**
 * What a device sees while it stamps one Newton iteration. Built-in devices
 * implement `load(ctx)`; legacy `stamp(matrix)`-only components keep working
 * through the default `Component.load`.
 */
export interface LoadContext {
  readonly matrix: MNAMatrix;
  /** 'dc' = operating point / DC sweep point; 'tran' = a transient time point. */
  readonly mode: 'dc' | 'tran';
  /**
   * Transient only: this solve fixes the t = 0 state. Reactive elements hold
   * their initial condition (capacitor voltage / inductor current) instead of
   * integrating.
   */
  readonly initial: boolean;
  /** Simulation time of the point being solved (0 in DC). */
  readonly time: number;
  /** Transient step being taken (0 in DC and at the initial point). */
  readonly h: number;
  /** Integration method of this step ('be' right after t = 0 and every breakpoint). */
  readonly method: 'be' | 'trap';
  /** Independent-source scale factor (source stepping); 1 = nominal values. */
  readonly srcFactor: number;
  /** Current iterate: the solution of the previous Newton iteration (or the initial guess). */
  readonly x: ArrayLike<number>;
  /**
   * 'junction' — first iteration of a cold DC solve: junctions start at their
   *              critical voltage instead of the (meaningless) zero guess;
   * 'guess'    — first iteration of a warm start: trust `x`, no limiting;
   * 'none'     — regular iteration: apply voltage limiting against the previous iterate.
   */
  readonly init: 'junction' | 'guess' | 'none';
  /** Conductance placed in parallel with every pn junction (numerical floor). */
  readonly gmin: number;
  /** Node voltage of `nodeIndex` in the current iterate (0 for ground). */
  v(nodeIndex: number): number;
  /** Report that this device clamped its controlling voltage (pnjlim/fetlim); blocks convergence. */
  limited(): void;
  /**
   * Integrate a reactive quantity (charge or flux) at this step with the
   * step's method. Returns its time derivative and d(derivative)/d(value).
   * Only valid when mode === 'tran' && !initial.
   */
  integrate(state: ReactiveState, value: number): { derivative: number; coeff: number };
}

/** Called once per transient step attempt, before the first Newton iteration. */
export interface StepContext {
  readonly time: number;
  readonly h: number;
  readonly method: 'be' | 'trap';
}

/** Called after the initial (t = 0) solve, to seed reactive states. */
export interface InitContext {
  readonly x: ArrayLike<number>;
  readonly matrix: MNAMatrix;
  /** True when the transient starts from the DC operating point (steady state, derivatives 0). */
  readonly fromOp: boolean;
  v(nodeIndex: number): number;
  /** Seed a reactive state's value and derivative at t = 0. */
  setState(state: ReactiveState, value: number, derivative: number): void;
}

/** Called after a transient step is accepted. */
export interface AcceptContext {
  readonly x: ArrayLike<number>;
  readonly matrix: MNAMatrix;
  readonly time: number;
  v(nodeIndex: number): number;
}

/** AC small-signal stamping around the DC operating point. */
export interface AcLoadContext {
  readonly matrix: ComplexMNAMatrix;
  /** Angular frequency ω = 2πf (rad/s). */
  readonly omega: number;
  readonly frequency: number;
}

/** Complex number as [re, im]. */
export type Phasor = [number, number];
