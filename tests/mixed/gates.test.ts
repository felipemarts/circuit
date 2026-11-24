import { describe, it, expect } from 'vitest';
import { bench, runLadder, VoltageSource, Resistor, LED, Capacitor, Part, elaborate } from '../../src/forge';
import type { LogicIC } from '../../src/mixed/device';
import { logicFamilyModel } from '../../src/mixed/families';
import { power, tieLow, waves, crossing } from './helpers';

/** 74HC00 gate 1 with DC inputs a, b (volts) at a supply. Returns the op record. */
function nandOp(vcc: number, a: number, b: number) {
  return runLadder(
    bench('nand', tb => {
      const u = tb.add('U1', Part('74HC00')) as LogicIC;
      power(tb, u, vcc);
      const va = tb.add('VA', new VoltageSource(a));
      const vb = tb.add('VB', new VoltageSource(b));
      va.pin('-').connect(tb.gnd);
      vb.pin('-').connect(tb.gnd);
      va.pin('+').connect(u.pin('1A'));
      vb.pin('+').connect(u.pin('1B'));
      tieLow(tb, u, ['2A', '2B', '3A', '3B', '4A', '4B']);
      tb.expect.op('U1.1Y').toBeAbove(-1);
    }),
    { stages: ['lint', 'op'] },
  );
}

describe('74HC00 truth table through the analog bridges', () => {
  for (const vcc of [5, 2]) {
    it(`VCC = ${vcc} V`, () => {
      for (const [a, b] of [[0, 0], [0, 1], [1, 0], [1, 1]]) {
        const r = nandOp(vcc, a * vcc, b * vcc);
        expect(r.exitCode, JSON.stringify(r.diagnostics)).toBe(0);
        const y = r.stages.op!.probes!['U1.1Y'];
        const want = a && b ? 0 : vcc;
        expect(Math.abs(y - want)).toBeLessThan(1e-3);
      }
    });
  }

  it('thresholds scale with VCC: 1.6 V is a valid 1 at 2 V but in the forbidden zone at 5 V', () => {
    const fam = logicFamilyModel('74HC00');
    expect(fam.vih(2)).toBeCloseTo(1.5, 9);
    expect(fam.vil(2)).toBeCloseTo(0.5, 9);
    expect(fam.vih(5)).toBeCloseTo(3.5, 9);
    expect(fam.vil(5)).toBeCloseTo(1.5, 9);
    const low = nandOp(2, 1.6, 2);
    expect(low.exitCode).toBe(0);
    expect(low.stages.op!.probes!['U1.1Y']).toBeLessThan(0.01); // NAND(1,1) = 0
    const mid = nandOp(5, 1.6, 5);
    expect(mid.exitCode).toBe(2);
    const d = mid.diagnostics.find(x => x.code === 'D508')!;
    expect(d.subject?.pins).toEqual(['U1.1A']);
    expect(d.evidence).toMatchObject({ vil: 1.5, vih: 3.5, voltage: 1.6 });
  });

  it('transient truth table (PWL inputs) with logic assertions on the output pin', () => {
    const r = runLadder(
      bench('nand-tran', tb => {
        const u = tb.add('U1', Part('74HC00')) as LogicIC;
        power(tb, u, 5);
        const va = tb.add('VA', new VoltageSource({ pwl: { points: [[0, 0], ['2u', 0], ['2.005u', 5], ['4u', 5], ['4.005u', 0], ['6u', 0], ['6.005u', 5]] } }));
        const vb = tb.add('VB', new VoltageSource({ pwl: { points: [[0, 0], ['4u', 0], ['4.005u', 5]] } }));
        va.pin('-').connect(tb.gnd);
        vb.pin('-').connect(tb.gnd);
        va.pin('+').connect(u.pin(1));
        vb.pin('+').connect(u.pin(2));
        tieLow(tb, u, [4, 5, 9, 10, 12, 13]);
        const lg = tb.expect.logic('U1.pin3', { tstop: '8u' });
        lg.toBe(1).at('1u'); // 0,0
        lg.toBe(1).at('3u'); // 1,0
        lg.toBe(1).at('5u'); // 0,1
        lg.toBe(0).at('7u'); // 1,1
        lg.toToggle({ count: 1 });
        tb.expect.logic('U1.1A').toToggle({ count: 3 });
      }),
    );
    expect(r.exitCode, JSON.stringify(r.diagnostics)).toBe(0);
    expect(r.stages.tran!.logic![0].signals['U1.pin3'].map(e => e[1])).toEqual([1, 0]);
  });
});

