/**
 * Panel models: pure transformations from (document, RunRecord, waveforms)
 * to what each viewer panel shows. No DOM — fully unit-testable.
 */
import type { CircuitDoc } from '../doc/types';
import type { AssertionResult, CheckSpec, Diagnostic, LogicCapture, LogicLevel, RatingResult, RunRecord, Severity, StageName, VerifiedParamHint } from '../schema/types';
import { STAGE_ORDER } from '../schema/types';
import { checkLabel, eng, measuredUnit, probeUnit, secs } from './format';
import type { SimResult } from './simulate';
import { languageOf, type SourceLang } from './highlight';

// ─── verdict ─────────────────────────────────────────────────────────────────

export interface VerdictModel {
  verdict: 'pass' | 'fail' | 'error';
  exitCode: 0 | 1 | 2 | 3;
  /** i18n key of the exit-code meaning. */
  meaningKey: 'exit0' | 'exit1' | 'exit2' | 'exit3';
  bench: string;
  title: string;
  description?: string;
  author?: string;
  hash: string;
  engine: string;
  firstFailure?: string;
  stages: { name: StageName; verdict: 'pass' | 'fail' | 'error' | 'skipped' | 'absent'; reason?: string; count: number }[];
  counts: { pass: number; fail: number; errors: number; warnings: number; ratingFails: number };
  overrides?: Record<string, number>;
}

export function verdictModel(doc: CircuitDoc, record: RunRecord): VerdictModel {
  const stages = STAGE_ORDER.map(name => {
    const st = record.stages[name];
    return { name, verdict: st?.verdict ?? ('absent' as const), reason: st?.reason, count: st?.assertions?.length ?? 0 };
  });
  let pass = 0;
  let fail = 0;
  let ratingFails = 0;
  for (const st of Object.values(record.stages)) {
    for (const a of st?.assertions ?? []) a.verdict === 'pass' ? pass++ : fail++;
    for (const r of st?.ratings ?? []) if (r.verdict === 'fail') ratingFails++;
  }
  const errors = record.diagnostics.filter(d => d.severity === 'error').length;
  const warnings = record.diagnostics.filter(d => d.severity === 'warning').length;
  return {
    verdict: record.verdict,
    exitCode: record.exitCode,
    meaningKey: `exit${record.exitCode}` as VerdictModel['meaningKey'],
    bench: record.bench,
    title: doc.meta?.title ?? record.bench,
    description: doc.meta?.description,
    author: doc.meta?.author,
    hash: record.netlist.hash,
    engine: record.engine,
    firstFailure: record.firstFailure,
    stages,
    counts: { pass, fail, errors, warnings, ratingFails },
    overrides: record.overrides,
  };
}

// ─── assertions ──────────────────────────────────────────────────────────────

export interface AssertionModel {
  id: string;
  stage: StageName;
  probe: string;
  ref?: string;
  verdict: 'pass' | 'fail';
  check: CheckSpec;
  expected: string;
  measured?: string;
  measuredValue?: number;
  measuredLogic?: LogicLevel;
  margin?: string;
  note?: string;
  tFirstViolation?: number;
  xFirstViolation?: number;
  hint?: VerifiedParamHint;
  hintText?: string;
  /** Where the chip sits on the schematic. */
  anchor: ChipAnchor;
  /** Short chip text: "D1.i 8.68 mA". */
  chip: string;
}

export type ChipAnchor = { kind: 'component' | 'net' | 'pin'; id: string };

function anchorOf(probe: string, doc: CircuitDoc): ChipAnchor {
  const m = probe.match(/^([A-Za-z][A-Za-z0-9_]*)\.(.+)$/);
  const comp = m ? doc.components.find(c => c.id === m[1]) : undefined;
  if (m && comp) {
    // 'U1.1Y' (an IC / primitive pin) anchors at the pin; 'Q1.ic' (a device quantity) at the part.
    if (m[2] in comp.pins && !(m[2] === 'i' || m[2] === 'v')) return { kind: 'pin', id: probe };
    return { kind: 'component', id: m[1] };
  }
  return { kind: 'net', id: probe };
}

