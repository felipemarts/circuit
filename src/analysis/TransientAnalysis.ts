import type { Circuit } from '../core/Circuit';
import type { Component } from '../core/Component';
import type { Node } from '../core/Node';
import type { MNAMatrix } from '../solver/MNAMatrix';
import { SimulationSystem, TransientEngine, type TranTelemetry } from './engine';

export interface TransientConfig {
  /** Fixed step (legacy) — or, with `adaptive: true`, the initial step. */
  timeStep: number;
  duration: number;
  /** Integration method; default 'trap' (BE after t = 0 and after every breakpoint). */
  method?: 'trap' | 'be';
  /** Adaptive (LTE-controlled) stepping with breakpoints. Default false: uniform grid k·timeStep. */
  adaptive?: boolean;
  /** Adaptive step ceiling (default: timeStep). */
  maxStep?: number;
  /** Adaptive step floor (default maxStep·1e-9). */
  minStep?: number;
  /** Initial state: 'zero' (default; caps 0 V, inductors 0 A) or 'op' (DC operating point). */
  ic?: 'zero' | 'op';
  /** Relative truncation-error tolerance for adaptive stepping (default 1e-3). */
  reltol?: number;
  /** @internal test hook */
  beAfterBreakpoint?: boolean;
}

export interface ProbeSpec {
  label: string;
  color: string;
  component?: Component;
  /** Net probe: voltage of this node (takes precedence over `component`). */
  node?: Node;
  type: 'voltage' | 'current';
}

export interface TransientResult {
  timePoints: number[];
  probes: { label: string; color: string; values: number[] }[];
  /** Stepping telemetry (accepted/rejected steps, minimum step, ...). */
  telemetry?: TranTelemetry;
}

/** Throws on configs that would hang (timeStep=0), run backwards, or NaN-poison results. */
export function validateTransientConfig(config: TransientConfig): void {
  if (!Number.isFinite(config.timeStep) || config.timeStep <= 0) {
    throw new Error(`invalid transient timeStep ${config.timeStep}: must be a finite number > 0`);
  }
  if (!Number.isFinite(config.duration) || config.duration <= 0) {
    throw new Error(`invalid transient duration ${config.duration}: must be a finite number > 0`);
  }
  if (config.maxStep !== undefined && (!Number.isFinite(config.maxStep) || config.maxStep <= 0)) {
    throw new Error(`invalid transient maxStep ${config.maxStep}: must be a finite number > 0`);
  }
}

/** Reads one probe value from a solution (shared by batch and interactive runs). */
export function readProbe(spec: ProbeSpec, x: ArrayLike<number>, matrix: MNAMatrix): number {
  if (spec.node) return spec.node.index > 0 ? x[spec.node.index - 1] : 0;
  if (!spec.component) return 0;
  const result = spec.component.readResults(x, matrix);
  if (spec.type === 'voltage') {
    if (result) return result.voltage;
    const pins = spec.component.allPins();
    const idx = pins.length > 0 ? pins[0].node.index : 0;
    return idx > 0 ? x[idx - 1] : 0;
  }
  return result ? result.current : 0;
}

export class TransientAnalysis {
  run(circuit: Circuit, config: TransientConfig, probeSpecs: ProbeSpec[]): TransientResult {
    validateTransientConfig(config);
    const system = new SimulationSystem(circuit);
    const method = config.method ?? 'trap';
    const adaptive = config.adaptive ?? false;
    const ic = config.ic ?? 'zero';
    const engine = new TransientEngine(system, method, adaptive, ic);
    const timePoints: number[] = [];
    const values: number[][] = probeSpecs.map(() => []);
    const sink = (t: number, x: Float64Array) => {
      timePoints.push(t);
      for (let i = 0; i < probeSpecs.length; i++) values[i].push(readProbe(probeSpecs[i], x, system.matrix));
    };
    const opts = {
      tstop: config.duration,
      dt: config.timeStep,
      maxStep: config.maxStep,
      minStep: config.minStep,
      method,
      adaptive,
      ic,
      reltol: config.reltol,
      beAfterBreakpoint: config.beAfterBreakpoint,
    };
    try {
      if (adaptive) engine.runAdaptive(opts, sink);
      else engine.runFixed(opts, sink);
      system.publish(engine.x);
    } finally {
      for (const comp of system.components) comp.resetToDC();
      system.release();
    }
    return {
      timePoints,
      probes: probeSpecs.map((spec, i) => ({ label: spec.label, color: spec.color, values: values[i] })),
      telemetry: engine.telemetry,
    };
  }
}
