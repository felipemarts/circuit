/**
 * Event-driven digital kernel and its co-simulation facade.
 *
 * Time: integer picosecond ticks (see units.ts). Events are ordered by the
 * key (tick, delta, seq):
 *   - tick   simulated time;
 *   - delta  delta cycle within the tick (zero-delay activity goes to delta+1);
 *   - seq    a global counter assigned at scheduling time.
 * Within one (tick, delta) batch all driver updates are applied first, then
 * every affected net is resolved, then every affected component is evaluated
 * exactly once — in ascending component-id order. Because nets, components
 * and drivers are indexed by sorted name (never by insertion order), the
 * scheduling order and therefore `seq` are the same for any build order of
 * the same netlist, and resolution itself is order-independent. Same
 * netlist + same stimuli ⇒ identical event order, waveforms and diagnostics.
 */
import type { Code, Logic, Strength } from './logic';
import { CZ, DZ, fromCode, makeDrive, resolveCodes } from './logic';
import type { DigitalDiagnostic } from './diagnostics';
import { makeDiagnostic } from './diagnostics';
import type { Host, Model } from './model';
import type { DigitalNetlist, DigitalInputPort, ResolvedNetlist } from './netlist';
import { resolveNetlist } from './netlist';
import { partDef } from './parts';
import { formatTime, fromTicks, parseTime, toTicks } from './units';
import type { ValueLike } from './units';

export interface DigitalSimOptions {
  /** Record waveforms: all nets (default), none, or the listed nets. */
  record?: boolean | string[];
  /** Delta cycles allowed per time point before D504 (default 1000). */
  maxDeltaCycles?: number;
  /** Diagnostics kept per (code, subject) before further ones are only counted (default 10). */
  maxDiagnosticsPerSubject?: number;
}

/** One settled change of a net, reported once per time point after delta cycles settle. */
export interface DigitalChange {
  /** Seconds. */
  t: number;
  net: string;
  value: Logic;
  previous: Logic;
}

export interface NetTrace {
  net: string;
  /** Change times in seconds, ascending; t[0] = 0 holds the power-on value. */
  t: number[];
  v: Logic[];
}

export interface DigitalRecording {
  schema: 'circuitsvibe-digital-wave/0.1';
  /** Simulated time reached (seconds). */
  tEnd: number;
  /** net → trace, keys sorted by net name. */
  traces: Record<string, NetTrace>;
}

export interface DigitalStats {
  nets: number;
  components: number;
  drivers: number;
  /** Driver/wake events processed. */
  events: number;
  /** Component evaluations. */
  evaluations: number;
  /** Pulses shorter than an inertial delay that were swallowed. */
  glitchesSuppressed: number;
  /** Deepest delta cycle reached at any time point. */
  maxDelta: number;
  /** Diagnostics dropped by the per-subject cap, by code. */
  suppressedDiagnostics: Record<string, number>;
}

interface Ev {
  tick: number;
  delta: number;
  seq: number;
  /** 0 = driver update, 1 = component wake */
  kind: 0 | 1;
  target: number;
  value: number;
  cancelled: boolean;
}

/** In-place ascending sort of small non-negative integers (typed-array sort, no comparator calls). */
function sortAscending(a: number[]): void {
  const t = Int32Array.from(a).sort();
  for (let i = 0; i < a.length; i++) a[i] = t[i];
}

function before(a: Ev, b: Ev): boolean {
  return a.tick !== b.tick ? a.tick < b.tick : a.delta !== b.delta ? a.delta < b.delta : a.seq < b.seq;
}

class EventHeap {
  private a: Ev[] = [];
  get size(): number {
    return this.a.length;
  }
  push(e: Ev): void {
    const a = this.a;
    let i = a.length;
    a.push(e);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!before(e, a[p])) break;
      a[i] = a[p];
      i = p;
    }
    a[i] = e;
  }
  peek(): Ev | undefined {
    const a = this.a;
    while (a.length > 0 && a[0].cancelled) this.pop();
    return a[0];
  }
  pop(): Ev | undefined {
    const a = this.a;
    const top = a[0];
    const last = a.pop();
    if (a.length > 0 && last) {
      let i = 0;
      const n = a.length;
      for (;;) {
        const l = 2 * i + 1;
        if (l >= n) break;
        const r = l + 1;
        const c = r < n && before(a[r], a[l]) ? r : l;
        if (!before(a[c], last)) break;
        a[i] = a[c];
        i = c;
      }
      a[i] = last;
    }
    return top;
  }
}