describe('74HC04 output stage', () => {
  it('drives LED + resistor with the current set by VOH, Rout(VCC) and the LED drop', () => {
    const r = runLadder(
      bench('led', tb => {
        const u = tb.add('U1', Part('74HC04')) as LogicIC;
        power(tb, u, 5);
        const r1 = tb.add('R1', new Resistor('220'));
        const d1 = tb.add('D1', new LED());
        tieLow(tb, u, ['1A', '2A', '3A', '4A', '5A', '6A']);
        u.pin('1Y').connect(r1.pin('1'));
        r1.pin('2').connect(d1.pin('anode'));
        d1.pin('cathode').connect(tb.gnd);
        tb.expect.op('R1.i').toBeAbove(0);
        tb.expect.op('D1.v').toBeAbove(0);
        tb.expect.op('U1.1Y').toBeAbove(0);
      }),
    );
    expect(r.exitCode).toBe(0);
    const p = r.stages.op!.probes!;
    const rOut = logicFamilyModel('74HC04').rOutHigh(5, 'typ');
    // HC rOutHigh: (4.5−4.3)/4 mA = 50 Ω at 4.5 V, (6−5.8)/5.2 mA = 38.5 Ω at 6 V → 5 V by conductance
    expect(rOut).toBeGreaterThan(38.5);
    expect(rOut).toBeLessThan(50);
    const expected = (5 - p['D1.v']) / (220 + rOut);
    expect(Math.abs(p['R1.i'] - expected) / expected).toBeLessThan(1e-3);
    expect(p['U1.1Y']).toBeCloseTo(5 - p['R1.i'] * rOut, 3);
  });

  it('propagation delay at 5 V into 50 pF matches the datasheet tpd within 20 %', () => {
    const desc = bench('tpd', tb => {
      const u = tb.add('U1', Part('74HC04')) as LogicIC;
      power(tb, u, 5);
      const vin = tb.add('VIN', new VoltageSource({ pulse: { v1: 0, v2: 5, td: '20n', tr: '1n', tf: '1n', pw: '100n' } }));
      vin.pin('-').connect(tb.gnd);
      vin.pin('+').connect(u.pin('1A'));
      const cl = tb.add('CL', new Capacitor('50p'));
      u.pin('1Y').connect(cl.pin('1'));
      cl.pin('2').connect(tb.gnd);
      tieLow(tb, u, ['2A', '3A', '4A', '5A', '6A']);
      tb.name('out', u.pin('1Y'));
      tb.name('in', u.pin('1A'));
    });
    const { t, v } = waves(desc, 200e-9, ['in', 'out'], 2e-9);
    const tpd = logicFamilyModel('74HC04').tpd('A->Y', 5, 'typ'); // 8.67 ns (9 @ 4.5 V, 8 @ 6 V)
    const inRise = crossing(t, v.in, 2.5, 'rise')!;
    const outFall = crossing(t, v.out, 2.5, 'fall')!;
    const inFall = crossing(t, v.in, 2.5, 'fall')!;
    const outRise = crossing(t, v.out, 2.5, 'rise', inFall)!;
    expect(Math.abs(outFall - inRise - tpd) / tpd).toBeLessThan(0.2);
    expect(Math.abs(outRise - inFall - tpd) / tpd).toBeLessThan(0.2);
  });
});

describe('74HC14 Schmitt trigger', () => {
  it('RC relaxation oscillator: f within 1 % of 1/(RC·[ln((VCC−VT−)/(VCC−VT+)) + ln(VT+/VT−)]), ramp bounded by VT±', () => {
    const fam = logicFamilyModel('74HC14');
    const vtp = fam.vtPlus!(5);
    const vtm = fam.vtMinus!(5);
    expect(vtp).toBeCloseTo(2.5 + 0.8 / 3, 9); // VT+ typ 2.5 V @ 4.5 V, 3.3 V @ 6 V
    expect(vtm).toBeCloseTo(1.6 + 0.4 / 3, 9); // VT− typ 1.6 V @ 4.5 V, 2.0 V @ 6 V
    const R = 10e3;
    const C = 10e-9;
    const f = 1 / (R * C * (Math.log((5 - vtm) / (5 - vtp)) + Math.log(vtp / vtm)));
    const desc = bench('hc14-osc', tb => {
      const u = tb.add('U1', Part('74HC14')) as LogicIC;
      power(tb, u, 5);
      const r1 = tb.add('R1', new Resistor(R));
      const c1 = tb.add('C1', new Capacitor(C));
      u.pin('1Y').connect(r1.pin('1'));
      r1.pin('2').connect(u.pin('1A'));
      c1.pin('1').connect(u.pin('1A'));
      c1.pin('2').connect(tb.gnd);
      tieLow(tb, u, ['2A', '3A', '4A', '5A', '6A']);
      tb.name('osc', u.pin('1Y'));
      tb.name('ramp', u.pin('1A'));
      const run = tb.expect.tran({ tstop: '2m', maxStep: '10u' });
      run.logic('osc').toHaveFrequency(f, 0.01, { from: '0.3m' });
      run.logic('osc').toToggle({ min: 40 });
      run.probe('ramp').toStayAbove(vtm - 0.01, { from: '0.3m' });
      run.probe('ramp').toStayBelow(vtp + 0.01, { from: '0.3m' });
    });
    const r = runLadder(desc, { stages: ['lint', 'tran'] });
    expect(r.exitCode, JSON.stringify(r.stages.tran?.assertions)).toBe(0);
    // Clean edges: the output swings rail to rail although the input only ramps between VT− and VT+.
    const { t, v } = waves(desc, 2e-3, ['osc'], 10e-6);
    const late = v.osc.filter((_, i) => t[i] > 0.3e-3);
    expect(Math.max(...late)).toBeGreaterThan(4.9);
    expect(Math.min(...late)).toBeLessThan(0.1);
  });
});

