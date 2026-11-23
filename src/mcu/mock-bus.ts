/**
 * MockPinBus — pure in-memory McuPinBus for testing firmware without any
 * circuit. Records every call with its timestamp; inputs are scripted as
 * digital waveforms (which also produce interrupt edges) or voltages (for
 * the ADC).
 */

import type { Level, McuPinBus, PinDirection, PwmDescriptor } from './types';

export type BusCall =
  | { kind: 'dir'; pin: string; t: number; dir: PinDirection }
  | { kind: 'drive'; pin: string; t: number; level: Level }
  | { kind: 'pwm'; pin: string; t: number; pwm: PwmDescriptor | null };

type EdgeCb = (level: Level, t: number) => void;

export interface MockPinBusOptions {
  /** Supply voltage used to turn digital levels into volts and back (default 5). */
  vcc?: number;
}

export class MockPinBus implements McuPinBus {
  /** Every call, in order. */
  readonly calls: BusCall[] = [];
  /** Only the drive() calls. */
  readonly drives: { t: number; pin: string; level: Level }[] = [];
  readonly vcc: number;

  private readonly waveforms = new Map<string, { t: number; level: Level }[]>();
  private readonly voltages = new Map<string, number | ((t: number) => number)>();
  private readonly subs = new Map<string, Set<EdgeCb>>();
  private readonly dirs = new Map<string, PinDirection>();
  private readonly outputs = new Map<string, Level>();
  /** Latest time seen in any call — edges at or before it can no longer be delivered. */
  private lastT = 0;

  constructor(opts: MockPinBusOptions = {}) {
    this.vcc = opts.vcc ?? 5;
  }

  // ── McuPinBus ──

  setDirection(pin: string, dir: PinDirection, t: number): void {
    this.seen(t);
    this.dirs.set(pin, dir);
    this.calls.push({ kind: 'dir', pin, t, dir });
  }

  drive(pin: string, level: Level, t: number): void {
    this.seen(t);
    this.outputs.set(pin, level);
    this.calls.push({ kind: 'drive', pin, t, level });
    this.drives.push({ t, pin, level });
  }

  setPwm(pin: string, pwm: PwmDescriptor | null, t: number): void {
    this.seen(t);
    this.calls.push({ kind: 'pwm', pin, t, pwm });
  }

  readDigital(pin: string, t: number): Level {
    this.seen(t);
    const wave = this.waveforms.get(pin);
    if (wave && wave.length > 0) return levelAt(wave, t);
    const v = this.voltages.get(pin);
    if (v !== undefined) return (typeof v === 'function' ? v(t) : v) >= this.vcc / 2 ? 1 : 0;
    const dir = this.dirs.get(pin);
    if (dir === 'output') return this.outputs.get(pin) ?? 0;
    return dir === 'input_pullup' ? 1 : 0; // floating input reads 0
  }

  readVoltage(pin: string, t: number): number {
    this.seen(t);
    const v = this.voltages.get(pin);
    if (v !== undefined) return typeof v === 'function' ? v(t) : v;
    const wave = this.waveforms.get(pin);
    if (wave && wave.length > 0) return levelAt(wave, t) * this.vcc;
    const dir = this.dirs.get(pin);
    if (dir === 'output') return (this.outputs.get(pin) ?? 0) * this.vcc;
    return dir === 'input_pullup' ? this.vcc : 0;
  }

  onEdge(pin: string, cb: EdgeCb): () => void {
    let set = this.subs.get(pin);
    if (!set) this.subs.set(pin, (set = new Set()));
    set.add(cb);
    // Deliver already-scripted future transitions.
    const wave = this.waveforms.get(pin) ?? [];
    let prev: Level = 0;
    for (const p of wave) {
      if (p.t > this.lastT && p.level !== prev) cb(p.level, p.t);
      prev = p.level;
    }
    return () => set!.delete(cb);
  }

  // ── scripting ──

  /** Set a digital input level from time t on (default 0). Script points in time order. */
  setInput(pin: string, level: Level, t = 0): this {
    let wave = this.waveforms.get(pin);
    if (!wave) this.waveforms.set(pin, (wave = []));
    const before = levelAt(wave, t);
    wave.push({ t, level });
    wave.sort((a, b) => a.t - b.t);
    if (before !== level) {
      for (const cb of this.subs.get(pin) ?? []) {
        if (t <= this.lastT) {
          throw new Error(`MockPinBus.setInput(${pin}) at t=${t}: the MCU is already at t=${this.lastT}; script inputs ahead of runUntil()`);
        }
        cb(level, t);
      }
    }
    return this;
  }

  /** Script a whole digital waveform: [[t, level], …]. */
  setInputWaveform(pin: string, points: [number, Level][]): this {
    for (const [t, level] of points) this.setInput(pin, level, t);
    return this;
  }

  /** Fixed voltage, or a function of time, for analogRead (and digitalRead at VCC/2). */
  setVoltage(pin: string, v: number | ((t: number) => number)): this {
    this.voltages.set(pin, v);
    return this;
  }

  /** Square wave on an input: `count` pulses of `high` s every `period` s starting at t0. */
  pulseTrain(pin: string, opts: { t0: number; period: number; high: number; count: number }): this {
    if (!this.waveforms.has(pin)) this.setInput(pin, 0, 0);
    for (let k = 0; k < opts.count; k++) {
      const t = opts.t0 + k * opts.period;
      this.setInput(pin, 1, t);
      this.setInput(pin, 0, t + opts.high);
    }
    return this;
  }

  /** Drive events for one pin. */
  drivesOf(pin: string): { t: number; level: Level }[] {
    return this.drives.filter(d => d.pin === pin).map(d => ({ t: d.t, level: d.level }));
  }

  private seen(t: number): void {
    if (t > this.lastT) this.lastT = t;
  }
}

function levelAt(wave: { t: number; level: Level }[], t: number): Level {
  let level: Level = 0;
  for (const p of wave) {
    if (p.t <= t) level = p.level;
    else break;
  }
  return level;
}