class Kernel implements Host {
  // nets
  readonly netNames: string[];
  readonly netIndex = new Map<string, number>();
  readonly refToNet = new Map<string, number>();
  netVal: Uint8Array;
  private netCont: Uint8Array;
  private netDrivers: number[][];
  private fanout: number[][];
  private netStamp: Int32Array;
  private netTickStamp: Int32Array;
  private tickStart: Uint8Array;
  // drivers
  private drvVal: number[] = [];
  private drvNet: number[] = [];
  private drvRise: number[] = [];
  private drvFall: number[] = [];
  private drvInertial: boolean[] = [];
  private drvPending: (Ev | null)[] = [];
  private drvTransport: (Ev[] | null)[] = [];
  private drvLabel: string[] = [];
  private extDriver = new Map<number, number>();
  private inputStrength = new Map<number, Strength>();
  // components
  readonly compIds: string[];
  private models: Model[];
  private compStamp: Int32Array;
  // time & queue
  private heap = new EventHeap();
  private seq = 0;
  tick = 0;
  initializing = true;
  private curTick = 0;
  private curDelta = -1;
  private stamp = 0;
  private tickId = 1;
  private dirty: number[] = [];
  private touched: number[] = [];
  private lastChanged: number[] = [];
  private lastEvaluated: number[] = [];
  readonly maxDeltas: number;
  // recording & listeners
  private recT: (number[] | null)[];
  private recV: (number[] | null)[];
  listeners: { nets: Set<number> | null; cb: (c: DigitalChange) => void }[] = [];
  // diagnostics & stats
  readonly diags: DigitalDiagnostic[] = [];
  private diagCount = new Map<string, number>();
  private readonly maxPerSubject: number;
  readonly suppressed: Record<string, number> = {};
  events = 0;
  evaluations = 0;
  glitches = 0;
  maxDelta = 0;

  constructor(r: ResolvedNetlist, opts: DigitalSimOptions) {
    this.maxDeltas = opts.maxDeltaCycles ?? 1000;
    this.maxPerSubject = opts.maxDiagnosticsPerSubject ?? 10;
    this.netNames = r.netNames;
    const N = r.netNames.length;
    r.netNames.forEach((n, i) => this.netIndex.set(n, i));
    this.netVal = new Uint8Array(N).fill(CZ);
    this.netCont = new Uint8Array(N);
    this.netDrivers = Array.from({ length: N }, () => []);
    this.netStamp = new Int32Array(N);
    this.netTickStamp = new Int32Array(N);
    this.tickStart = new Uint8Array(N);
    const fan: Set<number>[] = Array.from({ length: N }, () => new Set());

    this.compIds = r.components.map(c => c.id);
    this.compStamp = new Int32Array(r.components.length);
    this.models = r.components.map((c, ci) => {
      const def = partDef(c.type);
      const delay = def.delay(c.params);
      const inputs: Record<string, number> = {};
      const outputs: Record<string, number> = {};
      for (const pin of c.layout.inputs) {
        const net = this.netIndex.get(c.pins[pin])!;
        inputs[pin] = net;
        fan[net].add(ci);
      }
      for (const pin of c.layout.outputs) {
        const net = this.netIndex.get(c.pins[pin])!;
        outputs[pin] = this.addDriver(net, `${c.id}.${pin}`, toTicks(delay.rise), toTicks(delay.fall), delay.mode === 'inertial');
      }
      for (const [pin, net] of Object.entries(c.pins)) this.refToNet.set(`${c.id}.${pin}`, this.netIndex.get(net)!);
      return def.create(c.params, { id: c.id, comp: ci, inputs, outputs });
    });
    this.fanout = fan.map(s => [...s].sort((a, b) => a - b));
    for (const i of r.inputs) this.declareInput(i);

    const rec = opts.record ?? true;
    const recSet = Array.isArray(rec) ? new Set(rec.map(n => this.net(n))) : null;
    this.recT = r.netNames.map((_, i) => (rec === true || recSet?.has(i) ? [] : null));
    this.recV = r.netNames.map((_, i) => (rec === true || recSet?.has(i) ? [] : null));

    this.powerOn();
  }

