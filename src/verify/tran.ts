import type { Elaboration } from '../elab/bench';
import type { ProbeSpec } from '../analysis/TransientAnalysis';
import { evaluateTranCheck, type Waveform } from './measure';
import { solverDiagnostic } from './solverDiag';
import type { StageOutcome } from './op';
import { evaluateTranRatings, ratingProbes } from './ratings';
import type { AssertionResult, AssertionSpec, TranConfig, TranRunTelemetry } from '../schema/types';

import { COMPONENT_PROBE_RE, asQuantityDevice } from '../elab/quantity';

/** Probe expression → engine probe spec (component quantity or named net). */
export function probeSpecFor(elab: Elaboration, expr: string): ProbeSpec {
  const m = expr.match(COMPONENT_PROBE_RE);
  if (m) {
    const component = elab.components.get(m[1])!;
    if (asQuantityDevice(component)) return { label: expr, color: '#000', component, type: 'voltage', quantity: m[2] };
    return { label: expr, color: '#000', component, type: m[2] === 'i' ? 'current' : 'voltage' };
  }
  return { label: expr, color: '#000', node: elab.netNode.get(expr)!, type: 'voltage' };
}

function configKey(c: TranConfig): string {
  return JSON.stringify([c.tstop, c.dt, c.maxStep ?? c.dt, c.minStep ?? null, c.method ?? 'trap', c.ic ?? 'zero', c.reltol ?? null]);
}

/** Human-stable label of a transient configuration (used in probe keys). */
export function configLabel(c: TranConfig): string {
  const parts = [`tstop=${c.tstop}s`, `dt=${c.dt}s`];
  if (c.maxStep !== undefined && c.maxStep !== c.dt) parts.push(`maxStep=${c.maxStep}s`);
  if (c.minStep !== undefined) parts.push(`minStep=${c.minStep}s`);
  if (c.method && c.method !== 'trap') parts.push(`method=${c.method}`);
  if (c.ic && c.ic !== 'zero') parts.push(`ic=${c.ic}`);
  if (c.reltol !== undefined) parts.push(`reltol=${c.reltol}`);
  return parts.join(',');
}

/**
 * L3 — transient stage. Groups tran assertions by their configuration, runs
 * one deterministic adaptive simulation per group, and evaluates waveform
 * checks with the measurement kernel (which interpolates the non-uniform
 * samples).
 */