export function hintText(h: VerifiedParamHint, unitOf: string): string {
  const [lo, hi] = h.passingRange;
  return `${h.param} in [${eng(lo, unitOf)}, ${eng(hi, unitOf)}] passes · suggested ${eng(h.suggestedValue, unitOf)}`;
}

function paramUnit(doc: CircuitDoc, id: string): string {
  const c = doc.components.find(x => x.id === id);
  switch (c?.type) {
    case 'Resistor':
      return 'Ω';
    case 'Capacitor':
      return 'F';
    case 'Inductor':
      return 'H';
    case 'VoltageSource':
      return 'V';
    case 'CurrentSource':
      return 'A';
    default:
      return '';
  }
}

export function assertionModels(doc: CircuitDoc, record: RunRecord): AssertionModel[] {
  const out: AssertionModel[] = [];
  for (const stage of STAGE_ORDER) {
    for (const a of record.stages[stage]?.assertions ?? []) out.push(assertionModel(doc, a));
  }
  out.sort((x, y) => Number(x.id.slice(1)) - Number(y.id.slice(1)));
  return out;
}

export function assertionModel(doc: CircuitDoc, a: AssertionResult): AssertionModel {
  const unit = measuredUnit(a.check, a.probe);
  const expected = checkLabel(a.check as { op: string }, a.check.op in SCALAR_OPS || a.stage === 'tran' ? probeUnit(a.probe) : unit);
  let measured: string | undefined;
  if (a.measuredLogic !== undefined && a.measured === undefined) measured = String(a.measuredLogic);
  else if (a.measured !== undefined && (a.check.op === 'logicAt' || a.check.op === 'logicStable')) measured = String(a.measured);
  else if (a.measured !== undefined) {
    if (a.check.op === 'logicDutyCycle') measured = `${(a.measured * 100).toFixed(1)} %`;
    else if (a.check.op === 'logicEdges' || a.check.op === 'crosses') measured = a.check.op === 'crosses' ? eng(a.measured) : String(a.measured);
    else measured = eng(a.measured, unit);
  }
  let margin: string | undefined;
  if (a.margin) {
    margin = `${eng(a.margin.outsideBy, unit === '%' ? '' : unit)} outside${a.margin.ratio !== undefined && Number.isFinite(a.margin.ratio) ? ` (×${a.margin.ratio.toFixed(2)})` : ''}`;
  }
  const chipVal = measured ?? (a.note ? '?' : '');
  const anchor = anchorOf(a.probe, doc);
  const quantity = anchor.kind === 'net' ? a.probe : a.probe.slice(a.probe.indexOf('.') + 1);
  const probeShort = quantity.length > 14 ? `${quantity.slice(0, 13)}…` : quantity;
  return {
    id: a.id,
    stage: a.stage,
    probe: a.probe,
    ref: a.ref,
    verdict: a.verdict,
    check: a.check,
    expected,
    measured,
    measuredValue: a.measured,
    measuredLogic: a.measuredLogic,
    margin,
    note: a.note,
    tFirstViolation: a.tFirstViolation,
    xFirstViolation: a.xFirstViolation,
    hint: a.hint,
    hintText: a.hint ? hintText(a.hint, paramUnit(doc, a.hint.param)) : undefined,
    anchor,
    chip: `${probeShort} ${chipVal}`.trim(),
  };
}

const SCALAR_OPS: Record<string, true> = { within: true, closeTo: true, above: true, below: true };

// ─── diagnostics ─────────────────────────────────────────────────────────────

export interface DiagnosticModel {
  code: string;
  slug: string;
  severity: 'error' | 'warning';
  stage: StageName;
  message: string;
  note?: string;
  components: string[];
  net?: string;
  pins?: string[];
  fixes: { kind: string; confidence: 'verified' | 'mechanical' | 'suggested'; detail: string; patch?: string }[];
  evidence?: Record<string, unknown>;
  at?: string;
  explain: string;
}

export function diagnosticModels(record: RunRecord): DiagnosticModel[] {
  return record.diagnostics.map(d => diagnosticModel(d));
}

