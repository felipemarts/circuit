import { elaborate, type Elaboration } from '../elab/bench';
import { SimulationSystem } from '../analysis/engine';
import { readProbe } from '../analysis/TransientAnalysis';
import { evaluateDcCheck } from './measure';
import { solverDiagnostic } from './solverDiag';
import { probeSpecFor } from './tran';
import { runLint } from './lint';
import type { StageOutcome } from './op';
import type { AssertionResult, AssertionSpec, DcSweepConfig, Diagnostic } from '../schema/types';

export interface SweepCurve {
  /** Swept values, in sweep order (from → to). */
  x: number[];
  /** probe expression → value at each swept point. */
  values: Record<string, number[]>;
  iterations: number;
  aidedPoints: number;
  linear: boolean;
}

export type SweepOutcome = { ok: true; curve: SweepCurve } | { ok: false; diagnostic: Diagnostic };

/** The swept values: `points` evenly spaced from `from` to `to`, both ends exact. */
export function sweepValues(cfg: DcSweepConfig): number[] {
  const xs: number[] = [];
  for (let k = 0; k < cfg.points; k++) {
    xs.push(k === cfg.points - 1 ? cfg.to : cfg.from + ((cfg.to - cfg.from) * k) / (cfg.points - 1));
  }
  return xs;
}

/**
 * Run a DC sweep and collect probe curves. Each point is a full operating
 * point (with convergence aids) warm-started from the previous point, which
 * is what makes sweeps through a diode knee robust.
 */
export function runSweep(elab: Elaboration, cfg: DcSweepConfig, probes: string[]): SweepOutcome {
  const xs = sweepValues(cfg);
  const values: Record<string, number[]> = {};
  for (const p of probes) values[p] = [];
  let iterations = 0;
  let aidedPoints = 0;
  let linear = true;

  if (cfg.source !== undefined) {
    const id = cfg.source;
    const source = elab.components.get(id) as unknown as { _sweepValue: number | null };
    const system = new SimulationSystem(elab.circuit);
    linear = system.linear;
    const specs = probes.map(p => probeSpecFor(elab, p));
    let x0: Float64Array | undefined;
    try {
      for (const xv of xs) {
        source._sweepValue = xv;
        let solved;
        try {
          solved = system.solveDc({ x0 });
        } catch (err) {
          return { ok: false, diagnostic: solverDiagnostic(elab, err, 'dc', { sweep: { id, value: xv } }) };
        }
        iterations += solved.telemetry.iterations;
        if (solved.telemetry.aids) aidedPoints++;
        x0 = solved.x;
        for (let i = 0; i < probes.length; i++) values[probes[i]].push(readProbe(specs[i], solved.x, system.matrix));
      }
    } finally {
      source._sweepValue = null;
      system.release();
    }
    return { ok: true, curve: { x: xs, values, iterations, aidedPoints, linear } };
  }

  // Component-value sweep: re-elaborate with an override per point. The
  // deterministic unknown ordering makes the previous solution a valid warm
  // start for the next circuit instance.
  const id = cfg.param!;
  let x0: Float64Array | undefined;
  for (const xv of xs) {
    let el: Elaboration;
    try {
      el = elaborate(elab.desc, { ...elab.overrides, [id]: xv });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        diagnostic: {
          code: 'T001',
          slug: 'bench-error',
          severity: 'error',
          stage: 'dc',
          message: `the bench threw while sweeping ${id}=${xv}: ${message}`,
          note: 'the swept value is not valid for this component (e.g. a resistance <= 0); adjust the sweep range',
          fixes: [],
        },
      };
    }
    if (runLint(el).some(d => d.severity === 'error')) {
      const codes = runLint(el).filter(d => d.severity === 'error').map(d => d.code);
      return {
        ok: false,
        diagnostic: {
          code: codes[0],
          slug: 'sweep-point-invalid',
          severity: 'error',
          stage: 'dc',
          message: `at ${id}=${xv} the circuit fails lint (${[...new Set(codes)].join(', ')})`,
          note: 'a swept value turns the circuit invalid; narrow the sweep range',
          fixes: [],
        },
      };
    }
    const system = new SimulationSystem(el.circuit);
    linear = linear && system.linear;
    try {
      const specs = probes.map(p => probeSpecFor(el, p));
      let solved;
      try {
        solved = system.solveDc({ x0: x0 && x0.length === system.size ? x0 : undefined });
      } catch (err) {
        return { ok: false, diagnostic: solverDiagnostic(el, err, 'dc', { sweep: { id, value: xv } }) };
      }
      iterations += solved.telemetry.iterations;
      if (solved.telemetry.aids) aidedPoints++;
      x0 = solved.x;
      for (let i = 0; i < probes.length; i++) values[probes[i]].push(readProbe(specs[i], solved.x, system.matrix));
    } finally {
      system.release();
    }
  }
  return { ok: true, curve: { x: xs, values, iterations, aidedPoints, linear } };
}

function configKey(c: DcSweepConfig): string {
  return JSON.stringify([c.source ?? null, c.param ?? null, c.from, c.to, c.points]);
}

/** L2 — DC sweep stage: one sweep per distinct configuration, curve assertions. */
export function runDc(elab: Elaboration): StageOutcome {
  const dcAssertions = elab.assertions.filter(a => a.stage === 'dc');
  const groups = new Map<string, { config: DcSweepConfig; assertions: AssertionSpec[] }>();
  for (const a of dcAssertions) {
    const key = configKey(a.dc!);
    const group = groups.get(key) ?? { config: a.dc!, assertions: [] };
    group.assertions.push(a);
    groups.set(key, group);
  }

  const results: AssertionResult[] = [];
  let iterations = 0;
  let points = 0;
  let aidedPoints = 0;
  let allLinear = true;
  for (const key of [...groups.keys()].sort()) {
    const { config, assertions } = groups.get(key)!;
    const probeExprs = [...new Set(assertions.map(a => a.probe))].sort();
    const outcome = runSweep(elab, config, probeExprs);
    if (!outcome.ok) return { stage: { verdict: 'error' }, diagnostics: [outcome.diagnostic] };
    const { curve } = outcome;
    iterations += curve.iterations;
    points += curve.x.length;
    aidedPoints += curve.aidedPoints;
    allLinear = allLinear && curve.linear;
    for (const spec of assertions) {
      const out = evaluateDcCheck(spec.check, curve.x, curve.values[spec.probe]);
      const result: AssertionResult = {
        id: spec.id,
        stage: 'dc',
        probe: spec.probe,
        check: spec.check,
        verdict: out.pass ? 'pass' : 'fail',
        ...(out.measured !== undefined ? { measured: out.measured } : {}),
        ...(spec.at ? { at: spec.at } : {}),
      };
      if (!out.pass) {
        if (out.outsideBy !== undefined) {
          result.margin = { outsideBy: out.outsideBy, ...(out.ratio !== undefined ? { ratio: out.ratio } : {}) };
        }
        if (out.xFirstViolation !== undefined) result.xFirstViolation = out.xFirstViolation;
        if (out.note) result.note = out.note;
      }
      results.push(result);
    }
  }
  results.sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)));
  const failed = results.some(r => r.verdict === 'fail');
  return {
    stage: {
      verdict: failed ? 'fail' : 'pass',
      solver: {
        method: allLinear ? 'linear' : 'newton-raphson',
        iterations,
        points,
        ...(aidedPoints > 0 ? { aidedPoints } : {}),
      },
      assertions: results,
    },
    diagnostics: [],
  };
}