  // ── setup ──

  private addDriver(net: number, label: string, rise: number, fall: number, inertial: boolean): number {
    const d = this.drvVal.length;
    this.drvVal.push(DZ);
    this.drvNet.push(net);
    this.drvRise.push(rise);
    this.drvFall.push(fall);
    this.drvInertial.push(inertial);
    this.drvPending.push(null);
    this.drvTransport.push(null);
    this.drvLabel.push(label);
    this.netDrivers[net].push(d);
    return d;
  }

  private declareInput(i: DigitalInputPort): void {
    const net = this.netIndex.get(i.net)!;
    const d = this.addDriver(net, `input:${i.net}`, 0, 0, false);
    this.extDriver.set(net, d);
    this.inputStrength.set(net, i.strength);
    this.drvVal[d] = makeDrive(i.initial, i.strength);
  }

  /** Power-on settle at t = 0: zero-delay fixpoint of the level-sensitive behavior. */
  private powerOn(): void {
    const all = this.models.map((_, i) => i);
    this.stamp++;
    for (const m of this.models) m.reset(this);
    for (let n = 0; n < this.netNames.length; n++) this.netVal[n] = this.resolve(n);
    let queue = all;
    let iter = 0;
    while (queue.length > 0) {
      if (++iter > this.maxDeltas) {
        this.deltaLimitDiagnostic(0, queue.map(c => this.compIds[c]), []);
        break;
      }
      this.stamp++;
      this.dirty.length = 0;
      for (const c of queue) this.models[c].evaluate(this);
      queue = this.resolveDirty();
      this.lastEvaluated = queue;
    }
    this.initializing = false;
    for (let n = 0; n < this.netNames.length; n++) {
      this.recT[n]?.push(0);
      this.recV[n]?.push(this.netVal[n]);
    }
    for (const m of this.models) m.start?.(this);
  }

  // ── Host ──

  get time(): number {
    return fromTicks(this.tick);
  }

  read(net: number): Code {
    return this.netVal[net] as Code;
  }

  out(drv: number, drive: number): void {
    if (this.initializing) {
      if (this.drvVal[drv] !== drive) {
        this.drvVal[drv] = drive;
        this.markDirty(this.drvNet[drv]);
      }
      return;
    }
    const v = drive & 3;
    const d = v === 1 ? this.drvRise[drv] : v === 0 ? this.drvFall[drv] : Math.min(this.drvRise[drv], this.drvFall[drv]);
    const tick = this.tick + d;
    const delta = d === 0 ? this.curDelta + 1 : 0;
    if (this.drvInertial[drv]) {
      const p = this.drvPending[drv];
      if (p) {
        if (p.value === drive && (p.tick < tick || (p.tick === tick && p.delta <= delta))) return;
        p.cancelled = true;
        this.drvPending[drv] = null;
      }
      if (this.drvVal[drv] === drive) {
        if (p) this.glitches++;
        return;
      }
      this.drvPending[drv] = this.push(0, drv, drive, tick, delta);
    } else {
      // Transport: a new transaction removes every pending one at or after it.
      let list = this.drvTransport[drv];
      if (!list) list = this.drvTransport[drv] = [];
      while (list.length > 0) {
        const last = list[list.length - 1];
        if (last.tick > tick || (last.tick === tick && last.delta >= delta)) {
          last.cancelled = true;
          list.pop();
        } else break;
      }
      const projected = list.length > 0 ? list[list.length - 1].value : this.drvVal[drv];
      if (projected === drive) return;
      list.push(this.push(0, drv, drive, tick, delta));
    }
  }

  outAt(drv: number, drive: number, tick: number): void {
    this.push(0, drv, drive, tick, tick === this.curTick ? this.curDelta + 1 : 0);
  }

