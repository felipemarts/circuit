/**
 * tb.expect.serial(mcu, tran?) — assertions on what a microcontroller's
 * firmware printed with Serial.print/println during a transient run.
 *
 *   tb.expect.serial('U1', { tstop: '2' }).toContain('ready', { by: '10m' })
 *   tb.expect.tran({ tstop: '1' }).serial('U1').toMatch(/count=\d+/).toNotContain('ERROR')
 *   tb.expect.serial('U1').toHaveLines({ min: 3 })
 *
 * The text is the concatenated output (Arduino Print formatting, `println`
 * ends lines with "\r\n"); times are simulation times of the print calls.
 * Patterns are stored as plain data ({ pattern, flags }).
 */
import { parseValue } from './units';
import type { CheckSpec, TranConfig } from '../schema/types';
import type { ValueLike } from './bench';

interface Recorder {
  _record(stage: 'tran', probe: string, check: CheckSpec, extra: { tran: TranConfig }): void;
}

const SERIAL_OPS = new Set(['serialContains', 'serialNotContains', 'serialMatches', 'serialLines']);

export function isSerialCheck(check: CheckSpec): boolean {
  return SERIAL_OPS.has(check.op);
}

function count(v: unknown, what: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) throw new Error(`${what} must be a non-negative integer, got ${JSON.stringify(v)}`);
  return v;
}

export class SerialExpect {
  constructor(
    private tb: Recorder,
    private config: TranConfig,
    private mcu: string,
  ) {}

  private record(check: CheckSpec): this {
    this.tb._record('tran', this.mcu, check, { tran: this.config });
    return this;
  }

  /** The output contains `text` — optionally printed no later than `by` (s). */
  toContain(text: string, opts: { by?: ValueLike } = {}): this {
    if (typeof text !== 'string' || text === '') throw new Error(`serial toContain: expected a non-empty string`);
    let by: number | undefined;
    if (opts.by !== undefined) {
      by = parseValue(opts.by, 'serial toContain by');
      if (!(by >= 0) || by > this.config.tstop) throw new Error(`serial toContain: by=${by}s must be inside the simulation window (tstop=${this.config.tstop}s)`);
    }
    return this.record({ op: 'serialContains', text, ...(by !== undefined ? { by } : {}) });
  }

  /** The output never contains `text`. */
  toNotContain(text: string): this {
    if (typeof text !== 'string' || text === '') throw new Error(`serial toNotContain: expected a non-empty string`);
    return this.record({ op: 'serialNotContains', text });
  }

  /** The output matches a regular expression (a RegExp, or its source with optional flags). */
  toMatch(pattern: RegExp | string, flags?: string): this {
    let source: string;
    let f: string;
    if (pattern instanceof RegExp || (pattern && typeof pattern === 'object' && typeof (pattern as RegExp).source === 'string')) {
      source = (pattern as RegExp).source;
      f = flags ?? (pattern as RegExp).flags;
    } else if (typeof pattern === 'string') {
      source = pattern;
      f = flags ?? '';
    } else throw new Error(`serial toMatch: expected a RegExp or a pattern string`);
    f = [...new Set(f.replace(/g/g, ''))].sort().join('');
    try {
      new RegExp(source, f);
    } catch (err) {
      throw new Error(`serial toMatch: invalid regular expression /${source}/${f}: ${err instanceof Error ? err.message : String(err)}`);
    }
    return this.record({ op: 'serialMatches', pattern: source, ...(f ? { flags: f } : {}) });
  }

  /** Number of complete lines (ended by "\n"): exactly `n`, or within { min, max }. */
  toHaveLines(n: number | { min?: number; max?: number }): this {
    if (typeof n === 'number') return this.record({ op: 'serialLines', count: count(n, 'serial toHaveLines') });
    if (!n || typeof n !== 'object' || (n.min === undefined && n.max === undefined)) throw new Error(`serial toHaveLines: pass a count or { min, max }`);
    const min = n.min !== undefined ? count(n.min, 'serial toHaveLines min') : undefined;
    const max = n.max !== undefined ? count(n.max, 'serial toHaveLines max') : undefined;
    if (min !== undefined && max !== undefined && min > max) throw new Error(`serial toHaveLines: min (${min}) must be <= max (${max})`);
    return this.record({ op: 'serialLines', ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}) });
  }
}
