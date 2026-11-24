import { describe, it, expect } from 'vitest';
import { Circuit, VoltageSource, CurrentSource, Resistor, Capacitor, Inductor, waveformNextBreakpoint } from '../../src/index';
import type { TransientConfig, SourceOptions } from '../../src/index';
import { rcExact } from '../helpers/analytic';

/** V1 → R → C → gnd; returns the capacitor-voltage and resistor-current waveforms. */
function rc(source: number | SourceOptions, R: number, C: number, config: TransientConfig) {
  const circuit = new Circuit();
  const v1 = new VoltageSource(source);
  const r1 = new Resistor(R);
  const c1 = new Capacitor(C);
  v1.pin('+').connect(r1.pin('1'));
  r1.pin('2').connect(c1.pin('1'));
  c1.pin('2').connect(circuit.ground);
  v1.pin('-').connect(circuit.ground);
  const res = circuit.analyze('transient', config, [
    { label: 'vc', color: '', component: c1, type: 'voltage' },
    { label: 'ir', color: '', component: r1, type: 'current' },
  ]);
  return { t: res.timePoints, vc: res.probes[0].values, ir: res.probes[1].values, telemetry: res.telemetry! };
}

const maxAbs = (a: number[], f: (i: number) => number) => a.reduce((m, _, i) => Math.max(m, Math.abs(f(i))), 0);