export function diagnosticModel(d: Diagnostic): DiagnosticModel {
  return {
    code: d.code,
    slug: d.slug,
    severity: d.severity,
    stage: d.stage,
    message: d.message,
    note: d.note,
    components: d.subject?.components ?? [],
    net: d.subject?.net,
    pins: d.subject?.pins,
    fixes: d.fixes ?? [],
    evidence: d.evidence,
    at: d.at,
    explain: `npx circuitsvibe explain ${d.code}`,
  };
}

// ─── ratings ─────────────────────────────────────────────────────────────────

export interface RatingRow {
  code: string;
  stage: StageName;
  rating: string;
  description: string;
  quantity: string;
  measure: RatingResult['measure'];
  value: number;
  allowed: number;
  limit: number;
  derate?: number;
  unit: string;
  utilization: number;
  verdict: 'pass' | 'fail';
  valueText: string;
  allowedText: string;
  limitText: string;
  source: string;
  url?: string;
  estimated?: boolean;
  modelEstimated?: boolean;
  message?: string;
  note?: string;
  fixes: RatingResult['fixes'];
  hintText?: string;
  time?: number;
  config?: string;
}

export interface RatingGroup {
  component: string;
  part: string;
  rows: RatingRow[];
  worst: number;
  failed: boolean;
}

export function ratingGroups(doc: CircuitDoc, record: RunRecord): RatingGroup[] {
  const groups = new Map<string, RatingGroup>();
  for (const stage of STAGE_ORDER) {
    for (const r of record.stages[stage]?.ratings ?? []) {
      const g = groups.get(r.component) ?? { component: r.component, part: r.part, rows: [], worst: 0, failed: false };
      g.rows.push({
        code: r.code,
        stage,
        rating: r.rating,
        description: r.description,
        quantity: r.quantity,
        measure: r.measure,
        value: r.value,
        allowed: r.allowed,
        limit: r.limit,
        derate: r.derate,
        unit: r.unit,
        utilization: r.utilization,
        verdict: r.verdict,
        valueText: eng(r.value, r.unit),
        allowedText: eng(r.allowed, r.unit),
        limitText: eng(r.limit, r.unit),
        source: r.source,
        url: r.url,
        estimated: r.estimated,
        modelEstimated: r.modelEstimated,
        message: r.message,
        note: r.note,
        fixes: r.fixes,
        hintText: r.hint ? hintText(r.hint, paramUnit(doc, r.hint.param)) : undefined,
        time: r.time,
        config: r.config,
      });
      g.worst = Math.max(g.worst, r.utilization);
      if (r.verdict === 'fail') g.failed = true;
      groups.set(r.component, g);
    }
  }
  // Keep one row per (rating, stage) — the stages already differ; sort by utilization desc.
  const out = [...groups.values()].sort((a, b) => a.component.localeCompare(b.component));
  for (const g of out) g.rows.sort((a, b) => b.utilization - a.utilization || a.rating.localeCompare(b.rating));
  return out;
}

// ─── highlights ──────────────────────────────────────────────────────────────

export interface HighlightModel {
  id: string;
  kind: 'error' | 'warning' | 'rating';
  badge?: string;
}

export function highlightModels(record: RunRecord): HighlightModel[] {
  const out = new Map<string, HighlightModel>();
  for (const d of record.diagnostics) {
    for (const id of d.subject?.components ?? []) {
      const prev = out.get(id);
      if (!prev || (prev.kind === 'warning' && d.severity === 'error')) out.set(id, { id, kind: d.severity, badge: d.code });
    }
  }
  for (const st of Object.values(record.stages)) {
    for (const r of st?.ratings ?? []) {
      if (r.verdict !== 'fail') continue;
      if (!out.has(r.component) || out.get(r.component)!.kind !== 'error') out.set(r.component, { id: r.component, kind: 'rating', badge: r.code });
    }
  }
  return [...out.values()].sort((a, b) => a.id.localeCompare(b.id));
}

// ─── scope (transient) ───────────────────────────────────────────────────────

export interface Band {
  kind: 'line' | 'region' | 'band';
  /** y value (line) / [lo, hi] (region) / target ± tol (band) */
  y?: number;
  lo?: number;
  hi?: number;
  /** time window */
  from?: number;
  to?: number;
  label: string;
  verdict: 'pass' | 'fail';
}

