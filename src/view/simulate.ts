/**
 * Browser-safe simulation driver for the viewer. Runs the SAME verification
 * ladder as the CLI (`runLadder(benchFromDoc(doc))` — identical RunRecord,
 * verdict, exit code and netlist hash) and then, without touching engine
 * semantics, re-elaborates the bench and collects full waveforms for the
 * animation and the panels:
 *
 *  - op: every net voltage and every pin current at the operating point;
 *  - tran: node voltages / pin currents / probe values over the bench's own
 *    transient configuration (the longest one), plus logic traces of every
 *    digital net (mixed-signal benches);
 *  - ac: gain/phase curves of every AC assertion probe over its sweep;
 *  - dc: probe curves over each DC sweep (runSweep, the engine's own helper).
 *
 * Pure functions: usable on the main thread (with cooperative yields) or
 * inside a Web Worker (see worker.ts).
 */
import { benchFromDoc } from '../doc/convert';
import type { CircuitDoc } from '../doc/types';
import { runLadder } from '../verify/ladder';
import { elaborate, type Elaboration } from '../elab/bench';
import { kindOf } from '../elab/describe';
import { asQuantityDevice, COMPONENT_PROBE_RE } from '../elab/quantity';
import { runSweep } from '../verify/dc';
import { acFrequencies } from '../verify/ac';
import { configLabel, probeSpecFor } from '../verify/tran';
import { SimulationSystem } from '../analysis/engine';
import type { Phasor } from '../analysis/context';
import type { ProbeSpec } from '../analysis/TransientAnalysis';
import type { Component } from '../core/Component';
import type { AcSweepConfig, DcSweepConfig, LogicCapture, RunRecord, TranConfig } from '../schema/types';

export interface OpState {
  nets: Record<string, number>;
  /** Current entering the component at each pin ('R1.1' → A). */
  pins: Record<string, number>;
}

export interface TranData {
  label: string;
  config: TranConfig;
  t: number[];
  nets: Record<string, number[]>;
  pins: Record<string, number[]>;
  /** Assertion probes (device quantities, pin voltages…). */
  probes: Record<string, number[]>;
  /** Logic traces of every digital net / IC pin with a logic meaning. */
  logic?: LogicCapture;
  digitalOnly: boolean;
  ms: number;
}

export interface AcCurve {
  probe: string;
  ref?: string;
  gain: number[];
  phase: number[];
}

export interface AcData {
  config: AcSweepConfig;
  f: number[];
  curves: AcCurve[];
  ms: number;
}

export interface DcData {
  config: DcSweepConfig;
  x: number[];
  curves: Record<string, number[]>;
  ms: number;
}

export interface SimResult {
  record: RunRecord;
  op?: OpState;
  tran?: TranData;
  ac: AcData[];
  dc: DcData[];
  /** Milliseconds per phase. */
  timing: Record<string, number>;
  /** Non-fatal problems of the extra waveform runs (never affects the record). */
  notes: string[];
}

export interface SimProgress {
  phase: 'ladder' | 'op' | 'tran' | 'ac' | 'dc' | 'done';
  detail?: string;
}

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());
const yieldToUi = (): Promise<void> => new Promise(r => setTimeout(r, 0));

