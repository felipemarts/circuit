/**
 * Browser-safe simulation driver for the viewer. Runs the SAME verification
 * ladder as the CLI (`runLadderAsync(benchFromDoc(doc))` — identical RunRecord,
 * verdict, exit code and netlist hash; the asynchronous driver is what the CLI
 * uses too, and it is the only one that can co-simulate microcontroller
 * firmware, which the document carries as source text) and then, without
 * touching engine semantics, re-elaborates the bench and collects full
 * waveforms for the animation and the panels:
 *
 *  - op: every net voltage and every pin current at the operating point;
 *  - tran: node voltages / pin currents / probe values over the bench's own
 *    transient configuration (the longest one), plus logic traces of every
 *    logic-driven net and MCU pin (mixed-signal benches) and the serial
 *    output of every microcontroller;
 *  - ac: gain/phase curves of every AC assertion probe over its sweep;
 *  - dc: probe curves over each DC sweep (runSweep, the engine's own helper).
 *
 * Pure functions: usable on the main thread (with cooperative yields) or
 * inside a Web Worker (see worker.ts).
 */
import { benchFromDoc } from '../doc/convert';
import { loadDocDefinitions, type PlatformModule } from '../doc/definitions';
import type { CircuitDoc } from '../doc/types';
import { runLadderAsync } from '../verify/ladder';
import { elaborate, type Elaboration } from '../elab/bench';
import { kindOf } from '../elab/describe';
import { asQuantityDevice, COMPONENT_PROBE_RE } from '../elab/quantity';
import { runSweep } from '../verify/dc';
import { acFrequencies } from '../verify/ac';
import { configLabel, probeSpecFor } from '../verify/tran';
import { currentProbeSpecs, pinCurrents } from '../verify/currents';
import { SimulationSystem } from '../analysis/engine';
import { TransientAnalysis } from '../analysis/TransientAnalysis';
import { drainAsync } from '../analysis/steps';
import { symbolFor } from './symbols';
import type { Phasor } from '../analysis/context';
import type { ProbeSpec } from '../analysis/TransientAnalysis';
import type { AcSweepConfig, DcSweepConfig, LogicCapture, RunRecord, SerialCapture, TranConfig } from '../schema/types';

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
  /** Serial output of every microcontroller (`Serial.print`), per MCU. */
  serial?: SerialCapture[];
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

/**
 * Whether a net is driven by a logic output (an IC / primitive / VHDL output
 * pin, per the symbol pin roles) or touches a microcontroller pin — i.e. its
 * logic trace is a real signal and not the thresholded reading of an analog node.
 */
function logicDriven(doc: CircuitDoc, net: string, logicSignal: (probe: string) => string | undefined): boolean {
  for (const c of doc.components) {
    for (const [pinName, n] of Object.entries(c.pins)) {
      if (n !== net) continue;
      const ref = `${c.id}.${pinName}`;
      if (!logicSignal(ref)) continue;
      if (c.type === 'Mcu' || c.type === 'ArduinoUno') return true;
      const role = symbolFor(c).pins.find(p => p.name === pinName)?.role;
      if (role === 'out') return true;
    }
  }
  return false;
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

async function runTranData(elab: Elaboration, doc: CircuitDoc, config: TranConfig, probeExprs: string[]): Promise<TranData> {
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
    // The step generator form of the transient (src/analysis/steps.ts): it only
    // yields where firmware has asynchronous work, so plain benches run exactly
    // as before and MCU benches run their firmware in lockstep with the stepper.
    const result = await drainAsync(
      new TransientAnalysis().runSteps(
        elab.circuit,
        { timeStep: config.dt, duration: config.tstop, maxStep: config.maxStep, minStep: config.minStep, method: config.method, ic: config.ic, reltol: config.reltol, adaptive: true },
        specs,
      ),
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
    // Nets with a logic meaning: pure-digital nets, and analog nets DRIVEN by a
    // logic output or touching a microcontroller pin. An analog net that only
    // feeds logic inputs (an RC timing node into a 555 or a Schmitt trigger)
    // belongs to the scope, not to the logic analyzer.
    for (const net of [...elab.netNode.keys(), ...mixed.pureNets].sort()) {
      if (signals.has(net)) continue;
      const s = mixed.logicSignal(net);
      if (s && (mixed.pureNets.has(net) || logicDriven(doc, net, mixed.logicSignal.bind(mixed)))) signals.set(net, s);
    }
    // Every connected microcontroller pin ('U1.D13'): the driven level while it
    // is an output, the input-buffer level otherwise.
    const pinsOnNet = new Map<string, number>();
    for (const c of doc.components) for (const net of Object.values(c.pins)) pinsOnNet.set(net, (pinsOnNet.get(net) ?? 0) + 1);
    for (const c of doc.components) {
      if (kindOf(elab.components.get(c.id)!) !== 'Mcu') continue;
      for (const [pinName, net] of Object.entries(c.pins)) {
        const ref = `${c.id}.${pinName}`;
        if (net === 'gnd' || signals.has(ref) || (pinsOnNet.get(net) ?? 0) < 2) continue; // supply return / unconnected pin
        const s = mixed.logicSignal(ref);
        if (s && ![...signals.values()].includes(s)) signals.set(ref, s);
      }
    }
    // Probed IC / primitive pins ('U1.Q0'); a probed NET follows the same
    // logic-driven rule as above (an analog probe on an RC node stays analog).
    for (const expr of probeExprs) {
      if (signals.has(expr)) continue;
      const isNet = elab.netNode.has(expr) || mixed.pureNets.has(expr);
      if (isNet && !mixed.pureNets.has(expr) && !logicDriven(doc, expr, mixed.logicSignal.bind(mixed))) continue;
      const s = mixed.logicSignal(expr);
      if (s) signals.set(expr, s);
    }
    const cap = mixed.controller.capture(configLabel(config), signals);
    if (cap) data.logic = cap;
    const serial = mixed.controller.serialCaptures().map(c => ({ ...c, config: configLabel(config) }));
    if (serial.length > 0) data.serial = serial;
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
export async function simulateDoc(
  doc: CircuitDoc,
  onProgress?: (p: SimProgress) => void,
  /**
   * `platform`: the module custom-component code imports as 'circuitsvibe'.
   * Only the simulation worker passes it — custom components (doc.definitions)
   * are code and never run on the page's main thread (T019 there).
   */
  opts: { yield?: boolean; platform?: PlatformModule } = {},
): Promise<SimResult> {
  const timing: Record<string, number> = {};
  const notes: string[] = [];
  const tick = async (p: SimProgress) => {
    onProgress?.(p);
    if (opts.yield !== false) await yieldToUi();
  };

  await tick({ phase: 'ladder' });
  let t0 = now();
  const definitions = opts.platform && doc.definitions && doc.definitions.length > 0 ? loadDocDefinitions(doc, opts.platform) : undefined;
  const desc = benchFromDoc(doc, definitions ? { definitions } : {});
  const record = await runLadderAsync(desc, { overrides: doc.overrides });
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
      result.tran = await runTranData(elab, doc, g.config, analogProbes);
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