export interface Trace {
  probe: string;
  unit: string;
  t: number[];
  y: number[];
  bands: Band[];
  assertionIds: string[];
  verdict: 'pass' | 'fail' | 'none';
  tFirstViolation?: number;
}

export interface ScopeModel {
  label: string;
  tstop: number;
  traces: Trace[];
}

export function scopeModel(doc: CircuitDoc, record: RunRecord, sim: SimResult): ScopeModel | undefined {
  const tr = sim.tran;
  if (!tr || tr.digitalOnly) return undefined;
  const results = record.stages.tran?.assertions ?? [];
  // Analog probes only: logic-asserted pins and nets live in the logic analyzer.
  const logicProbes = new Set(results.filter(a => isLogicOp(a.check.op)).map(a => a.probe));
  const analogProbes = new Set(results.filter(a => !isLogicOp(a.check.op)).map(a => a.probe));
  const probes = Object.keys(tr.probes).filter(p => analogProbes.has(p) || !logicProbes.has(p)).sort();
  const traces: Trace[] = [];
  for (const probe of probes) {
    const y = tr.probes[probe];
    const specOf = (id: string) => doc.assertions.find(s => s.id === id);
    const mine = results.filter(a => a.probe === probe && specOf(a.id)?.tran?.tstop === tr.config.tstop);
    const bands: Band[] = [];
    let verdict: Trace['verdict'] = mine.length === 0 ? 'none' : mine.every(a => a.verdict === 'pass') ? 'pass' : 'fail';
    let tFirst: number | undefined;
    for (const a of mine) {
      const ch = a.check as CheckSpec & { from?: number };
      const v = a.verdict;
      const unit = probeUnit(probe);
      switch (ch.op) {
        case 'neverExceed':
          bands.push({ kind: 'line', y: ch.value, label: `≤ ${eng(ch.value, unit)}`, verdict: v });
          break;
        case 'stayAbove':
          bands.push({ kind: 'region', lo: -Infinity, hi: ch.value, from: ch.from, label: `≥ ${eng(ch.value, unit)}`, verdict: v });
          break;
        case 'stayBelow':
          bands.push({ kind: 'region', lo: ch.value, hi: Infinity, from: ch.from, label: `≤ ${eng(ch.value, unit)}`, verdict: v });
          break;
        case 'settleWithin':
          bands.push({ kind: 'band', lo: ch.target * (1 - ch.tol), hi: ch.target * (1 + ch.tol), from: ch.by, label: `${eng(ch.target, unit)} ±${Math.round(ch.tol * 100)} % by ${secs(ch.by)}`, verdict: v });
          break;
        case 'finalCloseTo':
          bands.push({ kind: 'band', lo: ch.value - ch.tol, hi: ch.value + ch.tol, from: tr.config.tstop * 0.98, label: `ends ≈ ${eng(ch.value, unit)}`, verdict: v });
          break;
        case 'rippleBelow':
          bands.push({ kind: 'line', y: NaN, from: ch.from ?? tr.config.tstop / 2, label: `ripple < ${eng(ch.amplitude, unit)}`, verdict: v });
          break;
        default:
          break;
      }
      if (a.tFirstViolation !== undefined) tFirst = tFirst === undefined ? a.tFirstViolation : Math.min(tFirst, a.tFirstViolation);
    }
    traces.push({ probe, unit: probeUnit(probe), t: tr.t, y, bands, assertionIds: mine.map(a => a.id), verdict, tFirstViolation: tFirst });
  }
  // Also show every user-named net that is not already a probe (context for the reader).
  for (const net of doc.nets ?? []) {
    if (probes.includes(net) || !tr.nets[net]) continue;
    traces.push({ probe: net, unit: 'V', t: tr.t, y: tr.nets[net], bands: [], assertionIds: [], verdict: 'none' });
  }
  return { label: tr.label, tstop: tr.config.tstop, traces };
}

// ─── bode (ac) ───────────────────────────────────────────────────────────────

export interface BodeMarker {
  f: number;
  gain?: number;
  phase?: number;
  label: string;
  verdict: 'pass' | 'fail';
  kind: 'gainAt' | 'phaseAt' | 'bandwidth3dB' | 'unityGainFrequency' | 'phaseMargin';
}

