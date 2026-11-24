/**
 * Behavioral-model contract between primitives and the event kernel.
 * Internal: models are created by the part registry from plain-JSON params.
 */
import type { Code } from './logic';
import type { DigitalDiagnostic } from './diagnostics';
import { makeDiagnostic } from './diagnostics';
import { formatTime, fromTicks } from './units';

/** What the kernel offers a model while it evaluates. */
export interface Host {
  /** Current time in ticks (ps). */
  readonly tick: number;
  /** Current time in seconds. */
  readonly time: number;
  /**
   * True during the power-on settle at t = 0: outputs are applied with zero
   * delay, and models must not detect edges or check timing (they only
   * record the input values as "previous").
   */
  readonly initializing: boolean;
  /** Resolved value code of a net (Z is reported as Z; models map it to X). */
  read(net: number): Code;
  /**
   * Schedule a new drive code on one of the model's drivers, using the
   * driver's configured propagation delay and mode (inertial/transport).
   * `delay` (integer ticks >= 0) overrides the configured delay for this one
   * transaction (behavioral models with per-assignment delays, e.g. VHDL
   * `after`); the driver's mode still applies. During the power-on settle the
   * value is applied immediately whatever the delay.
   */
  out(driver: number, drive: number, delay?: number): void;
  /** Schedule a drive code at an absolute tick (sources: clock, stimulus). Never cancels other events. */
  outAt(driver: number, drive: number, tick: number): void;
  /** Ask the kernel to call `model.wake(tag)` at an absolute tick. */
  wakeAt(comp: number, tick: number, tag: number): void;
  report(d: DigitalDiagnostic): void;
}

export interface Model {
  /** Called once before the power-on settle: put initial state on the outputs. */
  reset(h: Host): void;
  /** Called whenever any input net changed (once per delta cycle), and repeatedly during the settle. */
  evaluate(h: Host): void;
  /** Called once after the settle: sources schedule their first events here. */
  start?(h: Host): void;
  wake?(h: Host, tag: number): void;
}

/** Wiring handed to a model factory: pin name → net index (inputs) / driver index (outputs). */
export interface ModelCtx {
  id: string;
  comp: number;
  inputs: Record<string, number>;
  outputs: Record<string, number>;
}

/** Edge classification of a clock-like input. */
export const EDGE_NONE = 0;
export const EDGE_RISE = 1;
export const EDGE_FALL = 2;
/** A transition through X/Z that may or may not be the edge (0→X, X→1, …). */
export const EDGE_MAYBE_RISE = 3;
export const EDGE_MAYBE_FALL = 4;

export function classifyEdge(prev: Code, cur: Code): number {
  if (prev === cur) return EDGE_NONE;
  const p = prev > 1 ? 2 : prev;
  const c = cur > 1 ? 2 : cur;
  if (p === c) return EDGE_NONE; // X ↔ Z
  if (p === 0 && c === 1) return EDGE_RISE;
  if (p === 1 && c === 0) return EDGE_FALL;
  if (p === 0 || c === 1) return EDGE_MAYBE_RISE;
  return EDGE_MAYBE_FALL;
}

export interface TimingViolation {
  kind: 'setup' | 'hold';
  pin: string;
  /** Measured interval (ticks) between data change and edge. */
  measured: number;
  /** Required interval (ticks). */
  required: number;
  edgeTick: number;
  dataTick: number;
}

/**
 * Setup/hold bookkeeping for one sequential element. Times in ticks.
 *   setup: data must be stable `setup` before the active edge.
 *   hold:  data must stay stable `hold` after the active edge.
 * A data change in the same tick as the edge is 0 before it (setup check).
 */
export class TimingChecker {
  private lastChange: number[];
  private lastEdge = -Infinity;

  constructor(
    readonly setup: number,
    readonly hold: number,
    readonly pins: string[],
  ) {
    this.lastChange = pins.map(() => -Infinity);
  }

