/**
 * Microcontrollers as bench components (analog side). The firmware runs in
 * src/mcu (McuRuntime); src/mixed/mcu-cosim.ts couples it to the transient.
 *
 *   tb.add('U1', new Mcu({ profile: 'atmega328p', firmware: './blink.fw.ts' }))
 *   tb.add('U1', new ArduinoUno({ firmware: './blink.fw.ts' }))   // or Part('ArduinoUno', { firmware })
 *
 * Pins: the profile's canonical names ('D0'…'D13', 'A0'…'A5' on the Uno;
 * 'PB0'…'PB5', 'GPIOn', 'GPn') plus the supply pins VCC and GND (ArduinoUno:
 * '5V' and 'GND') and the ADC reference pin where the part has one ('AREF').
 *
 * Every I/O pin is an analog node with, between the MCU's own VCC/GND pins:
 *   leakage 1 GΩ to GND · ESD clamp diodes to VCC and GND ·
 *   OUTPUT: a push-pull stage (pull-up s/Rhigh, pull-down (1−s)/Rlow, ramped over 10 ns),
 *     Rout from the datasheet VOH/VOL rows at the accepted supply (src/mcu/electrical.ts) ·
 *   INPUT_PULLUP / INPUT_PULLDOWN: the nominal internal resistor ·
 *   averaged PWM (pwm: 'average'): a Thevenin source duty·VCC behind duty·Rhigh + (1−duty)·Rlow.
 * In reset (operating point, unpowered, brown-out) every pin is high-Z (clamps and leakage only).
 */
import { Component } from '../core/Component';
import type { Pin } from '../core/Pin';
import type { MNAMatrix } from '../solver/MNAMatrix';
import type { AcLoadContext, LoadContext } from '../analysis/context';
import type { ParamValue } from '../schema/types';
import type { Firmware, McuProfile, PinDirection, PinSpec } from '../mcu/types';
import { getMcuProfile } from '../mcu/profiles';
import { mcuElectrical, type McuElectrical } from '../mcu/electrical';
import { relativeToCwd } from '../mcu/diagnostics';
import { compileFirmware, firmwareHost, firmwareLanguage, reachableFiles, type CompiledFirmware, type FirmwareBundle, type FirmwareResult } from '../mcu/firmware';
import { Junction, OutputStage, PIN_LEAK, stampStage } from './device';

export type McuPwmMode = 'edges' | 'average';

/** Firmware: a path (relative to the bench file; read by the CLI), a source bundle, or inline entry points (tests). */
export type FirmwareInput = string | FirmwareBundle | Firmware;

export interface McuOptions {
  /** 'atmega328p' (default, Arduino Uno core) · 'attiny85' · 'esp32' · 'rp2040' (aliases 'uno', 'pico'). */
  profile?: string;
  firmware: FirmwareInput;
  /** 'edges' (default): real PWM square waves; 'average': each PWM pin is its duty-cycle average (no edges). */
  pwm?: McuPwmMode;
  /** Initial state of random() (default 1, avr-libc reset state). */
  randomSeed?: number;
}

/** @internal per-pin analog state, driven by the co-simulation. */
export interface McuCell {
  name: string;
  pin: Pin;
  /** Profile spec (undefined for the ADC reference pin). */
  spec?: PinSpec;
  dir: PinDirection;
  stage: OutputStage;
  /** Averaged PWM duty (pwm: 'average'), when the pin carries PWM. */
  avg?: number;
  clamp: [Junction, Junction];
}

const idx = (p: Pin): number => p.node.index;

/** File (cwd-relative) of the bench code constructing a component, skipping the platform's own frames. */
export function benchCallerFile(): string | undefined {
  const stack = new Error().stack;
  if (!stack) return undefined;
  let selfFile: string | undefined;
  for (const line of stack.split('\n').slice(1)) {
    const m = line.match(/\((.+?):(\d+):(\d+)\)$/) ?? line.match(/^\s*at (?:async )?(.+?):(\d+):(\d+)$/);
    if (!m) continue;
    let file = m[1].startsWith('file://') ? decodeURIComponent(m[1].replace(/^file:\/\/\/?/, '')) : m[1];
    if (m[1].startsWith('file://') && !/^[A-Za-z]:/.test(file)) file = `/${file}`;
    if (selfFile === undefined) selfFile = file;
    if (file === selfFile) continue;
    if (/[\\/]src[\\/](mixed|mcu|elab|core|vhdl|digital|components|doc)[\\/]/.test(file)) continue;
    if (file.includes('node_modules') || file.startsWith('node:')) continue;
    return relativeToCwd(file);
  }
  return undefined;
}