describe('A→D threshold crossing', () => {
  it('an RC edge into a 74HC04 switches when it crosses VIH (analytic time)', () => {
    const R = 1000;
    const C = 100e-12;
    const desc = bench('rc-vih', tb => {
      const u = tb.add('U1', Part('74HC04')) as LogicIC;
      power(tb, u, 5);
      const vs = tb.add('VS', new VoltageSource({ pulse: { v1: 0, v2: 5, td: '100n', tr: '0.1n', tf: '0.1n', pw: '5u' } }));
      vs.pin('-').connect(tb.gnd);
      const r1 = tb.add('R1', new Resistor(R));
      const c1 = tb.add('C1', new Capacitor(C));
      vs.pin('+').connect(r1.pin('1'));
      r1.pin('2').connect(u.pin('1A'));
      c1.pin('1').connect(u.pin('1A'));
      c1.pin('2').connect(tb.gnd);
      tieLow(tb, u, ['2A', '3A', '4A', '5A', '6A']);
      tb.expect.logic('U1.1A', { tstop: '1u' }).toToggle({ count: 1 });
    });
    const r = runLadder(desc, { stages: ['lint', 'tran'] });
    expect(r.exitCode, JSON.stringify(r.diagnostics)).toBe(0);
    const edges = r.stages.tran!.logic![0].signals['U1.1A'];
    const vih = logicFamilyModel('74HC04').vih(5);
    const analytic = 100e-9 + 0.05e-9 - R * C * Math.log(1 - vih / 5); // RC step starting at the ramp midpoint
    expect(edges[1][1]).toBe(1);
    expect(Math.abs(edges[1][0] - analytic)).toBeLessThan(0.5e-9); // within 0.5 ns of ~220 ns
  });
});

describe('unpowered / out-of-range supply', () => {
  it('an IC whose VCC pin is unconnected is a lint error (F135)', () => {
    const r = runLadder(
      bench('nopower', tb => {
        const u = tb.add('U1', Part('74HC04')) as LogicIC;
        const v = tb.add('V1', new VoltageSource(5));
        v.pin('-').connect(tb.gnd);
        u.pin('GND').connect(tb.gnd);
        v.pin('+').connect(u.pin('1A'));
        tieLow(tb, u, ['2A', '3A', '4A', '5A', '6A']);
      }),
    );
    expect(r.exitCode).toBe(2);
    expect(r.diagnostics.map(d => d.code)).toContain('F135');
  });

  it('an IC fed 0.8 V never powers (D510) and 74HCT04 at 3.3 V is outside its range (D509 warning)', () => {
    const r = runLadder(
      bench('weak', tb => {
        const u = tb.add('U1', Part('74HC04')) as LogicIC;
        power(tb, u, 0.8);
        tieLow(tb, u, ['1A', '2A', '3A', '4A', '5A', '6A']);
        tb.name('y', u.pin('1Y'));
        tb.expect.logic('y', { tstop: '1u' }).toBe(1);
      }),
    );
    expect(r.exitCode).toBe(2);
    const h = runLadder(
      bench('hct', tb => {
        const u = tb.add('U1', Part('74HCT04')) as LogicIC;
        power(tb, u, 3.3);
        tieLow(tb, u, ['1A', '2A', '3A', '4A', '5A', '6A']);
      }),
    );
    expect(h.exitCode).toBe(0);
    expect(h.diagnostics.map(d => [d.code, d.severity])).toEqual([['D509', 'warning']]);
  });

  it('IC pins resolve by datasheet name and by number', () => {
    const u = Part('74HC595') as LogicIC;
    expect(u.pin(14)).toBe(u.pin('SER'));
    expect(u.pin("QH'")).toBe(u.pin(9));
    expect(u.pin('~oe')).toBe(u.pin(13));
    expect(() => u.pin(17)).toThrow(/no pin 17/);
    expect(() =>
      elaborate(
        bench('x', tb => {
          tb.add('U1', Part('74HC04'));
          tb.expect.logic('U1.9Z', { tstop: 1e-6 }).toBe(1);
        }),
      ),
    ).toThrow(/unknown logic probe/);
  });
});
