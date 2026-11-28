import type { Elaboration } from '../elab/bench';
import { TransientAnalysis, type ProbeSpec } from '../analysis/TransientAnalysis';
import { drainAsync, drainSync, type Steps } from '../analysis/steps';
import { evaluateTranCheck, type Waveform } from './measure';
import { solverDiagnostic } from './solverDiag';
import type { StageOutcome } from './op';
import type { AssertionResult, AssertionSpec, Diagnostic, LogicCapture, RatingResult, SerialCapture, TranConfig, TranRunTelemetry } from '../schema/types';
import { isLogicCheck } from '../elab/logic';
import { isSerialCheck } from '../elab/serial';
import { evaluateSerialCheck } from '../mixed/serial-measure';
import { evaluateLogicCheck } from '../mixed/measure';
import { evaluateTranRatings, ratingProbes } from './ratings';

import { COMPONENT_PROBE_RE, asQuantityDevice } from '../elab/quantity';
import { currentProbeSpecs, netBound, netPins } from './currents';

/** Probe expression → engine probe spec (component quantity or named net). */
export function probeSpecFor(elab: Elaboration, expr: string): ProbeSpec {
  const m = expr.match(COMPONENT_PROBE_RE);
  if (m) {
    const component = elab.components.get(m[1])!;
    if (asQuantityDevice(component)) return { label: expr, color: '#000', component, type: 'voltage', quantity: m[2] };
    return { label: expr, color: '#000', component, type: m[2] === 'i' ? 'current' : 'voltage' };
  }
  return { label: expr, color: '#000', node: (elab.netNode.get(expr) ?? elab.mixed?.pinNode(expr))!, type: 'voltage' };
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
  return drainSync(runTranSteps(elab));
}

/** runTran for benches with microcontroller firmware (asynchronous co-simulation). */
export function runTranAsync(elab: Elaboration): Promise<StageOutcome> {
  return drainAsync(runTranSteps(elab));
}

