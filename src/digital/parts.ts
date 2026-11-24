/**
 * Digital part catalog: plain-JSON parameter normalization, pin layouts,
 * delay configuration, combinational paths (for lint) and model factories.
 *
 * Every part is fully described by `{ type, params }` where params is plain
 * JSON with times in SECONDS (numbers). `normalize` validates user options
 * (which may use strings like '10n') and is idempotent on its own output, so
 * a netlist serialized with JSON.stringify rebuilds the identical circuit.
 */
import type { Logic } from './logic';
import { parseLogic } from './logic';
import type { Model, ModelCtx } from './model';
import {
  ClockModel,
  ConstModel,
  CounterModel,
  DffModel,
  GateModel,
  JkModel,
  LatchModel,
  MuxModel,
  ShiftModel,
  StimulusModel,
  TriBufModel,
} from './models';
import type { GateOp } from './models';
import { parseFrequency, parseNumber, parseTime, toTicks } from './units';
import type { ValueLike } from './units';

export type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };
export type PartParams = { [k: string]: JsonValue };

/** Default propagation delay of every primitive with a delay (1 ns). */
export const DEFAULT_DELAY = 1e-9;

export interface PinLayout {
  inputs: string[];
  outputs: string[];
  /** Subset of inputs that are edge-sensitive clocks (lint F134). */
  clocks: string[];
}

export interface DelayConfig {
  rise: number;
  fall: number;
  mode: 'inertial' | 'transport';
}

export interface CombPath {
  from: string;
  to: string;
  /** Minimum delay along this path, seconds. */
  delay: number;
}

export interface PartDef {
  type: string;
  summary: string;
  normalize(opts: Record<string, unknown>): PartParams;
  pins(p: PartParams): PinLayout;
  /** strong push-pull, tristate (may release to Z) or weak (pull). */
  driver: 'strong' | 'tristate' | 'weak';
  delay(p: PartParams): DelayConfig;
  combPaths(p: PartParams): CombPath[];
  create(p: PartParams, ctx: ModelCtx): Model;
}

// ── option types (what users pass to constructors) ──

export type DelayLike = ValueLike | { rise: ValueLike; fall: ValueLike };

export interface TimingOptions {
  /** Propagation delay: seconds or '5n'; or { rise, fall } for tpLH/tpHL. Default 1 ns. */
  delay?: DelayLike;
  /** 'inertial' (default) rejects pulses shorter than the delay; 'transport' passes every pulse. */
  delayMode?: 'inertial' | 'transport';
}

export interface GateOptions extends TimingOptions {
  /** Number of inputs (pins 'a', 'b', 'c', …). Default 2. */
  inputs?: number;
}

export interface TriBufOptions extends TimingOptions {
  /** Enable is active low ('en' = 0 drives). Default false. */
  activeLow?: boolean;
}

export interface MuxOptions extends TimingOptions {
  /** Number of select bits k: pins s0..s(k-1) (s0 = LSB), d0..d(2^k-1). Default 1 (2:1). */
  select?: number;
}

export interface SequentialOptions extends TimingOptions {
  /** Setup time before the active edge. Default 0 (no check). */
  setup?: ValueLike;
  /** Hold time after the active edge. Default 0 (no check). */
  hold?: ValueLike;
  /** On a setup/hold violation: 'x' (default) drives X; 'keep' captures normally (diagnostic only). */
  onViolation?: 'x' | 'keep';
}

export interface FlipFlopOptions extends SequentialOptions {
  /** Power-on state. Default 0. */
  init?: Logic;
  /** Add an active-high asynchronous 'set' pin. */
  set?: boolean;
  /** Add an active-high asynchronous 'reset' pin. */
  reset?: boolean;
}

export interface LatchOptions extends SequentialOptions {
  init?: Logic;
}

export interface CounterOptions extends SequentialOptions {
  /** Width N: outputs q0..q(N-1), q0 = LSB. Default 4. */
  bits?: number;
  /** Add an 'en' pin (count only while 1). */
  enable?: boolean;
  /** Add an active-high 'reset' pin. */
  reset?: boolean;
  /** 'async' (default) clears immediately; 'sync' clears on the next rising clk edge. */
  resetMode?: 'async' | 'sync';
  /** Add an 'up' pin: 1 counts up, 0 counts down. */
  upDown?: boolean;
  /** Power-on count. Default 0. */
  init?: number;
}

