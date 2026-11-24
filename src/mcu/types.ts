/**
 * MCU runtime — shared plain-data types.
 *
 * Everything here is JSON-serializable data (profiles, diagnostics, traces,
 * serial logs) except the two interfaces the integrator implements or calls
 * (`McuPinBus`, `Firmware`). Time at every public boundary is in SECONDS of
 * simulation time; the runtime keeps integer nanoseconds internally so timer
 * arithmetic never drifts.
 */

import type { Fix } from '../schema/types';

export type { Fix, FixConfidence } from '../schema/types';

/** Logic level on a pin. */
export type Level = 0 | 1;

/** Electrical configuration of a GPIO, as the bus sees it. */
export type PinDirection = 'input' | 'input_pullup' | 'input_pulldown' | 'output';

/** A firmware-side pin identifier: an Arduino pin number (13, A0 = 14 on the Uno) or a name ('D13', 'A0', 'GPIO2'). */
export type PinId = number | string;

/** PWM descriptor handed to `McuPinBus.setPwm` (descriptor mode). */
export interface PwmDescriptor {
  /** Carrier frequency in Hz (the real timer frequency of that pin on this part/core). */
  freqHz: number;
  /** High fraction of each period, 0 < duty < 1 (0 and 1 are sent as plain `drive`). */
  duty: number;
  /** Simulation time (s) of the rising edge that starts the first period at this setting. */
  periodStart: number;
}

/**
 * The abstract pin bus the runtime drives. The integrator implements it on
 * top of the analog/digital bridges; `MockPinBus` is the in-memory version
 * used by tests. Pin names are the profile's canonical names ('D13', 'A0',
 * 'GPIO2', 'GP25', 'PB1'). `t` is always the current simulation time (s).
 */
export interface McuPinBus {
  /** Pin direction / pull configuration changed. All pins start as 'input' (high-Z) at t = 0. */
  setDirection(pin: string, dir: PinDirection, t: number): void;
  /** Output pin driven to a logic level (push-pull at the profile's VOH/VOL). */
  drive(pin: string, level: Level, t: number): void;
  /**
   * Descriptor-mode PWM (only called when the runtime runs with `pwm: 'descriptor'`):
   * the pin now carries a square wave. `null` = PWM stopped (a `drive` follows).
   */
  setPwm(pin: string, pwm: PwmDescriptor | null, t: number): void;
  /** Logic level seen by the input buffer at time t (the bus applies VIL/VIH). */
  readDigital(pin: string, t: number): Level;
  /** Pin voltage (V, relative to the MCU's GND) at time t — feeds the ADC. */
  readVoltage(pin: string, t: number): number;
  /** Optional: supply VCC − GND (V) at time t — the ADC's DEFAULT (VCC) reference. Nominal profile VCC when absent. */
  readSupply?(t: number): number;
  /**
   * Subscribe to input edges on a pin (used for attachInterrupt). The bus calls
   * `cb(level, t)` when the pin's logic level changes; `t` may be in the future
   * (it is queued) but never before the runtime's current time. Returns an unsubscribe function.
   */
  onEdge(pin: string, cb: (level: Level, t: number) => void): () => void;
}

/** Firmware entry points. Arduino-style: setup() once, then loop() forever. */
export interface Firmware {
  setup?: () => unknown;
  loop?: () => unknown;
  /** Source file, for diagnostics (cwd-relative, forward slashes). */
  file?: string;
  /** file:line of the entry point definitions, when the loader found them. */
  entryLocs?: { setup?: string; loop?: string };
}

// ───────────────────────────── profiles ─────────────────────────────

export type PwmDutyFormula =
  /** AVR fast PWM via the Arduino core: (v+1)/256; 0 and 255 become digitalWrite. */
  | 'avr-fast'
  /** AVR phase-correct PWM via the Arduino core: v/255; 0 and 255 become digitalWrite. */
  | 'avr-phase-correct'
  /** ESP32 LEDC at 8 bits (arduino-esp32 3.x): v/256, v >= 255 is full on. */
  | 'esp32-ledc'
  /** Linear v/range (arduino-pico): 0 = off, 255 = full on. */
  | 'ratio';

export interface PinPwmSpec {
  /** Hardware resource, e.g. 'TIMER1A', 'LEDC', 'PWM4A'. */
  timer: string;
  freqHz: number;
  formula: PwmDutyFormula;
}

export interface PinSpec {
  /** Canonical pin name used on the bus. */
  name: string;
  /** Arduino digital pin number (what `digitalWrite(13, …)` means). */
  number: number;
  /** Port bit, e.g. 'PB5' (informational). */
  port?: string;
  input: boolean;
  output: boolean;
  pullup: boolean;
  pulldown?: boolean;
  /** ADC channel number, when the pin is an analog input. */
  adc?: number;
  pwm?: PinPwmSpec;
  /** attachInterrupt() interrupt number, when the pin is interrupt-capable. */
  interrupt?: number;
  /** Free-form caveats ('strapping pin', 'shared with RESET', 'input only'). */
  notes?: string[];
}