export interface BodeCurve {
  probe: string;
  ref?: string;
  f: number[];
  gain: number[];
  phase: number[];
  markers: BodeMarker[];
  assertionIds: string[];
}

export function bodeModel(record: RunRecord, sim: SimResult): BodeCurve[] {
  const results = record.stages.ac?.assertions ?? [];
  const out: BodeCurve[] = [];
  for (const ac of sim.ac) {
    for (const c of ac.curves) {
      const mine = results.filter(a => a.probe === c.probe && (a.ref ?? undefined) === (c.ref ?? undefined));
      const markers: BodeMarker[] = [];
      const gainAt = (f: number) => interpLog(ac.f, c.gain, f);
      const phaseAt = (f: number) => interpLog(ac.f, c.phase, f);
      for (const a of mine) {
        const ch = a.check;
        const v = a.verdict;
        if (ch.op === 'gainAt') markers.push({ f: ch.f, gain: a.measured ?? gainAt(ch.f), label: `${eng(a.measured ?? gainAt(ch.f), 'dB')} @ ${eng(ch.f, 'Hz')}`, verdict: v, kind: 'gainAt' });
        else if (ch.op === 'phaseAt') markers.push({ f: ch.f, phase: a.measured ?? phaseAt(ch.f), label: `${(a.measured ?? phaseAt(ch.f)).toFixed(1)}° @ ${eng(ch.f, 'Hz')}`, verdict: v, kind: 'phaseAt' });
        else if (ch.op === 'bandwidth3dB' && a.measured !== undefined) {
          // Mark the −3 dB edges: both for a band-pass (BW = f_high − f_low), the upper one for a low-pass.
          const edges = minus3dbEdges(ac.f, c.gain);
          const level = Math.max(...c.gain) - 3.0103;
          if (edges.low !== undefined && edges.high !== undefined) {
            markers.push({ f: edges.high, gain: level, label: `f_high ${eng(edges.high, 'Hz')}`, verdict: v, kind: 'bandwidth3dB' });
            markers.push({ f: edges.low, gain: level, label: `f_low ${eng(edges.low, 'Hz')} · BW ${eng(a.measured, 'Hz')}`, verdict: v, kind: 'bandwidth3dB' });
          } else markers.push({ f: edges.high ?? a.measured, gain: level, label: `−3 dB @ ${eng(edges.high ?? a.measured, 'Hz')}`, verdict: v, kind: 'bandwidth3dB' });
        } else if (ch.op === 'unityGainFrequency' && a.measured !== undefined) markers.push({ f: a.measured, gain: 0, label: `0 dB @ ${eng(a.measured, 'Hz')}`, verdict: v, kind: 'unityGainFrequency' });
        else if (ch.op === 'phaseMargin' && a.measured !== undefined) {
          const fm = a.note?.match(/frequency ([0-9.eE+-]+) Hz/);
          const fu = fm ? Number(fm[1]) : ac.f[0];
          markers.push({ f: fu, phase: a.measured - 180, label: `PM ${a.measured.toFixed(1)}°`, verdict: v, kind: 'phaseMargin' });
        }
      }
      out.push({ probe: c.probe, ref: c.ref, f: ac.f, gain: c.gain, phase: c.phase, markers, assertionIds: mine.map(a => a.id) });
    }
  }
  return out;
}

/** −3 dB crossings around the gain peak, interpolated in log f. */
export function minus3dbEdges(f: number[], gain: number[]): { low?: number; high?: number } {
  let peak = 0;
  for (let k = 1; k < gain.length; k++) if (gain[k] > gain[peak]) peak = k;
  const level = gain[peak] - 3.0103;
  const cross = (a: number, b: number): number => {
    const t = (gain[a] - level) / (gain[a] - gain[b]);
    return Math.exp(Math.log(f[a]) + t * (Math.log(f[b]) - Math.log(f[a])));
  };
  let high: number | undefined;
  for (let k = peak + 1; k < gain.length; k++) {
    if (gain[k] < level) {
      high = cross(k - 1, k);
      break;
    }
  }
  let low: number | undefined;
  for (let k = peak - 1; k >= 0; k--) {
    if (gain[k] < level) {
      low = cross(k + 1, k);
      break;
    }
  }
  return { low, high };
}

