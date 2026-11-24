import { parseValue } from './units';
import type { TB, ValueLike } from './bench';
import type { AcSweepConfig, CheckSpec, DcSweepConfig, ScalarCheck } from '../schema/types';

/**
 * Assertion builders for the DC-sweep and AC stages. Every assertion is
 * recorded as plain data (AssertionSpec) at the moment the matcher is called.
 */

/** Scalar matchers on one measurement; each returns the probe builder for chaining. */
export class ScalarExpect<P> {
  constructor(
    private readonly emit: (check: ScalarCheck) => void,
    private readonly parent: P,
    private readonly what: string,
  ) {}

  toBeWithin(min: ValueLike, max: ValueLike): P {
    const lo = parseValue(min, `${this.what} toBeWithin min`);
    const hi = parseValue(max, `${this.what} toBeWithin max`);
    if (!(lo <= hi)) throw new Error(`${this.what} toBeWithin: min (${lo}) must be <= max (${hi})`);
    this.emit({ op: 'within', min: lo, max: hi });
    return this.parent;
  }

  toBeCloseTo(value: ValueLike, tol: ValueLike): P {
    this.emit({
      op: 'closeTo',
      value: parseValue(value, `${this.what} toBeCloseTo value`),
      tol: parseValue(tol, `${this.what} toBeCloseTo tol`),
    });
    return this.parent;
  }

  toBeAbove(value: ValueLike): P {
    this.emit({ op: 'above', value: parseValue(value, `${this.what} toBeAbove value`) });
    return this.parent;
  }

  toBeBelow(value: ValueLike): P {
    this.emit({ op: 'below', value: parseValue(value, `${this.what} toBeBelow value`) });
    return this.parent;
  }
}

// ─── DC sweep ────────────────────────────────────────────────────────────────

export interface DcSweepInput {
  /** Id of a VoltageSource/CurrentSource whose DC value is swept. */
  source?: string;
  /** Id of a component whose value is swept (Resistor, Capacitor, Inductor, sources). */
  param?: string;
  from: ValueLike;
  to: ValueLike;
  /** Number of points including both ends (2..10001). */
  points?: number;
  /** Alternative to points: spacing between points (must divide the range). */
  step?: ValueLike;
}

export function normalizeDcSweep(input: DcSweepInput): DcSweepConfig {
  const hasSource = input.source !== undefined;
  const hasParam = input.param !== undefined;
  if (hasSource === hasParam) {
    throw new Error(`tb.expect.dc: give exactly one of { source: 'V1' } (sweep a source's DC value) or { param: 'R1' } (sweep a component value)`);
  }
  const from = parseValue(input.from, 'dc sweep from');
  const to = parseValue(input.to, 'dc sweep to');
  if (from === to) throw new Error(`tb.expect.dc: from and to must differ (both ${from})`);
  let points: number;
  if (input.points !== undefined && input.step !== undefined) {
    throw new Error(`tb.expect.dc: give points or step, not both`);
  }
  if (input.step !== undefined) {
    const step = Math.abs(parseValue(input.step, 'dc sweep step'));
    if (!(step > 0)) throw new Error(`tb.expect.dc: step must be > 0`);
    const span = Math.abs(to - from);
    const n = Math.round(span / step);
    if (n < 1 || Math.abs(n * step - span) > 1e-9 * span) {
      throw new Error(`tb.expect.dc: step ${step} does not divide the range [${from}, ${to}] evenly; use points instead`);
    }
    points = n + 1;
  } else {
    points = input.points ?? 51;
  }
  if (!Number.isInteger(points) || points < 2 || points > 10001) {
    throw new Error(`tb.expect.dc: points must be an integer in 2..10001, got ${points}`);
  }
  return {
    ...(hasSource ? { source: input.source } : { param: input.param }),
    from,
    to,
    points,
  };
}

export class DcExpect {
  /** @internal */
  readonly _config: DcSweepConfig;
  constructor(private readonly tb: TB, input: DcSweepInput) {
    this._config = normalizeDcSweep(input);
  }

  /** Assert on a probe's curve over the sweep ('out', 'R1.i', 'D1.v'). */
  probe(probe: string): DcProbeExpect {
    return new DcProbeExpect(this.tb, this, probe);
  }
}

export class DcProbeExpect {
  constructor(
    protected readonly tb: TB,
    protected readonly parent: DcExpect,
    protected readonly probeExpr: string,
  ) {}

  /** Assert on a different probe of the same sweep. */
  probe(probe: string): DcProbeExpect {
    return this.parent.probe(probe);
  }

  private inRange(x: number, what: string): number {
    const { from, to } = this.parent._config;
    const lo = Math.min(from, to);
    const hi = Math.max(from, to);
    if (x < lo || x > hi) throw new Error(`${what}: x=${x} is outside the sweep [${lo}, ${hi}]`);
    return x;
  }

  /** The probe value at sweep value x (linear interpolation between swept points). */
  at(x: ValueLike): ScalarExpect<DcProbeExpect> {
    const xv = this.inRange(parseValue(x, 'dc at(x)'), 'dc at(x)');
    return new ScalarExpect(check => this.record({ op: 'at', x: xv, check }), this, `dc at(${xv})`);
  }

  /** The slope d(probe)/d(sweep) at x (central difference of the swept curve). */
  slopeAt(x: ValueLike): ScalarExpect<DcProbeExpect> {
    const xv = this.inRange(parseValue(x, 'dc slopeAt(x)'), 'dc slopeAt(x)');
    return new ScalarExpect(check => this.record({ op: 'slopeAt', x: xv, check }), this, `dc slopeAt(${xv})`);
  }