export function runTran(elab: Elaboration): StageOutcome {
  const tranAssertions = elab.assertions.filter(a => a.stage === 'tran');
  if (tranAssertions.length === 0) {
    return { stage: { verdict: 'pass', assertions: [] }, diagnostics: [] };
  }

  const groups = new Map<string, { config: TranConfig; assertions: AssertionSpec[] }>();
  for (const a of tranAssertions) {
    const key = configKey(a.tran!);
    const group = groups.get(key) ?? { config: a.tran!, assertions: [] };
    group.assertions.push(a);
    groups.set(key, group);
  }

  const results: AssertionResult[] = [];
  const finalValues: Record<string, number> = {};
  const runs: TranRunTelemetry[] = [];
  const ratingRuns: { label: string; waveforms: Map<string, Waveform> }[] = [];
  const extraProbes = ratingProbes(elab, 'tran');

  for (const key of [...groups.keys()].sort()) {
    const { config, assertions } = groups.get(key)!;
    const probeExprs = [...new Set(assertions.map(a => a.probe))].sort();
    const simulated = [...new Set([...probeExprs, ...extraProbes])].sort();
    const specs = simulated.map(expr => probeSpecFor(elab, expr));

    let waveforms: Map<string, Waveform>;
    try {
      const result = elab.circuit.analyze(
        'transient',
        {
          timeStep: config.dt,
          duration: config.tstop,
          maxStep: config.maxStep,
          minStep: config.minStep,
          method: config.method,
          ic: config.ic,
          reltol: config.reltol,
          adaptive: true,
        },
        specs,
      );
      waveforms = new Map(result.probes.map(p => [p.label, { t: result.timePoints, y: p.values } as Waveform]));
      const t = result.telemetry!;
      runs.push({
        config: { ...config },
        method: t.method,
        acceptedSteps: t.acceptedSteps,
        rejectedSteps: t.rejectedSteps,
        newtonFailures: t.newtonFailures,
        lteRejections: t.lteRejections,
        minStep: t.minStep,
        maxStepTaken: t.maxStepTaken,
        breakpoints: t.breakpoints,
        newtonIterations: t.newtonIterations,
      });
    } catch (err) {
      return { stage: { verdict: 'error' }, diagnostics: [solverDiagnostic(elab, err, 'tran')] };
    }

    if (extraProbes.length > 0) ratingRuns.push({ label: configLabel(config), waveforms });
    for (const expr of probeExprs) {
      const wf = waveforms.get(expr)!;
      finalValues[`${expr}@${configLabel(config)}`] = wf.y[wf.y.length - 1];
    }

    for (const spec of assertions) {
      const wf = waveforms.get(spec.probe)!;
      const outcome = evaluateTranCheck(spec.check, wf, config.tstop);
      const result: AssertionResult = {
        id: spec.id,
        stage: 'tran',
        probe: spec.probe,
        check: spec.check,
        verdict: outcome.pass ? 'pass' : 'fail',
        ...(outcome.measured !== undefined ? { measured: outcome.measured } : {}),
        ...(spec.at ? { at: spec.at } : {}),
      };
      if (!outcome.pass) {
        if (outcome.outsideBy !== undefined) {
          result.margin = { outsideBy: outcome.outsideBy, ...(outcome.ratio !== undefined ? { ratio: outcome.ratio } : {}) };
        }
        if (outcome.tFirstViolation !== undefined) {
          result.tFirstViolation = outcome.tFirstViolation;
          result.excerpt = excerptAround(wf, outcome.tFirstViolation);
        }
      }
      results.push(result);
    }
  }

  // Assertion results in declaration order, independent of group order.
  results.sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)));
  const ratings = evaluateTranRatings(elab, ratingRuns);
  const failed = results.some(r => r.verdict === 'fail') || ratings.some(r => r.verdict === 'fail');
  const totals = runs.reduce(
    (acc, r) => ({
      accepted: acc.accepted + r.acceptedSteps,
      rejected: acc.rejected + r.rejectedSteps,
      iterations: acc.iterations + r.newtonIterations,
      minStep: Math.min(acc.minStep, r.minStep),
    }),
    { accepted: 0, rejected: 0, iterations: 0, minStep: Infinity },
  );
  return {
    stage: {
      verdict: failed ? 'fail' : 'pass',
      probes: finalValues,
      solver: {
        method: runs.every(r => r.method === 'be') ? 'be' : 'trap',
        iterations: totals.iterations,
        acceptedSteps: totals.accepted,
        rejectedSteps: totals.rejected,
        minStep: totals.minStep,
        runs,
      },
      assertions: results,
      ...(ratings.length > 0 ? { ratings } : {}),
    },
    diagnostics: [],
  };
}

const EXCERPT_RADIUS = 5;

/** Up to 11 samples around the first violation, as [t, value] pairs. */
function excerptAround(wf: Waveform, time: number): [number, number][] {
  let idx = wf.t.findIndex(t => t >= time);
  if (idx === -1) idx = wf.t.length - 1;
  const from = Math.max(0, idx - EXCERPT_RADIUS);
  const to = Math.min(wf.t.length - 1, idx + EXCERPT_RADIUS);
  const excerpt: [number, number][] = [];
  for (let i = from; i <= to; i++) {
    excerpt.push([Number(wf.t[i].toPrecision(6)), Number(wf.y[i].toPrecision(6))]);
  }
  return excerpt;
}
