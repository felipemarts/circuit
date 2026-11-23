/**
 * The Arduino-style firmware API — what `import { … } from 'circuitsvibe/arduino'`
 * resolves to.
 *
 * Every function dispatches to the MCU runtime that is currently executing
 * (set by McuRuntime.runUntil), so one module instance serves any number of
 * MCUs in a co-simulation. Board constants (LED_BUILTIN, A0…) are live
 * bindings updated to the running profile; at module top level of a firmware
 * file they hold the values of the profile the loader evaluated it for
 * (Uno by default).
 *
 *   import { pinMode, digitalWrite, delay, OUTPUT, HIGH, LOW, LED_BUILTIN } from 'circuitsvibe/arduino';
 *
 *   export async function setup() { pinMode(LED_BUILTIN, OUTPUT); }
 *   export async function loop() {
 *     digitalWrite(LED_BUILTIN, HIGH); await delay(500);
 *     digitalWrite(LED_BUILTIN, LOW);  await delay(500);
 *   }
 */

import type { McuRuntime } from './runtime';
import type { Level, McuProfile, PinId } from './types';
import { ATMEGA328P_UNO } from './profiles';
import { DEC } from './constants';

export * from './constants';

// ───────────────────────── ambient runtime ─────────────────────────

let active: McuRuntime | null = null;

/** @internal Called by McuRuntime.runUntil. Returns the previous runtime for exitRuntime. */
export function enterRuntime(rt: McuRuntime): McuRuntime | null {
  if (active && active !== rt) {
    throw new Error(
      `MCU runtime '${rt.id}' started while '${active.id}' is running — await each runtime's runUntil() before calling another's`,
    );
  }
  const prev = active;
  active = rt;
  useProfileConstants(rt.profile);
  return prev;
}

/** @internal */
export function exitRuntime(prev: McuRuntime | null): void {
  active = prev;
}

/** The runtime executing firmware right now, if any. */
export function currentMcu(): McuRuntime | null {
  return active;
}

function rt(api: string): McuRuntime {
  if (!active) {
    throw new Error(
      `${api}() called outside a running MCU — Arduino API calls must run inside setup(), loop() or the handlers they register (not at module top level)`,
    );
  }
  return active;
}

// ───────────────────────── loop guard (busy-loop detection) ─────────────────────────

let orphanTicks = 0;

/**
 * Injected into every while/for/do loop condition of instrumented firmware
 * (see instrument.ts): counts against the running MCU's busy-loop budget.
 */
export function loopGuard(): true {
  if (active) active._tick();
  else if (++orphanTicks > 1e7) {
    orphanTicks = 0;
    throw new Error('firmware loop at module top level does not terminate');
  }
  return true;
}

export const LOOP_GUARD_GLOBAL = '__cvLoopGuard';

/** Make `__cvLoopGuard()` resolvable from instrumented code (a non-enumerable global). */
export function installLoopGuard(): void {
  const g = globalThis as Record<string, unknown>;
  if (g[LOOP_GUARD_GLOBAL] === loopGuard) return;
  Object.defineProperty(g, LOOP_GUARD_GLOBAL, { value: loopGuard, configurable: true, writable: true, enumerable: false });
}

// ───────────────────────── board constants (live bindings) ─────────────────────────

/* eslint-disable prefer-const */
export let LED_BUILTIN = 13;
export let A0 = 14;
export let A1 = 15;
export let A2 = 16;
export let A3 = 17;
export let A4 = 18;
export let A5 = 19;
export let A6: number = undefined as unknown as number;
export let A7: number = undefined as unknown as number;
export let A10: number = undefined as unknown as number;
export let A11: number = undefined as unknown as number;
export let A12: number = undefined as unknown as number;
export let A13: number = undefined as unknown as number;
export let A14: number = undefined as unknown as number;
export let A15: number = undefined as unknown as number;
export let A16: number = undefined as unknown as number;
export let A17: number = undefined as unknown as number;
export let A18: number = undefined as unknown as number;
export let A19: number = undefined as unknown as number;