  wakeAt(comp: number, tick: number, tag: number): void {
    this.push(1, comp, tag, tick, tick === this.curTick ? this.curDelta + 1 : 0);
  }

  report(d: DigitalDiagnostic): void {
    const key = `${d.code}|${(d.subject?.components ?? []).join(',')}|${d.subject?.net ?? ''}|${(d.subject?.pins ?? []).join(',')}`;
    const n = (this.diagCount.get(key) ?? 0) + 1;
    this.diagCount.set(key, n);
    if (n > this.maxPerSubject) {
      this.suppressed[d.code] = (this.suppressed[d.code] ?? 0) + 1;
      return;
    }
    this.diags.push(d);
  }

  // ── kernel internals ──

  private push(kind: 0 | 1, target: number, value: number, tick: number, delta: number): Ev {
    const e: Ev = { tick, delta, seq: this.seq++, kind, target, value, cancelled: false };
    this.heap.push(e);
    return e;
  }

  private markDirty(net: number): void {
    if (this.netStamp[net] !== this.stamp) {
      this.netStamp[net] = this.stamp;
      this.dirty.push(net);
    }
  }

  private resolve(net: number): number {
    const ds = this.netDrivers[net];
    let r: number;
    if (ds.length === 1) r = this.drvVal[ds[0]] & 3;
    else if (ds.length === 0) r = CZ;
    else r = resolveCodes(this.drvVal, ds);
    const cont = r >> 2;
    if (cont !== this.netCont[net]) {
      this.netCont[net] = cont;
      if (cont !== 0) this.contentionDiagnostic(net, cont === 1);
    }
    return r & 3;
  }

  /** Resolve dirty nets; returns the sorted components to evaluate. */
  private resolveDirty(): number[] {
    const dirty = this.dirty;
    if (dirty.length > 1) sortAscending(dirty);
    const comps: number[] = [];
    const changed: number[] = [];
    let sorted = true;
    for (const net of dirty) {
      const v = this.resolve(net);
      if (v === this.netVal[net]) continue;
      if (!this.initializing) {
        if (this.netTickStamp[net] !== this.tickId) {
          this.netTickStamp[net] = this.tickId;
          this.tickStart[net] = this.netVal[net];
          this.touched.push(net);
        }
        this.record(net, v);
      }
      this.netVal[net] = v;
      changed.push(net);
      for (const c of this.fanout[net]) {
        if (this.compStamp[c] !== this.stamp) {
          this.compStamp[c] = this.stamp;
          if (sorted && comps.length > 0 && c < comps[comps.length - 1]) sorted = false;
          comps.push(c);
        }
      }
    }
    this.lastChanged = changed;
    if (!sorted) sortAscending(comps);
    return comps;
  }

  private record(net: number, v: number): void {
    const t = this.recT[net];
    if (!t) return;
    const vs = this.recV[net]!;
    const n = t.length;
    if (t[n - 1] === this.tick) {
      if (n >= 2 && vs[n - 2] === v) {
        t.pop();
        vs.pop();
      } else vs[n - 1] = v;
    } else {
      t.push(this.tick);
      vs.push(v);
    }
  }

  /** Process one (tick, delta) batch. */
  private step(tick: number, delta: number): void {
    this.tick = tick;
    this.curDelta = delta;
    if (delta > this.maxDelta) this.maxDelta = delta;
    this.stamp++;
    this.dirty.length = 0;
    let wakes: Ev[] | null = null;
    for (;;) {
      const e = this.heap.peek();
      if (!e || e.tick !== tick || e.delta !== delta) break;
      this.heap.pop();
      this.events++;
      if (e.kind === 1) {
        (wakes ??= []).push(e);
        continue;
      }
      const drv = e.target;
      this.drvVal[drv] = e.value;
      if (this.drvPending[drv] === e) this.drvPending[drv] = null;
      else {
        const list = this.drvTransport[drv];
        if (list && list[0] === e) list.shift();
      }
      this.markDirty(this.drvNet[drv]);
    }
    if (wakes) for (const w of wakes) this.models[w.target].wake?.(this, w.value);
    const comps = this.resolveDirty();
    this.lastEvaluated = comps;
    for (const c of comps) this.models[c].evaluate(this);
    this.evaluations += comps.length;
  }

