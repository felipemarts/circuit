/**
 * McuRuntime — runs Arduino-style firmware against an abstract pin bus, in
 * simulation time owned by the caller (the analog/digital engine).
 *
 * Yield model: firmware is `async`; `await delay(ms)` returns a thenable the
 * runtime resolves only when `runUntil()` reaches the wake time. Between two
 * yields firmware executes in zero simulated time. There are no real timers:
 * after resuming the firmware the runtime drains microtasks (deterministic in
 * JS) until the firmware is suspended on a simulator timer again.
 *
 * Co-simulation contract (see src/mcu/README.md):
 *   nextWakeTime()  earliest pending firmware event (delay expiry, PWM edge,
 *                   hardware-timer tick, queued input edge) — a transient breakpoint
 *   runUntil(t)     process every event with time ≤ t, in order; leave now = t
 *   bus.onEdge(...) input changes reach the runtime as queued, timestamped edges
 */

import type {
  Firmware,
  Level,
  McuDiagnostic,
  McuPinBus,
  McuProfile,
  PinDirection,
  PinEvent,
  PinId,
  PinSpec,
  PwmDescriptor,
  SerialEntry,
} from './types';
import { getMcuProfile } from './profiles';
import { ArduinoRandom } from './random';
import { mcuDiagnostic, firmwareLocFromStack, firmwareFrames, captureFirmwareLoc, type McuCode, type DiagFields } from './diagnostics';
import { enterRuntime, exitRuntime, installLoopGuard } from './arduino';

import { INPUT, OUTPUT, INPUT_PULLUP, INPUT_PULLDOWN, CHANGE, FALLING, RISING, NOT_AN_INTERRUPT } from './constants';

export interface McuRuntimeOptions {
  /** Instance id used in diagnostics (e.g. 'U1'). */
  id?: string;
  /** Profile object or id ('atmega328p' | 'attiny85' | 'esp32' | 'rp2040'). */
  profile: McuProfile | string;
  firmware: Firmware;
  bus: McuPinBus;
  /**
   * 'edges' (default): PWM/tone are real square waves — every edge is a
   * `bus.drive` call and a wake time. 'descriptor': one `bus.setPwm` per
   * change; the integrator models the waveform (e.g. averaged).
   */
  pwm?: 'edges' | 'descriptor';
  /** Initial PRNG state (default 1 — avr-libc's reset state). */
  randomSeed?: number;
  /** Busy-loop budget: API calls + guarded loop iterations without yielding (default 1e6). */
  maxOpsPerYield?: number;
  /** Zero-time-loop budget: events processed at one instant (default 1e5). */
  maxEventsPerInstant?: number;
  /** Microtask hops without firmware activity before a stall is declared (default 1000). */
  maxStallTicks?: number;
  /** Time charged for a loop() pass that did not advance time, in µs (default: profile.idleLoopUs). */
  idleLoopUs?: number;
  /** Record the output trace (default true). */
  recordTrace?: boolean;
  /** Base directory for file:line locations (default: process.cwd() when available). */
  cwd?: string;
}

/** Thrown into a halted firmware's stale async chains to unwind them. */
class HaltSignal extends Error {
  constructor() {
    super('MCU halted');
    this.name = 'HaltSignal';
  }
}

/** Thrown out of the firmware when it exceeds the busy-loop budget. */
export class McuBusyLoopError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'McuBusyLoopError';
  }
}

type EventKind = 'edge' | 'timer' | 'pwm' | 'tone-stop' | 'main';
const PRIORITY: Record<EventKind, number> = { edge: 0, timer: 1, pwm: 2, 'tone-stop': 2, main: 3 };

interface QueuedEvent {
  t: number; // ns
  prio: number;
  seq: number;
  kind: EventKind;
  pin?: string;
  level?: Level;
  gen: number;
}

class EventHeap {
  private a: QueuedEvent[] = [];
  get size(): number {
    return this.a.length;
  }
  private less(x: QueuedEvent, y: QueuedEvent): boolean {
    return x.t !== y.t ? x.t < y.t : x.prio !== y.prio ? x.prio < y.prio : x.seq < y.seq;
  }
  push(e: QueuedEvent): void {
    const a = this.a;
    a.push(e);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.less(a[i], a[p])) break;
      [a[i], a[p]] = [a[p], a[i]];
      i = p;
    }
  }
  peek(): QueuedEvent | undefined {
    return this.a[0];
  }
  pop(): QueuedEvent | undefined {
    const a = this.a;
    if (a.length === 0) return undefined;
    const top = a[0];
    const last = a.pop()!;
    if (a.length > 0) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && this.less(a[l], a[m])) m = l;
        if (r < a.length && this.less(a[r], a[m])) m = r;
        if (m === i) break;
        [a[i], a[m]] = [a[m], a[i]];
        i = m;
      }
    }
    return top;
  }
}

interface PwmState {
  periodNs: number;
  highNs: number;
  pendingHighNs: number;
  originNs: number;
  freqHz: number;
  duty: number;
  tone: boolean;
}

interface PinState {
  spec: PinSpec;
  dir: PinDirection;
  /** Output latch (AVR PORTx bit). */
  latch: Level;
  /** Actual driven level while an output (tracks PWM edges). */
  level: Level;
  pwm?: PwmState;
  pwmGen: number;
}

interface InterruptState {
  pin: string;
  isr: () => unknown;
  mode: number;
  lastLevel: Level;
  unsubscribe: () => void;
  pending: boolean;
}

interface Timer1State {
  periodNs: number;
  originNs: number;
  running: boolean;
  isr?: () => unknown;
  gen: number;
}

type MainState = 'init' | 'running' | 'pending-await' | 'waiting' | 'done' | 'halted';

/** A delay() handle: a thenable, so `await` tells the runtime the firmware really suspended. */
class DelayToken implements PromiseLike<void> {
  done = false;
  /** Error captured at the delay() call, for the call site location. */
  readonly site: Error;
  constructor(
    private readonly rt: McuRuntime,
    readonly wakeNs: number,
    readonly api: string,
  ) {
    this.site = new Error(api);
  }
  then<A = void, B = never>(
    onFulfilled?: ((value: void) => A | PromiseLike<A>) | null,
    onRejected?: ((reason: unknown) => B | PromiseLike<B>) | null,
  ): PromiseLike<A | B> {
    return new Promise<A | B>((resolve, reject) => {
      const resume = (): void => {
        try {
          resolve(onFulfilled ? onFulfilled(undefined) : (undefined as A));
        } catch (err) {
          if (onRejected) resolve(onRejected(err));
          else reject(err);
        }
      };
      this.rt._awaited(this, resume);
    });
  }
}

const NS_PER_S = 1e9;
const toNs = (t: number): number => Math.round(t * NS_PER_S);
const toS = (ns: number): number => ns / NS_PER_S;

export class McuRuntime {
  readonly id: string;
  readonly profile: McuProfile;
  readonly firmware: Firmware;
  readonly bus: McuPinBus;
  readonly pwmMode: 'edges' | 'descriptor';

  private readonly maxOps: number;
  private readonly maxPerInstant: number;
  private readonly maxStall: number;
  private readonly idleNs: number;
  private readonly recordTrace: boolean;
  private readonly cwd?: string;

  private nowNs = 0;
  private seq = 0;
  private readonly queue = new EventHeap();
  private started = false;
  private busy = false;
  private halted = false;
  private haltReason?: string;