/** Pin → current entering the component, from the published op values / quantities. */
function pinCurrents(elab: Elaboration): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [id, comp] of elab.components) {
    const kind = kindOf(comp);
    const dev = asQuantityDevice(comp);
    const names = comp.pinEntries().map(([n]) => n);
    const uniq = [...new Set(comp.allPins())].length;
    if (dev && (kind === 'NPN' || kind === 'PNP')) {
      const ic = dev.quantity('ic') ?? 0;
      const ib = dev.quantity('ib') ?? 0;
      out[`${id}.c`] = ic;
      out[`${id}.b`] = ib;
      out[`${id}.e`] = dev.quantity('ie') ?? -(ic + ib);
    } else if (dev && (kind === 'NMOS' || kind === 'PMOS')) {
      const idr = dev.quantity('id') ?? 0;
      out[`${id}.d`] = idr;
      out[`${id}.g`] = dev.quantity('ig') ?? 0;
      out[`${id}.s`] = dev.quantity('is') ?? -idr;
      if (names.includes('b')) out[`${id}.b`] = dev.quantity('ib') ?? 0;
    } else if (kind === 'Switch') {
      const i = (comp as { current?: number }).current ?? 0;
      const closed = (comp as { closed?: boolean }).closed ?? false;
      out[`${id}.com`] = i;
      out[`${id}.${closed ? 'b' : 'a'}`] = -i;
      out[`${id}.${closed ? 'a' : 'b'}`] = 0;
    } else if (uniq === 2 && typeof (comp as { current?: number }).current === 'number') {
      const i = (comp as unknown as { current: number }).current;
      const canon = canonicalTwoPins(comp);
      out[`${id}.${canon[0]}`] = i;
      out[`${id}.${canon[1]}`] = -i;
    }
  }
  return out;
}

/** Canonical names of the two unique pins of a two-terminal component ('+','-' win over '1','2'). */
function canonicalTwoPins(comp: Component): [string, string] {
  const byPin = new Map<unknown, string>();
  for (const [name, pin] of comp.pinEntries()) byPin.set(pin, name); // later aliases win
  const pins = [...new Set(comp.allPins())];
  return [byPin.get(pins[0]) ?? '1', byPin.get(pins[1]) ?? '2'];
}

/** Transient probe specs for every pin current (same decomposition as pinCurrents). */
function currentProbeSpecs(elab: Elaboration): { ref: string; spec: ProbeSpec; sign: number; derived?: { from: string[]; sign: number } }[] {
  const out: { ref: string; spec: ProbeSpec; sign: number }[] = [];
  for (const [id, comp] of elab.components) {
    const kind = kindOf(comp);
    const dev = asQuantityDevice(comp);
    const uniq = [...new Set(comp.allPins())].length;
    const q = (pin: string, quantity: string, sign = 1) => out.push({ ref: `${id}.${pin}`, spec: { label: `${id}.${pin}`, color: '', component: comp, type: 'voltage', quantity }, sign });
    if (dev && (kind === 'NPN' || kind === 'PNP')) {
      q('c', 'ic');
      q('b', 'ib');
      q('e', 'ie');
    } else if (dev && (kind === 'NMOS' || kind === 'PMOS')) {
      q('d', 'id');
      q('g', 'ig');
      q('s', 'is');
    } else if (kind === 'Switch') {
      const closed = (comp as { closed?: boolean }).closed ?? false;
      out.push({ ref: `${id}.com`, spec: { label: `${id}.com`, color: '', component: comp, type: 'current' }, sign: 1 });
      out.push({ ref: `${id}.${closed ? 'b' : 'a'}`, spec: { label: `${id}.x`, color: '', component: comp, type: 'current' }, sign: -1 });
    } else if (uniq === 2 && typeof (comp as { current?: number }).current === 'number') {
      const canon = canonicalTwoPins(comp);
      out.push({ ref: `${id}.${canon[0]}`, spec: { label: `${id}.${canon[0]}`, color: '', component: comp, type: 'current' }, sign: 1 });
      out.push({ ref: `${id}.${canon[1]}`, spec: { label: `${id}.${canon[1]}`, color: '', component: comp, type: 'current' }, sign: -1 });
    }
  }
  return out;
}

function groupBy<T, C>(items: T[], keyOf: (t: T) => string, cfgOf: (t: T) => C): { key: string; config: C; items: T[] }[] {
  const m = new Map<string, { key: string; config: C; items: T[] }>();
  for (const it of items) {
    const k = keyOf(it);
    const g = m.get(k) ?? { key: k, config: cfgOf(it), items: [] };
    g.items.push(it);
    m.set(k, g);
  }
  return [...m.values()].sort((a, b) => a.key.localeCompare(b.key));
}

// ─── op ──────────────────────────────────────────────────────────────────────

function opState(elab: Elaboration): OpState {
  const dc = elab.circuit.analyze('dc');
  const nets: Record<string, number> = {};
  for (const [net, node] of elab.netNode) nets[net] = net === 'gnd' ? 0 : dc.nodeVoltages.get(node) ?? 0;
  return { nets, pins: pinCurrents(elab) };
}

