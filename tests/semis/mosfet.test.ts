import { describe, it, expect } from 'vitest';
import {
  bench,
  runLadder,
  Circuit,
  VoltageSource,
  Resistor,
  NMOS,
  PMOS,
  describeComponent,
  buildComponent,
} from '../../src/forge';
import { op, type Q } from './helpers';

const rel = (a: number, b: number) => Math.abs(a / b - 1);

/** Vgs and Vds forced by sources, source grounded (bulk pin to Vbs when given). */
function forced(m: Q, vgs: number, vds: number, vbs?: number): Q {
  const c = new Circuit();
  const vg = new VoltageSource(vgs);
  const vd = new VoltageSource(vds);
  vg.pin('+').connect(m.pin('g'));
  vd.pin('+').connect(m.pin('d'));
  vg.pin('-').connect(c.ground);
  vd.pin('-').connect(c.ground);
  m.pin('s').connect(c.ground);
  if (vbs !== undefined) {
    const vb = new VoltageSource(vbs);
    vb.pin('+').connect(m.pin('b'));
    vb.pin('-').connect(c.ground);
  }
  op(c);
  return m;
}

const KP = 2e-3;
const VTO = 1;
const LAMBDA = 0.02;

describe('MOSFET Level 1 — square law', () => {
  it('saturation: Id = Kp/2·(Vgs − Vto)²·(1 + λ·Vds) (1e-9)', () => {
    for (const [vgs, vds] of [[2, 5], [3, 2.5], [4, 10]]) {
      const m = forced(new NMOS({ vto: VTO, kp: KP, lambda: LAMBDA }) as unknown as Q, vgs, vds);
      expect(rel(m.quantity('id'), (KP / 2) * (vgs - VTO) ** 2 * (1 + LAMBDA * vds))).toBeLessThan(1e-9);
    }
  });

  it('triode: Id = Kp·(Vgs − Vto − Vds/2)·Vds·(1 + λ·Vds) (1e-9)', () => {
    for (const [vgs, vds] of [[3, 0.1], [5, 1], [4, 2.9]]) {
      const m = forced(new NMOS({ vto: VTO, kp: KP, lambda: LAMBDA }) as unknown as Q, vgs, vds);
      expect(rel(m.quantity('id'), KP * (vgs - VTO - vds / 2) * vds * (1 + LAMBDA * vds))).toBeLessThan(1e-9);
    }
  });

  it('cutoff below Vto (only the 1e-14 A bulk-junction leakage)', () => {
    const m = forced(new NMOS({ vto: VTO, kp: KP }) as unknown as Q, 0.9, 5);
    expect(Math.abs(m.quantity('id'))).toBeLessThan(1e-13);
  });

  it('λ slope: dId/dVds in saturation = λ·Kp/2·(Vgs − Vto)² (1e-9)', () => {
    const a = forced(new NMOS({ vto: VTO, kp: KP, lambda: LAMBDA }) as unknown as Q, 3, 4).quantity('id');
    const b = forced(new NMOS({ vto: VTO, kp: KP, lambda: LAMBDA }) as unknown as Q, 3, 6).quantity('id');
    expect(rel((b - a) / 2, LAMBDA * (KP / 2) * 4)).toBeLessThan(1e-9);
  });

  it('body effect: Vth = Vto + γ·(√(φ + Vsb) − √φ) with the bulk pin at −2 V (1e-9)', () => {
    const gamma = 0.5;
    const phi = 0.7;
    const m = forced(new NMOS({ vto: VTO, kp: KP, gamma, phi, bulkPin: true }) as unknown as Q, 3, 5, -2);
    const vth = VTO + gamma * (Math.sqrt(phi + 2) - Math.sqrt(phi));
    expect(rel(m.quantity('id'), (KP / 2) * (3 - vth) ** 2)).toBeLessThan(1e-9);
    // tied bulk (default) has no body effect
    const t = forced(new NMOS({ vto: VTO, kp: KP, gamma, phi }) as unknown as Q, 3, 5);
    expect(rel(t.quantity('id'), (KP / 2) * 4)).toBeLessThan(1e-9);
  });

  it('W/L scale beta; Vds < 0 swaps source and drain', () => {
    const m = forced(new NMOS({ vto: VTO, kp: '20u', w: '10u', l: '1u' }) as unknown as Q, 3, 5);
    expect(rel(m.quantity('id'), (20e-6 * 10) / 2 * 4)).toBeLessThan(1e-9);
    // Vds = −0.3 (body diode still off): the drain acts as the source (Vgs_eff = 3.3, Vds_eff = 0.3)
    const r = forced(new NMOS({ vto: VTO, kp: KP }) as unknown as Q, 3, -0.3);
    expect(rel(r.quantity('id'), -KP * (3.3 - VTO - 0.15) * 0.3)).toBeLessThan(1e-6);
  });

  it('PMOS mirrors NMOS (1e-12)', () => {
    const n = forced(new NMOS({ vto: VTO, kp: KP, lambda: LAMBDA, rd: 1, rs: 0.5 }) as unknown as Q, 3, 4);
    const p = forced(new PMOS({ vto: -VTO, kp: KP, lambda: LAMBDA, rd: 1, rs: 0.5 }) as unknown as Q, -3, -4);
    for (const k of ['id', 'is', 'vgs', 'vds']) expect(Math.abs(p.quantity(k) + n.quantity(k))).toBeLessThan(1e-12 * Math.abs(n.quantity(k)) + 1e-15);
  });

  it('Rd and Rs are internal nodes: Vds(ext) = Id·(Rd + Rs) + Vds(int)', () => {
    const m = forced(new NMOS({ vto: VTO, kp: KP, rd: 10, rs: 5 }) as unknown as Q, 5, 0.5);
    expect(new NMOS({ rd: 10, rs: 5 }).getInternalNodeCount()).toBe(2);
    const id = m.quantity('id');
    // inner triode equation with Vgs(int) = 5 − Id·Rs, Vds(int) = 0.5 − Id·15
    const vgsI = 5 - id * 5;
    const vdsI = 0.5 - id * 15;
    expect(rel(id, KP * (vgsI - VTO - vdsI / 2) * vdsI)).toBeLessThan(1e-6);
  });
});