  private mainState: MainState = 'init';
  private mainGen = 0;
  private mainResume: (() => void) | null = null;
  private pendingToken: DelayToken | null = null;
  private ctx: 'main' | 'isr' = 'main';
  private ctxLabel = 'main';

  private activity = 0;
  private opsSinceYield = 0;
  private lastInstantNs = -1;
  private eventsThisInstant = 0;

  private readonly pins = new Map<string, PinState>();
  private readonly interrupts = new Map<number, InterruptState>();
  private interruptsEnabled = true;
  private timer1: Timer1State = { periodNs: 1e9, originNs: 0, running: false, gen: 0 };
  private timer1Initialized = false;

  private readonly rng: ArduinoRandom;
  private serialBegun = false;
  private serialBaud?: number;
  private readonly serial: SerialEntry[] = [];
  private readonly rx: { t: number; byte: number }[] = [];

  private adcReadBits: number;
  private adcReference: string;

  private readonly trace: PinEvent[] = [];
  private readonly diags: McuDiagnostic[] = [];
  private readonly diagIndex = new Map<string, McuDiagnostic>();
  private idleWarned = false;

  constructor(opts: McuRuntimeOptions) {
    this.id = opts.id ?? 'U1';
    this.profile = typeof opts.profile === 'string' ? getMcuProfile(opts.profile) : opts.profile;
    this.firmware = opts.firmware;
    this.bus = opts.bus;
    this.pwmMode = opts.pwm ?? 'edges';
    this.maxOps = opts.maxOpsPerYield ?? 1e6;
    this.maxPerInstant = opts.maxEventsPerInstant ?? 1e5;
    this.maxStall = opts.maxStallTicks ?? 1000;
    this.idleNs = Math.max(1, Math.round((opts.idleLoopUs ?? this.profile.idleLoopUs) * 1e3));
    this.recordTrace = opts.recordTrace ?? true;
    this.cwd = opts.cwd;
    this.rng = new ArduinoRandom(opts.randomSeed ?? 1);
    this.adcReadBits = this.profile.adc.defaultReadBits;
    this.adcReference = this.profile.adc.defaultReference;
    for (const spec of this.profile.pins) {
      this.pins.set(spec.name, { spec, dir: 'input', latch: 0, level: 0, pwmGen: 0 });
    }
    installLoopGuard();
  }

  // ═════════════════════════ co-simulation surface ═════════════════════════

  /** Current simulation time of the firmware (s). */
  get now(): number {
    return toS(this.nowNs);
  }

  /** 'running' until the firmware crashes or is stopped by a diagnostic. */
  get state(): 'running' | 'halted' {
    return this.halted ? 'halted' : 'running';
  }

  /**
   * Earliest time (s) at which the runtime has something to do — a transient
   * breakpoint. Infinity when nothing is pending. Before the first runUntil()
   * this is the start time (setup() has not run yet).
   */
  nextWakeTime(): number {
    if (!this.started) return this.now;
    for (;;) {
      const ev = this.queue.peek();
      if (!ev) return Infinity;
      if (this.isStale(ev)) {
        this.queue.pop();
        continue;
      }
      return toS(ev.t);
    }
  }

  /**
   * Run the firmware up to simulation time t (s), processing every event with
   * time ≤ t in order, then set now = t. The pin bus is queried at each
   * event's own time; a solver-backed bus must therefore never be asked to
   * run past nextWakeTime() (see README). Calls must be awaited one at a time
   * (across all runtimes).
   */
  async runUntil(t: number): Promise<void> {
    if (!Number.isFinite(t)) throw new Error(`McuRuntime.runUntil: time must be finite, got ${t}`);
    const target = toNs(t);
    if (target < this.nowNs) {
      throw new Error(`McuRuntime.runUntil(${t}): time ${t}s is before the firmware's current time ${this.now}s`);
    }
    if (this.busy) throw new Error('McuRuntime.runUntil: already running — await the previous runUntil() first');
    this.busy = true;
    const prev = enterRuntime(this);
    try {
      if (!this.started) {
        this.started = true;
        this.startMain();
        await this.drainMain();
      }
      for (;;) {
        const ev = this.queue.peek();
        if (!ev || ev.t > target) break;
        this.queue.pop();
        if (this.isStale(ev)) continue;
        this.nowNs = ev.t;
        if (ev.t === this.lastInstantNs) {
          if (++this.eventsThisInstant > this.maxPerInstant && !this.halted && ev.kind !== 'pwm') {
            this.zeroTimeLoop();
            continue;
          }
        } else {
          this.lastInstantNs = ev.t;
          this.eventsThisInstant = 1;
        }
        await this.dispatch(ev);
      }
      this.nowNs = target;
    } finally {
      exitRuntime(prev);
      this.busy = false;
    }
  }

  /** Convenience for firmware-only runs: runUntil(t) in one call (same semantics). */
  run(t: number): Promise<void> {
    return this.runUntil(t);
  }

  /** Queue serial bytes for Serial.read()/available(), arriving at time t (default now). */
  serialInput(text: string, t = this.now): void {
    const ns = toNs(t);
    for (let i = 0; i < text.length; i++) this.rx.push({ t: ns, byte: text.charCodeAt(i) & 0xff });
    this.rx.sort((a, b) => a.t - b.t);
  }

  /** Captured serial output (copy). */
  serialLog(): SerialEntry[] {
    return this.serial.map(e => ({ ...e }));
  }

  /** Output trace: direction changes, levels, PWM descriptors (copy). */
  pinTrace(): PinEvent[] {
    return this.trace.map(e => ({ ...e }) as PinEvent);
  }

  /** Diagnostics emitted so far, in emission order (copy). */
  diagnostics(): McuDiagnostic[] {
    return this.diags.map(d => JSON.parse(JSON.stringify(d)) as McuDiagnostic);
  }

  /** Why the runtime halted, if it did. */
  get haltedBecause(): string | undefined {
    return this.haltReason;
  }

  // ═════════════════════════ event loop internals ═════════════════════════

  private push(kind: EventKind, tNs: number, gen: number, extra?: { pin?: string; level?: Level }): void {
    this.queue.push({ t: tNs, prio: PRIORITY[kind], seq: this.seq++, kind, gen, ...extra });
  }

  private isStale(ev: QueuedEvent): boolean {
    switch (ev.kind) {
      case 'main':
        return ev.gen !== this.mainGen || this.halted;
      case 'pwm':
      case 'tone-stop':
        return ev.gen !== this.pins.get(ev.pin!)!.pwmGen;
      case 'timer':
        return ev.gen !== this.timer1.gen || this.halted;
      case 'edge':
        return this.halted;
    }
  }

  private async dispatch(ev: QueuedEvent): Promise<void> {
    switch (ev.kind) {
      case 'main': {
        const token = this.pendingToken;
        if (token) {
          token.done = true;
          this.pendingToken = null;
        }
        const resume = this.mainResume;
        this.mainResume = null;
        this.mainState = 'running';
        this.ctx = 'main';
        this.ctxLabel = 'main';
        this.opsSinceYield = 0;
        resume?.();
        await this.drainMain();
        return;
      }
      case 'edge':
        this.handleEdge(ev.pin!, ev.level!);
        return;
      case 'timer': {
        const tm = this.timer1;
        if (tm.isr) this.runIsr(tm.isr, 'Timer1 callback');
        if (tm.running && tm.gen === ev.gen) this.push('timer', this.nowNs + tm.periodNs, tm.gen);
        return;
      }
      case 'pwm':
        this.pwmEdge(ev.pin!, ev.level!, ev.gen);
        return;
      case 'tone-stop': {
        const st = this.pins.get(ev.pin!)!;
        this.stopPwm(st);
        this.driveLevel(st, 0, true);
        return;
      }
    }
  }