/** Point LED_BUILTIN / A0… at a profile's values (done automatically while a runtime runs). */
export function useProfileConstants(profile: McuProfile): void {
  const c = profile.constants;
  const u = undefined as unknown as number;
  LED_BUILTIN = c.LED_BUILTIN ?? u;
  A0 = c.A0 ?? u;
  A1 = c.A1 ?? u;
  A2 = c.A2 ?? u;
  A3 = c.A3 ?? u;
  A4 = c.A4 ?? u;
  A5 = c.A5 ?? u;
  A6 = c.A6 ?? u;
  A7 = c.A7 ?? u;
  A10 = c.A10 ?? u;
  A11 = c.A11 ?? u;
  A12 = c.A12 ?? u;
  A13 = c.A13 ?? u;
  A14 = c.A14 ?? u;
  A15 = c.A15 ?? u;
  A16 = c.A16 ?? u;
  A17 = c.A17 ?? u;
  A18 = c.A18 ?? u;
  A19 = c.A19 ?? u;
}

useProfileConstants(ATMEGA328P_UNO);

// ───────────────────────── digital / analog I/O ─────────────────────────

export function pinMode(pin: PinId, mode: number): void {
  rt('pinMode').pinMode(pin, mode);
}

export function digitalWrite(pin: PinId, value: number | boolean): void {
  rt('digitalWrite').digitalWrite(pin, value);
}

export function digitalRead(pin: PinId): Level {
  return rt('digitalRead').digitalRead(pin);
}

/** ADC reading: floor(Vin · 2^bits / Vref), clamped to 0..2^bits−1 (10-bit on AVR). */
export function analogRead(pin: PinId): number {
  return rt('analogRead').analogRead(pin);
}

/** AVR: DEFAULT (VCC), INTERNAL (1.1 V), EXTERNAL (AREF pin). */
export function analogReference(ref: string): void {
  rt('analogReference').analogReference(ref);
}

/** ESP32 / RP2040 only. */
export function analogReadResolution(bits: number): void {
  rt('analogReadResolution').analogReadResolution(bits);
}

/** PWM at the pin's real timer frequency, value 0..255. */
export function analogWrite(pin: PinId, value: number): void {
  rt('analogWrite').analogWrite(pin, value);
}

export function tone(pin: PinId, frequency: number, durationMs?: number): void {
  rt('tone').tone(pin, frequency, durationMs);
}

export function noTone(pin: PinId): void {
  rt('noTone').noTone(pin);
}

// ───────────────────────── time ─────────────────────────

/** Milliseconds of simulated time since reset (wraps at 2^32 like the core). */
export function millis(): number {
  return rt('millis').millis();
}

/** Microseconds of simulated time since reset, at the core's granularity (4 µs on a 16 MHz Uno). */
export function micros(): number {
  return rt('micros').micros();
}

/** Always `await delay(ms)` — the wait happens in simulated time. */
export function delay(ms: number): PromiseLike<void> {
  return rt('delay').delay(ms);
}

/** Always `await delayMicroseconds(us)`. */
export function delayMicroseconds(us: number): PromiseLike<void> {
  return rt('delayMicroseconds').delayMicroseconds(us);
}

// ───────────────────────── interrupts ─────────────────────────

export function digitalPinToInterrupt(pin: PinId): number {
  return rt('digitalPinToInterrupt').digitalPinToInterrupt(pin);
}

/** Handlers are synchronous: no delay() inside; set a flag and act on it in loop(). */
export function attachInterrupt(interrupt: number, handler: () => void, mode: number): void {
  rt('attachInterrupt').attachInterrupt(interrupt, handler, mode);
}

export function detachInterrupt(interrupt: number): void {
  rt('detachInterrupt').detachInterrupt(interrupt);
}

export function noInterrupts(): void {
  rt('noInterrupts').noInterrupts();
}

export function interrupts(): void {
  rt('interrupts').interrupts_();
}

