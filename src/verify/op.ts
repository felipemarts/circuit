import { elaborate, type Elaboration } from '../elab/bench';
import { ConvergenceError } from '../solver/NewtonRaphson';
import { evaluateScalarCheck } from './measure';
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

export interface StageOutcome {
  stage: StageRecord;
  diagnostics: Diagnostic[];
}

const COMPONENT_PROBE_RE = /^([A-Za-z][A-Za-z0-9_]*)\.(i|v)$/;

/** Resolve a probe expression against a solved DC operating point. */
export function resolveOpProbe(elab: Elaboration, dc: DCResult, probe: string): number {
  const m = probe.match(COMPONENT_PROBE_RE);
  if (m) {
    const comp = elab.components.get(m[1]);
    if (!comp) throw new Error(`probe '${probe}': unknown component '${m[1]}'`);
    const value = m[2] === 'i' ? (comp as { current?: number }).current : (comp as { voltage?: number }).voltage;
    if (typeof value !== 'number') {
      throw new Error(`probe '${probe}': ${m[1]} does not expose ${m[2] === 'i' ? 'current' : 'voltage'}`);
    }
    return value;
  }
  const node = elab.netNode.get(probe);
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
function computeVerifiedHint(elab: Elaboration, opAssertions: AssertionSpec[]): VerifiedParamHint | undefined {
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
        return evaluateOpAssertions(el, dc, opAssertions).every(r => r.verdict === 'pass');
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
        note: `${HINT_SAMPLES}-point ${spec.scale} sweep of ${param} over [${formatEng(spec.min)}, ${formatEng(spec.max)}]; every listed SAMPLED value passes lint and ALL op assertions (simulated); the range spans sampled points only`,
      };
    }
  }
  return undefined;
}

/** L1 — DC operating point + assertions + verified sizing hints. */
export function runOp(elab: Elaboration, opts: { hints: boolean }): StageOutcome {
  const opAssertions = elab.assertions.filter(a => a.stage === 'op');
  const hasNonlinear = [...elab.components.values()].some(c => c.isNonlinear());

  let dc: DCResult;
  try {
    dc = elab.circuit.analyze('dc');
  } catch (err) {
    return { stage: { verdict: 'error' }, diagnostics: [solverDiagnostic(elab, err, 'op')] };
  }

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
  if (failed.length > 0 && opts.hints && elab.params.size > 0) {
    const hint = computeVerifiedHint(elab, opAssertions);
    if (hint) {
      for (const a of failed) a.hint = hint;
    }
  }

  return {
    stage: {
      verdict: failed.length > 0 ? 'fail' : 'pass',
      probes,
      solver: { method: hasNonlinear ? 'newton-raphson' : 'linear' },
      assertions,
    },
    diagnostics: [],
  };
}

/** Cross-bundle-safe ConvergenceError detection (never trust instanceof alone). */
function isConvergenceError(err: unknown): err is ConvergenceError {
  return (
    err instanceof ConvergenceError ||
    (err instanceof Error && err.name === 'ConvergenceError' && 'telemetry' in err)
  );
}

/** Map an engine exception to a stable solver diagnostic. */
export function solverDiagnostic(elab: Elaboration, err: unknown, stage: 'op' | 'tran'): Diagnostic {
  if (isConvergenceError(err)) {
    const worst = err.telemetry.worst;
    const worstId = worst ? elab.idOf.get(worst.component) : undefined;
    const history = worst?.history.map(v => Number(v.toPrecision(5))) ?? [];
    const oscillation = detectOscillation(history);
    return {
      code: stage === 'op' ? 'S201' : 'S202',
      slug: 'nr-nonconvergence',
      severity: 'error',
      stage,
      message: `newton-raphson did not converge after ${err.telemetry.iterations} iterations${
        worstId ? ` — worst: ${worstId} (ΔV=${formatEng(worst!.deltaV, 'V')})` : ''
      }`,
      subject: worstId ? { components: [worstId] } : undefined,
      note: oscillation
        ? `${worstId ?? 'the worst component'} oscillates between ${formatEng(oscillation[0], 'V')} and ${formatEng(oscillation[1], 'V')} — typical of a stiff exponential branch (diode/LED) with no series resistance`
        : 'nonlinear iteration is not settling; a stiff exponential branch or extreme drive is likely',
      evidence: {
        iterations: err.telemetry.iterations,
        ...(worstId ? { worstComponent: worstId, worstDeltaV: worst!.deltaV, voltageHistory: history } : {}),
      },
      fixes: [
        {
          kind: 'add-component',
          confidence: 'suggested',
          detail: `add series resistance in the ${worstId ?? 'nonlinear'} branch (even 1–10 Ω softens the exponential and lets newton-raphson converge)`,
        },
        {
          kind: 'check-values',
          confidence: 'suggested',
          detail: 'check source polarity and magnitude driving the nonlinear branch; very large forward or reverse drive slows convergence',
        },
      ],
      at: worstId ? elab.locOf.get(worstId) : undefined,
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  const nonlinearIds = [...elab.components.entries()]
    .filter(([, c]) => c.isNonlinear())
    .map(([id]) => id)
    .sort();
  return {
    code: 'S101',
    slug: 'unsolvable-system',
    severity: 'error',
    stage,
    message: `the solver could not solve this circuit: ${message}`,
    note: 'this usually means a topology problem the lint stage did not model; inspect the most recently changed components and nets',
    evidence: { engineMessage: message },
    fixes: [
      {
        kind: 'rewire',
        confidence: 'suggested',
        detail: 'ensure every net has a DC path to ground and no ideal-source loop exists; then re-run',
      },
      ...(nonlinearIds.length > 0
        ? [
            {
              kind: 'add-component',
              confidence: 'suggested' as const,
              detail: `a nonlinear device driven without series resistance can also produce this — check ${nonlinearIds.join(', ')} for a current-limiting resistor`,
            },
          ]
        : []),
    ],
  };
}

/** a,b,a,b tail pattern in the voltage history → the two levels, else null. */
function detectOscillation(history: number[]): [number, number] | null {
  if (history.length < 4) return null;
  const [d, c, b, a] = [...history].reverse();
  const eq = (x: number, y: number) => Math.abs(x - y) < 1e-3 + 1e-3 * Math.abs(x);
  if (eq(a, c) && eq(b, d) && !eq(a, b)) {
    return a < b ? [a, b] : [b, a];
  }
  return null;
}