  private startMain(): void {
    const fw = this.firmware;
    if (typeof fw.setup !== 'function' && typeof fw.loop !== 'function') {
      this.report('M609', {
        message: `firmware${fw.file ? ` ${fw.file}` : ''} exports neither setup() nor loop()`,
        at: fw.file,
        note: 'the runtime calls setup() once at t = 0 and then loop() forever; without either the MCU does nothing',
        fixes: [
          {
            kind: 'export-entry-points',
            confidence: 'mechanical',
            detail: 'export them from the firmware file: `export async function setup() { … }` and `export async function loop() { … }`',
          },
        ],
      });
      this.halt('missing entry points');
      return;
    }
    this.mainState = 'running';
    this.ctx = 'main';
    void this.mainThread();
  }

  private async mainThread(): Promise<void> {
    const fw = this.firmware;
    try {
      if (typeof fw.setup === 'function') {
        await fw.setup();
        this.checkDanglingDelay('setup');
      }
      if (typeof fw.loop !== 'function') {
        if (!this.halted) this.mainState = 'done';
        return;
      }
      for (;;) {
        const t0 = this.nowNs;
        await fw.loop();
        this.checkDanglingDelay('loop');
        if (this.nowNs === t0) {
          this.warnIdleLoop();
          await this.internalWait(this.idleNs);
        }
      }
    } catch (err) {
      this.crash(err, this.ctxLabel === 'main' ? 'main' : this.ctxLabel);
    }
  }

  /** Wait until the main thread is suspended on a simulator timer, finished or halted. */
  private async drainMain(): Promise<void> {
    let idle = 0;
    let seen = this.activity;
    while (this.mainState === 'running' || this.mainState === 'pending-await') {
      await null;
      if (this.activity !== seen) {
        seen = this.activity;
        idle = 0;
        continue;
      }
      if (++idle > this.maxStall) {
        if (this.mainState === 'pending-await' && this.pendingToken) {
          this.missingAwait(this.pendingToken);
        } else if (this.mainState === 'running') {
          this.report('M606', {
            message: `firmware is suspended on a promise the simulator does not control (t=${fmtT(this.now)})`,
            at: this.firmware.entryLocs?.loop ?? this.firmware.file,
            note: 'firmware may only await delay()/delayMicroseconds() (directly or through async helpers that do). Any other promise (fetch, setTimeout wrappers, a never-resolved Promise) would resolve in wall-clock time — or never — so simulated time cannot advance deterministically',
            fixes: [
              {
                kind: 'await-simulator-timer',
                confidence: 'suggested',
                detail: 'replace the foreign await with `await delay(ms)`; poll inputs with digitalRead() between delays or use attachInterrupt()',
              },
            ],
          });
          this.halt('foreign await');
        }
        return;
      }
    }
  }

  private internalWait(ns: number): Promise<void> {
    return new Promise<void>(resolve => {
      this.mainGen++;
      this.mainResume = resolve;
      this.mainState = 'waiting';
      this.push('main', this.nowNs + ns, this.mainGen);
    });
  }

  /** Called by DelayToken.then — the firmware really is suspended on this delay. */
  _awaited(token: DelayToken, resume: () => void): void {
    if (token.done || token !== this.pendingToken) {
      // Already elapsed (awaited twice), a no-op delay (ISR) or a halted MCU.
      if (!this.halted) resume();
      return;
    }
    this.mainResume = resume;
    this.mainState = 'waiting';
  }

  private checkDanglingDelay(where: string): void {
    if (this.mainState === 'pending-await' && this.pendingToken) {
      this.missingAwait(this.pendingToken, `${where}() returned`);
      throw new HaltSignal();
    }
  }

  private missingAwait(token: DelayToken, context?: string): void {
    const at = firmwareLocFromStack(token.site.stack, this.cwd);
    this.report('M605', {
      message: `${token.api}() at ${at ?? 'unknown location'} was not awaited${context ? ` (${context} while it was pending)` : ''}`,
      at,
      note: `delay() returns a promise; without \`await\` execution continues immediately, so the wait never happens and a later delay overlaps it. The MCU has a single thread: every delay must be awaited, and the function containing it must be async (and awaited by its callers)`,
      fixes: [
        {
          kind: 'add-await',
          confidence: 'mechanical',
          detail: `write \`await ${token.api}(…)\` at ${at ?? 'the call site'}; make the enclosing function \`async\` and \`await\` it where it is called`,
        },
      ],
    });
    this.halt('delay not awaited');
  }

  private warnIdleLoop(): void {
    if (this.idleWarned || this.halted) return;
    this.idleWarned = true;
    this.report('M604', {
      message: `loop() returned without awaiting a delay; each such pass is charged ${this.idleNs / 1e3} µs of simulated time`,
      at: this.firmware.entryLocs?.loop ?? this.firmware.file,
      note: 'firmware runs in zero simulated time between yields. A loop() pass that never waits is modelled as a fixed cost (idleLoopUs), so polling still sees inputs change, but it forces a simulator breakpoint every pass — slow for the analog engine',
      evidence: { idleLoopUs: this.idleNs / 1e3 },
      fixes: [
        {
          kind: 'await-delay',
          confidence: 'suggested',
          detail: 'if the loop only polls, add `await delay(1)` (or delayMicroseconds) at the end of loop(), or react to inputs with attachInterrupt()',
        },
      ],
    });
  }

  private zeroTimeLoop(): void {
    this.report('M603', {
      message: `more than ${this.maxPerInstant} firmware events at t=${fmtT(this.now)} — time cannot advance`,
      at: this.pendingToken ? firmwareLocFromStack(this.pendingToken.site.stack, this.cwd) : this.firmware.entryLocs?.loop,
      note: 'the firmware keeps yielding without letting simulated time advance (e.g. `while (…) await delay(0)`), or an input edge/interrupt storm is being reported at a single instant',
      fixes: [
        {
          kind: 'nonzero-delay',
          confidence: 'suggested',
          detail: 'wait a real amount of time in the loop (`await delay(1)` or `await delayMicroseconds(10)`)',
        },
      ],
    });
    this.halt('zero-time loop');
  }

  private halt(reason: string): void {
    if (this.halted) return;
    this.halted = true;
    this.haltReason = reason;
    this.mainState = 'halted';
    this.mainGen++;
    this.mainResume = null;
    this.pendingToken = null;
    for (const irq of this.interrupts.values()) irq.unsubscribe();
    this.interrupts.clear();
    this.timer1.gen++;
    this.timer1.running = false;
    // Hardware PWM keeps running: timers are hardware, only software stopped.
  }

  private crash(err: unknown, context: string): void {
    if (err instanceof HaltSignal || err instanceof McuBusyLoopError) return;
    if (this.halted) return;
    const e = err instanceof Error ? err : undefined;
    const name = e?.name ?? typeof err;
    const msg = e ? e.message : String(err);
    const frames = firmwareFrames(e?.stack, this.cwd);
    const at = frames[0]?.at;
    this.report('M601', {
      message: `firmware threw ${name}: ${msg} (in ${context}, t=${fmtT(this.now)})`,
      at,
      note: 'an uncaught exception stops the MCU; outputs keep their last state (hardware PWM keeps running). On real hardware this is usually a hang or a reset loop',
      evidence: { error: name, errorMessage: msg, context, stack: frames.map(f => (f.fn ? `${f.fn} (${f.at})` : f.at)) },
      fixes: [
        {
          kind: 'fix-firmware',
          confidence: 'suggested',
          detail: at ? `fix the code at ${at}` : 'fix the firmware code that throws',
        },
      ],
    });
    this.halt('exception');
  }