/** TimerOne-library style periodic hardware timer (period in µs). */
export const Timer1 = {
  initialize(periodUs = 1_000_000): void {
    rt('Timer1.initialize').timer1Initialize(periodUs);
  },
  setPeriod(periodUs: number): void {
    rt('Timer1.setPeriod').timer1SetPeriod(periodUs);
  },
  attachInterrupt(handler: () => void, periodUs?: number): void {
    rt('Timer1.attachInterrupt').timer1AttachInterrupt(handler, periodUs);
  },
  detachInterrupt(): void {
    rt('Timer1.detachInterrupt').timer1DetachInterrupt();
  },
  start(): void {
    rt('Timer1.start').timer1Start();
  },
  restart(): void {
    rt('Timer1.restart').timer1Start();
  },
  stop(): void {
    rt('Timer1.stop').timer1Stop();
  },
  resume(): void {
    rt('Timer1.resume').timer1Resume();
  },
};

// ───────────────────────── Serial ─────────────────────────

/** Arduino Print formatting: integers in a base, floats with N decimals (default 2), booleans as 1/0. */
export function formatPrint(value: unknown, format?: number): string {
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return 'nan';
    if (!Number.isFinite(value)) return value > 0 ? 'inf' : '-inf';
    const isBase = format === 2 || format === 8 || format === 10 || format === 16;
    if (Number.isInteger(value) && (format === undefined || isBase)) {
      const base = format ?? DEC;
      if (base === 10) return String(value);
      return (value >>> 0).toString(base).toUpperCase();
    }
    const digits = format !== undefined && !isBase ? Math.max(0, Math.trunc(format)) : 2;
    return value.toFixed(digits);
  }
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (value === undefined) return '';
  return String(value);
}

export const Serial = {
  begin(baud = 9600): void {
    rt('Serial.begin').serialBegin(baud);
  },
  end(): void {
    rt('Serial.end').serialEnd();
  },
  print(value: unknown, format?: number): number {
    return rt('Serial.print').serialPrint(formatPrint(value, format));
  },
  println(value?: unknown, format?: number): number {
    return rt('Serial.println').serialPrint(`${formatPrint(value, format)}\r\n`);
  },
  write(value: number | string | ArrayLike<number>): number {
    const text =
      typeof value === 'number'
        ? String.fromCharCode(value & 0xff)
        : typeof value === 'string'
          ? value
          : Array.from(value, b => String.fromCharCode(b & 0xff)).join('');
    return rt('Serial.write').serialPrint(text);
  },
  available(): number {
    return rt('Serial.available').serialAvailable();
  },
  read(): number {
    return rt('Serial.read').serialRead(false);
  },
  peek(): number {
    return rt('Serial.peek').serialRead(true);
  },
  flush(): void {
    rt('Serial.flush')._op();
  },
};

// ───────────────────────── math & bits (pure) ─────────────────────────

/** Arduino random(max) / random(min, max): deterministic (avr-libc generator, seeded per MCU). */
export function random(minOrMax?: number, max?: number): number {
  return rt('random').random(minOrMax, max);
}

export function randomSeed(seed: number): void {
  rt('randomSeed').randomSeed(seed);
}

/** Arduino map(): integer arithmetic with truncating division, like the core's `long` version. */
export function map(x: number, inMin: number, inMax: number, outMin: number, outMax: number): number {
  const [X, a, b, c, d] = [x, inMin, inMax, outMin, outMax].map(Math.trunc);
  if (b === a) return c;
  return Math.trunc(((X - a) * (d - c)) / (b - a)) + c;
}

export function constrain(x: number, low: number, high: number): number {
  return x < low ? low : x > high ? high : x;
}

export const min = (a: number, b: number): number => (a < b ? a : b);
export const max = (a: number, b: number): number => (a > b ? a : b);
export const abs = (x: number): number => (x > 0 ? x : -x);
export const sq = (x: number): number => x * x;
export const bit = (n: number): number => 2 ** n;
export const bitRead = (value: number, n: number): Level => (((value >>> n) & 1) as Level);
export const bitSet = (value: number, n: number): number => value | (1 << n);
export const bitClear = (value: number, n: number): number => value & ~(1 << n);
export const bitWrite = (value: number, n: number, b: number): number => (b ? bitSet(value, n) : bitClear(value, n));
export const lowByte = (w: number): number => w & 0xff;
export const highByte = (w: number): number => (w >>> 8) & 0xff;