export interface ShiftRegisterOptions extends SequentialOptions {
  bits?: number;
  /** 'sipo' (default): si → q0..q(N-1), so = q(N-1). 'piso': load + p0..p(N-1) → so. */
  mode?: 'sipo' | 'piso';
  /** PISO only: add an 'si' pin shifted in when not loading (otherwise 0 is shifted in). */
  serialIn?: boolean;
  /** Add an active-high asynchronous 'reset' pin. */
  reset?: boolean;
  /** Power-on contents as an integer (bit i = stage i). Default 0. */
  init?: number;
}

export interface ClockOptions {
  /** Frequency ('1M', 1e6) — or give `period`. */
  freq?: ValueLike;
  period?: ValueLike;
  /** High fraction of the period, 0 < duty < 1. Default 0.5. */
  duty?: number;
  /** Time of the first rising edge (phase offset). Low before it. Default 0. */
  start?: ValueLike;
  /** No edges after this time. Default: runs forever. */
  stop?: ValueLike;
}

export interface StimulusOptions {
  /** Value before the first change. Default 0. */
  initial?: Logic;
  /** Time-ordered [time, value] pairs, e.g. [['10n', 1], ['20n', 0]]. */
  changes?: [ValueLike, Logic][];
  /** Shorthand: a string of 0/1/X/Z, one character per `step`, starting at `from` (default 0). */
  pattern?: string;
  step?: ValueLike;
  from?: ValueLike;
}

// ── normalization helpers ──

function checkKeys(type: string, opts: Record<string, unknown>, allowed: string[]): void {
  if (opts === null || typeof opts !== 'object' || Array.isArray(opts)) {
    throw new Error(`${type}: options must be an object, got ${JSON.stringify(opts)}`);
  }
  for (const k of Object.keys(opts)) {
    if (!allowed.includes(k)) {
      throw new Error(`${type}: unknown option '${k}'. Valid options: ${allowed.join(', ')}`);
    }
  }
}

function int(type: string, name: string, v: unknown, def: number, min: number, max: number): number {
  if (v === undefined) return def;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
    throw new Error(`${type}: '${name}' must be an integer in [${min}, ${max}], got ${JSON.stringify(v)}`);
  }
  return v;
}

function bool(type: string, name: string, v: unknown, def: boolean): boolean {
  if (v === undefined) return def;
  if (typeof v !== 'boolean') throw new Error(`${type}: '${name}' must be true or false, got ${JSON.stringify(v)}`);
  return v;
}

function oneOf<T extends string>(type: string, name: string, v: unknown, values: T[], def: T): T {
  if (v === undefined) return def;
  if (!values.includes(v as T)) {
    throw new Error(`${type}: '${name}' must be one of ${values.map(x => `'${x}'`).join(', ')}, got ${JSON.stringify(v)}`);
  }
  return v as T;
}

function time(type: string, name: string, v: unknown, def: number): number {
  if (v === undefined) return def;
  return parseTime(v as ValueLike, `${type} ${name}`);
}

function normDelay(type: string, v: unknown): JsonValue {
  if (v === undefined) return DEFAULT_DELAY;
  if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    checkKeys(`${type} delay`, o, ['rise', 'fall']);
    if (o.rise === undefined || o.fall === undefined) throw new Error(`${type}: delay object needs both 'rise' and 'fall'`);
    return { rise: time(type, 'delay.rise', o.rise, 0), fall: time(type, 'delay.fall', o.fall, 0) };
  }
  return time(type, 'delay', v, DEFAULT_DELAY);
}

function timingParams(type: string, o: Record<string, unknown>): PartParams {
  return { delay: normDelay(type, o.delay), delayMode: oneOf(type, 'delayMode', o.delayMode, ['inertial', 'transport'], 'inertial') };
}