  private runIsr(fn: () => unknown, label: string): void {
    if (this.halted) return;
    const prevCtx = this.ctx;
    const prevLabel = this.ctxLabel;
    const prevOps = this.opsSinceYield;
    this.ctx = 'isr';
    this.ctxLabel = label;
    this.opsSinceYield = 0;
    try {
      const r = fn();
      if (r && typeof (r as PromiseLike<unknown>).then === 'function') {
        (r as Promise<unknown>).then(undefined, err => this.crash(err, label));
      }
    } catch (err) {
      this.crash(err, label);
    } finally {
      this.ctx = prevCtx;
      this.ctxLabel = prevLabel;
      this.opsSinceYield = prevOps;
    }
  }

  // ═════════════════════════ diagnostics ═════════════════════════

  private report(code: McuCode, f: DiagFields, dedupeKey?: string): void {
    const fields: DiagFields = { ...f, time: f.time ?? this.now, subject: { mcu: this.id, ...f.subject } };
    const key = `${code}|${dedupeKey ?? fields.at ?? ''}|${(fields.subject?.pins ?? []).join(',')}`;
    const existing = this.diagIndex.get(key);
    if (existing) {
      const ev = (existing.evidence ??= {});
      ev.occurrences = ((ev.occurrences as number | undefined) ?? 1) + 1;
      return;
    }
    const d = mcuDiagnostic(code, fields);
    this.diagIndex.set(key, d);
    this.diags.push(d);
  }

  /** Report an API misuse at the calling firmware line. */
  private misuse(code: McuCode, f: Omit<DiagFields, 'at'>): void {
    this.report(code, { ...f, at: captureFirmwareLoc(this.cwd) });
  }

  // ═════════════════════════ firmware-facing API (via ./arduino) ═════════════════════════

  /** Accounting for every API call: halted check, stall/busy-loop budgets. */
  _op(): void {
    if (this.halted) throw new HaltSignal();
    this.activity++;
    if (++this.opsSinceYield > this.maxOps) this.busyLoop();
  }

  /** Loop-guard tick injected into firmware loops (see instrument.ts). */
  _tick(): void {
    this._op();
  }

  private busyLoop(): never {
    const where = this.ctx === 'isr' ? this.ctxLabel : 'firmware';
    const err = new McuBusyLoopError(
      `${where} ran more than ${this.maxOps} operations at t=${fmtT(this.now)} without yielding`,
    );
    const at = firmwareLocFromStack(err.stack, this.cwd);
    this.report('M602', {
      message: `${where} ran more than ${this.maxOps} operations without yielding at t=${fmtT(this.now)} — a loop never awaits`,
      at,
      note: 'simulated time only advances when the firmware awaits delay()/delayMicroseconds() or loop() returns. A synchronous loop that waits for an input or for millis() to change spins forever: nothing can change while it runs',
      evidence: { maxOpsPerYield: this.maxOps, context: this.ctxLabel },
      fixes: [
        {
          kind: 'await-delay',
          confidence: 'suggested',
          detail: `add \`await delay(1)\` (or \`await delayMicroseconds(…)\`) inside the loop${at ? ` at ${at}` : ''}, or wait for the input with attachInterrupt()`,
        },
      ],
    });
    this.halt('busy loop');
    throw err;
  }

  private resolveDigital(pin: PinId, api: string): PinState | undefined {
    return this.resolve(pin, api, this.profile.digitalNumbers);
  }

  private resolve(pin: PinId, api: string, numbers: Record<string, string>): PinState | undefined {
    let name: string | undefined;
    if (typeof pin === 'number' && Number.isInteger(pin)) name = numbers[String(pin)];
    else if (typeof pin === 'string') {
      const up = pin.trim().toUpperCase();
      name = this.profile.pins.find(p => p.name.toUpperCase() === up)?.name;
      if (!name && /^\d+$/.test(up)) name = numbers[up];
    }
    const st = name ? this.pins.get(name) : undefined;
    if (!st) {
      const known = this.profile.pins.map(p => p.name);
      this.misuse('M610', {
        message: `${api}(${JSON.stringify(pin) ?? String(pin)}): no such pin on ${this.profile.part} (${this.profile.board})`,
        subject: { api },
        note: `pins on this profile: ${known.join(', ')}. Numbers follow the ${this.profile.core} numbering`,
        evidence: { pin: pin === undefined ? null : pin },
        fixes: [{ kind: 'use-existing-pin', confidence: 'suggested', detail: `use one of: ${known.join(', ')}` }],
      });
    }
    return st;
  }

  private setDir(st: PinState, dir: PinDirection): void {
    if (st.dir === dir) return;
    st.dir = dir;
    this.bus.setDirection(st.spec.name, dir, this.now);
    if (this.recordTrace) this.trace.push({ t: this.now, pin: st.spec.name, kind: 'dir', dir });
  }

  private driveLevel(st: PinState, level: Level, force = false): void {
    if (!force && st.level === level) return;
    st.level = level;
    this.bus.drive(st.spec.name, level, this.now);
    if (this.recordTrace) this.trace.push({ t: this.now, pin: st.spec.name, kind: 'level', level });
  }

  pinMode(pin: PinId, mode: number | string): void {
    this._op();
    const st = this.resolveDigital(pin, 'pinMode');
    if (!st) return;
    const m = typeof mode === 'string' ? ({ INPUT, OUTPUT, INPUT_PULLUP, INPUT_PULLDOWN } as Record<string, number>)[mode.toUpperCase()] : mode;
    const name = st.spec.name;
    if (m === OUTPUT) {
      if (!st.spec.output) {
        this.misuse('M611', {
          message: `pinMode(${name}, OUTPUT): ${name} cannot drive an output on ${this.profile.part}`,
          subject: { pins: [name], api: 'pinMode' },
          note: (st.spec.notes ?? []).join('; ') || 'this pin is input-only',
          fixes: [{ kind: 'use-output-pin', confidence: 'suggested', detail: `use an output-capable pin: ${outputPins(this.profile).slice(0, 8).join(', ')}…` }],
        });
        return;
      }
      const wasOutput = st.dir === 'output';
      this.setDir(st, 'output');
      if (!wasOutput && !st.pwm) this.driveLevel(st, st.latch, true);
      return;
    }
    if (m === INPUT || m === INPUT_PULLUP || m === INPUT_PULLDOWN) {
      if (st.pwm) this.stopPwm(st);
      let dir: PinDirection = m === INPUT ? 'input' : m === INPUT_PULLUP ? 'input_pullup' : 'input_pulldown';
      if (dir === 'input_pullup' && !st.spec.pullup) {
        this.misuse('M618', {
          message: `pinMode(${name}, INPUT_PULLUP): ${name} has no internal pull-up on ${this.profile.part}`,
          subject: { pins: [name], api: 'pinMode' },
          fixes: [{ kind: 'external-pullup', confidence: 'suggested', detail: `add an external pull-up resistor (e.g. 10k to ${this.profile.vcc} V) and use INPUT` }],
        });
        dir = 'input';
      } else if (dir === 'input_pulldown' && !st.spec.pulldown) {
        this.misuse('M618', {
          message: `pinMode(${name}, INPUT_PULLDOWN): ${this.profile.part} has no internal pull-down on ${name}`,
          subject: { pins: [name], api: 'pinMode' },
          fixes: [{ kind: 'external-pulldown', confidence: 'suggested', detail: 'add an external pull-down resistor (e.g. 10k to GND) and use INPUT' }],
        });
        dir = 'input';
      }
      if (this.profile.inputWriteControlsPullup) st.latch = dir === 'input_pullup' ? 1 : 0;
      this.setDir(st, dir);
      return;
    }
    this.misuse('M619', {
      message: `pinMode(${name}, ${String(mode)}): unknown mode`,
      subject: { pins: [name], api: 'pinMode' },
      fixes: [{ kind: 'use-mode-constant', confidence: 'mechanical', detail: 'use INPUT, OUTPUT or INPUT_PULLUP' }],
    });
  }

