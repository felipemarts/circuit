import { elaborate, type BenchDescriptor } from '../elab/bench';
import { runLint } from './lint';
import { runOp } from './op';
import { runTran } from './tran';
import { ENGINE } from '../schema/version';
import type { Diagnostic, RunRecord, StageName } from '../schema/types';

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
 * The verification ladder: L0 lint → L1 op → L3 tran, fail-fast per stage.
 *
 * Exit-code contract (RunRecord.exitCode):
 *   0 = requested stages all pass
 *   1 = assertion failure — circuit valid, spec not met (tune values/topology)
 *   2 = diagnostic error — circuit invalid or unsolvable (fix structure first)
 *   3 = tooling error — the bench itself threw (fix the bench code)
 */
export function runLadder(desc: BenchDescriptor, opts: LadderOptions = {}): RunRecord {
  const requested = opts.stages ?? ['lint', 'op', 'tran'];
  const overrides = opts.overrides ?? {};
  const record: RunRecord = {
    schema: 'forge-run/0.1',
    bench: desc.name,
    netlist: EMPTY_NETLIST,
    engine: ENGINE,
    ...(Object.keys(overrides).length > 0 ? { overrides } : {}),
    stages: {},
    diagnostics: [],
    verdict: 'pass',
    exitCode: 0,
  };

  let elab;
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

  // ── L0: lint ──
  if (requested.includes('lint')) {
    const diagnostics = runLint(elab);
    record.diagnostics.push(...diagnostics);
    const hasErrors = diagnostics.some(d => d.severity === 'error');
    record.stages.lint = { verdict: hasErrors ? 'error' : 'pass' };
    if (hasErrors) gate = 'lint failed';
  }

  // ── L1: op ──
  if (requested.includes('op')) {
    if (gate) {
      record.stages.op = { verdict: 'skipped', reason: gate };
    } else {
      const outcome = runOp(elab, { hints: opts.hints ?? true });
      record.stages.op = outcome.stage;
      record.diagnostics.push(...outcome.diagnostics);
      if (outcome.stage.verdict === 'error') gate = 'op failed';
      if (outcome.stage.verdict === 'fail') gate = 'op assertions failed';
    }
  }

  // ── L3: tran ──
  const hasTran = elab.assertions.some(a => a.stage === 'tran');
  if (requested.includes('tran') && hasTran) {
    if (gate) {
      record.stages.tran = { verdict: 'skipped', reason: gate };
    } else {
      const outcome = runTran(elab);
      record.stages.tran = outcome.stage;
      record.diagnostics.push(...outcome.diagnostics);
    }
  }

  // ── Verdict + exit code ──
  const errorDiag = record.diagnostics.find(d => d.severity === 'error');
  const failedAssertion = (['op', 'tran'] as const)
    .flatMap(s => record.stages[s]?.assertions ?? [])
    .find(a => a.verdict === 'fail');

  if (errorDiag) {
    record.verdict = 'error';
    record.exitCode = 2;
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