// ─── tran ────────────────────────────────────────────────────────────────────

function runTranData(elab: Elaboration, config: TranConfig, probeExprs: string[]): TranData {
  const t0 = now();
  const mixed = elab.mixed;
  const netSpecs: { net: string; spec: ProbeSpec }[] = [];
  for (const [net, node] of elab.netNode) if (net !== 'gnd') netSpecs.push({ net, spec: { label: `net:${net}`, color: '', node, type: 'voltage' } });
  const curSpecs = currentProbeSpecs(elab);
  const probeSpecs = probeExprs.map(expr => ({ expr, spec: probeSpecFor(elab, expr) }));
  for (const p of probeSpecs) p.spec.label = `probe:${p.expr}`;
  const specs = [...netSpecs.map(s => s.spec), ...curSpecs.map(s => s.spec), ...probeSpecs.map(s => s.spec)];
  // Unique labels for the engine (two switch pins share a readout).
  specs.forEach((s, k) => (s.label = `${k}|${s.label}`));

  const data: TranData = { label: configLabel(config), config, t: [], nets: {}, pins: {}, probes: {}, digitalOnly: !!mixed?.digitalOnly, ms: 0 };
  mixed?.controller.setTimeScale(config.tstop);
  if (mixed?.digitalOnly) {
    mixed.controller.runDigitalOnly(config.tstop);
    data.t = [0, config.tstop];
  } else {
    const result = elab.circuit.analyze(
      'transient',
      { timeStep: config.dt, duration: config.tstop, maxStep: config.maxStep, minStep: config.minStep, method: config.method, ic: config.ic, reltol: config.reltol, adaptive: true },
      specs,
    );
    data.t = result.timePoints;
    const byLabel = new Map(result.probes.map(p => [p.label, p.values]));
    specs.forEach((s, k) => {
      const vals = byLabel.get(s.label) ?? [];
      if (k < netSpecs.length) data.nets[netSpecs[k].net] = vals;
      else if (k < netSpecs.length + curSpecs.length) {
        const cs = curSpecs[k - netSpecs.length];
        data.pins[cs.ref] = cs.sign === 1 ? vals : vals.map(v => -v);
      } else data.probes[probeSpecs[k - netSpecs.length - curSpecs.length].expr] = vals;
    });
    // Emitter / source currents from the device quantities keep their own sign (terminal current into the device).
    for (const cs of curSpecs) if (cs.spec.quantity === 'ie' || cs.spec.quantity === 'is') data.pins[cs.ref] = byLabel.get(cs.spec.label) ?? data.pins[cs.ref];
    mixed?.controller.finishTransient(config.tstop);
  }
  if (mixed) {
    const signals = new Map<string, string>();
    for (const net of [...elab.netNode.keys()].sort()) {
      const s = mixed.logicSignal(net);
      if (s) signals.set(net, s);
    }
    for (const net of [...mixed.pureNets].sort()) {
      const s = mixed.logicSignal(net);
      if (s && !signals.has(net)) signals.set(net, s);
    }
    for (const expr of probeExprs) {
      const s = mixed.logicSignal(expr);
      if (s && !signals.has(expr)) signals.set(expr, s);
    }
    const cap = mixed.controller.capture(configLabel(config), signals);
    if (cap) data.logic = cap;
  }
  data.ms = now() - t0;
  return data;
}

// ─── ac ──────────────────────────────────────────────────────────────────────

const cdiv = (a: Phasor, b: Phasor): Phasor => {
  const den = b[0] * b[0] + b[1] * b[1];
  return [(a[0] * b[0] + a[1] * b[1]) / den, (a[1] * b[0] - a[0] * b[1]) / den];
};
const gainDb = (h: Phasor) => 20 * Math.log10(Math.hypot(h[0], h[1]));
const phaseDeg = (h: Phasor) => (Math.atan2(h[1], h[0]) * 180) / Math.PI;
const unwrapNear = (deg: number, near: number): number => deg + 360 * Math.round((near - deg) / 360);