  digitalWrite(pin: PinId, value: unknown): void {
    this._op();
    const st = this.resolveDigital(pin, 'digitalWrite');
    if (!st) return;
    const level: Level = value ? 1 : 0;
    const name = st.spec.name;
    if (!st.spec.output) {
      this.misuse('M611', {
        message: `digitalWrite(${name}, …): ${name} is input-only on ${this.profile.part}`,
        subject: { pins: [name], api: 'digitalWrite' },
        fixes: [{ kind: 'use-output-pin', confidence: 'suggested', detail: `use an output-capable pin: ${outputPins(this.profile).slice(0, 8).join(', ')}…` }],
      });
      return;
    }
    if (st.pwm) {
      this.stopPwm(st);
      st.latch = level;
      if (st.dir === 'output') this.driveLevel(st, level, true);
      return;
    }
    if (st.dir !== 'output') {
      const avr = this.profile.inputWriteControlsPullup;
      this.misuse('M615', {
        message: `digitalWrite(${name}, ${level ? 'HIGH' : 'LOW'}) but ${name} is not an OUTPUT (pinMode missing?)`,
        subject: { pins: [name], api: 'digitalWrite' },
        note: avr
          ? `on AVR, writing an INPUT pin switches its internal pull-up (${fmtOhms(this.profile.logic.pullupOhms)}) instead of driving it — an LED lights only faintly and nothing can be driven`
          : `on ${this.profile.part} the output latch is updated but the pin is not driven until it is set to OUTPUT`,
        fixes: [{ kind: 'add-pinmode', confidence: 'mechanical', detail: `call \`pinMode(${pinArg(pin)}, OUTPUT)\` in setup() before writing` }],
      });
      st.latch = level;
      if (avr) this.setDir(st, level ? 'input_pullup' : 'input');
      return;
    }
    st.latch = level;
    this.driveLevel(st, level);
  }

  digitalRead(pin: PinId): Level {
    this._op();
    const st = this.resolveDigital(pin, 'digitalRead');
    if (!st) return 0;
    if (st.dir === 'output') return st.level;
    return this.bus.readDigital(st.spec.name, this.now) ? 1 : 0;
  }

  analogRead(pin: PinId): number {
    this._op();
    const st = this.resolve(pin, 'analogRead', this.profile.analogNumbers);
    if (!st) return 0;
    const name = st.spec.name;
    if (st.spec.adc === undefined) {
      const adcPins = this.profile.pins.filter(p => p.adc !== undefined).map(p => p.name);
      this.misuse('M613', {
        message: `analogRead(${pinArg(pin)}): ${name} has no ADC channel on ${this.profile.part}`,
        subject: { pins: [name], api: 'analogRead' },
        note: `analog inputs on this profile: ${adcPins.join(', ')}`,
        fixes: [{ kind: 'use-adc-pin', confidence: 'suggested', detail: `connect the signal to an analog input (${adcPins.join(', ')}) and read that pin` }],
      });
      return 0;
    }
    const adc = this.profile.adc;
    const vref = this.referenceVoltage();
    const vin = this.bus.readVoltage(name, this.now);
    const full = 2 ** adc.bits;
    let code = Math.floor((vin * full) / vref);
    if (!Number.isFinite(code)) code = 0;
    if (vin > vref * (1 + 1e-9) || vin < -1e-9) {
      this.report(
        'M616',
        {
          message: `analogRead(${name}): input ${fmtV(vin)} is outside 0..${fmtV(vref)} (Vref) — reading clamped`,
          subject: { pins: [name], api: 'analogRead' },
          note: 'the ADC saturates outside 0..Vref, so the firmware cannot tell values apart there; well outside the supply rails the pin protection diodes conduct (an electrical rating issue)',
          evidence: { vin, vref },
          fixes: [{ kind: 'scale-input', confidence: 'suggested', detail: `scale the signal into 0..${fmtV(vref)} with a divider, or select a larger reference` }],
        },
        name,
      );
    }
    code = Math.min(full - 1, Math.max(0, code));
    const shift = this.adcReadBits - adc.bits;
    return shift >= 0 ? code * 2 ** shift : Math.floor(code / 2 ** -shift);
  }

  private referenceVoltage(): number {
    const ref = this.profile.adc.references[this.adcReference] ?? 'vcc';
    if (ref === 'vcc') {
      // The analog bridge knows the real supply; mock buses fall back to the nominal VCC.
      const vs = this.bus.readSupply?.(this.now);
      return vs !== undefined && vs > 0 ? vs : this.profile.vcc;
    }
    if (typeof ref === 'number') return ref;
    const v = this.bus.readVoltage(ref.pin, this.now);
    return v > 0 ? v : this.profile.vcc;
  }

  analogReference(ref: string): void {
    this._op();
    const key = String(ref).toUpperCase();
    if (!(key in this.profile.adc.references)) {
      this.misuse('M618', {
        message: `analogReference(${String(ref)}) is not available on ${this.profile.part}`,
        subject: { api: 'analogReference' },
        note: `available: ${Object.keys(this.profile.adc.references).join(', ')}`,
        fixes: [{ kind: 'use-reference', confidence: 'suggested', detail: `use one of ${Object.keys(this.profile.adc.references).join(', ')}` }],
      });
      return;
    }
    this.adcReference = key;
  }

  analogReadResolution(bits: number): void {
    this._op();
    if (!this.profile.adc.adjustableResolution) {
      this.misuse('M618', {
        message: `analogReadResolution() is not available on ${this.profile.part} (${this.profile.core}); analogRead is fixed at ${this.profile.adc.defaultReadBits} bits`,
        subject: { api: 'analogReadResolution' },
        fixes: [{ kind: 'remove-call', confidence: 'mechanical', detail: 'remove the call and scale readings in firmware if needed' }],
      });
      return;
    }
    if (!Number.isInteger(bits) || bits < 1 || bits > 16) {
      this.misuse('M619', {
        message: `analogReadResolution(${bits}): bits must be an integer 1..16`,
        subject: { api: 'analogReadResolution' },
        fixes: [{ kind: 'valid-resolution', confidence: 'mechanical', detail: `use ${this.profile.adc.bits} (native)` }],
      });
      return;
    }
    this.adcReadBits = bits;
  }

