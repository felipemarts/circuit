import type { Elaboration } from '../elab/bench';
import type { ProbeSpec } from '../analysis/TransientAnalysis';
import { evaluateTranCheck, type Waveform } from './measure';
import { solverDiagnostic, type StageOutcome } from './op';
import type { AssertionResult, AssertionSpec } from '../schema/types';

const COMPONENT_PROBE_RE = /^([A-Za-z][A-Za-z0-9_]*)\.(i|v)$/;

/**
 * L3 — transient stage. Groups tran assertions by their (tstop, dt) config,
 * runs one deterministic batch simulation per group, and evaluates waveform
 * checks with the measurement kernel.
 */
export function runTran(elab: Elaboration): StageOutcome {
  const tranAssertions = elab.assertions.filter(a => a.stage === 'tran');
  if (tranAssertions.length === 0) {
    return { stage: { verdict: 'pass', assertions: [] }, diagnostics: [] };
  }

  const groups = new Map<string, { tstop: number; dt: number; assertions: AssertionSpec[] }>();
  for (const a of tranAssertions) {
    const cfg = a.tran!;
    const key = `${cfg.tstop}|${cfg.dt}`;
    const group = groups.get(key) ?? { ...cfg, assertions: [] };
    group.assertions.push(a);
    groups.set(key, group);
  }

  const results: AssertionResult[] = [];
  const finalValues: Record<string, number> = {};

  for (const key of [...groups.keys()].sort()) {
    const group = groups.get(key)!;
    const probeExprs = [...new Set(group.assertions.map(a => a.probe))].sort();
    const specs: ProbeSpec[] = probeExprs.map(expr => {
      const m = expr.match(COMPONENT_PROBE_RE)!;
      return {
        label: expr,
        color: '#000',
        component: elab.components.get(m[1])!,
        type: m[2] === 'i' ? 'current' : 'voltage',
      };
    });

    let waveforms: Map<string, Waveform>;
    try {
      const result = elab.circuit.analyze('transient', { timeStep: group.dt, duration: group.tstop }, specs);
      waveforms = new Map(
        result.probes.map(p => [p.label, { t: result.timePoints, y: p.values } as Waveform]),
      );
    } catch (err) {
      return { stage: { verdict: 'error' }, diagnostics: [solverDiagnostic(elab, err, 'tran')] };
    }

    for (const expr of probeExprs) {
      const wf = waveforms.get(expr)!;
      // dt is part of the key: two groups may share tstop but differ in step.
      finalValues[`${expr}@tstop=${group.tstop}s,dt=${group.dt}s`] = wf.y[wf.y.length - 1];
    }

    for (const spec of group.assertions) {
      const wf = waveforms.get(spec.probe)!;
      const outcome = evaluateTranCheck(spec.check, wf, group.tstop);
      const result: AssertionResult = {
        id: spec.id,
        stage: 'tran',
        probe: spec.probe,
        check: spec.check,
        verdict: outcome.pass ? 'pass' : 'fail',
        measured: outcome.measured,
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

  const failed = results.some(r => r.verdict === 'fail');
  return {
    stage: { verdict: failed ? 'fail' : 'pass', probes: finalValues, assertions: results },
    diagnostics: [],
  };
}

const EXCERPT_RADIUS = 5;

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