function runAcData(elab: Elaboration, config: AcSweepConfig, probes: { probe: string; ref?: string }[]): AcData {
  const t0 = now();
  const system = new SimulationSystem(elab.circuit);
  try {
    const op = system.operatingPoint();
    system.publish(op.x);
    // The stimulus: the unique source with an AC magnitude (T003/T004 already handled by the ladder).
    let stimulus: Phasor = [1, 0];
    for (const id of [...elab.components.keys()].sort()) {
      const comp = elab.components.get(id)! as unknown as { acStimulus?: { mag: number; phase: number } | null };
      const kind = kindOf(elab.components.get(id)!);
      if ((kind === 'VoltageSource' || kind === 'CurrentSource') && comp.acStimulus && comp.acStimulus.mag !== 0) {
        const ph = (comp.acStimulus.phase * Math.PI) / 180;
        stimulus = [comp.acStimulus.mag * Math.cos(ph), comp.acStimulus.mag * Math.sin(ph)];
        break;
      }
    }
    const fs = acFrequencies(config);
    const phasor = (expr: string, re: Float64Array, im: Float64Array, omega: number, matrix: unknown): Phasor => {
      const m = expr.match(COMPONENT_PROBE_RE);
      if (m) {
        const comp = elab.components.get(m[1])!;
        const dev = asQuantityDevice(comp);
        if (dev?.acQuantity) return dev.acQuantity(m[2], re, im, omega) ?? [NaN, NaN];
        const r = (comp as unknown as { acReadResults(re: Float64Array, im: Float64Array, omega: number, matrix: unknown): { voltage: Phasor; current?: Phasor } | null }).acReadResults(re, im, omega, matrix);
        if (!r) return [NaN, NaN];
        return m[2] === 'v' ? r.voltage : r.current ?? [NaN, NaN];
      }
      const node = elab.netNode.get(expr) ?? elab.mixed?.pinNode(expr);
      return node && node.index > 0 ? [re[node.index - 1], im[node.index - 1]] : [0, 0];
    };
    const curves: AcCurve[] = probes.map(p => ({ probe: p.probe, ref: p.ref, gain: [], phase: [] }));
    for (const f of fs) {
      const { re, im, matrix } = system.acSolve(f);
      const omega = 2 * Math.PI * f;
      curves.forEach((c, k) => {
        const p = phasor(probes[k].probe, re, im, omega, matrix);
        const r = probes[k].ref !== undefined ? phasor(probes[k].ref!, re, im, omega, matrix) : stimulus;
        const h = cdiv(p, r);
        c.gain.push(gainDb(h));
        const ph = phaseDeg(h);
        c.phase.push(c.phase.length === 0 ? ph : unwrapNear(ph, c.phase[c.phase.length - 1]));
      });
    }
    return { config, f: fs, curves, ms: now() - t0 };
  } finally {
    system.release();
  }
}

// ─── driver ──────────────────────────────────────────────────────────────────

/**
 * Run the ladder and collect the waveforms. `onProgress` is called between
 * phases; on the main thread the driver yields to the event loop between
 * phases so the UI can repaint.
 */