function isBundle(v: unknown): v is FirmwareBundle {
  return !!v && typeof v === 'object' && typeof (v as FirmwareBundle).entry === 'string' && !!(v as FirmwareBundle).files && typeof (v as FirmwareBundle).files === 'object';
}

function isInline(v: unknown): v is Firmware {
  return !!v && typeof v === 'object' && (typeof (v as Firmware).setup === 'function' || typeof (v as Firmware).loop === 'function');
}

/**
 * A microcontroller running Arduino-style TypeScript firmware, co-simulated
 * with the analog transient (firmware time = simulation time).
 */
export class Mcu extends Component {
  readonly kind = 'Mcu' as const;
  /** Netlist type ('Mcu' or a board such as 'ArduinoUno'). */
  readonly typeName: string;
  readonly profile: McuProfile;
  readonly electrical: McuElectrical;
  readonly pwmMode: McuPwmMode;
  readonly randomSeed?: number;
  /** Source bundle (path / bundle firmware) — embedded in circuit documents. */
  readonly bundle?: FirmwareBundle;
  /** Inline firmware (tests); cannot be serialized. */
  readonly inline?: Firmware;
  /** @internal compiled bundle, or the M608 load error. */
  readonly compiled?: FirmwareResult<CompiledFirmware>;
  /** @internal canonical I/O pin name → cell. */
  readonly _cells = new Map<string, McuCell>();
  /** @internal pins drive / pull (false: in reset). */
  _powered = false;
  readonly vccName: string;
  readonly gndName: string;
  private readonly lookup = new Map<string, Pin>();

  constructor(opts: McuOptions, board?: { typeName: string; vccName: string; profile: string }) {
    super();
    if (opts === null || typeof opts !== 'object') throw new Error(`${board?.typeName ?? 'Mcu'}(options): options must be an object { firmware, … }`);
    const allowed = board ? ['firmware', 'pwm', 'randomSeed'] : ['profile', 'firmware', 'pwm', 'randomSeed'];
    for (const k of Object.keys(opts)) {
      if (!allowed.includes(k)) throw new Error(`${board?.typeName ?? 'Mcu'}: unknown option '${k}'. Valid options: ${allowed.join(', ')}`);
    }
    this.typeName = board?.typeName ?? 'Mcu';
    this.profile = getMcuProfile(board?.profile ?? opts.profile ?? 'atmega328p');
    this.electrical = mcuElectrical(this.profile);
    const pwm = opts.pwm ?? 'edges';
    if (pwm !== 'edges' && pwm !== 'average') throw new Error(`${this.typeName}: pwm must be 'edges' or 'average', got ${JSON.stringify(opts.pwm)}`);
    this.pwmMode = pwm;
    if (opts.randomSeed !== undefined) {
      if (!Number.isInteger(opts.randomSeed)) throw new Error(`${this.typeName}: randomSeed must be an integer`);
      this.randomSeed = opts.randomSeed;
    }
    const fw = opts.firmware;
    if (typeof fw === 'string') {
      const host = firmwareHost();
      if (!host) {
        throw new Error(
          `${this.typeName}({ firmware: '${fw}' }): firmware paths are read by the circuitsvibe CLI (relative to the bench file); in a library/browser context pass the source as { entry, files } or inline { setup, loop }`,
        );
      }
      this.bundle = host.readBundle(fw, benchCallerFile());
    } else if (isBundle(fw)) {
      const files: Record<string, string> = {};
      for (const k of Object.keys(fw.files).sort()) {
        if (typeof fw.files[k] !== 'string') throw new Error(`${this.typeName}: firmware.files['${k}'] must be source text`);
        files[k] = fw.files[k];
      }
      this.bundle = { entry: fw.entry, files };
    } else if (isInline(fw)) {
      this.inline = fw;
    } else {
      throw new Error(`${this.typeName}: firmware must be a path ('./blink.fw.ts'), a { entry, files } source bundle or { setup, loop } functions`);
    }
    if (this.bundle) this.compiled = compileFirmware(this.bundle);

    this.vccName = board?.vccName ?? 'VCC';
    this.gndName = 'GND';
    const e = this.electrical;
    const cell = (name: string, spec: PinSpec | undefined) => {
      const pin = this.addPin(name);
      this._cells.set(name, { name, pin, spec, dir: 'input', stage: new OutputStage(), clamp: [new Junction(), new Junction()] });
      this.lookup.set(name.toUpperCase(), pin);
    };
    for (const spec of this.profile.pins) cell(spec.name, spec);
    for (const ref of Object.values(this.profile.adc.references)) {
      if (typeof ref === 'object' && !this._cells.has(ref.pin)) cell(ref.pin, undefined);
    }
    const vcc = this.addPin('VCC');
    this.lookup.set('VCC', vcc);
    if (this.vccName !== 'VCC') {
      this.pins.set(this.vccName, vcc); // board alias registered last: the canonical name
      this.lookup.set(this.vccName.toUpperCase(), vcc);
    }
    const gnd = this.addPin('GND');
    this.lookup.set('GND', gnd);
    for (const c of this._cells.values()) c.stage.ramp = e.ramp;
    for (const [num, name] of Object.entries(this.profile.digitalNumbers)) {
      const p = this.lookup.get(name.toUpperCase());
      if (p && !this.lookup.has(num)) this.lookup.set(num, p);
    }
  }

