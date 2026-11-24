import type { Elaboration } from '../elab/bench';
import { ConvergenceError, TimestepTooSmallError, type OpTelemetry } from '../analysis/engine';
import { formatEng } from '../elab/units';
import type { Diagnostic, SolverRecord, StageName } from '../schema/types';

/** Stage telemetry from the engine's operating-point telemetry. */
export function opSolverRecord(t: OpTelemetry): SolverRecord {
  return {
    method: t.method,
    iterations: t.iterations,
    ...(t.aids && t.aids.length > 0 ? { aids: [...t.aids] as SolverRecord['aids'] } : {}),
    ...(t.attempts ? { attempts: t.attempts.map(a => ({ ...a })) } : {}),
  };
}

/** Cross-bundle-safe error detection (never trust instanceof alone). */
function isNamed(err: unknown, name: string): err is Error & Record<string, unknown> {
  return err instanceof Error && err.name === name;
}

const round5 = (v: number) => Number(v.toPrecision(5));

/** Map an engine exception to a stable solver diagnostic. */
export function solverDiagnostic(
  elab: Elaboration,
  err: unknown,
  stage: Exclude<StageName, 'lint'>,
  context: { sweep?: { id: string; value: number } } = {},
): Diagnostic {
  const sweepNote = context.sweep ? ` at ${context.sweep.id}=${formatEng(context.sweep.value)}` : '';
  if (err instanceof ConvergenceError || (isNamed(err, 'ConvergenceError') && 'telemetry' in err)) {
    const t = (err as ConvergenceError).telemetry;
    const worst = t.worst;
    const worstId = worst ? elab.idOf.get(worst.component) : undefined;
    const history = worst?.history.map(round5) ?? [];
    const oscillation = detectOscillation(history);
    const isTran = stage === 'tran';
    const aidsTried = (t.attempts?.length ?? 0) > 1;
    const when = isTran && t.time !== undefined ? ` at t=${formatEng(t.time, 's')}` : sweepNote;
    return {
      code: isTran ? 'S202' : 'S201',
      slug: 'nr-nonconvergence',
      severity: 'error',
      stage,
      message: `newton-raphson did not converge${when}${
        isTran && t.step !== undefined ? ` even after cutting the step to ${formatEng(t.step, 's')}` : ''
      }${aidsTried ? ' (plain newton, gmin stepping and source stepping all failed)' : ''}${
        worstId ? ` — worst: ${worstId} (ΔV=${formatEng(worst!.deltaV, 'V')})` : ''
      }`,
      subject: worstId ? { components: [worstId] } : undefined,
      note: oscillation
        ? `${worstId ?? 'the worst component'} oscillates between ${formatEng(oscillation[0], 'V')} and ${formatEng(oscillation[1], 'V')} — typical of a stiff exponential branch (diode/LED) with no series resistance`
        : t.reason === 'non-finite'
          ? 'the iteration produced a non-finite value (exponential overflow); an extreme drive on a nonlinear branch is likely'
          : 'nonlinear iteration is not settling; a stiff exponential branch or extreme drive is likely',
      evidence: {
        iterations: t.iterations,
        ...(t.time !== undefined ? { time: t.time } : {}),
        ...(t.step !== undefined ? { step: t.step } : {}),
        ...(context.sweep ? { sweep: { ...context.sweep } } : {}),
        ...(t.attempts ? { attempts: t.attempts.map(a => ({ ...a })) } : {}),
        ...(worstId ? { worstComponent: worstId, worstDeltaV: worst!.deltaV, voltageHistory: history } : {}),
      },
      fixes: [
        {
          kind: 'add-component',
          confidence: 'suggested',
          detail: `add series resistance in the ${worstId ?? 'nonlinear'} branch (even 1-10 ohm softens the exponential and lets newton-raphson converge)`,
        },
        {
          kind: 'check-values',
          confidence: 'suggested',
          detail: isTran
            ? 'check for an abrupt source edge into a stiff nonlinear branch; a finite rise/fall time (tr/tf) or series resistance helps'
            : 'check source polarity and magnitude driving the nonlinear branch; very large forward or reverse drive slows convergence',
        },
      ],
      at: worstId ? elab.locOf.get(worstId) : undefined,
    };
  }
  if (err instanceof TimestepTooSmallError || (isNamed(err, 'TimestepTooSmallError') && 'minStep' in err)) {
    const e = err as TimestepTooSmallError;
    const culpritId = e.culprit ? elab.idOf.get(e.culprit) : undefined;
    return {
      code: 'S203',
      slug: 'timestep-too-small',
      severity: 'error',
      stage,
      message: `transient step collapsed below the minimum at t=${formatEng(e.time, 's')} (step ${formatEng(e.step, 's')} < ${formatEng(e.minStep, 's')})${
        culpritId ? ` — truncation error dominated by ${culpritId}` : ''
      }`,
      subject: culpritId ? { components: [culpritId] } : undefined,
      note: 'the truncation-error control kept rejecting steps: the waveform changes faster than the minimum step can follow (a time constant far below the step floor, or a step budget exhausted by very fast dynamics)',
      evidence: { time: e.time, step: e.step, minStep: e.minStep, ...(culpritId ? { culprit: culpritId } : {}) },
      fixes: [
        {
          kind: 'check-values',
          confidence: 'suggested',
          detail: `check the time constants around ${culpritId ?? 'the reactive parts'}: a time constant far below the simulated window usually means a missing or tiny series resistance`,
        },
        {
          kind: 'tran-config',
          confidence: 'suggested',
          detail: `if the fast dynamics are real, shorten tstop or pass a smaller maxStep in tb.expect.tran(...) so the step floor (maxStep·1e-9) drops`,
        },
      ],
      at: culpritId ? elab.locOf.get(culpritId) : undefined,
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
    message: `the solver could not solve this circuit${sweepNote}: ${message}`,
    note: 'this usually means a topology problem the lint stage did not model; inspect the most recently changed components and nets',
    evidence: { engineMessage: message, ...(context.sweep ? { sweep: { ...context.sweep } } : {}) },
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
