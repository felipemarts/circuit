import { elaborate, type Elaboration } from '../elab/bench';
import { evaluateScalarCheck } from './measure';
import { opSolverRecord, solverDiagnostic } from './solverDiag';
import { runLint } from './lint';
import { formatEng } from '../elab/units';
import type {
  AssertionResult,
  AssertionSpec,
  Diagnostic,
  StageRecord,
  VerifiedParamHint,
} from '../schema/types';
import type { DCResult } from '../analysis/DCAnalysis';
import { attachRatingHint, evaluateOpRatings, ratingChecks } from './ratings';
import { evaluateAmplifierOpRatings } from '../opamps/ratings';
import type { DCResult as SolvedDc } from '../analysis/DCAnalysis';

/**
 * Every datasheet rating of the operating point: semiconductor Part()s (R401–R404,
 * src/verify/ratings.ts) and op-amp / comparator Part()s (R420–R425,
 * src/opamps/ratings.ts), in component-id order (stable within a component).
 */
function opRatings(el: Elaboration, dc: SolvedDc) {
  const all = [...evaluateOpRatings(el, p => resolveOpProbe(el, dc, p)), ...evaluateAmplifierOpRatings(el)];
  return all.map((r, i) => ({ r, i })).sort((a, b) => (a.r.component < b.r.component ? -1 : a.r.component > b.r.component ? 1 : a.i - b.i)).map(x => x.r);
}

export { solverDiagnostic, opSolverRecord } from './solverDiag';

export interface StageOutcome {
  stage: StageRecord;
  diagnostics: Diagnostic[];
}

import { COMPONENT_PROBE_RE, asQuantityDevice } from '../elab/quantity';
import { pinCurrents } from './currents';

/** Resolve a probe expression against a solved DC operating point. */
export function resolveOpProbe(elab: Elaboration, dc: DCResult, probe: string): number {
  const m = probe.match(COMPONENT_PROBE_RE);
  if (m) {
    const comp = elab.components.get(m[1]);
    if (!comp) throw new Error(`probe '${probe}': unknown component '${m[1]}'`);
    const dev = asQuantityDevice(comp);
    if (dev) {
      const q = dev.quantity(m[2]);
      if (typeof q !== 'number') throw new Error(`probe '${probe}': ${m[1]} has no quantity '${m[2]}'`);
      return q;
    }
    const value = m[2] === 'i' ? (comp as { current?: number }).current : (comp as { voltage?: number }).voltage;
    if (typeof value !== 'number') {
      throw new Error(`probe '${probe}': ${m[1]} does not expose ${m[2] === 'i' ? 'current' : 'voltage'}`);
    }
    return value;
  }
  const node = elab.netNode.get(probe) ?? elab.mixed?.pinNode(probe);
  if (!node) throw new Error(`probe '${probe}': unknown net`);
  const v = dc.nodeVoltages.get(node);
  if (v === undefined) throw new Error(`probe '${probe}': net not present in the solved circuit`);
  return v;
}

function evaluateOpAssertions(elab: Elaboration, dc: DCResult, assertions: AssertionSpec[]): AssertionResult[] {
  return assertions.map(spec => {
    const measured = resolveOpProbe(elab, dc, spec.probe);
    const outcome = evaluateScalarCheck(spec.check, measured);
    return {
      id: spec.id,
      stage: 'op',
      probe: spec.probe,
      check: spec.check,
      verdict: outcome.pass ? 'pass' : 'fail',
      measured,
      ...(outcome.pass || outcome.outsideBy === undefined
        ? {}
        : { margin: { outsideBy: outcome.outsideBy, ...(outcome.ratio !== undefined ? { ratio: outcome.ratio } : {}) } }),
      ...(spec.at ? { at: spec.at } : {}),
    };
  });
}

const HINT_SAMPLES = 25;

/**
 * Verified sizing hint: sample each declared free parameter across its range,
 * re-elaborate + re-solve at every sample, and keep only values where ALL
 * op-stage assertions pass. The hint is simulated before it is suggested —
 * `confidence: verified` is a hard contract.
 */