  analogWrite(pin: PinId, value: number): void {
    this._op();
    const st = this.resolveDigital(pin, 'analogWrite');
    if (!st) return;
    const name = st.spec.name;
    if (!st.spec.output) {
      this.misuse('M611', {
        message: `analogWrite(${name}, …): ${name} is input-only on ${this.profile.part}`,
        subject: { pins: [name], api: 'analogWrite' },
        fixes: [{ kind: 'use-pwm-pin', confidence: 'suggested', detail: `use a PWM pin: ${pwmPins(this.profile).join(', ')}` }],
      });
      return;
    }
    let v = Number(value);
    if (!Number.isFinite(v)) {
      this.misuse('M619', {
        message: `analogWrite(${name}, ${String(value)}): value must be a number 0..${this.profile.pwmRange}`,
        subject: { pins: [name], api: 'analogWrite' },
        fixes: [{ kind: 'valid-duty', confidence: 'suggested', detail: `pass an integer 0..${this.profile.pwmRange}` }],
      });
      return;
    }
    v = Math.trunc(v);
    const range = this.profile.pwmRange;
    if (v < 0 || v > range) {
      const clamped = Math.min(range, Math.max(0, v));
      this.misuse('M620', {
        message: `analogWrite(${name}, ${v}): value outside 0..${range}, clamped to ${clamped}`,
        subject: { pins: [name], api: 'analogWrite' },
        note: this.profile.inputWriteControlsPullup
          ? `on AVR hardware the 8-bit compare register keeps only the low byte (${v} → ${((v % 256) + 256) % 256}); the simulator clamps instead`
          : undefined,
        fixes: [{ kind: 'constrain', confidence: 'mechanical', detail: `use constrain(value, 0, ${range}) or map() the value into 0..${range}` }],
      });
      v = clamped;
    }
    if (st.dir !== 'output') this.setDir(st, 'output');
    const spec = st.spec.pwm;
    if (!spec) {
      const fallback: Level = v < 128 ? 0 : 1;
      this.misuse('M612', {
        message: `analogWrite(${name}, ${v}): ${name} has no PWM on ${this.profile.part} — the core falls back to digitalWrite(${fallback ? 'HIGH' : 'LOW'})`,
        subject: { pins: [name], api: 'analogWrite' },
        note: `the Arduino core writes LOW for values < 128 and HIGH otherwise on pins without a timer output. PWM pins: ${pwmPins(this.profile).join(', ')}`,
        fixes: [{ kind: 'use-pwm-pin', confidence: 'suggested', detail: `move the load to a PWM pin (${pwmPins(this.profile).join(', ')}) and update the pin in firmware` }],
      });
      if (st.pwm) this.stopPwm(st);
      st.latch = fallback;
      this.driveLevel(st, fallback);
      return;
    }
    this.checkTimer1Conflict(name);
    const duty = pwmDuty(spec.formula, v, range);
    if (duty <= 0 || duty >= 1) {
      const level: Level = duty >= 1 ? 1 : 0;
      if (st.pwm) this.stopPwm(st);
      st.latch = level;
      this.driveLevel(st, level, true);
      return;
    }
    this.startPwm(st, spec.freqHz, duty, false);
  }

  tone(pin: PinId, freqHz: number, durationMs?: number): void {
    this._op();
    const st = this.resolveDigital(pin, 'tone');
    if (!st) return;
    const f = Number(freqHz);
    if (!Number.isFinite(f) || f <= 0 || f > 1e6) {
      this.misuse('M619', {
        message: `tone(${st.spec.name}, ${String(freqHz)}): frequency must be > 0 Hz`,
        subject: { pins: [st.spec.name], api: 'tone' },
        fixes: [{ kind: 'valid-frequency', confidence: 'suggested', detail: 'pass a frequency in Hz, e.g. tone(pin, 440)' }],
      });
      return;
    }
    if (!st.spec.output) {
      this.misuse('M611', { message: `tone(${st.spec.name}, …): pin is input-only`, subject: { pins: [st.spec.name], api: 'tone' } });
      return;
    }
    if (st.dir !== 'output') this.setDir(st, 'output');
    this.startPwm(st, f, 0.5, true);
    if (durationMs !== undefined && Number(durationMs) > 0) {
      this.push('tone-stop', this.nowNs + Math.round(Number(durationMs) * 1e6), st.pwmGen, { pin: st.spec.name });
    }
  }

  noTone(pin: PinId): void {
    this._op();
    const st = this.resolveDigital(pin, 'noTone');
    if (!st) return;
    if (st.pwm?.tone) {
      this.stopPwm(st);
      st.latch = 0;
      this.driveLevel(st, 0, true);
    }
  }

  private startPwm(st: PinState, freqHz: number, duty: number, tone: boolean): void {
    const periodNs = Math.max(2, Math.round(NS_PER_S / freqHz));
    const highNs = Math.min(periodNs - 1, Math.max(1, Math.round(periodNs * duty)));
    if (st.pwm && !st.pwm.tone && !tone && st.pwm.periodNs === periodNs) {
      // Same carrier: the new compare value takes effect at the next period (double-buffered OCR).
      st.pwm.pendingHighNs = highNs;
      st.pwm.duty = duty;
      if (this.pwmMode === 'descriptor') this.emitPwmDescriptor(st, this.nextPeriodStart(st.pwm));
      return;
    }
    if (st.pwm) this.stopPwm(st);
    const originNs = tone ? this.nowNs : 0; // PWM timers free-run from reset; tone starts now
    const pwm: PwmState = { periodNs, highNs, pendingHighNs: highNs, originNs, freqHz, duty, tone };
    st.pwm = pwm;
    st.pwmGen++;
    const start = this.nextPeriodStart(pwm);
    if (this.pwmMode === 'descriptor') {
      this.emitPwmDescriptor(st, start);
      return;
    }
    this.push('pwm', start, st.pwmGen, { pin: st.spec.name, level: 1 });
  }

  private nextPeriodStart(pwm: PwmState): number {
    const k = Math.ceil((this.nowNs - pwm.originNs) / pwm.periodNs);
    return pwm.originNs + Math.max(0, k) * pwm.periodNs;
  }

  private emitPwmDescriptor(st: PinState, startNs: number): void {
    const pwm = st.pwm!;
    const d: PwmDescriptor = { freqHz: pwm.freqHz, duty: pwm.pendingHighNs / pwm.periodNs, periodStart: toS(startNs) };
    this.bus.setPwm(st.spec.name, d, this.now);
    if (this.recordTrace) this.trace.push({ t: this.now, pin: st.spec.name, kind: 'pwm', pwm: d });
  }

  private stopPwm(st: PinState): void {
    if (!st.pwm) return;
    st.pwm = undefined;
    st.pwmGen++;
    if (this.pwmMode === 'descriptor') {
      this.bus.setPwm(st.spec.name, null, this.now);
      if (this.recordTrace) this.trace.push({ t: this.now, pin: st.spec.name, kind: 'pwm', pwm: null });
    }
  }

  private pwmEdge(pin: string, level: Level, gen: number): void {
    const st = this.pins.get(pin)!;
    const pwm = st.pwm;
    if (!pwm || gen !== st.pwmGen) return;
    if (level === 1) {
      pwm.highNs = pwm.pendingHighNs;
      this.driveLevel(st, 1, true);
      this.push('pwm', this.nowNs + pwm.highNs, gen, { pin, level: 0 });
    } else {
      this.driveLevel(st, 0, true);
      this.push('pwm', this.nowNs + (pwm.periodNs - pwm.highNs), gen, { pin, level: 1 });
    }
  }

  millis(): number {
    this._op();
    return Math.floor(this.nowNs / 1e6) >>> 0;
  }

  micros(): number {
    this._op();
    const res = this.profile.microsResolutionUs;
    return (Math.floor(this.nowNs / 1e3 / res) * res) >>> 0;
  }

  delay(ms: number): PromiseLike<void> {
    return this.makeDelay(ms, 1e6, 'delay');
  }

  delayMicroseconds(us: number): PromiseLike<void> {
    return this.makeDelay(us, 1e3, 'delayMicroseconds');
  }