  get enabled(): boolean {
    return this.setup > 0 || this.hold > 0;
  }

  /** Record a data change; returns a hold violation when it is too close after the last edge. */
  dataChanged(i: number, tick: number, checkHold = true): TimingViolation | null {
    this.lastChange[i] = tick;
    if (!checkHold || this.hold <= 0) return null;
    const since = tick - this.lastEdge;
    if (since < this.hold) {
      return { kind: 'hold', pin: this.pins[i], measured: since, required: this.hold, edgeTick: this.lastEdge, dataTick: tick };
    }
    return null;
  }

  /** Record an active edge; returns the worst setup violation among the data pins. */
  edge(tick: number): TimingViolation | null {
    this.lastEdge = tick;
    if (this.setup <= 0) return null;
    let worst: TimingViolation | null = null;
    for (let i = 0; i < this.pins.length; i++) {
      const before = tick - this.lastChange[i];
      if (before < this.setup && (!worst || before < worst.measured)) {
        worst = { kind: 'setup', pin: this.pins[i], measured: before, required: this.setup, edgeTick: tick, dataTick: this.lastChange[i] };
      }
    }
    return worst;
  }
}

/** Build the D502/D503 diagnostic for a violation. */
export function timingDiagnostic(id: string, v: TimingViolation, edgeName: string, makesX: boolean): DigitalDiagnostic {
  const measured = fromTicks(v.measured);
  const required = fromTicks(v.required);
  const margin = measured - required;
  const ref = `${id}.${v.pin}`;
  const setup = v.kind === 'setup';
  return makeDiagnostic(setup ? 'D502' : 'D503', {
    message: setup
      ? `setup violation on ${ref} at ${formatTime(fromTicks(v.edgeTick))}: data changed ${formatTime(measured)} before the ${edgeName}, setup is ${formatTime(required)} (margin ${formatTime(margin)})`
      : `hold violation on ${ref} at ${formatTime(fromTicks(v.dataTick))}: data changed ${formatTime(measured)} after the ${edgeName}, hold is ${formatTime(required)} (margin ${formatTime(margin)})`,
    subject: { components: [id], pins: [ref] },
    time: fromTicks(setup ? v.edgeTick : v.dataTick),
    note: setup
      ? 'the input must be stable for the setup time before the sampling edge; closer than that the element may go metastable, so the captured value is unknown'
      : 'the input must stay stable for the hold time after the sampling edge; changing earlier corrupts the value being captured',
    evidence: {
      kind: v.kind,
      pin: v.pin,
      edgeTime: fromTicks(v.edgeTick),
      dataTime: fromTicks(v.dataTick),
      measured,
      required,
      margin,
      output: makesX ? 'X' : 'kept',
    },
    fixes: setup
      ? [
          { kind: 'retime', confidence: 'suggested', detail: `make ${ref} settle at least ${formatTime(required)} before the ${edgeName}: lower the clock frequency, shift the data edge, or shorten the logic path feeding ${ref}` },
        ]
      : [
          { kind: 'retime', confidence: 'suggested', detail: `keep ${ref} stable for ${formatTime(required)} after the ${edgeName}: add delay on the path feeding ${ref} or move the data edge later` },
        ],
  });
}

export function unknownControlDiagnostic(id: string, pin: string, tick: number, what: string): DigitalDiagnostic {
  const ref = `${id}.${pin}`;
  return makeDiagnostic('D506', {
    message: `${ref} is X/Z at ${formatTime(fromTicks(tick))} (${what}); ${id} outputs go to X`,
    subject: { components: [id], pins: [ref] },
    time: fromTicks(tick),
    note: 'an unknown clock or asynchronous control may or may not have acted, so the stored state is unknown',
    evidence: { pin },
    fixes: [
      { kind: 'drive-control', confidence: 'suggested', detail: `drive ${ref} to a defined 0/1 before it matters (initialize the source, add a Pull, or check for contention on its net)` },
    ],
  });
}