function seqParams(type: string, o: Record<string, unknown>): PartParams {
  return {
    ...timingParams(type, o),
    setup: time(type, 'setup', o.setup, 0),
    hold: time(type, 'hold', o.hold, 0),
    onViolation: oneOf(type, 'onViolation', o.onViolation, ['x', 'keep'], 'x'),
  };
}

function delayOf(p: PartParams): DelayConfig {
  const d = p.delay as number | { rise: number; fall: number };
  const mode = (p.delayMode as 'inertial' | 'transport') ?? 'inertial';
  return typeof d === 'number' ? { rise: d, fall: d, mode } : { rise: d.rise, fall: d.fall, mode };
}

const minDelay = (p: PartParams): number => {
  const d = delayOf(p);
  return Math.min(d.rise, d.fall);
};

const ZERO_DELAY: DelayConfig = { rise: 0, fall: 0, mode: 'transport' };

const TIMING_KEYS = ['delay', 'delayMode'];
const SEQ_KEYS = [...TIMING_KEYS, 'setup', 'hold', 'onViolation'];

/** Input pin names of an N-input gate: 'a', 'b', … 'z'. */
export function gatePins(n: number): string[] {
  return Array.from({ length: n }, (_, i) => String.fromCharCode(97 + i));
}

const range = (prefix: string, n: number): string[] => Array.from({ length: n }, (_, i) => `${prefix}${i}`);

function allPaths(p: PartParams, layout: PinLayout, from = layout.inputs, to = layout.outputs): CombPath[] {
  const d = minDelay(p);
  return from.flatMap(f => to.map(t => ({ from: f, to: t, delay: d })));
}

// ── definitions ──

function gateDef(type: string, op: GateOp, invert: boolean, fixedInputs?: number): PartDef {
  const layout = (p: PartParams): PinLayout => ({ inputs: gatePins(p.inputs as number), outputs: ['y'], clocks: [] });
  return {
    type,
    summary:
      fixedInputs === 1
        ? `${type}: a → y`
        : `${type} gate with N inputs a, b, c, … → y (default 2 inputs)`,
    normalize(o) {
      checkKeys(type, o, ['inputs', ...TIMING_KEYS]);
      if (fixedInputs !== undefined && o.inputs !== undefined && o.inputs !== fixedInputs) {
        throw new Error(`${type}: has exactly ${fixedInputs} input ('a'); 'inputs' cannot be changed`);
      }
      return { inputs: fixedInputs ?? int(type, 'inputs', o.inputs, 2, 1, 26), ...timingParams(type, o) };
    },
    pins: layout,
    driver: 'strong',
    delay: delayOf,
    combPaths: p => allPaths(p, layout(p)),
    create: (p, ctx) => new GateModel(ctx, gatePins(p.inputs as number), op, invert),
  };
}

const flipFlopLayout = (dataPins: string[]) => (p: PartParams): PinLayout => ({
  inputs: [...dataPins, 'clk', ...(p.set ? ['set'] : []), ...(p.reset ? ['reset'] : [])],
  outputs: ['q', 'qn'],
  clocks: ['clk'],
});

function flipFlopDef(type: string, dataPins: string[], summary: string, make: (p: PartParams, ctx: ModelCtx) => Model): PartDef {
  const layout = flipFlopLayout(dataPins);
  return {
    type,
    summary,
    normalize(o) {
      checkKeys(type, o, [...SEQ_KEYS, 'init', 'set', 'reset']);
      return {
        ...seqParams(type, o),
        init: parseLogic(o.init ?? 0, `${type} init`),
        set: bool(type, 'set', o.set, false),
        reset: bool(type, 'reset', o.reset, false),
      };
    },
    pins: layout,
    driver: 'strong',
    delay: delayOf,
    // Async set/reset are combinational paths to the outputs; clk/data are not (edge-triggered).
    combPaths: p => allPaths(p, layout(p), [...(p.set ? ['set'] : []), ...(p.reset ? ['reset'] : [])]),
    create: make,
  };
}

type SeqP = { setup: number; hold: number; onViolation: 'x' | 'keep'; init: Logic };