function interpLog(xs: number[], ys: number[], x: number): number {
  if (xs.length === 0) return NaN;
  if (x <= xs[0]) return ys[0];
  if (x >= xs[xs.length - 1]) return ys[ys.length - 1];
  for (let k = 1; k < xs.length; k++) {
    if (x <= xs[k]) {
      const f = (Math.log(x) - Math.log(xs[k - 1])) / (Math.log(xs[k]) - Math.log(xs[k - 1]));
      return ys[k - 1] + (ys[k] - ys[k - 1]) * f;
    }
  }
  return ys[ys.length - 1];
}

// ─── dc sweep ────────────────────────────────────────────────────────────────

export interface DcMarker {
  x?: number;
  y?: number;
  label: string;
  verdict: 'pass' | 'fail';
  kind: 'at' | 'slopeAt' | 'crosses' | 'monotonic';
}

export interface DcCurveModel {
  probe: string;
  unit: string;
  xLabel: string;
  x: number[];
  y: number[];
  markers: DcMarker[];
  assertionIds: string[];
}

export function dcModel(doc: CircuitDoc, record: RunRecord, sim: SimResult): DcCurveModel[] {
  const results = record.stages.dc?.assertions ?? [];
  const specOf = (id: string) => doc.assertions.find(s => s.id === id);
  const out: DcCurveModel[] = [];
  for (const d of sim.dc) {
    const xLabel = d.config.source ?? d.config.param ?? 'x';
    for (const probe of Object.keys(d.curves).sort()) {
      const y = d.curves[probe];
      const mine = results.filter(a => a.probe === probe && (specOf(a.id)?.dc?.source ?? specOf(a.id)?.dc?.param) === xLabel);
      const markers: DcMarker[] = [];
      const unit = probeUnit(probe);
      for (const a of mine) {
        const ch = a.check;
        if (ch.op === 'at') markers.push({ x: ch.x, y: a.measured, label: `${eng(a.measured ?? NaN, unit)} @ ${eng(ch.x)}`, verdict: a.verdict, kind: 'at' });
        else if (ch.op === 'slopeAt') markers.push({ x: ch.x, y: interpLin(d.x, y, ch.x), label: `slope ${eng(a.measured ?? NaN)} @ ${eng(ch.x)}`, verdict: a.verdict, kind: 'slopeAt' });
        else if (ch.op === 'crosses') markers.push({ x: a.measured, y: ch.level, label: `crosses ${eng(ch.level, unit)} @ ${eng(a.measured ?? NaN)}`, verdict: a.verdict, kind: 'crosses' });
        else if (ch.op === 'monotonic') markers.push({ x: a.xFirstViolation, label: `monotonic ${ch.direction}${a.xFirstViolation !== undefined ? ` ✗ @ ${eng(a.xFirstViolation)}` : ''}`, verdict: a.verdict, kind: 'monotonic' });
      }
      out.push({ probe, unit, xLabel, x: d.x, y, markers, assertionIds: mine.map(a => a.id) });
    }
  }
  return out;
}

function interpLin(xs: number[], ys: number[], x: number): number {
  for (let k = 1; k < xs.length; k++) {
    if ((x >= xs[k - 1] && x <= xs[k]) || (x <= xs[k - 1] && x >= xs[k])) {
      const f = (x - xs[k - 1]) / (xs[k] - xs[k - 1] || 1);
      return ys[k - 1] + (ys[k] - ys[k - 1]) * f;
    }
  }
  return NaN;
}

// ─── logic analyzer ──────────────────────────────────────────────────────────

export interface LogicSignalModel {
  name: string;
  changes: [number, LogicLevel][];
  assertionIds: string[];
  verdict: 'pass' | 'fail' | 'none';
  /** Assertion markers (time, expected, verdict). */
  markers: { t: number; label: string; verdict: 'pass' | 'fail'; to?: number }[];
}

export interface LogicModel {
  config: string;
  tEnd: number;
  signals: LogicSignalModel[];
  truncated: string[];
}