describe('MOSFET — CMOS inverter transfer curve', () => {
  const inverter = bench('cmos-inverter', (tb) => {
    const vdd = tb.add('VDD', new VoltageSource(5));
    const vin = tb.add('VIN', new VoltageSource(0));
    const mn = tb.add('MN', new NMOS({ vto: 1, kp: '1m', lambda: 0.01 }));
    const mp = tb.add('MP', new PMOS({ vto: -1, kp: '1m', lambda: 0.01 }));
    vdd.pin('-').connect(tb.gnd);
    vin.pin('-').connect(tb.gnd);
    mp.pin('s').connect(vdd.pin('+'));
    mp.pin('g').connect(vin.pin('+'));
    mn.pin('g').connect(vin.pin('+'));
    mn.pin('s').connect(tb.gnd);
    mp.pin('d').connect(mn.pin('d'));
    tb.name('out', mn.pin('d'));
    const sweep = tb.expect.dc({ source: 'VIN', from: 0, to: 5, points: 101 }).probe('out');
    sweep.toBeMonotonic('decreasing');
    sweep.at(0).toBeCloseTo(5, 1e-6);
    sweep.at(5).toBeCloseTo(0, 1e-6);
    sweep.toCross(2.5).between(2.45, 2.55);
  });

  it('rails at the ends, monotonic, symmetric switching threshold VM = VDD/2', () => {
    const r = runLadder(inverter, { hints: false });
    expect(r.diagnostics).toEqual([]);
    expect(r.exitCode).toBe(0);
    const cross = r.stages.dc!.assertions!.find(a => a.check.op === 'crosses')!;
    expect(cross.measured!).toBeCloseTo(2.5, 6); // matched devices: exact symmetry
  });
});

describe('MOSFET — gate capacitance charging', () => {
  it('Vg(t) through Rg charges Cgs + Cgd: 63.2 % at t = Rg·(Cgso + Cgdo) (0.5 %)', () => {
    const c = new Circuit();
    const vin = new VoltageSource({ pulse: { v1: 0, v2: 5, td: 0, tr: '1p', tf: '1p', pw: 1 } });
    const vdd = new VoltageSource(10);
    const rg = new Resistor('1k');
    const rd = new Resistor('100');
    const m = new NMOS({ vto: 8, kp: '1m', cgso: '800p', cgdo: '200p' }) as unknown as Q; // stays off: caps only
    vin.pin('+').connect(rg.pin('1'));
    rg.pin('2').connect(m.pin('g'));
    vdd.pin('+').connect(rd.pin('1'));
    rd.pin('2').connect(m.pin('d'));
    m.pin('s').connect(c.ground);
    vin.pin('-').connect(c.ground);
    vdd.pin('-').connect(c.ground);
    const tau = 1e3 * 1e-9;
    const res = c.analyze('transient', { timeStep: tau / 100, maxStep: tau / 20, duration: 5 * tau, adaptive: true, ic: 'op' }, [
      { label: 'vgs', color: '', component: m, type: 'voltage', quantity: 'vgs' },
    ]);
    const t = res.timePoints;
    const v = res.probes[0].values;
    const k = t.findIndex(x => x >= tau);
    const vAt = v[k - 1] + ((v[k] - v[k - 1]) * (tau - t[k - 1])) / (t[k] - t[k - 1]);
    expect(rel(vAt, 5 * (1 - Math.exp(-1)))).toBeLessThan(5e-3);
  });
});

describe('MOSFET — params, .model, round trip', () => {
  it('fromModel with instance W/L; LEVEL=3 is T006; round trip', () => {
    const m = NMOS.fromModel('.model MN NMOS(LEVEL=1 VTO=0.7 KP=110u LAMBDA=0.04 GAMMA=0.4 PHI=0.65)', { W: '10u', L: '1u' });
    expect(m.modelDiagnostics).toEqual([]);
    expect(m.params.Kp).toBeCloseTo(110e-6, 18);
    expect(m.params.W).toBe(1e-5);
    const l3 = NMOS.fromModel('.model MN NMOS(LEVEL=3 VTO=0.7)');
    expect(l3.modelDiagnostics[0].code).toBe('T006');
    for (const dev of [m, new PMOS({ vto: -2, kp: '20m', bodyDiode: { Is: 1e-12, n: 1.2, Rs: 0.1 } }), new NMOS({ bulkPin: true, gamma: 0.3 })]) {
      const info = describeComponent(dev);
      expect(describeComponent(buildComponent(info.type, JSON.parse(JSON.stringify(info.params))))).toEqual(info);
    }
    expect(() => new NMOS({ vth: 1 })).toThrow(/unknown parameter 'vth'/);
  });

  it('explicit body diode conducts source → drain when Vds < 0', () => {
    const m = forced(new NMOS({ vto: 2, kp: '1', bodyDiode: { Is: 1e-12, n: 1 } }) as unknown as Q, 0, -0.6);
    // gate at 0 V: channel off; current flows out of the drain = body diode Is·(e^(0.6/Vt) − 1)
    expect(rel(-m.quantity('id'), 1e-12 * (Math.exp(0.6 / 0.02585) - 1))).toBeLessThan(1e-6);
  });
});