function computeVerifiedHint(elab: Elaboration, opAssertions: AssertionSpec[], withRatings = false): VerifiedParamHint | undefined {
  for (const [param, spec] of [...elab.params.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const samples: number[] = [];
    for (let k = 0; k < HINT_SAMPLES; k++) {
      const f = k / (HINT_SAMPLES - 1);
      samples.push(
        spec.scale === 'log'
          ? Math.exp(Math.log(spec.min) + f * (Math.log(spec.max) - Math.log(spec.min)))
          : spec.min + f * (spec.max - spec.min),
      );
    }
    // pass/fail per grid index — the range claim must never bridge a failing
    // sample, so only the longest contiguous passing run is reported.
    const passAt: boolean[] = samples.map(value => {
      try {
        const el = elaborate(elab.desc, { ...elab.overrides, [param]: value });
        // A sample the platform itself would reject at lint is NOT a passing
        // value — a 'verified' hint must survive the full ladder.
        if (runLint(el).some(d => d.severity === 'error')) return false;
        const dc = el.circuit.analyze('dc');
        if (!evaluateOpAssertions(el, dc, opAssertions).every(r => r.verdict === 'pass')) return false;
        return !withRatings || opRatings(el, dc).every(r => r.verdict === 'pass');
      } catch {
        return false; // non-convergent or invalid sample
      }
    });
    let runStart = -1;
    let best: [number, number] | null = null;
    for (let i = 0; i <= passAt.length; i++) {
      if (i < passAt.length && passAt[i]) {
        if (runStart === -1) runStart = i;
      } else if (runStart !== -1) {
        if (!best || i - runStart > best[1] - best[0] + 1) best = [runStart, i - 1];
        runStart = -1;
      }
    }
    if (best) {
      const run = samples.slice(best[0], best[1] + 1);
      const suggested = run[Math.floor((run.length - 1) / 2)];
      return {
        kind: 'verified-param-range',
        param,
        passingRange: [run[0], run[run.length - 1]],
        suggestedValue: suggested,
        passingSamples: run.map(v => Number(v.toPrecision(6))),
        note: `${HINT_SAMPLES}-point ${spec.scale} sweep of ${param} over [${formatEng(spec.min)}, ${formatEng(spec.max)}]; every listed SAMPLED value passes lint and ALL op assertions${withRatings ? ' and keeps every part within its datasheet absolute maximum ratings at the operating point' : ''} (simulated); the range spans sampled points only`,
      };
    }
  }
  return undefined;
}

/** L1 — DC operating point + assertions + verified sizing hints. */
export function runOp(elab: Elaboration, opts: { hints: boolean }): StageOutcome {
  const opAssertions = elab.assertions.filter(a => a.stage === 'op');
  // A pure-digital bench has no analog operating point (its power-on state is the tran start).
  if (elab.mixed?.digitalOnly) return { stage: { verdict: 'pass', probes: {} }, diagnostics: [] };

  let dc: DCResult;
  try {
    dc = elab.circuit.analyze('dc');
  } catch (err) {
    return { stage: { verdict: 'error' }, diagnostics: [...(elab.mixed ? elab.mixed.controller.run.diagnostics : []), solverDiagnostic(elab, err, 'op')] };
  }
  // Boards size their traces from the pin currents (src/pcb): take them before any hint re-solve.
  if (elab.pcb) elab.pcbCurrents = { ...elab.pcbCurrents, op: pinCurrents(elab) };
  // Mixed-signal: static-state diagnostics of the operating point (D508–D514, D50x).
  const mixedDiags = elab.mixed ? [...elab.mixed.controller.run.diagnostics] : [];

  // Probe values reported: every asserted probe + every user-named net.
  const probes: Record<string, number> = {};
  for (const spec of opAssertions) {
    probes[spec.probe] = resolveOpProbe(elab, dc, spec.probe);
  }
  for (const net of [...elab.netNode.keys()].sort()) {
    if (net === 'gnd' || /^n\d+$/.test(net)) continue;
    if (!(net in probes)) probes[net] = resolveOpProbe(elab, dc, net);
  }

  const assertions = evaluateOpAssertions(elab, dc, opAssertions);
  const failed = assertions.filter(a => a.verdict === 'fail');
  const ratings = opRatings(elab, dc);
  const ratingFailed = ratings.some(r => r.verdict === 'fail');
  if ((failed.length > 0 || ratingFailed) && opts.hints && elab.params.size > 0) {
    // With catalog parts the hint must keep them within their ratings too.
    const hint = computeVerifiedHint(elab, opAssertions, ratingChecks(elab, 'op').length > 0 || ratings.length > 0);
    if (hint) {
      for (const a of failed) a.hint = hint;
      attachRatingHint(ratings, hint);
    }
  }

  return {
    stage: {
      verdict: mixedDiags.some(d => d.severity === 'error') ? 'error' : failed.length > 0 || ratingFailed ? 'fail' : 'pass',
      probes,
      solver: opSolverRecord(dc.telemetry),
      assertions,
      ...(ratings.length > 0 ? { ratings } : {}),
    },
    diagnostics: mixedDiags,
  };
}

