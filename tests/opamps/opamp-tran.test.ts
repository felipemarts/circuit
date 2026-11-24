import { describe, it, expect } from 'vitest';
import { IdealOpAmp, OpAmp, Part } from '../../src/forge';
import { integrator, nonInverting, inverting, tran, at, crossing } from './helpers';

const rel = (a: number, b: number) => Math.abs(a - b) / Math.abs(b);

describe('op-amps — transient', () => {
  it('integrator ramp slope = −Vin/(RC) (±0.5 %), macro and ideal', () => {
    for (const make of [() => new OpAmp(), () => new IdealOpAmp()]) {
      const w = tran(integrator(make, { vin: 0.5, r: 10e3, c: 100e-9 }), 'out', { tstop: 4e-3, dt: 10e-6 });
      const slope = (at(w, 3e-3) - at(w, 1e-3)) / 2e-3;
      expect(rel(slope, -0.5 / (10e3 * 100e-9))).toBeLessThan(5e-3);
    }
  });

  it('LM358 follower step: slew-limited slope = SR = 0.3 V/µs (data typ; ±3 %)', () => {
    const w = tran(
      nonInverting(() => Part('LM358'), { vin: { pulse: { v1: 0.5, v2: 3, td: 2e-6, tr: 1e-9, tf: 1e-9, pw: 100e-6 } }, r1: Infinity, r2: 0, rails: [5, 0] }),
      'out',
      { tstop: 20e-6, dt: 50e-9, ic: 'op' },
    );
    const t1 = crossing(w, 1.0, 2e-6);
    const t2 = crossing(w, 2.5, 2e-6);
    const sr = 1.5 / (t2 - t1);
    expect(rel(sr, 0.3e6)).toBeLessThan(0.03);
    expect(sr).toBeGreaterThanOrEqual(0.3e6 * 0.97);
    expect(sr).toBeLessThanOrEqual(0.6e6);
    expect(at(w, 19e-6)).toBeCloseTo(3 + 3e-3, 3); // settles to Vin + Vos
  });

  it('small-signal step of a follower: 10–90 % rise time = 0.35/GBW (single pole; ±5 %)', () => {
    const w = tran(
      nonInverting(() => new OpAmp({ gbw: 1e6, sr: 10e6 }), { vin: { pulse: { v1: 0, v2: 0.01, td: 1e-6, tr: 1e-10, tf: 1e-10, pw: 1e-3 } }, r1: Infinity, r2: 0 }),
      'out',
      { tstop: 3e-6, dt: 5e-9, ic: 'op' },
    );
    const final = 0.01 * (1e5 / (1 + 1e5));
    const rise = crossing(w, 0.9 * final, 1e-6) - crossing(w, 0.1 * final, 1e-6);
    expect(rel(rise, Math.log(9) / (2 * Math.PI * 1e6))).toBeLessThan(0.05);
  });

  it('LM358 gain-of-10 stage on 5 V clips a sine at the data swing (≈ V+ − 1.5 V), recovers each cycle', () => {
    const w = tran(
      inverting(() => Part('LM358'), { vin: { sin: { offset: 0, amplitude: 0.4, freq: 1e3 } }, r1: 10e3, r2: 100e3, rails: [5, 0], rl: 2e3,
        build: tb => void tb }),
      'out',
      { tstop: 3e-3, dt: 2e-6 },
    );
    // Inverting from a single supply: the output clips at the top during the negative half-wave.
    const max = Math.max(...w.y.filter((_, i) => w.t[i] > 1e-3));
    expect(max).toBeGreaterThan(3.4);
    expect(max).toBeLessThan(3.55);
    const min = Math.min(...w.y.filter((_, i) => w.t[i] > 1e-3));
    expect(min).toBeLessThan(0.05);
  });

  it('transient from the zero state and from the op point agree in steady state', () => {
    const mk = () => inverting(() => Part('TL072'), { vin: 0.2, r1: 1e3, r2: 4.7e3 });
    const z = tran(mk(), 'out', { tstop: 50e-6, dt: 0.1e-6 });
    const o = tran(mk(), 'out', { tstop: 50e-6, dt: 0.1e-6, ic: 'op' });
    expect(Math.abs(z.y[z.y.length - 1] - o.y[o.y.length - 1])).toBeLessThan(1e-6);
    expect(o.y[0]).toBeCloseTo(-0.94 + 3e-3 * 5.7, 3); // −Vin·R2/R1 + Vos·(1 + R2/R1)
  });
});
