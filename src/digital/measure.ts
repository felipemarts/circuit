/**
 * Measurements over recorded logic waveforms — pure functions on plain data
 * (a NetTrace from `sim.trace(net)` or `sim.recording().traces[net]`).
 *
 * Conventions:
 *   - A trace is right-continuous: the value AT a change time t is the new value.
 *   - Times are compared on the 1 ps grid (both sides rounded), so a time you
 *     computed as 2e-3 matches an edge recorded at 2 ms exactly.
 *   - Windows are inclusive: from ≤ t ≤ to. Defaults: from = 0, to = +∞.
 *   - A rising edge is a 0 → 1 transition, a falling edge 1 → 0. Transitions
 *     through X or Z (0 → X → 1) are not edges: an unknown signal has no
 *     measurable timing.
 *   - Results are numbers or `undefined` ("not measurable") — never NaN or
 *     Infinity, which do not survive JSON.
 */
import type { Logic } from './logic';
import { parseLogic } from './logic';
import type { NetTrace } from './sim';
import { fromTicks, parseTime, toTicks } from './units';
import type { ValueLike } from './units';

export type EdgeKind = 'rising' | 'falling' | 'both';

export interface MeasureWindow {
  from?: ValueLike;
  to?: ValueLike;
}

function windowTicks(w: MeasureWindow = {}): [number, number] {
  const from = w.from === undefined ? 0 : toTicks(parseTime(w.from, 'window from'));
  const to = w.to === undefined ? Infinity : toTicks(parseTime(w.to, 'window to'));
  if (to < from) throw new Error(`measurement window: 'to' (${w.to}) is before 'from' (${w.from})`);
  return [from, to];
}

function check(trace: NetTrace): void {
  if (!trace || !Array.isArray(trace.t) || !Array.isArray(trace.v) || trace.t.length !== trace.v.length || trace.t.length === 0) {
    throw new Error(`malformed trace${trace?.net ? ` '${trace.net}'` : ''}: expected { net, t: number[], v: Logic[] } with at least one point`);
  }
}

/** Index of the last change at or before tick (−1 if before the first point). */
function indexAt(trace: NetTrace, tick: number): number {
  let lo = 0;
  let hi = trace.t.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (toTicks(trace.t[mid]) <= tick) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

/** Value of the net at time t (after any change at exactly t). Before the first point: the first value. */
export function valueAt(trace: NetTrace, t: ValueLike): Logic {
  check(trace);
  const i = indexAt(trace, toTicks(parseTime(t)));
  return trace.v[Math.max(0, i)];
}

/** Times (seconds) of the edges in the window. */
export function edgeTimes(trace: NetTrace, edge: EdgeKind = 'rising', w: MeasureWindow = {}): number[] {
  check(trace);
  const [from, to] = windowTicks(w);
  const out: number[] = [];
  for (let i = 1; i < trace.t.length; i++) {
    const tick = toTicks(trace.t[i]);
    if (tick < from) continue;
    if (tick > to) break;
    const a = trace.v[i - 1];
    const b = trace.v[i];
    if ((edge !== 'falling' && a === 0 && b === 1) || (edge !== 'rising' && a === 1 && b === 0)) out.push(trace.t[i]);
  }
  return out;
}

/** Number of edges of the given kind in the window. */
export function edgeCount(trace: NetTrace, edge: EdgeKind = 'rising', w: MeasureWindow = {}): number {
  return edgeTimes(trace, edge, w).length;
}

/** Mean period (s) between the first and last rising edge in the window; undefined with < 2 rising edges. */
export function period(trace: NetTrace, w: MeasureWindow = {}): number | undefined {
  const r = edgeTimes(trace, 'rising', w);
  if (r.length < 2) return undefined;
  return (r[r.length - 1] - r[0]) / (r.length - 1);
}

/** Frequency (Hz) from rising edges in the window; undefined with < 2 rising edges. */
export function frequency(trace: NetTrace, w: MeasureWindow = {}): number | undefined {
  const p = period(trace, w);
  return p === undefined || p <= 0 ? undefined : 1 / p;
}

/**
 * Duty cycle (0..1): time spent at 1 over the whole periods between the first
 * and last rising edge in the window; undefined with < 2 rising edges.
 */
export function dutyCycle(trace: NetTrace, w: MeasureWindow = {}): number | undefined {
  const r = edgeTimes(trace, 'rising', w);
  if (r.length < 2) return undefined;
  const t0 = toTicks(r[0]);
  const t1 = toTicks(r[r.length - 1]);
  return highTicks(trace, t0, t1) / (t1 - t0);
}

function highTicks(trace: NetTrace, from: number, to: number): number {
  let high = 0;
  for (let i = 0; i < trace.t.length; i++) {
    if (trace.v[i] !== 1) continue;
    const s = Math.max(from, toTicks(trace.t[i]));
    const e = Math.min(to, i + 1 < trace.t.length ? toTicks(trace.t[i + 1]) : Infinity);
    if (e > s) high += e - s;
  }
  return high;
}

/**
 * First time (s) at or after `from` that the net HAS `value`: `from` itself
 * if it already holds it there, else the first change to it. Undefined if never.
 */
export function firstTime(trace: NetTrace, value: Logic, w: MeasureWindow = {}): number | undefined {
  check(trace);
  const v = parseLogic(value);
  const [from, to] = windowTicks(w);
  const i0 = indexAt(trace, from);
  if (trace.v[Math.max(0, i0)] === v) return fromTicks(from);
  for (let i = i0 + 1; i < trace.t.length; i++) {
    const tick = toTicks(trace.t[i]);
    if (tick > to) break;
    if (trace.v[i] === v) return trace.t[i];
  }
  return undefined;
}

// ── verdict-shaped checks (back `tb.expect.logic(...)` later) ──

export interface LogicVerdict {
  pass: boolean;
  /** What the waveform shows at the decisive time. */
  measured: Logic;
  expected: Logic;
  /** Decisive time (s): the sample time, or the first violation. */
  t: number;
}

/** `expect.logic(net).toBe(value).at(t)`. */
export function checkValueAt(trace: NetTrace, expected: Logic, t: ValueLike): LogicVerdict {
  const e = parseLogic(expected);
  const time = fromTicks(toTicks(parseTime(t)));
  const measured = valueAt(trace, time);
  return { pass: measured === e, measured, expected: e, t: time };
}

/** `expect.logic(net).toStay(value).between(from, to)`: verdict at the first violation, or pass. */
export function checkStable(trace: NetTrace, expected: Logic, w: MeasureWindow = {}): LogicVerdict {
  check(trace);
  const e = parseLogic(expected);
  const [from, to] = windowTicks(w);
  const i0 = Math.max(0, indexAt(trace, from));
  if (trace.v[i0] !== e) return { pass: false, measured: trace.v[i0], expected: e, t: fromTicks(from) };
  for (let i = i0 + 1; i < trace.t.length; i++) {
    const tick = toTicks(trace.t[i]);
    if (tick > to) break;
    if (trace.v[i] !== e) return { pass: false, measured: trace.v[i], expected: e, t: trace.t[i] };
  }
  return { pass: true, measured: e, expected: e, t: fromTicks(from) };
}
