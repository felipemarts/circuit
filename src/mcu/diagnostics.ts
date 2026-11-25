/**
 * MCU diagnostic catalog (M601–M649 runtime, F140–F149 firmware lint) and the
 * stack-frame → firmware file:line mapping.
 *
 * Long-form explanations live in src/verify/registry.ts (`circuitsvibe explain`);
 * this table is the runtime's source of slug/severity so emitted payloads and
 * docs cannot drift apart silently (tests cross-check both).
 */

import type { Fix, McuDiagnostic } from './types';

export interface McuCodeInfo {
  slug: string;
  severity: 'error' | 'warning';
  stage: 'mcu' | 'lint';
  title: string;
}

export const MCU_CODES = {
  M601: { slug: 'firmware-exception', severity: 'error', stage: 'mcu', title: 'firmware threw an exception' },
  M602: { slug: 'busy-loop', severity: 'error', stage: 'mcu', title: 'firmware ran too long without yielding' },
  M603: { slug: 'zero-time-loop', severity: 'error', stage: 'mcu', title: 'firmware keeps yielding without letting time advance' },
  M604: { slug: 'idle-loop', severity: 'warning', stage: 'mcu', title: 'loop() returns without awaiting a delay' },
  M605: { slug: 'delay-not-awaited', severity: 'error', stage: 'mcu', title: 'delay() called without await' },
  M606: { slug: 'foreign-await', severity: 'error', stage: 'mcu', title: 'firmware awaited something that is not a simulator timer' },
  M607: { slug: 'delay-in-interrupt', severity: 'error', stage: 'mcu', title: 'delay() inside an interrupt or timer callback' },
  M608: { slug: 'firmware-load-error', severity: 'error', stage: 'mcu', title: 'firmware failed to load' },
  M609: { slug: 'missing-entry-points', severity: 'error', stage: 'mcu', title: 'firmware exports neither setup() nor loop()' },
  M610: { slug: 'unknown-pin', severity: 'error', stage: 'mcu', title: 'pin does not exist on this part' },
  M611: { slug: 'pin-not-output-capable', severity: 'error', stage: 'mcu', title: 'pin cannot be an output' },
  M612: { slug: 'no-pwm-on-pin', severity: 'error', stage: 'mcu', title: 'analogWrite() on a pin without PWM' },
  M613: { slug: 'no-adc-on-pin', severity: 'error', stage: 'mcu', title: 'analogRead() on a pin without an ADC channel' },
  M614: { slug: 'not-an-interrupt', severity: 'error', stage: 'mcu', title: 'attachInterrupt() with an invalid interrupt number' },
  M615: { slug: 'write-to-non-output', severity: 'warning', stage: 'mcu', title: 'digitalWrite() on a pin not configured as OUTPUT' },
  M616: { slug: 'adc-input-clamped', severity: 'warning', stage: 'mcu', title: 'ADC input outside 0..Vref — reading saturated' },
  M617: { slug: 'serial-not-begun', severity: 'warning', stage: 'mcu', title: 'Serial used before Serial.begin()' },
  M618: { slug: 'unsupported-api', severity: 'error', stage: 'mcu', title: 'API or mode not supported on this part or by the simulator' },
  M619: { slug: 'invalid-argument', severity: 'error', stage: 'mcu', title: 'invalid argument to an Arduino API call' },
  M620: { slug: 'value-clamped', severity: 'warning', stage: 'mcu', title: 'value out of range — clamped' },
  M621: { slug: 'timer-pwm-conflict', severity: 'warning', stage: 'mcu', title: 'hardware timer shared with PWM pins' },
  M622: { slug: 'mcu-reset-unpowered', severity: 'error', stage: 'mcu', title: 'MCU held in reset: supply below the brown-out / power-on threshold' },
  M623: { slug: 'mcu-supply-out-of-range', severity: 'error', stage: 'mcu', title: 'MCU supply outside its recommended range (error above the absolute maximum)' },

  F140: { slug: 'delay-not-awaited', severity: 'error', stage: 'lint', title: 'delay() call without await' },
  F141: { slug: 'missing-entry-points', severity: 'error', stage: 'lint', title: 'firmware does not export setup()/loop()' },
  F142: { slug: 'sync-busy-wait', severity: 'error', stage: 'lint', title: 'polling loop without await can never see time or inputs change' },
  F143: { slug: 'no-pwm-on-pin', severity: 'error', stage: 'lint', title: 'analogWrite() on a pin without PWM' },
  F144: { slug: 'pin-capability', severity: 'error', stage: 'lint', title: 'pin does not exist on this part or lacks the required function' },
  F145: { slug: 'not-an-interrupt', severity: 'error', stage: 'lint', title: 'attachInterrupt() given a pin number instead of an interrupt number' },
  F146: { slug: 'unsupported-api', severity: 'error', stage: 'lint', title: 'Arduino API not supported by the simulator' },
  F147: { slug: 'host-api', severity: 'error', stage: 'lint', title: 'wall-clock or host API in firmware' },
  F148: { slug: 'serial-not-begun', severity: 'warning', stage: 'lint', title: 'Serial used but Serial.begin() never called' },
  F149: { slug: 'write-without-pinmode', severity: 'warning', stage: 'lint', title: 'digitalWrite() to a pin never set to OUTPUT' },
} as const satisfies Record<string, McuCodeInfo>;

