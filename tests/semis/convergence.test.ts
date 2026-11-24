import { describe, it, expect } from 'vitest';
import { bench, runLadder, VoltageSource, Resistor, Inductor, Part, NPN, NMOS } from '../../src/forge';
import type { TB } from '../../src/forge';

/**
 * Circuits whose cold-start Newton iterate would overflow the junction
 * exponentials (or swing the MOSFET far past its threshold) without voltage
 * limiting. They must converge; when a convergence aid is needed, the
 * telemetry names it.
 */
describe('convergence — circuits that need limiting', () => {
  it('BJT: two-stage saturated switch from a 24 V rail (pnjlim on both junctions)', () => {
    const b = bench('bjt-hard', (tb: TB) => {
      const vcc = tb.add('VCC', new VoltageSource(24));
      const r1 = tb.add('R1', new Resistor('2.2k'));
      const r2 = tb.add('R2', new Resistor('100'));
      const rl = tb.add('RL', new Resistor('47'));
      const q1 = tb.add('Q1', new NPN({ is: 1e-15, bf: 200, vaf: 80, ikf: 0.3, rb: 10, re: 0.2, rc: 1 }));
      const q2 = tb.add('Q2', Part('BD139'));
      vcc.pin('-').connect(tb.gnd);
      r1.pin('1').connect(vcc.pin('+'));
      r1.pin('2').connect(q1.pin('b'));
      q1.pin('c').connect(vcc.pin('+'));
      q1.pin('e').connect(r2.pin('1'));
      r2.pin('2').connect(q2.pin('b'));
      rl.pin('1').connect(vcc.pin('+'));
      rl.pin('2').connect(q2.pin('c'));
      q2.pin('e').connect(tb.gnd);
      tb.expect.op('Q2.vce').toBeBelow(1);
      tb.ratings(false);
    });
    const r = runLadder(b, { hints: false });
    expect(r.diagnostics).toEqual([]);
    expect(r.exitCode).toBe(0);
    const s = r.stages.op!.solver!;
    expect(s.method).toBe('newton-raphson');
    expect(s.iterations).toBeGreaterThan(3); // limited steps walk up the exponentials
    expect(s.iterations).toBeLessThan(200);
  });

  it('MOSFET: gate at 20 V, Vth 1 V, drain from 48 V (fetlim + limvds)', () => {
    const b = bench('mos-hard', (tb: TB) => {
      const vdd = tb.add('VDD', new VoltageSource(48));
      const vg = tb.add('VG', new VoltageSource(20));
      const rl = tb.add('RL', new Resistor('10'));
      const m = tb.add('M1', new NMOS({ vto: 1, kp: 20, lambda: 0.01, rd: 0.01, bodyDiode: { Is: 1e-12, n: 1, Rs: 0.01 } }));
      vdd.pin('-').connect(tb.gnd);
      vg.pin('-').connect(tb.gnd);
      rl.pin('1').connect(vdd.pin('+'));
      rl.pin('2').connect(m.pin('d'));
      vg.pin('+').connect(m.pin('g'));
      m.pin('s').connect(tb.gnd);
      tb.expect.op('M1.vds').toBeBelow(0.2);
    });
    const r = runLadder(b, { hints: false });
    expect(r.exitCode).toBe(0);
    expect(r.stages.op!.solver!.iterations).toBeGreaterThan(2);
  });

  it('PNP high-side + NPN low-side push-pull at ±15 V converges and reports any aid it needed', () => {
    const b = bench('push-pull', (tb: TB) => {
      const vp = tb.add('VP', new VoltageSource(15));
      const vn = tb.add('VN', new VoltageSource(-15));
      const vin = tb.add('VIN', new VoltageSource(3));
      const rb = tb.add('RB', new Resistor('1k'));
      const rl = tb.add('RL', new Resistor('100'));
      const qn = tb.add('QN', Part('2N3904'));
      const qp = tb.add('QP', Part('2N3906'));
      vp.pin('-').connect(tb.gnd);
      vn.pin('-').connect(tb.gnd);
      vin.pin('-').connect(tb.gnd);
      vin.pin('+').connect(rb.pin('1'));
      rb.pin('2').connect(qn.pin('b'));
      qp.pin('b').connect(qn.pin('b'));
      qn.pin('c').connect(vp.pin('+'));
      qp.pin('c').connect(vn.pin('+'));
      qn.pin('e').connect(qp.pin('e'));
      rl.pin('1').connect(qn.pin('e'));
      rl.pin('2').connect(tb.gnd);
      tb.name('out', qn.pin('e'));
      tb.expect.op('out').toBeWithin(2, 3);
    });
    const r = runLadder(b, { hints: false });
    expect(r.diagnostics).toEqual([]);
    expect(r.exitCode).toBe(0);
    const s = r.stages.op!.solver!;
    if (s.aids) expect(s.attempts!.length).toBeGreaterThan(1); // aid telemetry is complete when used
  });

  it('transient: hard-switched BJT with an inductive load and a flyback diode', () => {
    const b = bench('flyback', (tb: TB) => {
      const vcc = tb.add('VCC', new VoltageSource(12));
      const vin = tb.add('VIN', new VoltageSource({ pulse: { v1: 0, v2: 5, td: '10u', tr: '10n', tf: '10n', pw: '200u', per: '400u' } }));
      const rb = tb.add('RB', new Resistor('1k'));
      const l = tb.add('L1', new Inductor('10m'));
      const rl = tb.add('RL', new Resistor('100'));
      const q = tb.add('Q1', Part('2N3904'));
      const d = tb.add('D1', Part('1N4148'));
      vcc.pin('-').connect(tb.gnd);
      vin.pin('-').connect(tb.gnd);
      vin.pin('+').connect(rb.pin('1'));
      rb.pin('2').connect(q.pin('b'));
      q.pin('e').connect(tb.gnd);
      vcc.pin('+').connect(rl.pin('1'));
      rl.pin('2').connect(l.pin('1'));
      l.pin('2').connect(q.pin('c'));
      d.pin('anode').connect(q.pin('c'));
      d.pin('cathode').connect(vcc.pin('+'));
      tb.expect.tran({ tstop: '1m', maxStep: '5u' }).probe('Q1.vce').toNeverExceed(14);
    });
    const r = runLadder(b, { hints: false });
    expect(r.diagnostics).toEqual([]);
    expect(r.exitCode).toBe(0);
    const run = r.stages.tran!.solver!.runs![0];
    expect(run.acceptedSteps).toBeGreaterThan(100);
    // the diode clamps the flyback: the collector stays below Vcc + one diode drop
    expect(r.stages.tran!.ratings!.every(x => x.verdict === 'pass')).toBe(true);
  });

});
