import { bench, elaborate, Resistor, VoltageSource, Capacitor, type TB, type BenchDescriptor } from '../../src/forge';
import type { Component } from '../../src/core/Component';

export type Amp = Component;

/** Wire the supply pins: a positive rail and a negative rail (0 = ground). */
export function supplies(tb: TB, u: Amp, vpos: number, vneg: number): void {
  const vp = tb.add('VP', new VoltageSource(vpos));
  vp.pin('+').connect(u.pin('v+'));
  vp.pin('-').connect(tb.gnd);
  if (vneg === 0) {
    u.pin('v-').connect(tb.gnd);
  } else {
    const vn = tb.add('VN', new VoltageSource(vneg));
    vn.pin('+').connect(u.pin('v-'));
    vn.pin('-').connect(tb.gnd);
  }
}

export interface StageOpts {
  vin: number | object;
  r1: number;
  r2: number;
  /** [V+, V−]; null = leave the supply pins unconnected (IdealOpAmp). Default ±15 V. */
  rails?: [number, number] | null;
  /** Load resistor from out to ground. */
  rl?: number;
  build?: (tb: TB, u: Amp) => void;
}

/** Inverting amplifier: VI → R1 → inn, R2 inn → out, inp to ground. */
export function inverting(make: () => Amp, opts: StageOpts): BenchDescriptor {
  return bench('inverting', tb => {
    const u = tb.add('U1', make());
    const vi = tb.add('VI', new VoltageSource(opts.vin as never));
    const r1 = tb.add('R1', new Resistor(opts.r1));
    const r2 = tb.add('R2', new Resistor(opts.r2));
    vi.pin('+').connect(r1.pin('1'));
    vi.pin('-').connect(tb.gnd);
    r1.pin('2').connect(u.pin('inn'));
    r2.pin('1').connect(u.pin('inn'));
    r2.pin('2').connect(u.pin('out'));
    u.pin('inp').connect(tb.gnd);
    if (opts.rails !== null) supplies(tb, u, ...(opts.rails ?? [15, -15]));
    if (opts.rl) {
      const rl = tb.add('RL', new Resistor(opts.rl));
      rl.pin('1').connect(u.pin('out'));
      rl.pin('2').connect(tb.gnd);
    }
    tb.name('out', u.pin('out'));
    tb.name('inn', u.pin('inn'));
    opts.build?.(tb, u);
  });
}

/** Non-inverting amplifier: VI → inp, R1 inn → gnd, R2 inn → out (r1 = Infinity: voltage follower). */
export function nonInverting(make: () => Amp, opts: StageOpts): BenchDescriptor {
  return bench('non-inverting', tb => {
    const u = tb.add('U1', make());
    const vi = tb.add('VI', new VoltageSource(opts.vin as never));
    vi.pin('+').connect(u.pin('inp'));
    vi.pin('-').connect(tb.gnd);
    if (Number.isFinite(opts.r1)) {
      const r1 = tb.add('R1', new Resistor(opts.r1));
      const r2 = tb.add('R2', new Resistor(opts.r2));
      r1.pin('1').connect(u.pin('inn'));
      r1.pin('2').connect(tb.gnd);
      r2.pin('1').connect(u.pin('inn'));
      r2.pin('2').connect(u.pin('out'));
    } else {
      u.pin('inn').connect(u.pin('out'));
    }
    if (opts.rails !== null) supplies(tb, u, ...(opts.rails ?? [15, -15]));
    if (opts.rl) {
      const rl = tb.add('RL', new Resistor(opts.rl));
      rl.pin('1').connect(u.pin('out'));
      rl.pin('2').connect(tb.gnd);
    }
    tb.name('out', u.pin('out'));
    tb.name('in', u.pin('inp'));
    opts.build?.(tb, u);
  });
}

/** Integrator: VI → R → inn, C inn → out, inp to ground. */
export function integrator(make: () => Amp, opts: { vin: number | object; r: number; c: number; rails?: [number, number] }): BenchDescriptor {
  return bench('integrator', tb => {
    const u = tb.add('U1', make());
    const vi = tb.add('VI', new VoltageSource(opts.vin as never));
    const r = tb.add('R1', new Resistor(opts.r));
    const c = tb.add('C1', new Capacitor(opts.c));
    vi.pin('+').connect(r.pin('1'));
    vi.pin('-').connect(tb.gnd);
    r.pin('2').connect(u.pin('inn'));
    c.pin('1').connect(u.pin('inn'));
    c.pin('2').connect(u.pin('out'));
    u.pin('inp').connect(tb.gnd);
    supplies(tb, u, ...(opts.rails ?? [15, -15]));
    tb.name('out', u.pin('out'));
  });
}

/** DC operating point: named-net voltages + the elaboration. */
export function op(desc: BenchDescriptor) {
  const el = elaborate(desc);
  const dc = el.circuit.analyze('dc');
  const v = (net: string) => dc.nodeVoltages.get(el.netNode.get(net)!)!;
  return { el, dc, v };
}

export interface Wave {
  t: number[];
  y: number[];
}

/** Adaptive transient of one probe (named net or '<id>.i' / '<id>.v'). */
export function tran(desc: BenchDescriptor, probe: string, cfg: { tstop: number; dt: number; maxStep?: number; ic?: 'zero' | 'op' }) {
  const el = elaborate(desc);
  const m = probe.match(/^([A-Za-z]\w*)\.(i|v)$/);
  const spec = m
    ? { label: probe, color: '#000', component: el.components.get(m[1])!, type: (m[2] === 'i' ? 'current' : 'voltage') as 'current' | 'voltage' }
    : { label: probe, color: '#000', node: el.netNode.get(probe)!, type: 'voltage' as const };
  const r = el.circuit.analyze('transient', { timeStep: cfg.dt, duration: cfg.tstop, maxStep: cfg.maxStep, ic: cfg.ic, adaptive: true }, [spec]);
  return { t: r.timePoints, y: r.probes[0].values, telemetry: r.telemetry! };
}

/** Linear interpolation of a waveform at time t. */
export function at(w: Wave, t: number): number {
  for (let i = 1; i < w.t.length; i++) {
    if (w.t[i] >= t) {
      const f = (t - w.t[i - 1]) / (w.t[i] - w.t[i - 1]);
      return w.y[i - 1] + f * (w.y[i] - w.y[i - 1]);
    }
  }
  return w.y[w.y.length - 1];
}

/** First time after `after` the waveform crosses `level`, interpolated; NaN if never. */
export function crossing(w: Wave, level: number, after = 0): number {
  for (let i = 1; i < w.t.length; i++) {
    if (w.t[i] < after) continue;
    const a = w.y[i - 1] - level;
    const b = w.y[i] - level;
    if (a === 0) return w.t[i - 1];
    if (a < 0 !== b < 0) return w.t[i - 1] + ((w.t[i] - w.t[i - 1]) * a) / (a - b);
  }
  return NaN;
}
