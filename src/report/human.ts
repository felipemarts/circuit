import type { AssertionResult, CheckSpec, Diagnostic, RunRecord, StageName } from '../schema/types';
import { formatEng } from '../elab/units';

/**
 * Deterministic human/agent-readable rendering of a RunRecord. No colors, no
 * timestamps — two identical runs produce byte-identical output, so an agent
 * can diff consecutive runs cheaply.
 */
export function renderHuman(record: RunRecord): string {
  const lines: string[] = [];
  const hash = record.netlist.hash ? `  netlist ${record.netlist.hash.slice(0, 12)}` : '';
  const overrides = record.overrides
    ? `  set ${Object.entries(record.overrides)
        .map(([k, v]) => `${k}=${formatEng(v)}`)
        .join(',')}`
    : '';
  lines.push(`bench ${record.bench}${hash}${overrides}  (${record.engine})`);
  lines.push('');

  const stageNames: StageName[] = ['lint', 'op', 'tran'];
  for (const name of stageNames) {
    const stage = record.stages[name];
    const diags = record.diagnostics.filter(d => d.stage === name);
    if (!stage && diags.length === 0) continue;

    const verdict = stage?.verdict ?? 'error';
    const mark = verdict === 'pass' ? '✓' : verdict === 'skipped' ? '–' : '✗';
    const label = verdict === 'skipped' ? `skipped (${stage?.reason})` : verdict;
    lines.push(`  ${mark} ${name.padEnd(5)} ${label}`);

    for (const d of diags) {
      lines.push(...renderDiagnostic(d));
    }
    for (const a of stage?.assertions ?? []) {
      if (a.verdict === 'fail') lines.push(...renderFailedAssertion(a));
    }
    const passed = (stage?.assertions ?? []).filter(a => a.verdict === 'pass').length;
    if (passed > 0) {
      lines.push(`        ${passed} assertion${passed > 1 ? 's' : ''} passed`);
    }
  }

  lines.push('');
  const failCount =
    record.diagnostics.filter(d => d.severity === 'error').length +
    stageNames.flatMap(s => record.stages[s]?.assertions ?? []).filter(a => a.verdict === 'fail').length;
  const head = record.verdict === 'pass' ? 'PASS' : record.verdict === 'fail' ? 'FAIL' : 'ERROR';
  const first = record.firstFailure ? ` · first failure: ${record.firstFailure}` : '';
  lines.push(`${head}${failCount > 0 ? ` · ${failCount} problem${failCount > 1 ? 's' : ''}` : ''}${first} · exit ${record.exitCode}`);
  return lines.join('\n');
}

function renderDiagnostic(d: Diagnostic): string[] {
  const lines: string[] = [];
  const sev = d.severity === 'warning' ? 'warning ' : '';
  lines.push(`        ${d.code} ${sev}${d.message}`);
  if (d.at) lines.push(`          at ${d.at}`);
  if (d.note) lines.push(`          note: ${d.note}`);
  for (const fix of d.fixes) {
    lines.push(`          fix (${fix.confidence}): ${fix.detail}`);
  }
  lines.push(`          docs: forge explain ${d.code}`);
  return lines;
}

function renderFailedAssertion(a: AssertionResult): string[] {
  const lines: string[] = [];
  const margin =
    a.margin !== undefined
      ? ` (outside by ${formatEng(a.margin.outsideBy)}${a.margin.ratio !== undefined ? `, ${a.margin.ratio}x` : ''})`
      : '';
  lines.push(`        A301 ${a.id}: ${a.probe} ${describeCheck(a.check)} — measured ${formatEng(a.measured ?? NaN)}${margin}`);
  if (a.at) lines.push(`          at ${a.at}`);
  if (a.tFirstViolation !== undefined) {
    lines.push(`          first violation at t=${formatEng(a.tFirstViolation, 's')}`);
  }
  if (a.hint) {
    const [lo, hi] = a.hint.passingRange;
    lines.push(
      `          hint (verified): ${a.hint.param} in [${formatEng(lo)}, ${formatEng(hi)}] passes all op assertions — try ${a.hint.param} = ${formatEng(a.hint.suggestedValue)}`,
    );
  }
  return lines;
}

export function describeCheck(check: CheckSpec): string {
  switch (check.op) {
    case 'within':
      return `within [${formatEng(check.min)}, ${formatEng(check.max)}]`;
    case 'closeTo':
      return `close to ${formatEng(check.value)} ± ${formatEng(check.tol)}`;
    case 'above':
      return `above ${formatEng(check.value)}`;
    case 'below':
      return `below ${formatEng(check.value)}`;
    case 'settleWithin':
      return `settles to ${formatEng(check.target)} ± ${Math.round(check.tol * 100)}% by ${formatEng(check.by, 's')} (measured: settle time)`;
    case 'neverExceed':
      return `never exceeds ${formatEng(check.value)}`;
    case 'stayAbove':
      return `stays above ${formatEng(check.value)}${check.from !== undefined ? ` from ${formatEng(check.from, 's')}` : ''}`;
    case 'stayBelow':
      return `stays below ${formatEng(check.value)}${check.from !== undefined ? ` from ${formatEng(check.from, 's')}` : ''}`;
    case 'rippleBelow':
      return `ripple below ${formatEng(check.amplitude)}${check.from !== undefined ? ` from ${formatEng(check.from, 's')}` : ''}`;
    case 'finalCloseTo':
      return `ends close to ${formatEng(check.value)} ± ${formatEng(check.tol)}`;
  }
}
