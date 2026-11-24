import { describe, it, expect } from 'vitest';
import { bench, IdealOpAmp, OpAmp, Resistor, VoltageSource, runLadder, opampPartParams, type BenchDescriptor } from '../../src/forge';
import { nonInverting, inverting, supplies } from './helpers';

const measured = (desc: BenchDescriptor) => {
  const r = runLadder(desc);
  expect(r.diagnostics.filter(d => d.severity === 'error')).toEqual([]);
  return r.stages.ac!.assertions!.map(a => a.measured!);
};

/** Open-loop: AC stimulus on inp, inn grounded, output loaded by 10 kΩ. */
function openLoop(params: object, dcIn = 0): BenchDescriptor {
  return bench('open-loop', tb => {
    const u = tb.add('U1', new OpAmp(params));
    const vi = tb.add('VI', new VoltageSource({ dc: dcIn, ac: 1 }));
    const rl = tb.add('RL', new Resistor('10k'));
    vi.pin('+').connect(u.pin('inp'));
    vi.pin('-').connect(tb.gnd);
    u.pin('inn').connect(tb.gnd);
    rl.pin('1').connect(u.pin('out'));
    rl.pin('2').connect(tb.gnd);
    supplies(tb, u, 15, -15);
    tb.name('out', u.pin('out'));
    tb.expect
      .ac({ from: '0.1', to: '100M', pointsPerDecade: 20 })
      .probe('out')
      .gainAt('0.1').toBeWithin(-400, 400)
      .unityGainFrequency().toBeWithin(0, 1e12)
      .phaseMargin().toBeWithin(-360, 360);
  });
}

describe('OpAmp macro model — AC small signal', () => {
  it('non-inverting stage: closed-loop −3 dB bandwidth = GBW/(1 + R2/R1) (±2 %)', () => {
    for (const [gbw, r2] of [[1e6, 9e3], [1e6, 99e3], [5e6, 9e3]]) {
      const [g, bw] = measured(
        nonInverting(() => new OpAmp({ gbw }), {
          vin: { dc: 0, ac: 1 },
          r1: 1e3,
          r2,
          build: tb => void tb.expect.ac({ from: '10', to: '100M', pointsPerDecade: 20 }).probe('out').gainAt('10').toBeWithin(-100, 100).bandwidth3dB().toBeWithin(0, 1e12),
        }),
      );
      const noiseGain = 1 + r2 / 1e3;
      expect(Math.abs(g - 20 * Math.log10(noiseGain))).toBeLessThan(0.01);
      expect(Math.abs(bw / (gbw / noiseGain) - 1)).toBeLessThan(0.02);
    }
  });

  it('open loop (single pole): DC gain = Aol, unity-gain frequency = GBW (±2 %), phase margin 90° (±1°)', () => {
    const [g, fu, pm] = measured(openLoop({ aol: 2e5, gbw: 3e6 }));
    expect(Math.abs(g - 20 * Math.log10(2e5 * (10e3 / (10e3 + 50))))).toBeLessThan(0.05);
    expect(Math.abs(fu / 3e6 - 1)).toBeLessThan(0.02);
    expect(Math.abs(pm - 90)).toBeLessThan(1);
  });

  it('TL072 (second pole from the 56° phase margin in the data): fu = GBW/√(1+r²), PM = 56° ± 1°', () => {
    const p = { ...opampPartParams('TL072'), vos: 0, ib: 0, ios: 0 };
    const [, fu, pm] = measured(openLoop(p));
    const r = Math.tan((34 * Math.PI) / 180);
    expect(Math.abs(fu / (5.25e6 / Math.sqrt(1 + r * r)) - 1)).toBeLessThan(0.02);
    expect(Math.abs(pm - 56)).toBeLessThan(1);
  });

  it('a saturated output has (almost) no small-signal gain', () => {
    // 1 V DC on an open-loop input drives the output into the +rail clamp.
    const [g] = measured(openLoop({ aol: 1e5 }, 1));
    expect(g).toBeLessThan(-20); // vs +100 dB in the linear region
  });

  it('IdealOpAmp is frequency-independent: inverting gain −R2/R1 at 1 Hz and 100 MHz', () => {
    const [a, b] = measured(
      inverting(() => new IdealOpAmp(), {
        vin: { dc: 0, ac: 1 },
        r1: 1e3,
        r2: 10e3,
        rails: null,
        build: tb => void tb.expect.ac({ from: '1', to: '100M', pointsPerDecade: 5 }).probe('out').gainAt('1').toBeWithin(-100, 100).gainAt('100M').toBeWithin(-100, 100),
      }),
    );
    expect(a).toBeCloseTo(20, 3);
    expect(b).toBeCloseTo(20, 3);
  });
});