export async function simulateDoc(doc: CircuitDoc, onProgress?: (p: SimProgress) => void, opts: { yield?: boolean } = {}): Promise<SimResult> {
  const timing: Record<string, number> = {};
  const notes: string[] = [];
  const tick = async (p: SimProgress) => {
    onProgress?.(p);
    if (opts.yield !== false) await yieldToUi();
  };

  await tick({ phase: 'ladder' });
  let t0 = now();
  const desc = benchFromDoc(doc);
  const record = runLadder(desc, { overrides: doc.overrides });
  timing.ladder = now() - t0;

  const result: SimResult = { record, ac: [], dc: [], timing, notes };
  const lintOk = record.stages.lint?.verdict === 'pass';
  if (!lintOk || record.stages.op?.verdict === 'error') {
    await tick({ phase: 'done' });
    return result;
  }
  const overrides = doc.overrides ?? {};

  // op
  await tick({ phase: 'op' });
  t0 = now();
  try {
    const elab = elaborate(desc, overrides);
    if (!elab.mixed?.digitalOnly) result.op = opState(elab);
  } catch (err) {
    notes.push(`op waveforms: ${(err as Error).message}`);
  }
  timing.op = now() - t0;

  // tran: the longest configuration among the bench's tran assertions.
  const tranSpecs = (record.stages.tran && record.stages.tran.verdict !== 'skipped' && record.stages.tran.verdict !== 'error' ? desc.circuitDoc.assertions : []).filter(a => a.stage === 'tran' && a.tran);
  if (tranSpecs.length > 0) {
    const groups = groupBy(tranSpecs, a => JSON.stringify([a.tran!.tstop, a.tran!.dt, a.tran!.maxStep ?? a.tran!.dt, a.tran!.minStep ?? null, a.tran!.method ?? 'trap', a.tran!.ic ?? 'zero', a.tran!.reltol ?? null]), a => a.tran!);
    groups.sort((a, b) => b.config.tstop - a.config.tstop || a.key.localeCompare(b.key));
    const g = groups[0];
    await tick({ phase: 'tran', detail: configLabel(g.config) });
    t0 = now();
    try {
      const elab = elaborate(desc, overrides);
      const analogProbes = [...new Set(g.items.map(a => a.probe))].filter(p => {
        // logic probes (IC pins / digital nets) are captured as logic, not as voltages, when they have no analog node
        return !!(p.match(COMPONENT_PROBE_RE) ? elab.components.get(p.split('.')[0]) && (asQuantityDevice(elab.components.get(p.split('.')[0])!) || /\.(i|v)$/.test(p) || elab.mixed?.pinNode(p)) : elab.netNode.get(p) ?? elab.mixed?.pinNode(p));
      }).sort();
      result.tran = runTranData(elab, g.config, analogProbes);
    } catch (err) {
      notes.push(`tran waveforms: ${(err as Error).message}`);
    }
    timing.tran = now() - t0;
  }

  // ac
  const acSpecs = (record.stages.ac && record.stages.ac.verdict !== 'skipped' && record.stages.ac.verdict !== 'error' ? desc.circuitDoc.assertions : []).filter(a => a.stage === 'ac' && a.ac);
  if (acSpecs.length > 0) {
    await tick({ phase: 'ac' });
    t0 = now();
    try {
      const elab = elaborate(desc, overrides);
      for (const g of groupBy(acSpecs, a => JSON.stringify([a.ac!.from, a.ac!.to, a.ac!.pointsPerDecade]), a => a.ac!)) {
        const probes = [...new Map(g.items.map(a => [`${a.probe}|${a.ref ?? ''}`, { probe: a.probe, ref: a.ref }])).values()];
        result.ac.push(runAcData(elab, g.config, probes));
      }
    } catch (err) {
      notes.push(`ac curves: ${(err as Error).message}`);
    }
    timing.ac = now() - t0;
  }

  // dc
  const dcSpecs = (record.stages.dc && record.stages.dc.verdict !== 'skipped' && record.stages.dc.verdict !== 'error' ? desc.circuitDoc.assertions : []).filter(a => a.stage === 'dc' && a.dc);
  if (dcSpecs.length > 0) {
    await tick({ phase: 'dc' });
    t0 = now();
    try {
      for (const g of groupBy(dcSpecs, a => JSON.stringify([a.dc!.source ?? null, a.dc!.param ?? null, a.dc!.from, a.dc!.to, a.dc!.points]), a => a.dc!)) {
        const elab = elaborate(desc, overrides);
        const probes = [...new Set(g.items.map(a => a.probe))].sort();
        const t1 = now();
        const out = runSweep(elab, g.config, probes);
        if (out.ok) result.dc.push({ config: g.config, x: out.curve.x, curves: out.curve.values, ms: now() - t1 });
        else notes.push(`dc sweep: ${out.diagnostic.message}`);
      }
    } catch (err) {
      notes.push(`dc curves: ${(err as Error).message}`);
    }
    timing.dc = now() - t0;
  }

  await tick({ phase: 'done' });
  return result;
}
