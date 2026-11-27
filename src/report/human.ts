import { STAGE_ORDER, type LogicCapture, type SerialCapture, type RatingResult, type AssertionResult, type CheckSpec, type Diagnostic, type RunRecord, type ScalarCheck, type StageRecord } from '../schema/types';
import { formatEng } from '../elab/units';
import type { PcbRecord } from '../pcb/types';
import { CLI } from '../schema/version';

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

  for (const name of STAGE_ORDER) {
    const stage = record.stages[name];
    const diags = record.diagnostics.filter(d => d.stage === name);
    if (!stage && diags.length === 0) continue;

    const verdict = stage?.verdict ?? 'error';
    const mark = verdict === 'pass' ? '✓' : verdict === 'skipped' ? '–' : '✗';
    const label = verdict === 'skipped' ? `skipped (${stage?.reason})` : verdict;
    lines.push(`  ${mark} ${name.padEnd(5)} ${label}`);

    const solver = stage ? solverLine(stage) : undefined;
    if (solver) lines.push(`        ${solver}`);
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
    if (stage?.logic && stage.logic.length > 0) lines.push(...renderLogic(stage.logic));
    if (stage?.serial && stage.serial.length > 0) lines.push(...renderSerial(stage.serial));
    if (stage?.ratings && stage.ratings.length > 0) lines.push(...renderRatings(stage.ratings));
    if (stage?.pcb) lines.push(renderPcb(stage.pcb));
  }

  lines.push('');
  const failCount =
    record.diagnostics.filter(d => d.severity === 'error').length +
    STAGE_ORDER.flatMap(s => record.stages[s]?.assertions ?? []).filter(a => a.verdict === 'fail').length +
    STAGE_ORDER.flatMap(s => record.stages[s]?.ratings ?? []).filter(r => r.verdict === 'fail').length;
  const head = record.verdict === 'pass' ? 'PASS' : record.verdict === 'fail' ? 'FAIL' : 'ERROR';
  const first = record.firstFailure ? ` · first failure: ${record.firstFailure}` : '';
  lines.push(`${head}${failCount > 0 ? ` · ${failCount} problem${failCount > 1 ? 's' : ''}` : ''}${first} · exit ${record.exitCode}`);
  return lines.join('\n');
}

/** One line of solver telemetry, only when it says something non-routine. */
function solverLine(stage: StageRecord): string | undefined {
  const s = stage.solver;
  if (!s) return undefined;
  if (s.aids && s.aids.length > 0) {
    return `solver: plain newton failed; converged with ${s.aids[s.aids.length - 1]} (${s.iterations} iterations)`;
  }
  if (s.runs && s.runs.length > 0 && s.runs.every(r => r.acceptedSteps === 0 && r.digitalEvents !== undefined)) {
    return `digital engine only (no analog parts): ${s.runs.reduce((n, r) => n + (r.digitalEvents ?? 0), 0)} events`;
  }
  if (s.runs && s.runs.length > 0) {
    return `solver: ${s.method}, ${s.acceptedSteps} steps accepted, ${s.rejectedSteps} rejected, min step ${formatEng(s.minStep ?? 0, 's')}`;
  }
  if (s.aidedPoints) return `solver: ${s.aidedPoints} of ${s.points} sweep points needed convergence aids`;
  return undefined;
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
  lines.push(`          docs: ${CLI} explain ${d.code}`);
  return lines;
}

/** One line per board: size, parts, ratsnest. */
function renderPcb(p: PcbRecord): string {
  const b = p.board;
  const parts = [`${p.stats.placed} placed`, ...(p.stats.unplaced ? [`${p.stats.unplaced} unplaced`] : []), ...(p.stats.offBoard ? [`${p.stats.offBoard} off-board`] : [])];
  return `        board ${b.width}×${b.height} mm, ${b.layers} layer${b.layers > 1 ? 's' : ''}, ${b.tech} · ${parts.join(', ')} · ${p.stats.nets} nets to route, ${p.stats.airwires} airwires (${p.stats.airwireLength} mm)`;
}

const LOGIC_SIGNALS_SHOWN = 8;
const SERIAL_LINES_SHOWN = 3;