  /** The curve never decreases ('increasing') / never increases ('decreasing') along the sweep. */
  toBeMonotonic(direction: 'increasing' | 'decreasing' = 'increasing'): this {
    if (direction !== 'increasing' && direction !== 'decreasing') {
      throw new Error(`toBeMonotonic: direction must be 'increasing' or 'decreasing'`);
    }
    this.record({ op: 'monotonic', direction });
    return this;
  }

  /** The curve crosses `level`; chain .between(a, b) to bound where (sweep units). */
  toCross(level: ValueLike): CrossExpect {
    const spec = this.record({ op: 'crosses', level: parseValue(level, 'toCross level') });
    return new CrossExpect(this.tb, this.parent, this.probeExpr, spec);
  }

  /** @internal */
  protected record(check: CheckSpec): CheckSpec {
    this.tb._record('dc', this.probeExpr, check, { dc: this.parent._config });
    return check;
  }
}

export class CrossExpect extends DcProbeExpect {
  constructor(tb: TB, parent: DcExpect, probe: string, private readonly spec: CheckSpec) {
    super(tb, parent, probe);
  }

  /** The first crossing must happen at a sweep value in [a, b]. */
  between(a: ValueLike, b: ValueLike): DcProbeExpect {
    const lo = parseValue(a, 'toCross between a');
    const hi = parseValue(b, 'toCross between b');
    if (!(lo <= hi)) throw new Error(`toCross().between(a, b): a (${lo}) must be <= b (${hi})`);
    const spec = this.spec as { op: 'crosses'; level: number; min?: number; max?: number };
    spec.min = lo;
    spec.max = hi;
    return this;
  }
}

// ─── AC ──────────────────────────────────────────────────────────────────────

export interface AcSweepInput {
  from: ValueLike;
  to: ValueLike;
  /** Default 20. */
  pointsPerDecade?: number;
}

export function normalizeAcSweep(input: AcSweepInput): AcSweepConfig {
  const from = parseValue(input.from, 'ac from');
  const to = parseValue(input.to, 'ac to');
  if (!(from > 0)) throw new Error(`tb.expect.ac: from must be > 0 Hz (logarithmic sweep), got ${from}`);
  if (!(to > from)) throw new Error(`tb.expect.ac: to (${to}) must be > from (${from})`);
  const ppd = input.pointsPerDecade ?? 20;
  if (!Number.isInteger(ppd) || ppd < 1 || ppd > 1000) {
    throw new Error(`tb.expect.ac: pointsPerDecade must be an integer in 1..1000, got ${ppd}`);
  }
  if (Math.log10(to / from) * ppd > 100000) throw new Error(`tb.expect.ac: too many points; reduce the range or pointsPerDecade`);
  return { from, to, pointsPerDecade: ppd };
}

export class AcExpect {
  /** @internal */
  readonly _config: AcSweepConfig;
  constructor(private readonly tb: TB, input: AcSweepInput) {
    this._config = normalizeAcSweep(input);
  }

  /**
   * Transfer function H(f) = probe / reference. The reference is the AC
   * stimulus phasor (the source given `ac: ...`) unless `{ ref }` names
   * another probe, e.g. probe('out', { ref: 'in' }) = V(out)/V(in).
   */
  probe(probe: string, opts: { ref?: string } = {}): AcProbeExpect {
    return new AcProbeExpect(this.tb, this, probe, opts.ref);
  }
}

export class AcProbeExpect {
  constructor(
    private readonly tb: TB,
    private readonly parent: AcExpect,
    private readonly probeExpr: string,
    private readonly ref: string | undefined,
  ) {}

  probe(probe: string, opts: { ref?: string } = {}): AcProbeExpect {
    return this.parent.probe(probe, opts);
  }

  private freq(f: ValueLike, what: string): number {
    const fv = parseValue(f, what);
    const { from, to } = this.parent._config;
    if (fv < from || fv > to) throw new Error(`${what}: f=${fv} Hz is outside the sweep [${from}, ${to}]`);
    return fv;
  }

  /** Gain 20·log10|H(f)| in dB at frequency f. */
  gainAt(f: ValueLike): ScalarExpect<AcProbeExpect> {
    const fv = this.freq(f, 'gainAt');
    return new ScalarExpect(check => this.record({ op: 'gainAt', f: fv, check }), this, `gainAt(${fv})`);
  }

  /** Phase of H(f) in degrees (unwrapped along the sweep) at frequency f. */
  phaseAt(f: ValueLike): ScalarExpect<AcProbeExpect> {
    const fv = this.freq(f, 'phaseAt');
    return new ScalarExpect(check => this.record({ op: 'phaseAt', f: fv, check }), this, `phaseAt(${fv})`);
  }

  /**
   * −3 dB bandwidth in Hz, relative to the peak gain of the sweep: the upper
   * −3 dB frequency for a low-pass response, f_high − f_low for a band-pass.
   */
  bandwidth3dB(): ScalarExpect<AcProbeExpect> {
    return new ScalarExpect(check => this.record({ op: 'bandwidth3dB', check }), this, 'bandwidth3dB()');
  }

  /** First frequency where |H| falls through 1 (0 dB), in Hz. */
  unityGainFrequency(): ScalarExpect<AcProbeExpect> {
    return new ScalarExpect(check => this.record({ op: 'unityGainFrequency', check }), this, 'unityGainFrequency()');
  }

  /** 180° + phase(H) at the unity-gain frequency, in degrees (probe a loop gain). */
  phaseMargin(): ScalarExpect<AcProbeExpect> {
    return new ScalarExpect(check => this.record({ op: 'phaseMargin', check }), this, 'phaseMargin()');
  }

  private record(check: CheckSpec): void {
    this.tb._record('ac', this.probeExpr, check, { ac: this.parent._config, ...(this.ref ? { ref: this.ref } : {}) });
  }
}
