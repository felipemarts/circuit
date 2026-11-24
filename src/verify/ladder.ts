import { elaborate, type BenchDescriptor, type Elaboration } from '../elab/bench';
import { runLint } from './lint';
import { runOp } from './op';
import { runTran } from './tran';
import { runDc } from './dc';
import { runAc } from './ac';
import type { StageOutcome } from './op';
import { ENGINE, RUN_SCHEMA } from '../schema/version';
import { STAGE_ORDER, type Diagnostic, type RunRecord, type StageName } from '../schema/types';

export interface LadderOptions {
  /** Stages to run (gating still applies). Default: all. */
  stages?: StageName[];
  /** Scalar overrides by component id (from --set or programmatic sweeps). */
  overrides?: Record<string, number>;
  /** Compute verified sizing hints on op-assertion failures. Default: true. */
  hints?: boolean;
}

const EMPTY_NETLIST = { hash: '', components: [], nets: {} };

/**
 * The verification ladder: lint → op → dc → ac → tran, fail-fast per stage.
 *
 * Exit-code contract (RunRecord.exitCode):
 *   0 = requested stages all pass
 *   1 = assertion failure — circuit valid, spec not met (tune values/topology)
 *   2 = diagnostic error — circuit invalid or unsolvable (fix structure first)
 *   3 = tooling error — the bench itself threw (fix the bench code)
 */
/** Why a stage verdict is 'fail': its own assertions, or a part outside its datasheet ratings. */
function failReason(stage: string, rec: { assertions?: { verdict: string }[]; ratings?: { verdict: string }[] }): string {
  if (rec.assertions?.some(a => a.verdict === 'fail')) return `${stage} assertions failed`;
  if (rec.ratings?.some(r => r.verdict === 'fail')) return `${stage} datasheet ratings exceeded`;
  return `${stage} assertions failed`;
}

export function runLadder(desc: BenchDescriptor, opts: LadderOptions = {}): RunRecord {
  const requested = opts.stages ?? STAGE_ORDER;
  const overrides = opts.overrides ?? {};
  const record: RunRecord = {
    schema: RUN_SCHEMA,
    bench: desc.name,
    netlist: EMPTY_NETLIST,
    engine: ENGINE,
    ...(Object.keys(overrides).length > 0 ? { overrides } : {}),
    stages: {},
    diagnostics: [],
    verdict: 'pass',
    exitCode: 0,
  };

  let elab: Elaboration;
  try {
    elab = elaborate(desc, overrides);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    record.diagnostics.push({
      code: 'T001',
      slug: 'bench-error',
      severity: 'error',
      stage: 'lint',
      message: `the bench threw during elaboration: ${message}`,
      note: 'this is an error in the bench code itself, not in the circuit; fix the bench and re-run',
      fixes: [],
    } satisfies Diagnostic);
    record.verdict = 'error';
    record.exitCode = 3;
    record.firstFailure = 'T001';
    return record;
  }
  record.netlist = elab.netlist;

  let gate: string | null = null;

  // ── L0: lint — ALWAYS runs. Solving a circuit the lint would reject means
  // silently dropping unreachable components and reporting fabricated numbers,
  // so `--stage op` must never bypass this gate.
  {
    const diagnostics = runLint(elab);
    record.diagnostics.push(...diagnostics);
    const hasErrors = diagnostics.some(d => d.severity === 'error');
    record.stages.lint = { verdict: hasErrors ? 'error' : 'pass' };
    if (hasErrors) gate = 'lint failed';
  }

  // A stage runner crash is a platform bug: it must still yield a RunRecord.
  const crashed = (stage: Exclude<StageName, 'lint'>, err: unknown): void => {
    const message = err instanceof Error ? err.message : String(err);
    record.stages[stage] = { verdict: 'error' };
    record.diagnostics.push({
      code: 'T002',
      slug: 'stage-crash',
      severity: 'error',
      stage,
      message: `the ${stage} stage crashed: ${message}`,
      note: 'this is a platform bug, not a circuit result — please report the bench that triggered it',
      evidence: { error: message },
      fixes: [],
    });
    gate = `${stage} crashed`;
  };

  // ── L1: op ──
  if (requested.includes('op')) {
    if (gate) {
      record.stages.op = { verdict: 'skipped', reason: gate };
    } else {
      try {
        const outcome = runOp(elab, { hints: opts.hints ?? true });
        record.stages.op = outcome.stage;
        record.diagnostics.push(...outcome.diagnostics);
        if (outcome.stage.verdict === 'error') gate = 'op failed';
        if (outcome.stage.verdict === 'fail') gate = failReason('op', outcome.stage);
      } catch (err) {
        crashed('op', err);
      }
    }
  }

  // ── L2: dc sweep · L2b: ac · L3: tran — each runs only when the bench
  // asserts on it, and each gates the next (fail-fast).
  const later: [Exclude<StageName, 'lint' | 'op'>, (e: Elaboration) => StageOutcome][] = [
    ['dc', runDc],
    ['ac', runAc],
    ['tran', runTran],
  ];
  for (const [stage, run] of later) {
    if (!requested.includes(stage) || !elab.assertions.some(a => a.stage === stage)) continue;
    if (gate) {
      record.stages[stage] = { verdict: 'skipped', reason: gate };
      continue;
    }
    try {
      const outcome = run(elab);
      record.stages[stage] = outcome.stage;
      record.diagnostics.push(...outcome.diagnostics);
      if (outcome.stage.verdict === 'error') gate = `${stage} failed`;
      if (outcome.stage.verdict === 'fail') gate = failReason(stage, outcome.stage);
    } catch (err) {
      crashed(stage, err);
    }
  }

  // ── Verdict + exit code ──
  const errorDiag = record.diagnostics.find(d => d.severity === 'error');
  // First failure in stage order: a failed assertion (its id) or, failing
  // that, an exceeded datasheet rating (its R4xx code).
  let failedAssertion: { id: string } | undefined;
  for (const s of STAGE_ORDER) {
    const st = record.stages[s];
    const a = st?.assertions?.find(x => x.verdict === 'fail');
    if (a) {
      failedAssertion = a;
      break;
    }
    const r = st?.ratings?.find(x => x.verdict === 'fail');
    if (r) {
      failedAssertion = { id: r.code };
      break;
    }
  }

  if (errorDiag) {
    record.verdict = 'error';
    // T-coded diagnostics are tooling/platform faults (exit 3), never a
    // statement about the circuit (exit 2).
    record.exitCode = errorDiag.code.startsWith('T') ? 3 : 2;
    record.firstFailure = errorDiag.code;
  } else if (failedAssertion) {
    record.verdict = 'fail';
    record.exitCode = 1;
    record.firstFailure = failedAssertion.id;
  } else {
    record.verdict = 'pass';
    record.exitCode = 0;
  }
  return record;
}