  private makeDelay(amount: number, nsPerUnit: number, api: string): PromiseLike<void> {
    this._op();
    let n = Number(amount);
    if (!Number.isFinite(n) || n < 0) {
      this.misuse('M619', {
        message: `${api}(${String(amount)}): duration must be a non-negative number — treated as 0`,
        subject: { api },
        note: 'on hardware the argument is unsigned: a negative value becomes a wait of ~49 days',
        fixes: [{ kind: 'valid-duration', confidence: 'suggested', detail: `pass a non-negative duration to ${api}()` }],
      });
      n = 0;
    } else if (!Number.isInteger(n)) {
      const t = Math.floor(n);
      this.misuse('M620', {
        message: `${api}(${n}) truncated to ${api}(${t}) — the argument is an unsigned integer`,
        subject: { api },
        fixes: [
          api === 'delay'
            ? { kind: 'use-delay-microseconds', confidence: 'mechanical', detail: `use \`await delayMicroseconds(${Math.round(n * 1000)})\` for sub-millisecond waits` }
            : { kind: 'integer-duration', confidence: 'mechanical', detail: `pass an integer number of microseconds (${t})` },
        ],
      });
      n = t;
    }
    if (this.ctx === 'isr') {
      this.misuse('M607', {
        message: `${api}() called inside ${this.ctxLabel} — ignored`,
        subject: { api },
        note: 'interrupt handlers must return quickly; on hardware millis() does not advance inside an ISR, so delay() hangs or returns immediately. Interrupt handlers here are synchronous: set a flag and do the slow work in loop()',
        fixes: [{ kind: 'flag-from-isr', confidence: 'suggested', detail: 'set a variable in the handler and act on it in loop()' }],
      });
      const t = new DelayToken(this, this.nowNs, api);
      t.done = true;
      return t;
    }
    if (this.mainState === 'pending-await' && this.pendingToken) {
      this.missingAwait(this.pendingToken, `another ${api}() was called while it was pending`);
      throw new HaltSignal();
    }
    if (this.mainState === 'waiting' || this.mainState === 'done') {
      // The main thread is suspended (or finished): this call comes from a detached
      // async chain — an async function nobody awaited, or an async interrupt handler.
      const at = captureFirmwareLoc(this.cwd);
      this.report('M605', {
        message: `${api}() at ${at ?? 'unknown location'} runs outside the main thread — an async function was started without await`,
        at,
        subject: { api },
        note: 'the MCU has a single thread: async helpers that wait must be awaited by setup()/loop(); interrupt handlers must be synchronous',
        fixes: [
          {
            kind: 'add-await',
            confidence: 'mechanical',
            detail: 'await the async function that contains this call where it is invoked (e.g. `await blink()` instead of `blink()`)',
          },
        ],
      });
      this.halt('delay outside the main thread');
      throw new HaltSignal();
    }
    const token = new DelayToken(this, this.nowNs + Math.round(n * nsPerUnit), api);
    this.mainGen++;
    this.pendingToken = token;
    this.mainResume = null;
    this.mainState = 'pending-await';
    this.push('main', token.wakeNs, this.mainGen);
    return token;
  }

  digitalPinToInterrupt(pin: PinId): number {
    this._op();
    const st = this.resolveDigital(pin, 'digitalPinToInterrupt');
    return st?.spec.interrupt ?? NOT_AN_INTERRUPT;
  }

  attachInterrupt(num: number, isr: () => unknown, mode: number): void {
    this._op();
    const irqPins = this.profile.pins.filter(p => p.interrupt !== undefined);
    const spec = this.profile.pins.find(p => p.interrupt === num);
    if (!spec) {
      const asPin = this.profile.pins.find(p => p.number === num && p.interrupt !== undefined);
      const list = irqPins.length > 6 ? `every GPIO (interrupt number = pin number)` : irqPins.map(p => `${p.name} → ${p.interrupt}`).join(', ');
      this.misuse('M614', {
        message:
          num === NOT_AN_INTERRUPT
            ? `attachInterrupt(NOT_AN_INTERRUPT, …): the pin passed to digitalPinToInterrupt() cannot raise external interrupts on ${this.profile.part}`
            : `attachInterrupt(${num}, …): ${num} is not an interrupt number on ${this.profile.part}`,
        subject: { api: 'attachInterrupt' },
        note: `attachInterrupt takes an INTERRUPT number, not a pin number. Interrupt-capable pins: ${list}`,
        fixes: asPin
          ? [{ kind: 'use-digitalPinToInterrupt', confidence: 'mechanical', detail: `write \`attachInterrupt(digitalPinToInterrupt(${num}), …)\`` }]
          : [{ kind: 'use-interrupt-pin', confidence: 'suggested', detail: `wire the signal to an interrupt-capable pin (${irqPins.slice(0, 6).map(p => p.name).join(', ')}) and use digitalPinToInterrupt(pin)` }],
      });
      return;
    }
    if (typeof isr !== 'function') {
      this.misuse('M619', {
        message: `attachInterrupt(${num}, …): the handler must be a function`,
        subject: { api: 'attachInterrupt', pins: [spec.name] },
        fixes: [{ kind: 'pass-function', confidence: 'mechanical', detail: 'pass the function itself (no parentheses): attachInterrupt(n, onEdge, RISING)' }],
      });
      return;
    }
    if (mode !== RISING && mode !== FALLING && mode !== CHANGE) {
      this.misuse('M618', {
        message: `attachInterrupt(${num}, …, ${String(mode)}): only RISING, FALLING and CHANGE are supported`,
        subject: { api: 'attachInterrupt', pins: [spec.name] },
        note: 'level-triggered (LOW) interrupts re-fire continuously while the level holds and are not modelled',
        fixes: [{ kind: 'edge-mode', confidence: 'suggested', detail: 'use FALLING (button to GND with INPUT_PULLUP) or CHANGE' }],
      });
      return;
    }
    this.detachInterruptRaw(num);
    const name = spec.name;
    const st = this.pins.get(name)!;
    const lastLevel: Level = st.dir === 'output' ? st.level : this.bus.readDigital(name, this.now) ? 1 : 0;
    const unsubscribe = this.bus.onEdge(name, (level, t) => this.queueEdge(name, level, t));
    this.interrupts.set(num, { pin: name, isr, mode, lastLevel, unsubscribe, pending: false });
  }

  detachInterrupt(num: number): void {
    this._op();
    this.detachInterruptRaw(num);
  }

  private detachInterruptRaw(num: number): void {
    const irq = this.interrupts.get(num);
    if (irq) {
      irq.unsubscribe();
      this.interrupts.delete(num);
    }
  }

  noInterrupts(): void {
    this._op();
    this.interruptsEnabled = false;
  }

  interrupts_(): void {
    this._op();
    this.interruptsEnabled = true;
    const nums = [...this.interrupts.keys()].sort((a, b) => a - b);
    for (const n of nums) {
      const irq = this.interrupts.get(n);
      if (irq?.pending) {
        irq.pending = false;
        this.runIsr(irq.isr, `interrupt handler for ${irq.pin}`);
      }
    }
  }

  private queueEdge(pin: string, level: Level, t: number): void {
    const ns = toNs(t);
    if (ns < this.nowNs) {
      throw new Error(`McuPinBus.onEdge(${pin}): edge at ${t}s is before the MCU's current time ${this.now}s — report edges before calling runUntil() past them`);
    }
    this.push('edge', ns, 0, { pin, level: level ? 1 : 0 });
  }