/** Serial output per MCU and run: line count and the last lines (full log: --json). */
function renderSerial(captures: SerialCapture[]): string[] {
  return captures.map(cap => {
    const last = cap.lines.slice(-SERIAL_LINES_SHOWN).map(([t, text]) => `${formatEng(t, 's')} ${JSON.stringify(text)}`);
    const n = cap.lines.length;
    return `        serial ${cap.mcu} [${cap.config}]: ${n} line${n === 1 ? '' : 's'}${last.length ? ` — last: ${last.join(' · ')}` : ''}${cap.partial ? ` · partial ${JSON.stringify(cap.partial[1])}` : ''}${cap.truncated ? ' (truncated)' : ''}`;
  });
}

/**
 * Logic-analyzer capture of a mixed-signal transient, one line per run:
 * per signal its number of changes and final level (full traces: --json / --vcd).
 */
function renderLogic(captures: LogicCapture[]): string[] {
  return captures.map(cap => {
    const entries = Object.entries(cap.signals);
    const shown = entries.slice(0, LOGIC_SIGNALS_SHOWN).map(([name, trace]) => {
      const changes = Math.max(0, trace.length - 1);
      return `${name} ${changes} change${changes === 1 ? '' : 's'}, final ${trace.length > 0 ? trace[trace.length - 1][1] : '?'}`;
    });
    const more = entries.length > LOGIC_SIGNALS_SHOWN ? ` · +${entries.length - LOGIC_SIGNALS_SHOWN} more` : '';
    const cut = cap.truncated && cap.truncated.length > 0 ? ` (truncated: ${cap.truncated.join(', ')})` : '';
    return `        logic [${cap.config}]: ${shown.join(' · ')}${more}${cut}`;
  });
}

/**
 * Datasheet ratings of real parts, shown apart from the bench's spec: every
 * violation in full, then a one-line summary with the tightest margin.
 */
function renderRatings(ratings: RatingResult[]): string[] {
  const lines: string[] = [];
  for (const r of ratings) {
    if (r.verdict !== 'fail') continue;
    lines.push(`        ${r.code} ratings: ${r.message}`);
    if (r.at) lines.push(`          at ${r.at}`);
    if (r.tFirstViolation !== undefined) lines.push(`          first exceeded at t=${formatEng(r.tFirstViolation, 's')}`);
    lines.push(`          datasheet: ${r.part} ${r.rating} max ${formatEng(r.limit, r.unit)} — ${r.source}${r.modelEstimated ? ' (model card estimated)' : ''}`);
    for (const fix of r.fixes ?? []) lines.push(`          fix (${fix.confidence}): ${fix.detail}`);
    lines.push(`          docs: ${CLI} explain ${r.code}`);
  }
  const failed = ratings.filter(r => r.verdict === 'fail').length;
  const tightest = ratings.filter(r => r.verdict === 'pass').sort((a, b) => b.utilization - a.utilization)[0];
  const parts = [...new Set(ratings.map(r => r.component))].length;
  lines.push(
    `        ratings (datasheet absolute max, simulated): ${ratings.length} checked on ${parts} part${parts > 1 ? 's' : ''}, ${failed} exceeded${
      tightest ? ` · tightest passing: ${tightest.component} ${tightest.rating} at ${Math.round(tightest.utilization * 100)}%` : ''
    }`,
  );
  return lines;
}

function renderFailedAssertion(a: AssertionResult): string[] {
  const lines: string[] = [];
  const margin =
    a.margin !== undefined
      ? ` (outside by ${formatEng(a.margin.outsideBy)}${a.margin.ratio !== undefined ? `, ${a.margin.ratio}x` : ''})`
      : '';
  const measured =
    a.measuredLogic !== undefined && a.measured === undefined
      ? `measured ${a.measuredLogic}`
      : a.measured !== undefined
        ? `measured ${formatEng(a.measured)}${margin}`
        : 'not measurable';
  const probe = a.ref ? `${a.probe}/${a.ref}` : a.probe;
  lines.push(`        A301 ${a.id}: ${probe} ${describeCheck(a.check)} — ${measured}`);
  if (a.at) lines.push(`          at ${a.at}`);
  if (a.note) lines.push(`          note: ${a.note}`);
  if (a.tFirstViolation !== undefined) {
    lines.push(`          first violation at t=${formatEng(a.tFirstViolation, 's')}`);
  }
  if (a.xFirstViolation !== undefined) {
    lines.push(`          first violation at x=${formatEng(a.xFirstViolation)}`);
  }
  if (a.hint) {
    const [lo, hi] = a.hint.passingRange;
    lines.push(
      `          hint (verified): ${a.hint.param} in [${formatEng(lo)}, ${formatEng(hi)}] passes all op assertions — try ${a.hint.param} = ${formatEng(a.hint.suggestedValue)}`,
    );
  }
  return lines;
}