/** The transient stage as a step generator (src/analysis/steps.ts). */
export function* runTranSteps(elab: Elaboration): Steps<StageOutcome> {
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
  const mixed = elab.mixed;
  const mixedDiags: Diagnostic[] = [];
  const seenDiags = new Set<string>();
  const captures: LogicCapture[] = [];
  const serialCaptures: SerialCapture[] = [];
  const mcuRatings = new Map<string, RatingResult>();
  // Datasheet ratings of Part() devices: their quantities ride along in every analog run.
  const ratingRuns: { label: string; waveforms: Map<string, Waveform> }[] = [];
  const extraProbes = ratingProbes(elab, 'tran');
  // Boards: every pin current rides along too, for the trace widths (RMS per run).
  const pinSpecs = elab.pcb ? currentProbeSpecs(elab) : [];
  const boardNets = elab.pcb ? netPins(elab, new Set(pinSpecs.map(p => p.ref))) : [];

  for (const key of [...groups.keys()].sort()) {
    const { config, assertions: all } = groups.get(key)!;
    const assertions = all.filter(a => !isLogicCheck(a.check) && !isSerialCheck(a.check));
    const logicAssertions = all.filter(a => isLogicCheck(a.check));
    const serialAssertions = all.filter(a => isSerialCheck(a.check));
    const probeExprs = [...new Set(assertions.map(a => a.probe))].sort();
    const simulated = [...new Set([...probeExprs, ...extraProbes])].sort();
    const specs = simulated.map(expr => probeSpecFor(elab, expr));
    const pinLabels = pinSpecs.map((p, k) => `pcb-pin:${k}:${p.ref}`);
    if (!mixed?.digitalOnly) specs.push(...pinSpecs.map((p, k) => ({ ...p.spec, label: pinLabels[k] })));

    let waveforms: Map<string, Waveform> = new Map();
    mixed?.controller.setTimeScale(config.tstop);
    if (mixed) mixed.controller.config = configLabel(config);
    if (mixed?.digitalOnly) {
      // Pure-digital bench: the event engine alone over [0, tstop].
      mixed.controller.runDigitalOnly(config.tstop);
      runs.push({
        config: { ...config },
        method: config.method ?? 'trap',
        acceptedSteps: 0,
        rejectedSteps: 0,
        newtonFailures: 0,
        lteRejections: 0,
        minStep: 0,
        maxStepTaken: 0,
        breakpoints: 0,
        newtonIterations: 0,
        ...(mixed.controller.run.events !== undefined ? { digitalEvents: mixed.controller.run.events } : {}),
      });
    } else try {
      const result = yield* new TransientAnalysis().runSteps(
        elab.circuit,
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
      if (pinSpecs.length > 0) {
        const series = new Map<string, ArrayLike<number>>();
        pinSpecs.forEach((p, k) => {
          const wf = waveforms.get(pinLabels[k]);
          if (!wf) return;
          series.set(p.ref, p.sign === 1 ? wf.y : Array.from(wf.y, v => -v));
          waveforms.delete(pinLabels[k]);
        });
        const rms = { ...elab.pcbCurrents?.tran };
        for (const n of boardNets) {
          const v = netRms(result.timePoints, n.refs.map(r => series.get(r) ?? []), n.unknown);
          if (!(n.net in rms) || v > rms[n.net]) rms[n.net] = v;
        }
        elab.pcbCurrents = { ...elab.pcbCurrents, tran: rms };
      }
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
        ...(mixed ? { eventCuts: t.eventCuts ?? 0 } : {}),
      });
      if (mixed) {
        mixed.controller.finishTransient(config.tstop);
        if (mixed.controller.run.events !== undefined) runs[runs.length - 1].digitalEvents = mixed.controller.run.events;
      }
    } catch (err) {
      return { stage: { verdict: 'error' }, diagnostics: [...(mixed ? mixed.controller.run.diagnostics : []), solverDiagnostic(elab, err, 'tran')] };
    }

    if (mixed) {
      for (const d of mixed.controller.run.diagnostics) {
        const k = JSON.stringify(d);
        if (seenDiags.has(k)) continue;
        seenDiags.add(k);
        mixedDiags.push(d);
      }
      const signals = new Map(mixed.namedSignals);
      for (const a of logicAssertions) signals.set(a.probe, mixed.logicSignal(a.probe)!);
      const cap = mixed.controller.capture(configLabel(config), signals);
      if (cap && Object.keys(cap.signals).length > 0) captures.push(cap);
      serialCaptures.push(...mixed.controller.serialCaptures());
      for (const r of mixed.controller.mcuRatings()) {
        const key = `${r.component}|${r.code}|${r.quantity}`;
        const prev = mcuRatings.get(key);
        if (!prev || r.value > prev.value) mcuRatings.set(key, r);
      }
      for (const spec of serialAssertions) {
        const outcome = evaluateSerialCheck(spec.check, mixed.controller.serialLog(spec.probe) ?? []);
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
          if (outcome.outsideBy !== undefined) result.margin = { outsideBy: outcome.outsideBy };
          if (outcome.note) result.note = outcome.note;
        }
        results.push(result);
      }
      for (const spec of logicAssertions) {
        const tr = mixed.controller.trace(mixed.logicSignal(spec.probe)!)!;
        const outcome = evaluateLogicCheck(spec.check, tr, config.tstop);
        const result: AssertionResult = {
          id: spec.id,
          stage: 'tran',
          probe: spec.probe,
          check: spec.check,
          verdict: outcome.pass ? 'pass' : 'fail',
          ...(outcome.measured !== undefined ? { measured: outcome.measured } : {}),
          ...(outcome.measuredLogic !== undefined && outcome.measured === undefined ? { measuredLogic: outcome.measuredLogic } : {}),
          ...(spec.at ? { at: spec.at } : {}),
        };
        if (!outcome.pass) {
          if (outcome.measuredLogic !== undefined) result.measuredLogic = outcome.measuredLogic;
          if (outcome.outsideBy !== undefined) result.margin = { outsideBy: outcome.outsideBy, ...(outcome.ratio !== undefined ? { ratio: outcome.ratio } : {}) };
          if (outcome.note) result.note = outcome.note;
          if (outcome.tFirstViolation !== undefined) result.tFirstViolation = outcome.tFirstViolation;
        }
        results.push(result);
      }
    }

    if (extraProbes.length > 0 && !mixed?.digitalOnly) ratingRuns.push({ label: configLabel(config), waveforms });
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
  const ratings = [
    ...evaluateTranRatings(elab, ratingRuns),
    ...[...mcuRatings.values()].sort((a, b) => (a.component !== b.component ? (a.component < b.component ? -1 : 1) : a.code !== b.code ? (a.code < b.code ? -1 : 1) : a.quantity < b.quantity ? -1 : a.quantity > b.quantity ? 1 : 0)),
  ];
  const failed = results.some(r => r.verdict === 'fail') || ratings.some(r => r.verdict === 'fail');
  const mixedError = mixedDiags.some(d => d.severity === 'error');
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
      verdict: mixedError ? 'error' : failed ? 'fail' : 'pass',
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
      ...(captures.length > 0 ? { logic: captures } : {}),
      ...(serialCaptures.length > 0 ? { serial: serialCaptures } : {}),
      ...(ratings.length > 0 ? { ratings } : {}),
    },
    diagnostics: mixedDiags,
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

/**
 * RMS of a net's current bound (netBound) over the second half of the window.
 * The first half is left out: a transient that starts from the zero state
 * charges every capacitor through ideal sources, and that start-up inrush says
 * nothing about what a trace carries in use. Each interval uses the average
 * current of each pin, (iₙ + iₙ₊₁)/2 — the charge-consistent current of the
 * trapezoidal rule — so the ±i ringing that rule leaves on a capacitor across
 * an ideal source cancels instead of counting as current.
 */
function netRms(t: ArrayLike<number>, pins: ArrayLike<number>[], unknown: boolean): number {
  const n = t.length;
  if (n < 2) return netBound(pins.map(y => y[0] ?? 0), unknown);
  const from = t[0] + (t[n - 1] - t[0]) / 2;
  let acc = 0;
  const mean = new Array<number>(pins.length);
  for (let i = 1; i < n; i++) {
    const [a, b] = [Math.max(t[i - 1], from), t[i]];
    if (b <= a) continue;
    for (let k = 0; k < pins.length; k++) mean[k] = ((pins[k][i - 1] ?? 0) + (pins[k][i] ?? 0)) / 2;
    const bound = netBound(mean, unknown);
    acc += bound * bound * (b - a);
  }
  const span = t[n - 1] - from;
  return span > 0 ? Math.sqrt(acc / span) : netBound(pins.map(y => y[n - 1] ?? 0), unknown);
}