  private handleEdge(pin: string, level: Level): void {
    for (const irq of this.interrupts.values()) {
      if (irq.pin !== pin) continue;
      if (irq.lastLevel === level) continue;
      irq.lastLevel = level;
      const fire = irq.mode === CHANGE || (irq.mode === RISING && level === 1) || (irq.mode === FALLING && level === 0);
      if (!fire) continue;
      if (!this.interruptsEnabled) {
        irq.pending = true;
        continue;
      }
      this.runIsr(irq.isr, `interrupt handler for ${pin}`);
    }
  }

  // ── Timer1 (TimerOne-library style hardware timer) ──

  timer1Initialize(periodUs = 1e6): void {
    this._op();
    if (!this.validPeriod(periodUs, 'Timer1.initialize')) return;
    this.timer1Initialized = true;
    for (const p of this.profile.timer1?.conflictsWithPins ?? []) if (this.pins.get(p)?.pwm) this.checkTimer1Conflict(p);
    this.timer1.periodNs = Math.round(periodUs * 1e3);
    this.timer1.originNs = this.nowNs;
    this.timer1.running = true;
    this.scheduleTimer1();
  }

  timer1SetPeriod(periodUs: number): void {
    this._op();
    if (!this.validPeriod(periodUs, 'Timer1.setPeriod')) return;
    this.timer1.periodNs = Math.round(periodUs * 1e3);
    this.timer1.originNs = this.nowNs;
    this.scheduleTimer1();
  }

  timer1AttachInterrupt(isr: () => unknown, periodUs?: number): void {
    this._op();
    if (typeof isr !== 'function') {
      this.misuse('M619', {
        message: 'Timer1.attachInterrupt(…): the callback must be a function',
        subject: { api: 'Timer1.attachInterrupt' },
        fixes: [{ kind: 'pass-function', confidence: 'mechanical', detail: 'pass the function itself: Timer1.attachInterrupt(onTick)' }],
      });
      return;
    }
    if (periodUs !== undefined) {
      if (!this.validPeriod(periodUs, 'Timer1.attachInterrupt')) return;
      this.timer1.periodNs = Math.round(periodUs * 1e3);
      this.timer1.originNs = this.nowNs;
    }
    if (!this.timer1Initialized) {
      this.timer1Initialized = true;
      this.timer1.originNs = this.nowNs;
    }
    this.timer1.isr = isr;
    this.timer1.running = true;
    this.scheduleTimer1();
  }

  timer1DetachInterrupt(): void {
    this._op();
    this.timer1.isr = undefined;
    this.timer1.gen++;
  }

  timer1Start(): void {
    this._op();
    this.timer1.originNs = this.nowNs;
    this.timer1.running = true;
    this.scheduleTimer1();
  }

  timer1Stop(): void {
    this._op();
    this.timer1.running = false;
    this.timer1.gen++;
  }

  timer1Resume(): void {
    this._op();
    this.timer1.running = true;
    this.scheduleTimer1();
  }

  private scheduleTimer1(): void {
    const tm = this.timer1;
    tm.gen++;
    if (!tm.running || !tm.isr) return;
    const k = Math.floor((this.nowNs - tm.originNs) / tm.periodNs) + 1;
    this.push('timer', tm.originNs + k * tm.periodNs, tm.gen);
  }

  private validPeriod(us: number, api: string): boolean {
    if (Number.isFinite(us) && us >= 1) return true;
    this.misuse('M619', {
      message: `${api}(${String(us)}): period must be ≥ 1 µs`,
      subject: { api },
      fixes: [{ kind: 'valid-period', confidence: 'suggested', detail: 'pass the period in microseconds, e.g. Timer1.initialize(1000) for 1 kHz' }],
    });
    return false;
  }

  private checkTimer1Conflict(pin: string): void {
    const conflicts = this.profile.timer1?.conflictsWithPins ?? [];
    if (!this.timer1Initialized || !conflicts.includes(pin)) return;
    this.misuse('M621', {
      message: `Timer1 is in use, but analogWrite(${pin}) needs the same hardware timer`,
      subject: { pins: [pin], api: 'analogWrite' },
      note: `on ${this.profile.part}, ${conflicts.join('/')} are Timer1 compare outputs; reprogramming Timer1 changes their PWM frequency (the simulator keeps the default frequency)`,
      fixes: [{ kind: 'other-pwm-pin', confidence: 'suggested', detail: `use a PWM pin on another timer (${pwmPins(this.profile).filter(p => !conflicts.includes(p)).join(', ')})` }],
    });
  }

  // ── Serial ──

  serialBegin(baud: number): void {
    this._op();
    this.serialBegun = true;
    this.serialBaud = Number(baud);
  }

  serialEnd(): void {
    this._op();
    this.serialBegun = false;
  }

  serialPrint(text: string): number {
    this._op();
    if (!this.serialBegun) {
      this.report(
        'M617',
        {
          message: 'Serial output before Serial.begin() — real hardware transmits nothing',
          at: captureFirmwareLoc(this.cwd),
          note: 'the UART is disabled until Serial.begin(baud); the simulator still records the text so you can see it',
          fixes: [{ kind: 'add-serial-begin', confidence: 'mechanical', detail: 'call `Serial.begin(9600)` (or 115200) at the start of setup()' }],
        },
        'serial',
      );
    }
    this.serial.push({ t: this.now, port: 'Serial', text });
    return text.length;
  }

  serialAvailable(): number {
    this._op();
    return this.rx.filter(b => b.t <= this.nowNs).length;
  }

  serialRead(peek = false): number {
    this._op();
    const first = this.rx[0];
    if (!first || first.t > this.nowNs) return -1;
    if (!peek) this.rx.shift();
    return first.byte;
  }

  get serialBaudRate(): number | undefined {
    return this.serialBaud;
  }

  // ── random ──

  random(a?: number, b?: number): number {
    this._op();
    return this.rng.random(a, b);
  }

  randomSeed(seed: number): void {
    this._op();
    this.rng.seed(seed);
  }
}

// ───────────────────────── helpers ─────────────────────────

export function pwmDuty(formula: string, v: number, range = 255): number {
  switch (formula) {
    case 'avr-fast':
      return v <= 0 ? 0 : v >= 255 ? 1 : (v + 1) / 256;
    case 'avr-phase-correct':
      return v <= 0 ? 0 : v >= 255 ? 1 : v / 255;
    case 'esp32-ledc':
      return v <= 0 ? 0 : v >= 255 ? 1 : v / 256;
    default:
      return v <= 0 ? 0 : v >= range ? 1 : v / range;
  }
}

function pwmPins(p: McuProfile): string[] {
  return p.pins.filter(x => x.pwm).map(x => x.name);
}

function outputPins(p: McuProfile): string[] {
  return p.pins.filter(x => x.output).map(x => x.name);
}

function pinArg(pin: PinId): string {
  return typeof pin === 'string' ? `'${pin}'` : String(pin);
}

function fmtT(s: number): string {
  if (s === 0) return '0 s';
  const abs = Math.abs(s);
  if (abs >= 1) return `${+s.toFixed(6)} s`;
  if (abs >= 1e-3) return `${+(s * 1e3).toFixed(6)} ms`;
  return `${+(s * 1e6).toFixed(3)} µs`;
}

function fmtV(v: number): string {
  return `${+v.toFixed(4)} V`;
}

function fmtOhms(r?: [number, number]): string {
  if (!r) return 'internal pull-up';
  return r[0] === r[1] ? `≈${r[0] / 1e3} kΩ` : `${r[0] / 1e3}–${r[1] / 1e3} kΩ`;
}