  /** Emit settled changes of the current time point to listeners. */
  private flush(): void {
    if (this.touched.length === 0) {
      this.tickId++;
      return;
    }
    const touched = this.touched.sort((a, b) => a - b);
    const t = fromTicks(this.curTick);
    if (this.listeners.length > 0) {
      for (const net of touched) {
        const v = this.netVal[net];
        if (v === this.tickStart[net]) continue;
        const change: DigitalChange = { t, net: this.netNames[net], value: fromCode(v), previous: fromCode(this.tickStart[net]) };
        for (const l of this.listeners) if (!l.nets || l.nets.has(net)) l.cb(change);
      }
    }
    this.touched = [];
    this.tickId++;
  }

  advanceTo(limit: number): void {
    for (;;) {
      const e = this.heap.peek();
      if (!e || e.tick > limit) break;
      if (e.tick !== this.curTick) {
        this.flush();
        this.curTick = e.tick;
        this.curDelta = -1;
      }
      if (e.delta >= this.maxDeltas) {
        this.discardTick(e.tick);
        continue;
      }
      this.step(e.tick, e.delta);
    }
    this.flush();
    if (limit > this.tick) this.tick = limit;
  }

  nextEventTick(): number | undefined {
    return this.heap.peek()?.tick;
  }

  /** D504: drop every remaining event of a time point that would not settle. */
  private discardTick(tick: number): void {
    const comps = [...new Set(this.lastEvaluated)].map(c => this.compIds[c]).sort();
    const nets = this.lastChanged.map(n => this.netNames[n]);
    let dropped = 0;
    for (;;) {
      const e = this.heap.peek();
      if (!e || e.tick !== tick) break;
      this.heap.pop();
      dropped++;
      if (e.kind === 0) {
        if (this.drvPending[e.target] === e) this.drvPending[e.target] = null;
        const list = this.drvTransport[e.target];
        if (list) {
          const i = list.indexOf(e);
          if (i >= 0) list.splice(i, 1);
        }
      }
    }
    this.deltaLimitDiagnostic(tick, comps, nets, dropped);
  }

  private deltaLimitDiagnostic(tick: number, comps: string[], nets: string[], dropped = 0): void {
    const shown = comps.slice(0, 10);
    this.report(
      makeDiagnostic('D504', {
        message: `zero-delay activity did not settle after ${this.maxDeltas} delta cycles at ${formatTime(fromTicks(tick))}${shown.length ? ` (still switching: ${shown.join(', ')}${comps.length > shown.length ? ', …' : ''})` : ''}`,
        subject: { components: shown, nets: nets.slice(0, 10) },
        time: fromTicks(tick),
        note: 'a feedback loop of zero-delay elements keeps re-triggering itself within one time point, like an oscillator with no propagation delay; remaining events of this time point were dropped',
        evidence: { maxDeltaCycles: this.maxDeltas, droppedEvents: dropped, components: comps, nets },
        fixes: [
          { kind: 'add-delay', confidence: 'suggested', detail: `give at least one element of the loop a non-zero delay (e.g. { delay: '1n' }), or break the loop with a flip-flop` },
        ],
      }),
    );
  }

