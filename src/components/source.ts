import { parseValue } from '../core/units';
import {
  normalizeWaveform,
  waveformMaxStep,
  waveformNextBreakpoint,
  waveformValue,
  type WaveformInput,
  type WaveformSpec,
} from './waveforms';

type ValueLike = number | string;

/** AC small-signal stimulus: magnitude and phase (degrees). */
export interface AcStimulus {
  mag: number;
  phase: number;
}

/**
 * Options accepted by `new VoltageSource({...})` / `new CurrentSource({...})`.
 * Give at most one transient waveform; `dc` defaults to the waveform's value
 * at t = 0 (0 without a waveform); `ac` is the small-signal stimulus.
 */
export interface SourceOptions extends WaveformInput {
  dc?: ValueLike;
  ac?: ValueLike | { mag: ValueLike; phase?: ValueLike };
}

export interface ParsedSource {
  dc: number;
  wave: WaveformSpec | null;
  ac: AcStimulus | null;
}

const OPTION_KEYS = new Set(['dc', 'ac', 'sin', 'pulse', 'pwl', 'pwm']);

export function parseSource(arg: ValueLike | SourceOptions, who: string, quantity: string): ParsedSource {
  if (typeof arg === 'number' || typeof arg === 'string') {
    return { dc: parseValue(arg, quantity), wave: null, ac: null };
  }
  if (arg === null || typeof arg !== 'object') {
    throw new Error(`${who}: expected a ${quantity} value or an options object like { dc: 5 } or { pulse: {...} }`);
  }
  for (const key of Object.keys(arg)) {
    if (!OPTION_KEYS.has(key)) {
      throw new Error(`${who}: unknown option '${key}'. Valid: dc, ac, sin, pulse, pwl, pwm`);
    }
  }
  const wave = normalizeWaveform(arg, who);
  const dc = arg.dc !== undefined ? parseValue(arg.dc, `${who} dc`) : wave ? waveformValue(wave, 0) : 0;
  let ac: AcStimulus | null = null;
  if (arg.ac !== undefined) {
    if (typeof arg.ac === 'object') {
      ac = { mag: parseValue(arg.ac.mag, `${who} ac.mag`), phase: parseValue(arg.ac.phase ?? 0, `${who} ac.phase`) };
    } else {
      ac = { mag: parseValue(arg.ac, `${who} ac`), phase: 0 };
    }
  }
  return { dc, wave, ac };
}

export function sourceValueAt(wave: WaveformSpec | null, dc: number, t: number): number {
  return wave ? waveformValue(wave, t) : dc;
}

export function sourceNextBreakpoint(wave: WaveformSpec | null, t: number): number {
  return wave ? waveformNextBreakpoint(wave, t) : Infinity;
}

export function sourceMaxStep(wave: WaveformSpec | null): number {
  return wave ? waveformMaxStep(wave) : Infinity;
}

/** Plain-JSON params of a source: { [key]: dc, <wave kind>: {...}, ac: {mag, phase} }. */
export function sourceParams(key: string, dc: number, wave: WaveformSpec | null, ac: AcStimulus | null): Record<string, unknown> {
  const params: Record<string, unknown> = { [key]: dc };
  if (wave) Object.assign(params, JSON.parse(JSON.stringify(wave)));
  if (ac) params.ac = { mag: ac.mag, phase: ac.phase };
  return params;
}