function describeScalar(check: ScalarCheck): string {
  switch (check.op) {
    case 'within':
      return `within [${formatEng(check.min)}, ${formatEng(check.max)}]`;
    case 'closeTo':
      return `close to ${formatEng(check.value)} ± ${formatEng(check.tol)}`;
    case 'above':
      return `above ${formatEng(check.value)}`;
    case 'below':
      return `below ${formatEng(check.value)}`;
  }
}

export function describeCheck(check: CheckSpec): string {
  switch (check.op) {
    case 'within':
    case 'closeTo':
    case 'above':
    case 'below':
      return describeScalar(check);
    case 'at':
      return `at x=${formatEng(check.x)} ${describeScalar(check.check)}`;
    case 'slopeAt':
      return `slope at x=${formatEng(check.x)} ${describeScalar(check.check)}`;
    case 'monotonic':
      return `monotonically ${check.direction}`;
    case 'crosses':
      return `crosses ${formatEng(check.level)}${
        check.min !== undefined ? ` between x=${formatEng(check.min)} and ${formatEng(check.max ?? Infinity)}` : ''
      } (measured: crossing x)`;
    case 'gainAt':
      return `gain at ${formatEng(check.f, 'Hz')} ${describeScalar(check.check)} dB`;
    case 'phaseAt':
      return `phase at ${formatEng(check.f, 'Hz')} ${describeScalar(check.check)} deg`;
    case 'bandwidth3dB':
      return `-3 dB bandwidth ${describeScalar(check.check)} Hz`;
    case 'unityGainFrequency':
      return `unity-gain frequency ${describeScalar(check.check)} Hz`;
    case 'phaseMargin':
      return `phase margin ${describeScalar(check.check)} deg`;
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
    case 'logicAt':
      return `is ${check.value} at t=${formatEng(check.t, 's')}`;
    case 'logicEdges': {
      const n = check.count !== undefined ? `exactly ${check.count}` : check.max === undefined ? `at least ${check.min}` : check.min === undefined ? `at most ${check.max}` : `${check.min}–${check.max}`;
      return `toggles ${n} times (${check.edge} edges)${logicWindow(check.from, check.to)} (measured: edges)`;
    }
    case 'logicFrequency':
      return `frequency ${formatEng(check.value, 'Hz')} ± ${Number((check.tol * 100).toPrecision(3))}%${logicWindow(check.from, check.to)}`;
    case 'logicDutyCycle':
      return `duty cycle ${check.value} ± ${check.tol}${logicWindow(check.from, check.to)}`;
    case 'logicStable':
      return `stable${check.value !== undefined ? ` at ${check.value}` : ''} from ${formatEng(check.from, 's')} to ${formatEng(check.to, 's')}`;
    case 'serialContains':
      return `serial output contains ${JSON.stringify(check.text)}${check.by !== undefined ? ` by ${formatEng(check.by, 's')}` : ''} (measured: time printed)`;
    case 'serialNotContains':
      return `serial output never contains ${JSON.stringify(check.text)}`;
    case 'serialMatches':
      return `serial output matches /${check.pattern}/${check.flags ?? ''}`;
    case 'serialLines':
      return `serial output has ${check.count !== undefined ? `exactly ${check.count}` : check.max === undefined ? `at least ${check.min}` : check.min === undefined ? `at most ${check.max}` : `${check.min}–${check.max}`} lines (measured: lines)`;
  }
}

function logicWindow(from?: number, to?: number): string {
  if (from === undefined && to === undefined) return '';
  return ` in [${formatEng(from ?? 0, 's')}, ${to !== undefined ? formatEng(to, 's') : 'tstop'}]`;
}