  private contentionDiagnostic(net: number, isStrong: boolean): void {
    const name = this.netNames[net];
    const zeros: string[] = [];
    const ones: string[] = [];
    for (const d of this.netDrivers[net]) {
      const dv = this.drvVal[d];
      if (dv >> 2 !== (isStrong ? 2 : 1)) continue;
      if ((dv & 3) === 0) zeros.push(this.drvLabel[d]);
      else if ((dv & 3) === 1) ones.push(this.drvLabel[d]);
    }
    const comps = [...new Set([...zeros, ...ones].filter(l => !l.startsWith('input:')).map(l => l.split('.')[0]))].sort();
    const when = formatTime(fromTicks(this.tick));
    if (isStrong) {
      this.report(
        makeDiagnostic('D501', {
          message: `contention on net ${name} at ${when}: ${zeros.join(', ')} drive 0 while ${ones.join(', ')} drive 1; the net is X`,
          subject: { net: name, components: comps, pins: [...zeros, ...ones].filter(l => !l.startsWith('input:')).sort() },
          time: fromTicks(this.tick),
          note: 'two push-pull outputs fighting short the supply through both output stages: real parts overheat and the logic level is undefined',
          evidence: { drivingZero: zeros, drivingOne: ones },
          fixes: [
            { kind: 'tristate', confidence: 'suggested', detail: `drive ${name} from TriBuf outputs with mutually exclusive enables, or combine the signals with a gate / Mux instead of wiring outputs together` },
          ],
        }),
      );
    } else {
      this.report(
        makeDiagnostic('D507', {
          message: `weak contention on net ${name} at ${when}: ${zeros.join(', ')} pull to 0 while ${ones.join(', ')} pull to 1; the net is X`,
          subject: { net: name, components: comps, pins: [...zeros, ...ones].filter(l => !l.startsWith('input:')).sort() },
          time: fromTicks(this.tick),
          note: 'a pull-up and a pull-down on the same undriven net form a divider: the level sits mid-rail, which is neither 0 nor 1',
          evidence: { pullingZero: zeros, pullingOne: ones },
          fixes: [{ kind: 'remove-component', confidence: 'suggested', detail: `keep only one Pull on ${name}` }],
        }),
      );
    }
  }

  // ── external drive ──

  net(name: string): number {
    const i = this.netIndex.get(name) ?? this.refToNet.get(name);
    if (i === undefined) {
      const sample = this.netNames.filter(n => !n.includes('.')).slice(0, 12);
      throw new Error(`unknown net '${name}'. Use a net name${sample.length ? ` (${sample.join(', ')}${this.netNames.length > sample.length ? ', …' : ''})` : ''} or a pin ref like 'U1.y'`);
    }
    return i;
  }

  drive(net: number, value: Logic, tick: number, strength?: Strength): void {
    if (tick < this.tick) {
      const name = this.netNames[net];
      this.report(
        makeDiagnostic('D505', {
          message: `drive(${name}) at ${formatTime(fromTicks(tick))} is before the current time ${formatTime(fromTicks(this.tick))}; applied at ${formatTime(fromTicks(this.tick))} instead`,
          subject: { net: name },
          time: fromTicks(this.tick),
          note: 'the event kernel cannot change the past: everything up to the current time has already been processed and reported',
          evidence: { requested: fromTicks(tick), now: fromTicks(this.tick) },
          fixes: [
            { kind: 'reorder', confidence: 'mechanical', detail: `call drive() before advanceTo() passes that time: schedule inputs first, or advance only to the time the analog side has accepted` },
          ],
        }),
      );
      tick = this.tick;
    }
    let d = this.extDriver.get(net);
    if (d === undefined) {
      d = this.addDriver(net, `input:${this.netNames[net]}`, 0, 0, false);
      this.extDriver.set(net, d);
    }
    this.outAt(d, makeDrive(value, strength ?? this.inputStrength.get(net) ?? 'strong'), tick);
  }

  trace(net: number): NetTrace {
    const t = this.recT[net];
    if (!t) throw new Error(`net '${this.netNames[net]}' is not recorded (see the 'record' option)`);
    return { net: this.netNames[net], t: t.map(fromTicks), v: this.recV[net]!.map(fromCode) };
  }

  isRecorded(net: number): boolean {
    return this.recT[net] !== null;
  }

  driverCount(): number {
    return this.drvVal.length;
  }
}

/**
 * A running digital simulation built from a plain-JSON netlist.
 *
 * Co-simulation contract (see src/digital/README.md):
 *   - `nextEventTime()` — earliest pending event (seconds) or undefined; use it as an analog breakpoint.
 *   - `advanceTo(t)` — process every event with time ≤ t (all delta cycles), then now = t.
 *   - `drive(net, value, t)` — schedule an external value at t ≥ now (analog→digital bridge).
 *   - `onChange(cb)` — settled changes with timestamps (digital→analog bridge, logic analyzer).
 */