export type McuCode = keyof typeof MCU_CODES;

export interface DiagFields {
  message: string;
  severity?: 'error' | 'warning';
  subject?: McuDiagnostic['subject'];
  time?: number;
  at?: string;
  note?: string;
  evidence?: Record<string, unknown>;
  fixes?: Fix[];
}

export function mcuDiagnostic(code: McuCode, f: DiagFields): McuDiagnostic {
  const info: McuCodeInfo = MCU_CODES[code];
  const d: McuDiagnostic = {
    code,
    slug: info.slug,
    severity: f.severity ?? info.severity,
    stage: info.stage,
    message: f.message,
    fixes: f.fixes ?? [],
  };
  if (f.subject) d.subject = f.subject;
  if (f.time !== undefined) d.time = f.time;
  if (f.at) d.at = f.at;
  if (f.note) d.note = f.note;
  if (f.evidence) d.evidence = f.evidence;
  return d;
}

// ───────────────────────── stack frames → firmware locations ─────────────────────────

interface Frame {
  file: string;
  line: number;
  col: number;
  fn?: string;
}

function parseFrame(line: string): Frame | undefined {
  // `at fn (path:line:col)` or `at path:line:col`; paths may contain spaces.
  const withFn = line.match(/^\s*at (?:async )?(.*?) \((.+?):(\d+):(\d+)\)$/);
  const bare = withFn ? null : line.match(/^\s*at (?:async )?(.+?):(\d+):(\d+)$/);
  let file: string;
  let ln: string;
  let col: string;
  let fn: string | undefined;
  if (withFn) [, fn, file, ln, col] = withFn;
  else if (bare) [, file, ln, col] = bare;
  else return undefined;
  if (file.startsWith('file://')) {
    let f = decodeURIComponent(file.replace(/^file:\/\/\/?/, ''));
    if (!/^[A-Za-z]:/.test(f)) f = `/${f}`;
    file = f;
  }
  return { file, line: Number(ln), col: Number(col), fn };
}

function topFrameFile(): string | undefined {
  const stack = new Error().stack;
  if (!stack) return undefined;
  for (const l of stack.split('\n').slice(1)) {
    const f = parseFrame(l);
    if (f) return f.file;
  }
  return undefined;
}

/**
 * When the platform is bundled (CLI standalone, dist/index.js) every runtime
 * frame reports the bundle file; frames from that file are never firmware.
 */
const SELF_FILE = topFrameFile();

/** The runtime's own source files (when not bundled). */
const RUNTIME_FILE =
  /[\\/]src[\\/]mcu[\\/](?:node[\\/])?(?:runtime|arduino|diagnostics|module|mock-bus|measure|instrument|lint|random|profiles|constants|types|index|load-firmware)\.[cm]?[jt]s$/;

function isRuntimeFrame(file: string): boolean {
  return (
    file === SELF_FILE ||
    RUNTIME_FILE.test(file) ||
    file.includes('node_modules') ||
    file.startsWith('node:') ||
    file === '<anonymous>' ||
    file === 'native'
  );
}

/** Firmware-side frames ("file:line" plus function), innermost first. */
export function firmwareFrames(stack: string | undefined, cwd?: string): { at: string; fn?: string }[] {
  if (!stack) return [];
  const out: { at: string; fn?: string }[] = [];
  for (const l of stack.split('\n')) {
    const f = parseFrame(l);
    if (!f || isRuntimeFrame(f.file)) continue;
    out.push({ at: `${relativeToCwd(f.file, cwd)}:${f.line}`, ...(f.fn ? { fn: f.fn } : {}) });
  }
  return out;
}

/** Innermost firmware frame of a stack as cwd-relative file:line. */
export function firmwareLocFromStack(stack: string | undefined, cwd?: string): string | undefined {
  return firmwareFrames(stack, cwd)[0]?.at;
}

/** file:line of the firmware code calling into the runtime right now. */
export function captureFirmwareLoc(cwd?: string): string | undefined {
  return firmwareLocFromStack(new Error().stack, cwd);
}

function hostCwd(): string | undefined {
  // Browser-safe: `process` only exists under Node.
  const proc = (globalThis as { process?: { cwd?: () => string } }).process;
  try {
    return typeof proc?.cwd === 'function' ? proc.cwd() : undefined;
  } catch {
    return undefined;
  }
}

/** cwd-relative path with forward slashes, like src/elab/loc.ts (stable across machines). */
export function relativeToCwd(file: string, cwd = hostCwd()): string {
  const normalized = file.replace(/\\/g, '/');
  if (!cwd) return normalized;
  const base = `${cwd.replace(/\\/g, '/').replace(/\/$/, '')}/`;
  const caseInsensitive = /^[A-Za-z]:\//.test(base);
  const fold = caseInsensitive ? (s: string) => s.toLowerCase() : (s: string) => s;
  return fold(normalized).startsWith(fold(base)) ? normalized.slice(base.length) : normalized;
}