  /** Pin by canonical name ('D13', 'A0', 'VCC'), board alias, or Arduino pin number (13). Case-insensitive. */
  pin(name: string | number): Pin {
    const key = String(name).trim().toUpperCase();
    const p = this.pins.get(String(name)) ?? this.lookup.get(key);
    if (!p) {
      throw new Error(`${this.typeName} (${this.profile.part}) has no pin '${name}'. Pins: ${[...this._cells.keys()].join(', ')}, ${this.vccName}, GND`);
    }
    return p;
  }

  /** Canonical (netlist) name of one of this MCU's pins. */
  canonicalPinName(p: Pin): string {
    return p === this.pins.get('VCC') ? this.vccName : p.name;
  }

  /** @internal supply pins. */
  vccPin(): Pin {
    return this.pins.get('VCC')!;
  }
  gndPin(): Pin {
    return this.pins.get('GND')!;
  }

  /** Netlist params (the firmware is referenced by its entry path; the text travels in the document's `sources`). */
  describeParams(): Record<string, ParamValue> {
    return {
      ...(this.typeName === 'Mcu' ? { profile: this.profile.id } : {}),
      firmware: this.bundle ? this.bundle.entry : '<inline>',
      ...(this.pwmMode !== 'edges' ? { pwm: this.pwmMode } : {}),
      ...(this.randomSeed !== undefined ? { randomSeed: this.randomSeed } : {}),
    };
  }

  /** Source files to embed in a circuit document (the entry and its relative imports). */
  sourceFiles(): { path: string; language: string; text: string }[] {
    if (!this.bundle) return [];
    const files = reachableFiles(this.bundle).files.filter(p => this.bundle!.files[p] !== undefined);
    return files.map(p => ({ path: p, language: firmwareLanguage(p), text: this.bundle!.files[p] }));
  }

  /** Whether the component can be written into a circuit document (false for inline functions). */
  get serializable(): boolean {
    return this.bundle !== undefined;
  }

  isNonlinear(): boolean {
    return true;
  }

  load(ctx: LoadContext): void {
    const m = ctx.matrix;
    const vcc = idx(this.vccPin());
    const gnd = idx(this.gndPin());
    const e = this.electrical;
    for (const c of this._cells.values()) {
      const n = idx(c.pin);
      m.stampConductance(n, gnd, PIN_LEAK);
      c.clamp[0].stamp(ctx, n, vcc);
      c.clamp[1].stamp(ctx, gnd, n);
      if (!this._powered) continue;
      if (c.dir === 'input_pullup') m.stampConductance(n, vcc, 1 / e.pullup);
      else if (c.dir === 'input_pulldown' && e.pulldown) m.stampConductance(n, gnd, 1 / e.pulldown);
      if (c.avg !== undefined) {
        const g = 1 / (c.avg * c.stage.rHigh + (1 - c.avg) * c.stage.rLow);
        if (c.avg > 0) m.stampConductance(n, vcc, c.avg * g);
        if (c.avg < 1) m.stampConductance(n, gnd, (1 - c.avg) * g);
      } else stampStage(m, ctx, c.stage, 'pushpull', n, vcc, gnd);
    }
  }