export function logicModel(record: RunRecord, capture?: LogicCapture): LogicModel | undefined {
  const cap = capture ?? record.stages.tran?.logic?.[0];
  if (!cap) return undefined;
  const results = record.stages.tran?.assertions ?? [];
  const signals: LogicSignalModel[] = [];
  for (const name of Object.keys(cap.signals)) {
    const mine = results.filter(a => a.probe === name && isLogicOp(a.check.op));
    const markers: LogicSignalModel['markers'] = [];
    for (const a of mine) {
      const ch = a.check as CheckSpec & { t?: number; from?: number; to?: number; value?: unknown };
      if (ch.op === 'logicAt') markers.push({ t: ch.t!, label: `= ${ch.value}`, verdict: a.verdict });
      else if (ch.op === 'logicStable') markers.push({ t: ch.from!, to: ch.to, label: `stable${ch.value !== undefined ? ` ${ch.value}` : ''}`, verdict: a.verdict });
      else if (ch.op === 'logicFrequency') markers.push({ t: ch.from ?? 0, to: ch.to ?? cap.tEnd, label: `f ≈ ${eng((ch as { value: number }).value, 'Hz')}${a.measured !== undefined ? ` (${eng(a.measured, 'Hz')})` : ''}`, verdict: a.verdict });
      else if (ch.op === 'logicDutyCycle') markers.push({ t: ch.from ?? 0, to: ch.to ?? cap.tEnd, label: `duty ≈ ${Math.round((ch as { value: number }).value * 100)} %${a.measured !== undefined ? ` (${(a.measured * 100).toFixed(1)} %)` : ''}`, verdict: a.verdict });
      else if (ch.op === 'logicEdges') markers.push({ t: ch.from ?? 0, to: ch.to ?? cap.tEnd, label: `${(ch as { edge: string }).edge} edges${a.measured !== undefined ? ` = ${a.measured}` : ''}`, verdict: a.verdict });
      if (a.tFirstViolation !== undefined) markers.push({ t: a.tFirstViolation, label: '✗', verdict: 'fail' });
    }
    signals.push({ name, changes: cap.signals[name], assertionIds: mine.map(a => a.id), verdict: mine.length === 0 ? 'none' : mine.every(a => a.verdict === 'pass') ? 'pass' : 'fail', markers });
  }
  // Asserted signals first, then by name.
  signals.sort((a, b) => Number(b.assertionIds.length > 0) - Number(a.assertionIds.length > 0) || a.name.localeCompare(b.name));
  return { config: cap.config, tEnd: cap.tEnd, signals, truncated: cap.truncated ?? [] };
}

export const isLogicOp = (op: string): boolean => op.startsWith('logic');

/** Logic level of a value-change list at time t. */
export function logicAt(changes: [number, LogicLevel][], t: number): LogicLevel {
  let v: LogicLevel = 'X';
  for (const [tc, lv] of changes) {
    if (tc > t) break;
    v = lv;
  }
  return v;
}

