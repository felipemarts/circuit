/**
 * Measurement helpers over recorded serial logs and pin traces — pure
 * functions, the backing for future assertions such as
 * `tb.expect.serial('U1').toContain('ready')` or
 * `tb.expect.pin('U1.D9').toHaveFrequency(490, { tol: 0.01 })`.
 *
 * Pin traces are piecewise-constant: a level holds from its event time until
 * the next event. Windows are closed intervals [from, to] in seconds.
 */

import type { Level, PinEvent, SerialEntry } from './types';

export interface Window {
  from?: number;
  to?: number;
}

export interface LevelPoint {
  t: number;
  level: Level;
}

// ───────────────────────── serial ─────────────────────────

/** All captured output of a port, concatenated. */
export function serialText(log: SerialEntry[], port = 'Serial'): string {
  return log.filter(e => e.port === port).map(e => e.text).join('');
}

export interface SerialLine {
  /** Time the line terminator was printed (or of the last chunk, for an unterminated tail). */
  t: number;
  text: string;
  complete: boolean;
}

/** Output split into lines on \n (a preceding \r is dropped), with completion times. */
export function serialLines(log: SerialEntry[], port = 'Serial'): SerialLine[] {
  const lines: SerialLine[] = [];
  let buf = '';
  let lastT = 0;
  for (const e of log) {
    if (e.port !== port) continue;
    lastT = e.t;
    for (const ch of e.text) {
      if (ch === '\n') {
        lines.push({ t: e.t, text: buf.endsWith('\r') ? buf.slice(0, -1) : buf, complete: true });
        buf = '';
      } else buf += ch;
    }
  }
  if (buf.length > 0) lines.push({ t: lastT, text: buf, complete: false });
  return lines;
}

export function serialContains(log: SerialEntry[], needle: string, port = 'Serial'): boolean {
  return serialText(log, port).includes(needle);
}

export function serialMatches(log: SerialEntry[], re: RegExp, port = 'Serial'): RegExpMatchArray | null {
  return serialText(log, port).match(re);
}

/** Number of lines (an unterminated tail counts as a line). */
export function serialLineCount(log: SerialEntry[], port = 'Serial'): number {
  return serialLines(log, port).length;
}

/**
 * Simulation time at which the output first contains `needle` (string or
 * regex) — the time of the chunk that completed the first occurrence.
 */
export function serialFirstTime(log: SerialEntry[], needle: string | RegExp, port = 'Serial'): number | undefined {
  const entries = log.filter(e => e.port === port);
  const text = entries.map(e => e.text).join('');
  let endIndex: number;
  if (typeof needle === 'string') {
    const i = text.indexOf(needle);
    if (i < 0) return undefined;
    endIndex = i + needle.length;
  } else {
    const re = new RegExp(needle.source, needle.flags.replace('g', ''));
    const m = re.exec(text);
    if (!m) return undefined;
    endIndex = m.index + m[0].length;
  }
  let acc = 0;
  for (const e of entries) {
    acc += e.text.length;
    if (acc >= endIndex) return e.t;
  }
  return entries[entries.length - 1]?.t;
}

// ───────────────────────── pin traces ─────────────────────────

/**
 * Level trace of one pin, from the runtime's pinTrace() or a bus drive log
 * (`{ t, pin, level }`). Consecutive duplicates are dropped.
 */
export function levelsOf(trace: ReadonlyArray<PinEvent | { t: number; pin: string; level: Level }>, pin: string): LevelPoint[] {
  const out: LevelPoint[] = [];
  for (const e of trace) {
    if (e.pin !== pin) continue;
    if ('kind' in e && e.kind !== 'level') continue;
    const level = (e as { level: Level }).level;
    const last = out[out.length - 1];
    if (last && last.level === level) continue;
    if (last && last.t === e.t) {
      out[out.length - 1] = { t: e.t, level };
      if (out.length >= 2 && out[out.length - 2].level === level) out.pop();
      continue;
    }
    out.push({ t: e.t, level });
  }
  return out;
}

/** Level at time t (the last event at or before t wins; `initial` before the first). */
export function levelAt(levels: LevelPoint[], t: number, initial: Level = 0): Level {
  let level = initial;
  for (const p of levels) {
    if (p.t <= t) level = p.level;
    else break;
  }
  return level;
}

function inWindow(t: number, w: Window): boolean {
  return (w.from === undefined || t >= w.from) && (w.to === undefined || t <= w.to);
}

/** Number of level changes inside the window. */
export function toggleCount(levels: LevelPoint[], w: Window = {}, initial: Level = 0): number {
  let count = 0;
  let prev = initial;
  for (const p of levels) {
    if (p.level !== prev && inWindow(p.t, w)) count++;
    prev = p.level;
  }
  return count;
}

/** Times of rising edges inside the window. */
export function risingEdges(levels: LevelPoint[], w: Window = {}, initial: Level = 0): number[] {
  const out: number[] = [];
  let prev = initial;
  for (const p of levels) {
    if (p.level === 1 && prev === 0 && inWindow(p.t, w)) out.push(p.t);
    prev = p.level;
  }
  return out;
}

/** Times of falling edges inside the window. */
export function fallingEdges(levels: LevelPoint[], w: Window = {}, initial: Level = 0): number[] {
  const out: number[] = [];
  let prev = initial;
  for (const p of levels) {
    if (p.level === 0 && prev === 1 && inWindow(p.t, w)) out.push(p.t);
    prev = p.level;
  }
  return out;
}

/** Mean frequency (Hz) from rising edges in the window; undefined with fewer than two. */
export function frequency(levels: LevelPoint[], w: Window = {}, initial: Level = 0): number | undefined {
  const r = risingEdges(levels, w, initial);
  if (r.length < 2) return undefined;
  return (r.length - 1) / (r[r.length - 1] - r[0]);
}

/** Time spent high inside [from, to] (s). Requires a bounded window (defaults: first/last event). */
export function highTime(levels: LevelPoint[], w: Window = {}, initial: Level = 0): number {
  const from = w.from ?? levels[0]?.t ?? 0;
  const to = w.to ?? levels[levels.length - 1]?.t ?? from;
  if (to <= from) return 0;
  let level = levelAt(levels, from, initial);
  let t = from;
  let high = 0;
  for (const p of levels) {
    if (p.t <= from) continue;
    if (p.t >= to) break;
    if (level === 1) high += p.t - t;
    level = p.level;
    t = p.t;
  }
  if (level === 1) high += to - t;
  return high;
}

/**
 * Fraction of time high in [from, to]. For a PWM signal pick a window that
 * spans whole periods (e.g. from one rising edge to a later one) for an exact
 * duty; `pwmStats` does that for you.
 */
export function dutyCycle(levels: LevelPoint[], w: Window = {}, initial: Level = 0): number {
  const from = w.from ?? levels[0]?.t ?? 0;
  const to = w.to ?? levels[levels.length - 1]?.t ?? from;
  if (to <= from) return levelAt(levels, from, initial);
  return highTime(levels, { from, to }, initial) / (to - from);
}

/** Frequency and duty measured over whole periods (first to last rising edge in the window). */
export function pwmStats(
  levels: LevelPoint[],
  w: Window = {},
  initial: Level = 0,
): { frequency: number; duty: number; periods: number } | undefined {
  const r = risingEdges(levels, w, initial);
  if (r.length < 2) return undefined;
  const from = r[0];
  const to = r[r.length - 1];
  return {
    frequency: (r.length - 1) / (to - from),
    duty: highTime(levels, { from, to }, initial) / (to - from),
    periods: r.length - 1,
  };
}
