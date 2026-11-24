import { describe, it, expect } from 'vitest';
import { Circuit, VoltageSource, Resistor, Diode, LED, describeComponent, buildComponent } from '../../src/forge';
import { admittance, diodeVoltageAt, op, type Q } from './helpers';

const VT = 0.02585;

describe('Diode — series resistance', () => {
  it('V(I) = n·Vt·ln(I/Is + 1) + I·Rs at high current (1e-9 relative)', () => {
    for (const i of [1e-3, 0.05, 0.5]) {
      const d = new Diode({ Is: 1e-14, n: 1.2, Rs: 2 }) as unknown as Q;
      const exact = 1.2 * VT * Math.log(i / 1e-14 + 1) + i * 2;
      expect(Math.abs(diodeVoltageAt(d, i) - exact)).toBeLessThan(1e-9 * exact + 1e-9);
    }
  });

  it('Rs = 0 keeps the legacy Shockley diode exactly (no internal node)', () => {
    const d = new Diode({ Is: 1e-14, n: 1 });
    expect(d.getInternalNodeCount()).toBe(0);
    expect(new Diode({ Rs: 1 }).getInternalNodeCount()).toBe(1);
    expect(describeComponent(new Diode()).params).toEqual({ Is: 1e-14, n: 1, Vt: VT });
    expect(describeComponent(new LED()).params).toEqual({ Is: 1e-20, n: 2, Vt: VT });
  });

  it('parameter names are case-insensitive and accept unit strings; unknown names throw', () => {
    const d = new Diode({ IS: '2.52n', N: 1.752, rs: '0.568', CJO: '4p', tt: '20n', bv: 100, ibv: '100u' });
    expect([d.Is, d.n, d.Rs, d.Cjo, d.Tt, d.BV, d.IBV]).toEqual([2.52e-9, 1.752, 0.568, 4e-12, 2e-8, 100, 1e-4]);
    expect(() => new Diode({ Iss: 1 })).toThrow(/unknown parameter 'Iss'/);
    expect(() => new Diode({ M: 1.2 })).toThrow(/M must be in \[0, 1\)/);
  });
});

describe('Diode — Zener breakdown', () => {
  const zener = () => new Diode({ BV: 5.1, IBV: '49m', Is: 1e-14 }) as unknown as Q;

  it('the reverse voltage at IBV equals BV (the datasheet Vz-at-Izt point), 1e-9', () => {
    expect(-diodeVoltageAt(zener(), -0.049)).toBeCloseTo(5.1, 9);
  });

  it('knee: Vz(I) = BVeff + Vt·ln(I/Is) — 1 mA sits Vt·ln(49) below BV', () => {
    const v1m = -diodeVoltageAt(zener(), -1e-3);
    expect(v1m).toBeCloseTo(5.1 - VT * Math.log(49), 6);
    // far below the knee (1 µA) the junction is in plain reverse bias
    expect(-diodeVoltageAt(zener(), -1e-9)).toBeLessThan(4.9);
  });

  it('regulates: 12 V → 220 Ω → Zener; dVz/dVin = rz/(R + rz), rz = Vt/Iz (0.5 %)', () => {
    const solve = (vin: number) => {
      const c = new Circuit();
      const v = new VoltageSource(vin);
      const r = new Resistor(220);
      const z = zener();
      v.pin('+').connect(r.pin('1'));
      r.pin('2').connect(z.pin('cathode'));
      z.pin('anode').connect(c.ground);
      v.pin('-').connect(c.ground);
      op(c);
      return { vz: -z.quantity('v'), iz: -z.quantity('i') };
    };
    const a = solve(12);
    const b = solve(12.01);
    expect(a.iz).toBeCloseTo((12 - a.vz) / 220, 9);
    expect(a.vz).toBeGreaterThan(5.08);
    expect(a.vz).toBeLessThan(5.12);
    const rz = VT / ((a.iz + b.iz) / 2);
    const slope = (b.vz - a.vz) / 0.01;
    expect(Math.abs(slope / (rz / (220 + rz)) - 1)).toBeLessThan(5e-3);
  });

  it('converges from a cold start straight into deep breakdown (100 V through 1k)', () => {
    const c = new Circuit();
    const v = new VoltageSource(100);
    const r = new Resistor(1000);
    const z = zener();
    v.pin('+').connect(r.pin('1'));
    r.pin('2').connect(z.pin('cathode'));
    z.pin('anode').connect(c.ground);
    v.pin('-').connect(c.ground);
    const res = c.analyze('dc');
    expect(-z.quantity('v')).toBeGreaterThan(5.1);
    expect(res.telemetry.method).toBe('newton-raphson');
  });
});