export interface PortGroupLimit {
  /** Pins whose currents are summed. */
  pins: string[];
  sinkMaxMa?: number;
  sourceMaxMa?: number;
  note?: string;
}

/**
 * Current limits, exposed as data for the integration's rating diagnostics
 * (R41x range). The runtime itself does not evaluate currents.
 */
export interface PinCurrentLimits {
  /** Absolute maximum DC current per I/O pin (mA). Exceeding it may destroy the pin. */
  pinAbsMaxMa?: number;
  /** Current at which output levels are specified / recommended continuous design limit (mA). */
  pinRecommendedMa?: number;
  /** Total current through the VCC / GND pins (mA). */
  vccGndMaxMa?: number;
  /** Sum of all sunk / sourced currents across ports (mA). */
  totalSinkMaxMa?: number;
  totalSourceMaxMa?: number;
  portGroups?: PortGroupLimit[];
  notes?: string[];
}

export interface AdcSpec {
  /** Native converter resolution in bits. */
  bits: number;
  /** Resolution analogRead() returns by default in this core. */
  defaultReadBits: number;
  /** analogReadResolution() is available (ESP32, RP2040). */
  adjustableResolution: boolean;
  /** Reference selectable with analogReference(): 'vcc', a fixed voltage, or a pin name to read. */
  references: Record<string, 'vcc' | number | { pin: string }>;
  defaultReference: string;
  /** Conversion transfer function; all supported parts: code = floor(Vin · 2^bits / Vref), clamped. */
  transfer: 'floor';
  /** Conversion time (µs) — informational; analogRead() is modelled as instantaneous. */
  conversionTimeUs?: number;
  notes?: string[];
}

export interface LogicThresholds {
  /** Input low max / input high min as a fraction of VCC (or absolute volts when `absolute`). */
  vilMax: number;
  vihMin: number;
  absolute?: boolean;
  /** Output levels at the test current (V). */
  vohMin?: number;
  volMax?: number;
  outputTestCurrentMa?: number;
  /** Internal pull-up resistance range (Ω). */
  pullupOhms?: [number, number];
  pulldownOhms?: [number, number];
}

export interface McuProfile {
  /** Stable profile id used in config: 'atmega328p', 'attiny85', 'esp32', 'rp2040'. */
  id: string;
  part: string;
  board: string;
  /** Arduino core whose behaviour (pin numbers, PWM, ADC defaults) is modelled. */
  core: string;
  cpuHz: number;
  vcc: number;
  logic: LogicThresholds;
  pins: PinSpec[];
  /** Arduino number → canonical name, for digital APIs (pinMode/digitalWrite/digitalRead/analogWrite). */
  digitalNumbers: Record<string, string>;
  /** Arduino number → canonical name, for analogRead (on AVR analogRead(0) means A0). */
  analogNumbers: Record<string, string>;
  /** Core constants exposed to firmware: LED_BUILTIN, A0…, as numbers. */
  constants: Record<string, number>;
  adc: AdcSpec;
  /** analogWrite() full-scale value (255 on all supported cores). */
  pwmRange: number;
  /** digitalWrite on an INPUT pin toggles the pull-up (AVR) instead of doing nothing. */
  inputWriteControlsPullup: boolean;
  /** micros() granularity (µs): 4 on a 16 MHz Uno (Timer0 /64). */
  microsResolutionUs: number;
  /** Simulated time charged for a loop() pass that returns without awaiting a delay (µs). */
  idleLoopUs: number;
  limits: PinCurrentLimits;
  /** Hardware timer used by the Timer1 API and the PWM pins it would steal. */
  timer1?: { conflictsWithPins: string[] };
  sources: string[];
  notes?: string[];
}

// ───────────────────────────── diagnostics ─────────────────────────────

export interface McuDiagnostic {
  /** Stable code: M601–M649 (runtime) or F140–F149 (firmware lint). */
  code: string;
  slug: string;
  severity: 'error' | 'warning';
  stage: 'mcu' | 'lint';
  /** One line, lowercase, root cause first. */
  message: string;
  subject?: { mcu?: string; pins?: string[]; api?: string };
  /** Simulation time (s) at which it happened (runtime diagnostics). */
  time?: number;
  /** Firmware source location file:line, when known. */
  at?: string;
  note?: string;
  evidence?: Record<string, unknown>;
  fixes: Fix[];
}

// ───────────────────────────── traces ─────────────────────────────

export interface SerialEntry {
  /** Simulation time (s) of the print/write call. */
  t: number;
  port: string;
  text: string;
}

/** Output-side event recorded by the runtime (what the firmware did to its pins). */
export type PinEvent =
  | { t: number; pin: string; kind: 'dir'; dir: PinDirection }
  | { t: number; pin: string; kind: 'level'; level: Level }
  | { t: number; pin: string; kind: 'pwm'; pwm: PwmDescriptor | null };