describe('transient engine — analytic solutions', () => {
  it('RC step: v(t) = V(1 − e^(−t/τ)) within 2 mV (adaptive, reltol 1e-3)', () => {
    const tau = 1e-3;
    const { t, vc, telemetry } = rc(5, 1000, 1e-6, { timeStep: 1e-6, maxStep: 1e-3, duration: 8 * tau, adaptive: true });
    expect(t[0]).toBe(0);
    expect(vc[0]).toBeCloseTo(0, 6); // zero initial state
    expect(t[t.length - 1]).toBe(8 * tau); // lands exactly on tstop
    const err = maxAbs(t, i => vc[i] - 5 * (1 - Math.exp(-t[i] / tau)));
    expect(err).toBeLessThan(2e-3);
    expect(telemetry.acceptedSteps).toBeLessThan(200);
  });

  it('RL step: i(t) = (V/R)(1 − e^(−t/τ)) within 0.05 % of V/R', () => {
    const circuit = new Circuit();
    const v1 = new VoltageSource(5);
    const r1 = new Resistor(100);
    const l1 = new Inductor('10m');
    v1.pin('+').connect(r1.pin('1'));
    r1.pin('2').connect(l1.pin('1'));
    l1.pin('2').connect(circuit.ground);
    v1.pin('-').connect(circuit.ground);
    const tau = 1e-4;
    const res = circuit.analyze('transient', { timeStep: 1e-7, maxStep: 1e-5, duration: 6 * tau, adaptive: true }, [
      { label: 'iL', color: '', component: l1, type: 'current' },
      { label: 'iR', color: '', component: r1, type: 'current' },
    ]);
    const t = res.timePoints;
    const iL = res.probes[0].values;
    const iR = res.probes[1].values;
    const err = maxAbs(t, i => iL[i] - 0.05 * (1 - Math.exp(-t[i] / tau)));
    expect(err).toBeLessThan(0.05 * 5e-4);
    // The inductor branch current and the series resistor current agree at every sample.
    expect(maxAbs(t, i => iL[i] - iR[i])).toBeLessThan(1e-9);
  });

  it('RLC underdamped: ringing frequency within 0.2 % and decay rate within 1 % of theory', () => {
    // Series R-L-C step: ω0 = 1/√(LC) = 1e4 rad/s, α = R/2L = 500 1/s, ωd = √(ω0² − α²).
    const R = 10;
    const L = 10e-3;
    const C = 1e-6;
    const circuit = new Circuit();
    const v1 = new VoltageSource(1);
    const r1 = new Resistor(R);
    const l1 = new Inductor(L);
    const c1 = new Capacitor(C);
    v1.pin('+').connect(r1.pin('1'));
    r1.pin('2').connect(l1.pin('1'));
    l1.pin('2').connect(c1.pin('1'));
    c1.pin('2').connect(circuit.ground);
    v1.pin('-').connect(circuit.ground);
    const res = circuit.analyze('transient', { timeStep: 1e-7, maxStep: 2e-5, duration: 5e-3, adaptive: true }, [
      { label: 'vc', color: '', component: c1, type: 'voltage' },
    ]);
    const t = res.timePoints;
    const vc = res.probes[0].values;
    const alpha = R / (2 * L);
    const wd = Math.sqrt(1 / (L * C) - alpha * alpha);
    // Whole waveform against the closed form.
    const exact = (tt: number) => 1 - Math.exp(-alpha * tt) * (Math.cos(wd * tt) + (alpha / wd) * Math.sin(wd * tt));
    expect(maxAbs(t, i => vc[i] - exact(t[i]))).toBeLessThan(1e-2); // 1 % of the 1 V step
    // Upward crossings of the final value give the period.
    const ups: number[] = [];
    for (let i = 1; i < t.length; i++) {
      const a = vc[i - 1] - 1;
      const b = vc[i] - 1;
      if (a < 0 && b >= 0) ups.push(t[i - 1] + (-a / (b - a)) * (t[i] - t[i - 1]));
    }
    expect(ups.length).toBeGreaterThanOrEqual(5);
    const period = (ups[ups.length - 1] - ups[0]) / (ups.length - 1);
    expect(Math.abs(2 * Math.PI / period - wd) / wd).toBeLessThan(2e-3);
    // Peak envelope: successive maxima decay as e^(−α·Td).
    const peaks: number[] = [];
    for (let i = 1; i < t.length - 1; i++) if (vc[i] > vc[i - 1] && vc[i] >= vc[i + 1] && vc[i] > 1) peaks.push(vc[i] - 1);
    const ratio = peaks[3] / peaks[1];
    const expected = Math.exp(-alpha * 2 * (2 * Math.PI / wd));
    expect(Math.abs(ratio - expected) / expected).toBeLessThan(0.01);
  });

  it('trapezoidal is 2nd-order accurate: halving h divides the error by ~4 (BE: ~2)', () => {
    const tau = 1e-3;
    const errAt = (h: number, method: 'trap' | 'be') => {
      const { t, vc } = rc(5, 1000, 1e-6, { timeStep: h, duration: 2 * tau, method });
      const i = t.length - 1;
      return Math.abs(vc[i] - 5 * (1 - Math.exp(-t[i] / tau)));
    };
    const trapRatio = errAt(20e-6, 'trap') / errAt(10e-6, 'trap');
    const beRatio = errAt(20e-6, 'be') / errAt(10e-6, 'be');
    expect(trapRatio).toBeGreaterThan(3.6);
    expect(trapRatio).toBeLessThan(4.4);
    expect(beRatio).toBeGreaterThan(1.8);
    expect(beRatio).toBeLessThan(2.2);
  });

  it('BE restart after a PULSE edge: the capacitor current does not ring (trapezoidal alone does)', () => {
    // Ideal source across a capacitor: i = C·dv/dt is a pure derivative, the
    // quantity trapezoidal integration rings on when the slope jumps.
    // Edges at 0.5 ms (0 → 1 mA) and 1.5 ms (1 mA → 0); exact current is piecewise constant.
    const run = (beAfterBreakpoint: boolean) => {
      const circuit = new Circuit();
      const v1 = new VoltageSource({ pulse: { v1: 0, v2: 1, td: '0.5m', tr: '1m', pw: '1m', tf: '1m' } });
      const c1 = new Capacitor('1u');
      v1.pin('+').connect(c1.pin('1'));
      c1.pin('2').connect(circuit.ground);
      v1.pin('-').connect(circuit.ground);
      const res = circuit.analyze('transient', { timeStep: 10e-6, maxStep: 100e-6, duration: 3e-3, adaptive: true, beAfterBreakpoint }, [
        { label: 'i', color: '', component: c1, type: 'current' },
      ]);
      const exact = (t: number) => (t > 0.5e-3 && t <= 1.5e-3 ? 1e-3 : t > 2.5e-3 && t <= 3.5e-3 ? -1e-3 : 0);
      return maxAbs(res.timePoints, i => res.probes[0].values[i] - exact(res.timePoints[i]));
    };
    expect(run(true)).toBeLessThan(1e-9); // BE restart: exact secant derivative, no ringing
    expect(run(false)).toBeGreaterThan(0.5e-3); // trapezoidal through the edge: ±1 mA ringing
  });

  it('breakpoints: the adaptive stepper lands exactly on every PULSE corner', () => {
    const w = { v1: 0, v2: 5, td: 0.3e-3, tr: 7e-6, tf: 13e-6, pw: 1.1e-3, per: 3e-3 };
    const { t } = rc({ pulse: w }, 1000, 1e-6, { timeStep: 1e-6, maxStep: 1e-3, duration: 7e-3, adaptive: true });
    const corners: number[] = [];
    for (let k = 0; k < 3; k++) {
      const base = w.td + k * w.per;
      for (const c of [0, w.tr, w.tr + w.pw, w.tr + w.pw + w.tf]) if (base + c <= 7e-3) corners.push(base + c);
    }
    const set = new Set(t);
    for (const c of corners) expect(set.has(c)).toBe(true); // exact float equality
    // The source's own breakpoint chain reports the same corners.
    const chain: number[] = [];
    let bp = 0;
    while ((bp = waveformNextBreakpoint({ pulse: w }, bp)) <= 7e-3) chain.push(bp);
    expect(chain).toEqual(corners);
  });

  it('adaptive stepping: far fewer steps than fixed stepping on an RC with long idle periods, within 10 mV', () => {
    const tau = 1e-3;
    const w = { v1: 0, v2: 5, td: 1e-3, tr: 1e-6, tf: 1e-6, pw: 2e-3, per: 50e-3 };
    const corners: [number, number][] = [];
    for (let k = 0; k < 2; k++) {
      const b = w.td + k * w.per;
      corners.push([b, 0], [b + w.tr, 5], [b + w.tr + w.pw, 5], [b + w.tr + w.pw + w.tf, 0]);
    }
    const tstop = 100e-3;
    const adaptive = rc({ pulse: w }, 1000, 1e-6, { timeStep: 1e-6, maxStep: 5e-3, duration: tstop, adaptive: true });
    const fixed = rc({ pulse: w }, 1000, 1e-6, { timeStep: 10e-6, duration: tstop });
    const errA = maxAbs(adaptive.t, i => adaptive.vc[i] - rcExact(tau, corners, adaptive.t[i]));
    const errF = maxAbs(fixed.t, i => fixed.vc[i] - rcExact(tau, corners, fixed.t[i]));
    expect(errA).toBeLessThan(10e-3);
    expect(errF).toBeLessThan(10e-3);
    expect(adaptive.telemetry.acceptedSteps * 20).toBeLessThan(fixed.telemetry.acceptedSteps);
  });

  it('ic: "op" starts from the DC operating point (charged capacitor stays charged)', () => {
    const { vc, ir } = rc(5, 1000, 1e-6, { timeStep: 1e-5, duration: 1e-3, ic: 'op', adaptive: true });
    expect(Math.min(...vc)).toBeGreaterThan(5 - 1e-9);
    expect(Math.max(...ir.map(Math.abs))).toBeLessThan(1e-9);
  });

  it('current-source pulse into an RC charges with the right slope', () => {
    const circuit = new Circuit();
    const i1 = new CurrentSource({ pulse: { v1: 0, v2: '1m', td: 0, pw: '1m' } });
    const c1 = new Capacitor('1u');
    const r1 = new Resistor('1M');
    i1.pin('+').connect(c1.pin('1'));
    c1.pin('1').connect(r1.pin('1'));
    c1.pin('2').connect(circuit.ground);
    r1.pin('2').connect(circuit.ground);
    i1.pin('-').connect(circuit.ground);
    const res = circuit.analyze('transient', { timeStep: 1e-6, maxStep: 1e-4, duration: 1e-3, adaptive: true }, [
      { label: 'vc', color: '', component: c1, type: 'voltage' },
    ]);
    // dv/dt = I/C = 1000 V/s (the 1 MΩ bleed changes this by < 0.1 %).
    const v = res.probes[0].values;
    expect(v[v.length - 1]).toBeGreaterThan(0.999 * 0.9995);
    expect(v[v.length - 1]).toBeLessThan(1.0001);
  });
});