describe('Diode — junction and diffusion capacitance (AC)', () => {
  const Cjo = 4e-12;
  const Vj = 0.7;
  const M = 0.4;
  it('reverse bias: C(V) = Cjo·(1 − V/Vj)^−M (1e-9 relative)', () => {
    for (const v of [0, -1, -5]) {
      const d = new Diode({ Is: 1e-14, Cjo, Vj, M });
      const f = 1e6;
      const y = admittance(d, v, f);
      const c = y[1] / (2 * Math.PI * f);
      expect(Math.abs(c / (Cjo * Math.pow(1 - v / Vj, -M)) - 1)).toBeLessThan(1e-9);
    }
  });

  it('forward bias above Fc·Vj: linear extrapolation + Tt·gd', () => {
    const Tt = 5e-9;
    const Fc = 0.5;
    const v = 0.6;
    const d = new Diode({ Is: 1e-14, Cjo, Vj, M, Fc, Tt });
    const y = admittance(d, v, 1e3);
    const gd = (1e-14 / VT) * Math.exp(v / VT);
    const cdep = (Cjo / Math.pow(1 - Fc, 1 + M)) * (1 - Fc * (1 + M) + (M * v) / Vj);
    expect(y[0]).toBeCloseTo(gd + 1e-12, 12);
    expect(Math.abs(y[1] / (2 * Math.PI * 1e3) / (cdep + Tt * gd) - 1)).toBeLessThan(1e-6);
  });
});

describe('Diode — reverse recovery (Tt charge storage)', () => {
  it('storage time ≈ Tt·ln(1 + IF/IR) (charge-control), within 10 %', () => {
    const Tt = 1e-6;
    const c = new Circuit();
    const v = new VoltageSource({ pulse: { v1: 5, v2: -5, td: '10u', tr: '1n', tf: '1n', pw: '1' } });
    const r = new Resistor(1000);
    const d = new Diode({ Is: 1e-14, Tt });
    v.pin('+').connect(r.pin('1'));
    r.pin('2').connect(d.pin('anode'));
    d.pin('cathode').connect(c.ground);
    v.pin('-').connect(c.ground);
    const res = c.analyze('transient', { timeStep: 1e-8, maxStep: 5e-8, duration: 14e-6, adaptive: true }, [
      { label: 'v', color: '', component: d, type: 'voltage', quantity: 'v' },
      { label: 'i', color: '', component: d, type: 'current', quantity: 'i' },
    ]);
    const t = res.timePoints;
    const vd = res.probes[0].values;
    const id = res.probes[1].values;
    const k0 = t.findIndex(x => x >= 10e-6);
    const vf = vd[k0];
    const IF = (5 - vf) / 1000;
    // Reverse current during storage: the junction is still forward biased (~vf).
    const kMid = t.findIndex(x => x >= 10.1e-6);
    expect(id[kMid]).toBeLessThan(-4e-3); // the diode conducts BACKWARDS while charge is removed
    const IR = (5 + vd[kMid]) / 1000;
    let ts = NaN;
    for (let k = k0 + 1; k < t.length; k++) {
      if (vd[k] < 0) {
        ts = t[k - 1] + ((0 - vd[k - 1]) / (vd[k] - vd[k - 1])) * (t[k] - t[k - 1]) - 10e-6;
        break;
      }
    }
    const expected = Tt * Math.log(1 + IF / IR);
    expect(Math.abs(ts / expected - 1)).toBeLessThan(0.1);
    // Charge check: the charge pulled out during storage ≈ the stored charge Tt·IF
    // minus what recombines meanwhile (∫ i_d over ts ≈ (Q0/Tt)·ts/2 for a linear decay).
    let pulled = 0;
    for (let k = k0 + 1; k < t.length && t[k] <= 10e-6 + ts; k++) pulled += (-(id[k] + id[k - 1]) / 2) * (t[k] - t[k - 1]);
    const q0 = Tt * IF;
    expect(pulled).toBeGreaterThan(0.5 * q0);
    expect(pulled).toBeLessThan(1.5 * q0);
  });
});

describe('Diode — .model and round trip', () => {
  it('fromModel builds the same device as the constructor', () => {
    const d = Diode.fromModel('.model D1N4148 D(IS=2.52n RS=0.568 N=1.752 CJO=4p M=0.4 TT=20n BV=100 IBV=100u)');
    expect(d.modelDiagnostics).toEqual([]);
    expect(d.modelName).toBe('D1N4148');
    const info = describeComponent(d);
    expect(info.params).toMatchObject({ Is: 2.52e-9, n: 1.752, Rs: 0.568, Cjo: 4e-12, M: 0.4, Tt: 2e-8, BV: 100, IBV: 1e-4, model: 'D1N4148' });
    expect(describeComponent(buildComponent(info.type, JSON.parse(JSON.stringify(info.params))))).toEqual(info);
  });

  it('LED keeps its defaults and accepts parameters', () => {
    expect(new LED({ rs: 2.75 }).Rs).toBe(2.75);
    expect(new LED({ is: 1e-18 }).Is).toBe(1e-18);
    expect(new LED().Is).toBe(1e-20);
  });
});