/** Sample index of a non-uniform time axis at or before `t` (binary search). */
export function indexAt(ts: number[], t: number): number {
  let lo = 0;
  let hi = ts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ts[mid] <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Full-scale voltage / current for the animation from the waveforms (or the op point). */
export function animationScales(sim: SimResult): { vmax: number; imax: number } {
  let vmax = 0;
  let imax = 0;
  if (sim.tran) {
    for (const ys of Object.values(sim.tran.nets)) for (const v of ys) if (Number.isFinite(v)) vmax = Math.max(vmax, Math.abs(v));
    for (const ys of Object.values(sim.tran.pins)) for (const i of ys) if (Number.isFinite(i)) imax = Math.max(imax, Math.abs(i));
  }
  if (sim.op) {
    for (const v of Object.values(sim.op.nets)) if (Number.isFinite(v)) vmax = Math.max(vmax, Math.abs(v));
    for (const i of Object.values(sim.op.pins)) if (Number.isFinite(i)) imax = Math.max(imax, Math.abs(i));
  }
  return { vmax: niceScale(vmax || 5), imax: imax || 1e-3 };
}

export function niceScale(maxAbs: number): number {
  if (!(maxAbs > 0)) return 1;
  const exp = Math.floor(Math.log10(maxAbs));
  const base = Math.pow(10, exp);
  const m = maxAbs / base;
  const nice = m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10;
  return nice * base;
}

// ─── serial console (microcontrollers) ───────────────────────────────────────

export interface SerialLineModel {
  /** Completion time of the line (s). */
  t: number;
  text: string;
  /** Text after the last line terminator (still being printed at tstop). */
  partial?: boolean;
}

export interface SerialModel {
  mcu: string;
  config: string;
  lines: SerialLineModel[];
  truncated: boolean;
  assertionIds: string[];
  verdict: 'pass' | 'fail' | 'none';
}

export const isSerialOp = (op: string): boolean => op.startsWith('serial');

/** One console per microcontroller that printed (`stages.tran.serial[]`). */
export function serialModels(record: RunRecord, sim?: SimResult): SerialModel[] {
  const caps = sim?.tran?.serial ?? record.stages.tran?.serial ?? [];
  const results = (record.stages.tran?.assertions ?? []).filter(a => isSerialOp(a.check.op));
  return caps.map(c => {
    const mine = results.filter(a => a.probe === c.mcu);
    const lines: SerialLineModel[] = c.lines.map(([t, text]) => ({ t, text }));
    if (c.partial) lines.push({ t: c.partial[0], text: c.partial[1], partial: true });
    return {
      mcu: c.mcu,
      config: c.config,
      lines,
      truncated: !!c.truncated,
      assertionIds: mine.map(a => a.id),
      verdict: mine.length === 0 ? 'none' : mine.every(a => a.verdict === 'pass') ? 'pass' : 'fail',
    };
  });
}

// ─── embedded sources (firmware, VHDL) ───────────────────────────────────────

export interface SourceMark {
  line: number;
  col?: number;
  code: string;
  severity: Severity;
  message: string;
}

export interface SourceModel {
  path: string;
  /** Basename, for the file tabs. */
  name: string;
  lang: SourceLang;
  text: string;
  kind: 'firmware' | 'vhdl' | 'other';
  /** Components that reference this file (U1 → firmware, U2 → VHDL entity). */
  owners: string[];
  marks: SourceMark[];
}

export interface SourceLocation {
  path: string;
  line: number;
  col?: number;
}

/** `bench/mcu/blink.fw.ts:12` / `x.vhd:16:5` → a location inside an embedded source (undefined otherwise). */
export function sourceLocation(at: string | undefined, doc: CircuitDoc): SourceLocation | undefined {
  if (!at) return undefined;
  const m = at.match(/^(.*?):(\d+)(?::(\d+))?$/);
  if (!m) return undefined;
  const path = m[1];
  if (!doc.sources?.some(s => s.path === path)) return undefined;
  return { path, line: Number(m[2]), col: m[3] !== undefined ? Number(m[3]) : undefined };
}

/** The document's embedded files with every diagnostic that points into them. */
export function sourceModels(doc: CircuitDoc, record: RunRecord): SourceModel[] {
  const out: SourceModel[] = [];
  for (const s of doc.sources ?? []) {
    const lang = languageOf(s.path);
    const owners = doc.components.filter(c => c.params.firmware === s.path || c.params.source === s.path).map(c => c.id);
    const isVhdl = lang === 'vhdl';
    const marks: SourceMark[] = [];
    for (const d of record.diagnostics) {
      const loc = sourceLocation(d.at, doc);
      if (loc && loc.path === s.path) marks.push({ line: loc.line, col: loc.col, code: d.code, severity: d.severity, message: d.message });
    }
    marks.sort((a, b) => a.line - b.line || a.code.localeCompare(b.code));
    out.push({ path: s.path, name: s.path.split('/').pop() ?? s.path, lang, text: s.text, kind: isVhdl ? 'vhdl' : owners.length ? 'firmware' : 'other', owners, marks });
  }
  // Files with diagnostics first, then entry files (owned), then imports; stable by path.
  return out.sort((a, b) => Number(b.marks.length > 0) - Number(a.marks.length > 0) || Number(b.owners.length > 0) - Number(a.owners.length > 0) || a.path.localeCompare(b.path));
}
