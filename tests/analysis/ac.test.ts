import { describe, it, expect } from 'vitest';
import { bench, runLadder, defineComponent, VoltageSource, CurrentSource, Resistor, Capacitor, Inductor, Diode } from '../../src/forge';
import type { TB, AssertionResult } from '../../src/forge';

const R = 1000;
const C = 100e-9;
const FC = 1 / (2 * Math.PI * R * C); // ≈ 1591.55 Hz

const rcLowPass = (assert: (tb: TB) => void) =>
  bench('rc-ac', (tb: TB) => {
    const v1 = tb.add('V1', new VoltageSource({ dc: 0, ac: 1 }));
    const r1 = tb.add('R1', new Resistor(R));
    const c1 = tb.add('C1', new Capacitor(C));
    v1.pin('+').connect(r1.pin('1'));
    r1.pin('2').connect(c1.pin('1'));
    c1.pin('2').connect(tb.gnd);
    v1.pin('-').connect(tb.gnd);
    tb.name('in', v1.pin('+'));
    tb.name('out', c1.pin('1'));
    assert(tb);
  });

const measured = (a: AssertionResult[] | undefined, i: number) => a![i].measured!;

describe('AC small-signal analysis', () => {
  it('RC low-pass: -3.0103 dB and -45° at fc, -20 dB/decade, bandwidth = fc', () => {
    const record = runLadder(
      rcLowPass(tb => {
        const ac = tb.expect.ac({ from: '10', to: '1M', pointsPerDecade: 20 });
        ac.probe('out')
          .gainAt(FC).toBeWithin(-3.02, -3.0)
          .phaseAt(FC).toBeWithin(-45.01, -44.99)
          .gainAt(10 * FC).toBeBelow(-20)
          .gainAt(100 * FC).toBeBelow(-40)
          .bandwidth3dB().toBeWithin(0.999 * FC, 1.001 * FC)
          .gainAt('10').toBeAbove(-0.01);
        ac.probe('out', { ref: 'in' }).gainAt(FC).toBeWithin(-3.02, -3.0);
      }),
    );
    expect(record.exitCode).toBe(0);
    const a = record.stages.ac!.assertions;
    // Exact values (tolerances stated): |H(fc)| = 1/√2, ∠H(fc) = -45°.
    expect(Math.abs(measured(a, 0) - 20 * Math.log10(Math.SQRT1_2))).toBeLessThan(1e-9);
    expect(Math.abs(measured(a, 1) + 45)).toBeLessThan(1e-9);
    // Asymptotic roll-off: one decade costs 20 dB (within 0.05 dB between 10·fc and 100·fc).
    expect(Math.abs(measured(a, 3) - measured(a, 2) + 20)).toBeLessThan(0.05);
    // Bandwidth is relative to the sweep's peak gain (here |H(10 Hz)|), so the
    // exact -3 dB point is fc·√(1 + 2·(10/fc)²).
    const bw = FC * Math.sqrt(1 + 2 * (10 / FC) ** 2);
    expect(Math.abs(measured(a, 4) - bw) / bw).toBeLessThan(1e-9);
    // Ratio to another probe equals ratio to the stimulus when the stimulus drives that net.
    expect(Math.abs(measured(a, 6) - measured(a, 0))).toBeLessThan(1e-12);
    expect(record.stages.ac!.solver!.method).toBe('complex-lu');
  });

  it('series RLC band-pass: 0 dB at f0 = 1/(2π√LC), bandwidth R/(2πL), phase 0 at resonance', () => {
    const L = 10e-3;
    const Cr = 100e-9;
    const Rr = 100;
    const f0 = 1 / (2 * Math.PI * Math.sqrt(L * Cr));
    const record = runLadder(
      bench('rlc', (tb: TB) => {
        const v1 = tb.add('V1', new VoltageSource({ dc: 0, ac: { mag: 2, phase: 0 } }));
        const l1 = tb.add('L1', new Inductor(L));
        const c1 = tb.add('C1', new Capacitor(Cr));
        const r1 = tb.add('R1', new Resistor(Rr));
        v1.pin('+').connect(l1.pin('1'));
        l1.pin('2').connect(c1.pin('1'));
        c1.pin('2').connect(r1.pin('1'));
        r1.pin('2').connect(tb.gnd);
        v1.pin('-').connect(tb.gnd);
        tb.name('out', r1.pin('1'));
        tb.expect
          .ac({ from: '100', to: '100k', pointsPerDecade: 25 })
          .probe('out')
          .gainAt(f0).toBeWithin(-1e-6, 1e-6)
          .phaseAt(f0).toBeWithin(-1e-6, 1e-6)
          .bandwidth3dB().toBeWithin(1591, 1592)
          .probe('L1.i')
          .gainAt(f0).toBeWithin(20 * Math.log10(1 / Rr) - 1e-6, 20 * Math.log10(1 / Rr) + 1e-6); // I/V = 1/R at f0
      }),
    );
    expect(record.exitCode).toBe(0);
    expect(Math.abs(measured(record.stages.ac!.assertions, 2) - Rr / (2 * Math.PI * L))).toBeLessThan(1e-3);
  });

  it('a diode is linearized at its operating point: gd = (Id + Is)/nVt', () => {
    // 5 V → 10 kΩ → diode; small signal across the diode: gd/(gd + 1/R) divider.
    const record = runLadder(
      bench('diode-ac', (tb: TB) => {
        const v1 = tb.add('V1', new VoltageSource({ dc: 5, ac: 1 }));
        const r1 = tb.add('R1', new Resistor('10k'));
        const d1 = tb.add('D1', new Diode());
        v1.pin('+').connect(r1.pin('1'));
        r1.pin('2').connect(d1.pin('anode'));
        d1.pin('cathode').connect(tb.gnd);
        v1.pin('-').connect(tb.gnd);
        tb.name('a', d1.pin('anode'));
        tb.expect.op('D1.i').toBeAbove(0);
        tb.expect.ac({ from: '1', to: '10' }).probe('a').gainAt('1').toBeBelow(0);
      }),
    );
    expect(record.exitCode).toBe(0);
    const id = record.stages.op!.probes!['D1.i'];
    const gd = (id + 1e-14) / 0.02585 + 1e-12;
    const expected = 20 * Math.log10(1e-4 / (1e-4 + gd));
    expect(Math.abs(measured(record.stages.ac!.assertions, 0) - expected)).toBeLessThan(1e-3);
  });

  it('unity-gain frequency and phase margin of a two-pole loop gain', () => {
    // Transimpedance of a current source into R ∥ C, twice (VCCS between): use a
    // custom gm stage with an AC model so the loop gain is 100/((1+jf/f1)(1+jf/f2)).
    const Gm = defineComponent({
      name: 'Gm',
      pins: ['inp', 'out', 'gnd'],
      params: { gm: { default: 1e-3 } },
      stamp(ctx) {
        // DC model: the same VCCS evaluated on the iterate (linear, converges in one pass).
        ctx.stampCurrentSource('out', 'gnd', -ctx.params.gm * (ctx.voltage('inp') - ctx.voltage('gnd')));
      },
      nonlinear: true,
      ac(ctx) {
        ctx.stampTransconductance('out', 'gnd', 'inp', 'gnd', -ctx.params.gm);
      },
    });
    const record = runLadder(
      bench('loop', (tb: TB) => {
        const vin = tb.add('VIN', new VoltageSource({ dc: 0, ac: 1 }));
        const g1 = tb.add('G1', new Gm({ gm: 1e-2 }));
        const r1 = tb.add('R1', new Resistor('1k'));
        const c1 = tb.add('C1', new Capacitor('1u')); // pole 159 Hz, gain 10
        const g2 = tb.add('G2', new Gm({ gm: 1e-2 }));
        const r2 = tb.add('R2', new Resistor('1k'));
        const c2 = tb.add('C2', new Capacitor('10n')); // pole 15.9 kHz, gain 10
        vin.pin('+').connect(g1.pin('inp'));
        vin.pin('-').connect(tb.gnd);
        g1.pin('gnd').connect(tb.gnd);
        g1.pin('out').connect(r1.pin('1'));
        r1.pin('1').connect(c1.pin('1'));
        r1.pin('2').connect(tb.gnd);
        c1.pin('2').connect(tb.gnd);
        g2.pin('inp').connect(r1.pin('1'));
        g2.pin('gnd').connect(tb.gnd);
        g2.pin('out').connect(r2.pin('1'));
        r2.pin('1').connect(c2.pin('1'));
        r2.pin('2').connect(tb.gnd);
        c2.pin('2').connect(tb.gnd);
        tb.name('out', r2.pin('1'));
        tb.expect.ac({ from: '1', to: '10M' }).probe('out').gainAt('1').toBeWithin(39.9, 40.1).unityGainFrequency().toBeAbove(0).phaseMargin().toBeAbove(0);
      }),
    );
    expect(record.exitCode).toBe(0);
    const [, fuMeasured, pm] = record.stages.ac!.assertions!.map(a => a.measured!);
    // Closed form: |H| = 100/√((1+(f/f1)²)(1+(f/f2)²)) = 1, with f1 = 159.15 Hz, f2 = 15.915 kHz.
    const f1 = 1 / (2 * Math.PI * 1e-3);
    const f2 = 1 / (2 * Math.PI * 1e-5);
    let lo = f1;
    let hi = 1e7;
    for (let k = 0; k < 200; k++) {
      const mid = Math.sqrt(lo * hi);
      const mag = 100 / Math.sqrt((1 + (mid / f1) ** 2) * (1 + (mid / f2) ** 2));
      if (mag > 1) lo = mid;
      else hi = mid;
    }
    const fu = Math.sqrt(lo * hi);
    expect(Math.abs(fuMeasured - fu) / fu).toBeLessThan(1e-6);
    const phase = -(Math.atan(fu / f1) + Math.atan(fu / f2)) * (180 / Math.PI);
    expect(Math.abs(pm - (180 + phase))).toBeLessThan(1e-4);
  });

  it('current-source stimulus: H = V/I is a transimpedance (R at DC)', () => {
    const record = runLadder(
      bench('zin', (tb: TB) => {
        const i1 = tb.add('I1', new CurrentSource({ dc: 0, ac: 1 }));
        const r1 = tb.add('R1', new Resistor('2k'));
        i1.pin('+').connect(r1.pin('1'));
        r1.pin('2').connect(tb.gnd);
        i1.pin('-').connect(tb.gnd);
        tb.name('n', r1.pin('1'));
        tb.expect.ac({ from: '1', to: '100' }).probe('n').gainAt(10).toBeCloseTo(20 * Math.log10(2000), 1e-9);
      }),
    );
    expect(record.exitCode).toBe(0);
  });

  it('missing measurements fail with a note, never with an invented number', () => {
    const record = runLadder(rcLowPass(tb => tb.expect.ac({ from: '10', to: '100' }).probe('out').bandwidth3dB().toBeAbove(1)));
    expect(record.exitCode).toBe(1);
    const a = record.stages.ac!.assertions![0];
    expect(a.measured).toBeUndefined();
    expect(a.note).toMatch(/no upper -3 dB crossing/);
  });

  it('S204 / T003 / T004 diagnostics', () => {
    const NoAc = defineComponent({ name: 'NoAc', pins: ['a', 'b'], stamp: ctx => ctx.stampConductance('a', 'b', 1e-3) });
    const noModel = runLadder(
      rcLowPass(tb => {
        const u = tb.add('U1', new NoAc());
        u.pin('a').connect(tb.gnd);
        tb.expect.ac({ from: '10', to: '100' }).probe('out').gainAt(10).toBeBelow(1);
        // Connect U1's second pin to the output net.
        (tb._components.get('C1')!.pin('1')).connect(u.pin('b'));
      }),
    );
    expect(noModel.exitCode).toBe(2);
    expect(noModel.diagnostics.map(d => d.code)).toEqual(['S204']);
    expect(noModel.diagnostics[0].subject?.components).toEqual(['U1']);

    const noStim = runLadder(
      bench('nostim', (tb: TB) => {
        const v1 = tb.add('V1', new VoltageSource(1));
        const r1 = tb.add('R1', new Resistor(1));
        v1.pin('+').connect(r1.pin('1'));
        r1.pin('2').connect(tb.gnd);
        v1.pin('-').connect(tb.gnd);
        tb.expect.ac({ from: '10', to: '100' }).probe('R1.v').gainAt(10).toBeBelow(1);
      }),
    );
    expect(noStim.exitCode).toBe(3);
    expect(noStim.diagnostics[0].code).toBe('T003');
  });
});