export class DigitalSim {
  private k: Kernel;

  constructor(netlist: Pick<DigitalNetlist, 'components'> & { inputs?: DigitalInputPort[] }, opts: DigitalSimOptions = {}) {
    this.k = new Kernel(resolveNetlist(netlist), opts);
  }

  /** Current simulated time, seconds. */
  get now(): number {
    return fromTicks(this.k.tick);
  }

  /** Time (seconds) of the earliest pending event, or undefined when the circuit is quiescent. */
  nextEventTime(): number | undefined {
    const t = this.k.nextEventTick();
    return t === undefined ? undefined : fromTicks(t);
  }

  /** Process all events with time ≤ t (including every delta cycle at t). No-op for t < now. */
  advanceTo(t: ValueLike): this {
    this.k.advanceTo(toTicks(parseTime(t, 'advanceTo time')));
    return this;
  }

  /**
   * Drive a net from outside at time t (default: now). Accepts a net name or
   * a pin ref ('U1.a'). 'Z' releases the external driver. Several drives at
   * the same time: the last call wins. t < now ⇒ D505 and applied at now.
   */
  drive(net: string, value: Logic, t?: ValueLike, opts: { strength?: Strength } = {}): this {
    const n = this.k.net(net);
    const tick = t === undefined ? this.k.tick : toTicks(parseTime(t, 'drive time'));
    this.k.drive(n, value, tick, opts.strength);
    return this;
  }

  /** Release the external driver of a net (drive 'Z'). */
  release(net: string, t?: ValueLike): this {
    return this.drive(net, 'Z', t);
  }

  /** Current resolved value of a net (name or pin ref). */
  value(net: string): Logic {
    return fromCode(this.k.netVal[this.k.net(net)]);
  }

  /** Current values of every named net (auto nets '<id>.<pin>' excluded unless `all`). */
  values(all = false): Record<string, Logic> {
    const out: Record<string, Logic> = {};
    this.k.netNames.forEach((n, i) => {
      if (all || !n.includes('.')) out[n] = fromCode(this.k.netVal[i]);
    });
    return out;
  }

  /** Sorted net names. */
  nets(): string[] {
    return [...this.k.netNames];
  }

  /** The net name a pin ref ('U1.y') or name resolves to. */
  netOf(ref: string): string {
    return this.k.netNames[this.k.net(ref)];
  }

  /**
   * Subscribe to settled net changes. Called once per changed net per time
   * point, after its delta cycles settle, in net-name order. A drive() at
   * the current time followed by another advanceTo() can report a second
   * change at the same t. Returns an unsubscribe function.
   */
  onChange(cb: (change: DigitalChange) => void, opts: { nets?: string[] } = {}): () => void {
    const entry = { nets: opts.nets ? new Set(opts.nets.map(n => this.k.net(n))) : null, cb };
    this.k.listeners.push(entry);
    return () => {
      this.k.listeners = this.k.listeners.filter(l => l !== entry);
    };
  }

  /** Recorded waveform of one net (name or pin ref). */
  trace(net: string): NetTrace {
    return this.k.trace(this.k.net(net));
  }

  /** Every recorded net, plus the simulated end time. */
  recording(): DigitalRecording {
    const traces: Record<string, NetTrace> = {};
    this.k.netNames.forEach((n, i) => {
      if (this.k.isRecorded(i)) traces[n] = this.k.trace(i);
    });
    return { schema: 'circuitsvibe-digital-wave/0.1', tEnd: this.now, traces };
  }

  /** Runtime diagnostics (D5xx) so far, in simulation order. */
  diagnostics(): DigitalDiagnostic[] {
    return [...this.k.diags];
  }

  stats(): DigitalStats {
    return {
      nets: this.k.netNames.length,
      components: this.k.compIds.length,
      drivers: this.k.driverCount(),
      events: this.k.events,
      evaluations: this.k.evaluations,
      glitchesSuppressed: this.k.glitches,
      maxDelta: this.k.maxDelta,
      suppressedDiagnostics: { ...this.k.suppressed },
    };
  }
}