const DEFS: PartDef[] = [
  gateDef('Buf', 'buf', false, 1),
  gateDef('Not', 'buf', true, 1),
  gateDef('And', 'and', false),
  gateDef('Or', 'or', false),
  gateDef('Nand', 'and', true),
  gateDef('Nor', 'or', true),
  gateDef('Xor', 'xor', false),
  gateDef('Xnor', 'xor', true),
  {
    type: 'TriBuf',
    summary: "tri-state buffer: a, en → y (y = Z while disabled; en active high unless activeLow)",
    normalize(o) {
      checkKeys('TriBuf', o, ['activeLow', ...TIMING_KEYS]);
      return { activeLow: bool('TriBuf', 'activeLow', o.activeLow, false), ...timingParams('TriBuf', o) };
    },
    pins: () => ({ inputs: ['a', 'en'], outputs: ['y'], clocks: [] }),
    driver: 'tristate',
    delay: delayOf,
    combPaths: p => allPaths(p, { inputs: ['a', 'en'], outputs: ['y'], clocks: [] }),
    create: (p, ctx) => new TriBufModel(ctx, p.activeLow as boolean),
  },
  {
    type: 'Mux',
    summary: 'multiplexer 2^k:1: s0..s(k-1) (s0 = LSB), d0..d(2^k-1) → y',
    normalize(o) {
      checkKeys('Mux', o, ['select', ...TIMING_KEYS]);
      return { select: int('Mux', 'select', o.select, 1, 1, 8), ...timingParams('Mux', o) };
    },
    pins: p => ({ inputs: [...range('s', p.select as number), ...range('d', 2 ** (p.select as number))], outputs: ['y'], clocks: [] }),
    driver: 'strong',
    delay: delayOf,
    combPaths(p) {
      const k = p.select as number;
      return allPaths(p, { inputs: [...range('s', k), ...range('d', 2 ** k)], outputs: ['y'], clocks: [] });
    },
    create: (p, ctx) => new MuxModel(ctx, p.select as number),
  },
  flipFlopDef('DFF', ['d'], 'D flip-flop, rising edge: d, clk [, set, reset] → q, qn', (p, ctx) => new DffModel(ctx, p as unknown as SeqP)),
  flipFlopDef('JKFF', ['j', 'k'], 'JK flip-flop, rising edge: j, k, clk [, set, reset] → q, qn (j=k=1 toggles)', (p, ctx) => new JkModel(ctx, p as unknown as SeqP)),
  {
    type: 'DLatch',
    summary: 'D latch: transparent while en = 1, holds while en = 0: d, en → q, qn',
    normalize(o) {
      checkKeys('DLatch', o, [...SEQ_KEYS, 'init']);
      return { ...seqParams('DLatch', o), init: parseLogic(o.init ?? 0, 'DLatch init') };
    },
    pins: () => ({ inputs: ['d', 'en'], outputs: ['q', 'qn'], clocks: [] }),
    driver: 'strong',
    delay: delayOf,
    combPaths: p => allPaths(p, { inputs: ['d', 'en'], outputs: ['q', 'qn'], clocks: [] }),
    create: (p, ctx) => new LatchModel(ctx, p as unknown as SeqP),
  },
  {
    type: 'Counter',
    summary: 'N-bit binary counter, rising edge: clk [, en, reset, up] → q0..q(N-1) (q0 = LSB), wraps modulo 2^N',
    normalize(o) {
      checkKeys('Counter', o, [...SEQ_KEYS, 'bits', 'enable', 'reset', 'resetMode', 'upDown', 'init']);
      const bits = int('Counter', 'bits', o.bits, 4, 1, 48);
      return {
        ...seqParams('Counter', o),
        bits,
        enable: bool('Counter', 'enable', o.enable, false),
        reset: bool('Counter', 'reset', o.reset, false),
        resetMode: oneOf('Counter', 'resetMode', o.resetMode, ['async', 'sync'], 'async'),
        upDown: bool('Counter', 'upDown', o.upDown, false),
        init: int('Counter', 'init', o.init, 0, 0, 2 ** bits - 1),
      };
    },
    pins: p => ({
      inputs: ['clk', ...(p.enable ? ['en'] : []), ...(p.reset ? ['reset'] : []), ...(p.upDown ? ['up'] : [])],
      outputs: range('q', p.bits as number),
      clocks: ['clk'],
    }),
    driver: 'strong',
    delay: delayOf,
    combPaths: p => (p.reset && p.resetMode === 'async' ? allPaths(p, { inputs: ['reset'], outputs: range('q', p.bits as number), clocks: [] }) : []),
    create: (p, ctx) => new CounterModel(ctx, p as never),
  },
  {
    type: 'ShiftRegister',
    summary: "N-bit shift register, rising edge. SIPO: si, clk [, reset] → q0..q(N-1), so. PISO: load, p0..p(N-1), clk [, si, reset] → so",
    normalize(o) {
      checkKeys('ShiftRegister', o, [...SEQ_KEYS, 'bits', 'mode', 'serialIn', 'reset', 'init']);
      const bits = int('ShiftRegister', 'bits', o.bits, 8, 1, 1024);
      const mode = oneOf('ShiftRegister', 'mode', o.mode, ['sipo', 'piso'], 'sipo');
      if (o.serialIn === true && mode === 'sipo') throw new Error(`ShiftRegister: 'serialIn' applies to mode 'piso' only (SIPO always has 'si')`);
      return {
        ...seqParams('ShiftRegister', o),
        bits,
        mode,
        serialIn: bool('ShiftRegister', 'serialIn', o.serialIn, false),
        reset: bool('ShiftRegister', 'reset', o.reset, false),
        init: int('ShiftRegister', 'init', o.init, 0, 0, Math.min(2 ** bits - 1, Number.MAX_SAFE_INTEGER)),
      };
    },
    pins(p) {
      const n = p.bits as number;
      const extra = p.reset ? ['reset'] : [];
      return p.mode === 'piso'
        ? { inputs: ['load', ...range('p', n), 'clk', ...(p.serialIn ? ['si'] : []), ...extra], outputs: ['so'], clocks: ['clk'] }
        : { inputs: ['si', 'clk', ...extra], outputs: [...range('q', n), 'so'], clocks: ['clk'] };
    },
    driver: 'strong',
    delay: delayOf,
    combPaths(p) {
      if (!p.reset) return [];
      const outs = p.mode === 'piso' ? ['so'] : [...range('q', p.bits as number), 'so'];
      return allPaths(p, { inputs: ['reset'], outputs: outs, clocks: [] });
    },
    create: (p, ctx) => new ShiftModel(ctx, p as never),
  },
  {
    type: 'Clock',
    summary: 'clock generator → y: freq or period, duty (0.5), start (first rising edge, default 0), optional stop',
    normalize(o) {
      checkKeys('Clock', o, ['freq', 'period', 'duty', 'start', 'stop']);
      if ((o.freq === undefined) === (o.period === undefined)) {
        throw new Error(`Clock: give exactly one of 'freq' (e.g. '1M') or 'period' (e.g. '1u')`);
      }
      const period = o.period !== undefined ? parseTime(o.period as ValueLike, 'Clock period') : 1 / parseFrequency(o.freq as ValueLike, 'Clock freq');
      const duty = o.duty === undefined ? 0.5 : parseNumber(o.duty as ValueLike, 'Clock duty');
      if (!(duty > 0 && duty < 1)) throw new Error(`Clock: 'duty' must be strictly between 0 and 1, got ${duty}`);
      const pt = period * 1e12;
      if (Math.round(duty * pt) < 1 || Math.round((1 - duty) * pt) < 1) {
        throw new Error(`Clock: period ${period}s with duty ${duty} has a high or low phase under the 1 ps timebase`);
      }
      const out: PartParams = { period, duty, start: time('Clock', 'start', o.start, 0) };
      if (o.stop !== undefined) out.stop = time('Clock', 'stop', o.stop, 0);
      return out;
    },
    pins: () => ({ inputs: [], outputs: ['y'], clocks: [] }),
    driver: 'strong',
    delay: () => ZERO_DELAY,
    combPaths: () => [],
    create: (p, ctx) => new ClockModel(ctx, p as never),
  },
  {
    type: 'Const',
    summary: "constant strong driver → y (value 0, 1, 'X' or 'Z')",
    normalize(o) {
      checkKeys('Const', o, ['value']);
      if (o.value === undefined) throw new Error(`Const: 'value' is required (0 or 1)`);
      return { value: parseLogic(o.value, 'Const value') };
    },
    pins: () => ({ inputs: [], outputs: ['y'], clocks: [] }),
    driver: 'strong',
    delay: () => ZERO_DELAY,
    combPaths: () => [],
    create: (p, ctx) => new ConstModel(ctx, p.value as Logic, false),
  },
  {
    type: 'Pull',
    summary: 'weak pull-up (value 1) or pull-down (value 0) → y; any strong driver overrides it',
    normalize(o) {
      checkKeys('Pull', o, ['value']);
      const v = parseLogic(o.value, 'Pull value');
      if (v !== 0 && v !== 1) throw new Error(`Pull: 'value' must be 0 (pull-down) or 1 (pull-up)`);
      return { value: v };
    },
    pins: () => ({ inputs: [], outputs: ['y'], clocks: [] }),
    driver: 'weak',
    delay: () => ZERO_DELAY,
    combPaths: () => [],
    create: (p, ctx) => new ConstModel(ctx, p.value as Logic, true),
  },
  {
    type: 'Stimulus',
    summary: "scripted waveform → y: initial value plus [time, value] changes, or a '0110' pattern with a step",
    normalize(o) {
      checkKeys('Stimulus', o, ['initial', 'changes', 'pattern', 'step', 'from']);
      const initial = parseLogic(o.initial ?? 0, 'Stimulus initial');
      const changes: [number, Logic][] = [];
      if (o.changes !== undefined) {
        if (!Array.isArray(o.changes)) throw new Error(`Stimulus: 'changes' must be an array of [time, value] pairs`);
        for (const c of o.changes) {
          if (!Array.isArray(c) || c.length !== 2) throw new Error(`Stimulus: each change must be [time, value], got ${JSON.stringify(c)}`);
          changes.push([parseTime(c[0] as ValueLike, 'Stimulus change time'), parseLogic(c[1], 'Stimulus change value')]);
        }
      }
      if (o.pattern !== undefined) {
        if (typeof o.pattern !== 'string' || !/^[01xXzZ]*$/.test(o.pattern)) throw new Error(`Stimulus: 'pattern' must be a string of 0/1/X/Z characters`);
        if (o.step === undefined) throw new Error(`Stimulus: 'pattern' needs a 'step' (time per character, e.g. '10n')`);
        const step = parseTime(o.step as ValueLike, 'Stimulus step');
        if (toTicks(step) < 1) throw new Error(`Stimulus: 'step' must be at least 1 ps`);
        const from = time('Stimulus', 'from', o.from, 0);
        [...o.pattern].forEach((ch, i) => changes.push([from + i * step, parseLogic(ch, 'Stimulus pattern')]));
      } else if (o.step !== undefined || o.from !== undefined) {
        throw new Error(`Stimulus: 'step'/'from' only apply together with 'pattern'`);
      }
      // Stable sort by time: equal times keep their order (the last one wins).
      const sorted = changes.map((c, i) => [c, i] as const).sort((a, b) => a[0][0] - b[0][0] || a[1] - b[1]).map(x => x[0]);
      return { initial, changes: sorted as unknown as JsonValue };
    },
    pins: () => ({ inputs: [], outputs: ['y'], clocks: [] }),
    driver: 'strong',
    delay: () => ZERO_DELAY,
    combPaths: () => [],
    create: (p, ctx) => new StimulusModel(ctx, p.initial as Logic, p.changes as unknown as [number, Logic][]),
  },
];

export const PART_DEFS: Record<string, PartDef> = Object.fromEntries(DEFS.map(d => [d.type, d]));

export function partDef(type: string): PartDef {
  const def = PART_DEFS[type];
  if (!def) throw new Error(`unknown digital part type '${type}'. Known types: ${Object.keys(PART_DEFS).join(', ')}`);
  return def;
}