  hasAcModel(): boolean {
    return true;
  }

  /** Small-signal: pins hold their state at the operating point (in reset there: high-Z + clamp/leak). */
  acLoad(ctx: AcLoadContext): void {
    const m = ctx.matrix;
    const vcc = idx(this.vccPin());
    const gnd = idx(this.gndPin());
    for (const c of this._cells.values()) {
      const n = idx(c.pin);
      m.stampAdmittance(n, gnd, PIN_LEAK, 0);
      m.stampAdmittance(n, vcc, c.clamp[0].g, 0);
      m.stampAdmittance(gnd, n, c.clamp[1].g, 0);
    }
  }

  /** Legacy entry point: the device stamps through load(ctx). */
  stamp(_matrix: MNAMatrix): void {}
}

/**
 * Arduino Uno R3 board: the ATmega328P with the Uno header names (D0–D13,
 * A0–A5, AREF, 5V, GND). The board model is the MCU pins only: the 5 V
 * regulator (VIN), the 3.3 V regulator, the USB bridge and the on-board "L"
 * LED (driven through an op-amp buffer, so it does not load D13) are not
 * modelled — power the 5V pin from a source and wire your own LED.
 */
export class ArduinoUno extends Mcu {
  constructor(opts: Omit<McuOptions, 'profile'>) {
    super(opts as McuOptions, { typeName: 'ArduinoUno', vccName: '5V', profile: 'atmega328p' });
  }
}

/** Board-level MCU types (netlist type → constructor), for Part() and buildComponent. */
export const MCU_BOARDS: Record<string, (opts: Omit<McuOptions, 'profile'>) => Mcu> = {
  ArduinoUno: opts => new ArduinoUno(opts),
};

/** `Part('ArduinoUno', { firmware })` — the MCU side of Part(); undefined for other ids. */
export function mcuPart(id: string, opts: unknown): Mcu | undefined {
  if (typeof id !== 'string') return undefined;
  const key = Object.keys(MCU_BOARDS).find(k => k.toLowerCase() === id.trim().toLowerCase().replace(/[\s_-]/g, ''));
  if (!key) return undefined;
  if (!opts || typeof opts !== 'object' || !('firmware' in opts)) throw new Error(`Part('${key}', { firmware }): a board needs its firmware, e.g. Part('${key}', { firmware: './blink.fw.ts' })`);
  return MCU_BOARDS[key](opts as Omit<McuOptions, 'profile'>);
}

export function mcuPartIds(): string[] {
  return Object.keys(MCU_BOARDS);
}

/** Rebuild an MCU from its netlist { type, params } and the document's sources. */
export function buildMcuComponent(type: string, params: Record<string, ParamValue>, sources: { path: string; text: string }[] | undefined): Mcu | undefined {
  if (type !== 'Mcu' && !(type in MCU_BOARDS)) return undefined;
  const entry = params.firmware;
  if (typeof entry !== 'string') throw new Error(`${type}: param 'firmware' must be the firmware entry path`);
  if (entry === '<inline>') throw new Error(`${type}: inline firmware functions cannot be rebuilt from a document`);
  const files: Record<string, string> = {};
  for (const s of sources ?? []) files[s.path] = s.text;
  if (files[entry] === undefined) throw new Error(`${type}: firmware '${entry}' is not among the document's sources`);
  const bundle: FirmwareBundle = { entry, files };
  // Only the files the entry reaches belong to this MCU.
  const reach = reachableFiles(bundle);
  const own: Record<string, string> = {};
  for (const p of reach.files) if (files[p] !== undefined) own[p] = files[p];
  const opts: McuOptions = { firmware: { entry, files: own } };
  if (params.pwm !== undefined) opts.pwm = params.pwm as McuPwmMode;
  if (params.randomSeed !== undefined) opts.randomSeed = params.randomSeed as number;
  if (type === 'Mcu') {
    if (typeof params.profile !== 'string') throw new Error(`Mcu: param 'profile' must be a profile id`);
    return new Mcu({ ...opts, profile: params.profile });
  }
  return MCU_BOARDS[type](opts);
}
