/**
 * tb.expect.logic(probe, tran?) — assertions on a logic signal of the
 * transient run (digital nets, IC pins, primitive pins; see src/mixed).
 *
 *   tb.expect.logic('Q', { tstop: '1m' }).toBe(1).at('200u')
 *   tb.expect.logic('U1.1Y').toToggle({ count: 10, within: ['0', '1m'] })
 *   tb.expect.logic('U2.3').toHaveFrequency('1k', 0.02)      // tol: fraction
 *   tb.expect.logic('OUT').toHaveDutyCycle(0.5, 0.02)        // tol: absolute
 *   tb.expect.logic('Q').toBeStable('100u', '200u')
 */
import { parseValue } from './units';
import type { CheckSpec, LogicLevel, TranConfig } from '../schema/types';
import type { ValueLike } from './bench';

/** The part of TB this builder needs (avoids an import cycle with bench.ts). */
interface Recorder {
  _record(stage: 'tran', probe: string, check: CheckSpec, extra: { tran: TranConfig }): void;
  _assertions: { check: CheckSpec }[];
}

function level(v: unknown, what: string): LogicLevel {
  if (v === 0 || v === 1 || v === 'X' || v === 'Z') return v;
  if (v === '0' || v === '1') return Number(v) as 0 | 1;
  if (v === true) return 1;
  if (v === false) return 0;
  if (v === 'x' || v === 'z') return v.toUpperCase() as 'X' | 'Z';
  throw new Error(`${what}: expected a logic value 0, 1, 'X' or 'Z', got ${JSON.stringify(v)}`);
}

/** A fraction: 0.02 or '2%'. */
export function fraction(v: number | string, what: string): number {
  if (typeof v === 'string' && v.trim().endsWith('%')) {
    const n = Number(v.trim().slice(0, -1));
    if (!Number.isFinite(n)) throw new Error(`${what}: invalid percentage '${v}'`);
    return n / 100;
  }
  const n = parseValue(v, what);
  if (!(n >= 0)) throw new Error(`${what} must be >= 0, got ${n}`);
  return n;
}

export interface LogicWindow {
  from?: ValueLike;
  to?: ValueLike;
}

export class LogicExpect {
  constructor(
    private tb: Recorder,
    private config: TranConfig,
    private probe: string,
  ) {}

  private time(v: ValueLike, what: string): number {
    const t = parseValue(v, what);
    if (t < 0) throw new Error(`${what} must be >= 0, got ${t}`);
    if (t > this.config.tstop) throw new Error(`${what}=${t}s is beyond the simulation window (tstop=${this.config.tstop}s)`);
    return t;
  }

  private window(w: LogicWindow | undefined, what: string): { from?: number; to?: number } {
    if (!w) return {};
    const from = w.from !== undefined ? this.time(w.from, `${what} from`) : undefined;
    const to = w.to !== undefined ? this.time(w.to, `${what} to`) : undefined;
    if (from !== undefined && to !== undefined && !(from < to)) throw new Error(`${what}: from (${from}) must be < to (${to})`);
    return { ...(from !== undefined ? { from } : {}), ...(to !== undefined ? { to } : {}) };
  }

  private record(check: CheckSpec): void {
    this.tb._record('tran', this.probe, check, { tran: this.config });
  }

  /** Assert on another logic signal of the same run. */
  logic(probe: string): LogicExpect {
    return new LogicExpect(this.tb, this.config, probe);
  }

  /** Value at the end of the run; chain `.at(t)` for another time. */
  toBe(value: LogicLevel | '0' | '1' | boolean): { at(t: ValueLike): LogicExpect } {
    const v = level(value, 'toBe');
    this.record({ op: 'logicAt', t: this.config.tstop, value: v });
    const spec = this.tb._assertions[this.tb._assertions.length - 1] as { check: CheckSpec };
    return {
      at: (t: ValueLike) => {
        spec.check = { op: 'logicAt', t: this.time(t, 'toBe().at'), value: v };
        return this;
      },
    };
  }

  /**
   * Number of transitions in a window: exactly `count`, or within [min, max]
   * (default: at least one). `edge`: 'both' (default), 'rising', 'falling'.
   */
  toToggle(opts: { count?: number; min?: number; max?: number; edge?: 'rising' | 'falling' | 'both'; within?: [ValueLike, ValueLike] } = {}): this {
    const edge = opts.edge ?? 'both';
    if (!['rising', 'falling', 'both'].includes(edge)) throw new Error(`toToggle: edge must be 'rising', 'falling' or 'both'`);
    for (const k of ['count', 'min', 'max'] as const) {
      const v = opts[k];
      if (v !== undefined && !(Number.isInteger(v) && v >= 0)) throw new Error(`toToggle: ${k} must be a non-negative integer, got ${v}`);
    }
    if (opts.count !== undefined && (opts.min !== undefined || opts.max !== undefined)) throw new Error(`toToggle: give count, or min/max — not both`);
    const w = opts.within ? this.window({ from: opts.within[0], to: opts.within[1] }, 'toToggle within') : {};
    const bounds =
      opts.count !== undefined ? { count: opts.count } : opts.min === undefined && opts.max === undefined ? { min: 1 } : { ...(opts.min !== undefined ? { min: opts.min } : {}), ...(opts.max !== undefined ? { max: opts.max } : {}) };
    this.record({ op: 'logicEdges', edge, ...w, ...bounds });
    return this;
  }

  /** Frequency from rising edges (period averaged over whole cycles); tol is a FRACTION (0.02 or '2%'). */
  toHaveFrequency(freq: ValueLike, tol: number | string, window?: LogicWindow): this {
    const value = parseValue(freq, 'toHaveFrequency');
    if (!(value > 0)) throw new Error(`toHaveFrequency: frequency must be > 0`);
    this.record({ op: 'logicFrequency', value, tol: fraction(tol, 'toHaveFrequency tol'), ...this.window(window, 'toHaveFrequency') });
    return this;
  }

  /** High fraction over whole periods; tol is ABSOLUTE in duty units (0.02 = ±2 points). */
  toHaveDutyCycle(duty: number | string, tol: number | string, window?: LogicWindow): this {
    const value = fraction(duty, 'toHaveDutyCycle');
    if (!(value > 0 && value < 1)) throw new Error(`toHaveDutyCycle: duty must be in (0, 1), got ${value}`);
    this.record({ op: 'logicDutyCycle', value, tol: fraction(tol, 'toHaveDutyCycle tol'), ...this.window(window, 'toHaveDutyCycle') });
    return this;
  }

  /** No transition in [from, to] (optionally: and equal to `value` there). */
  toBeStable(from: ValueLike, to: ValueLike, opts: { value?: LogicLevel } = {}): this {
    const w = this.window({ from, to }, 'toBeStable');
    this.record({ op: 'logicStable', from: w.from!, to: w.to!, ...(opts.value !== undefined ? { value: level(opts.value, 'toBeStable value') } : {}) });
    return this;
  }
}

export function isLogicCheck(check: CheckSpec): boolean {
  return check.op.startsWith('logic');
}
