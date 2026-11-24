import { describe, it, expect } from 'vitest';
import { IdealOpAmp, OpAmp, Part, bench, Resistor, VoltageSource, runLadder } from '../../src/forge';
import { inverting, nonInverting, op, supplies } from './helpers';

// Finite open-loop gain A: noise gain β⁻¹ = 1 + R2/R1, closed loop = G∞ / (1 + β⁻¹/A).
const invGain = (A: number, r1: number, r2: number) => -(r2 / r1) / (1 + (1 + r2 / r1) / A);
const nonInvGain = (A: number, r1: number, r2: number) => (1 + r2 / r1) / (1 + (1 + r2 / r1) / A);
const rel = (a: number, b: number) => Math.abs(a - b) / Math.abs(b);

describe('IdealOpAmp (VCVS)', () => {
  it('inverting gain = −R2/R1 with the finite-gain error, rel. error < 1e-9', () => {
    for (const A of [1e3, 1e6]) {
      const r = op(inverting(() => new IdealOpAmp({ gain: A }), { vin: 0.5, r1: 10e3, r2: 47e3, rails: null }));
      expect(rel(r.v('out'), 0.5 * invGain(A, 10e3, 47e3))).toBeLessThan(1e-9);
      expect(r.dc.telemetry.method).toBe('linear');
    }
  });

  it('non-inverting 1 + R2/R1 and the voltage follower, rel. error < 1e-9', () => {
    const r = op(nonInverting(() => new IdealOpAmp(), { vin: 0.2, r1: 1e3, r2: 9e3, rails: null }));
    expect(rel(r.v('out'), 0.2 * nonInvGain(1e6, 1e3, 9e3))).toBeLessThan(1e-9);
    const f = op(nonInverting(() => new IdealOpAmp(), { vin: 1.234, r1: Infinity, r2: 0, rails: null }));
    expect(rel(f.v('out'), (1.234 * 1e6) / (1 + 1e6))).toBeLessThan(1e-9);
  });

  it('with both supply pins wired the output clamps smoothly to the rails', () => {
    const lin = op(inverting(() => new IdealOpAmp(), { vin: 0.5, r1: 10e3, r2: 100e3, rails: [12, -12] }));
    expect(lin.v('out')).toBeCloseTo(-5, 3);
    const sat = op(inverting(() => new IdealOpAmp(), { vin: 3, r1: 10e3, r2: 100e3, rails: [12, -12] }));
    expect(sat.v('out')).toBeCloseTo(-12, 6);
    const sat2 = op(inverting(() => new IdealOpAmp(), { vin: -3, r1: 10e3, r2: 100e3, rails: [12, 0] }));
    expect(sat2.v('out')).toBeCloseTo(12, 6);
  });

  it('U1.v is the output voltage, U1.i the current it sources', () => {
    const r = op(nonInverting(() => new IdealOpAmp(), { vin: 2, r1: Infinity, r2: 0, rails: null, rl: 1e3 }));
    const u = r.el.components.get('U1') as unknown as { voltage: number; current: number };
    expect(u.voltage).toBeCloseTo(2, 5);
    expect(u.current).toBeCloseTo(2e-3, 8);
  });
});

describe('OpAmp macro model — DC', () => {
  it('inverting and non-inverting gains match the finite-Aol formulas (rel. < 2e-5)', () => {
    // rout = 50 Ω sees a ≥ 10 kΩ feedback load: its effect on the loop gain is < 0.5 %, i.e. < 1e-7 on the result.
    const inv = op(inverting(() => new OpAmp(), { vin: 0.3, r1: 10e3, r2: 100e3 }));
    expect(rel(inv.v('out'), 0.3 * invGain(1e5, 10e3, 100e3))).toBeLessThan(2e-5);
    const non = op(nonInverting(() => new OpAmp({ aol: 2e5 }), { vin: 0.3, r1: 1e3, r2: 9e3 }));
    expect(rel(non.v('out'), 0.3 * nonInvGain(2e5, 1e3, 9e3))).toBeLessThan(2e-5);
    const fol = op(nonInverting(() => new OpAmp(), { vin: -4, r1: Infinity, r2: 0 }));
    expect(rel(fol.v('out'), (-4 * 1e5) / (1 + 1e5))).toBeLessThan(2e-5);
  });

  it('Vos appears at the output multiplied by the noise gain 1 + R2/R1 (±0.5 %)', () => {
    for (const [r1, r2] of [[1e3, 9e3], [1e3, 99e3]]) {
      const r = op(inverting(() => new OpAmp({ vos: 2e-3 }), { vin: 0, r1, r2 }));
      const expected = 2e-3 * nonInvGain(1e5, r1, r2);
      expect(rel(r.v('out'), expected)).toBeLessThan(5e-3);
    }
  });

  it('input bias current Ib shows up as Ib·R2 at the output of an inverting stage (±1 %)', () => {
    const r = op(inverting(() => new OpAmp({ ib: 100e-9 }), { vin: 0, r1: 100e3, r2: 1e6 }));
    // Ib flows into inn, drawn through R2 from the output: Vout = +Ib·R2 (noise-gain error negligible).
    expect(rel(r.v('out'), 100e-9 * 1e6)).toBeLessThan(1e-2);
  });

  it('LM358 clips at its data output swing on a 5 V supply (VOH ≈ V+ − 1.5 V at 2 kΩ, VOL ≈ 5 mV)', () => {
    // Data: VOH ≥ V+ − 1.5 V at RL = 2 kΩ, VS = 5 V; VOL 5 mV typ (RL 10 kΩ).
    const hi = op(nonInverting(() => Part('LM358'), { vin: 2.5, r1: 1e6, r2: 1e6, rails: [5, 0], rl: 2e3 }));
    expect(hi.v('out')).toBeGreaterThan(3.48);
    expect(hi.v('out')).toBeLessThan(3.52);
    const lo = op(inverting(() => Part('LM358'), { vin: 1, r1: 10e3, r2: 100e3, rails: [5, 0], build: tb => void tb }));
    expect(lo.v('out')).toBeGreaterThan(0);
    expect(lo.v('out')).toBeLessThan(0.02);
  });

  it('LM741 output swing is load-dependent as in the data (±14 V at 10 kΩ, ±13 V at 2 kΩ, ±0.05 V)', () => {
    for (const [rl, swing] of [[10e3, 14], [2e3, 13]] as const) {
      const r = op(nonInverting(() => Part('LM741'), { vin: 5, r1: 1e6, r2: 9e6, rl }));
      expect(r.v('out')).toBeCloseTo(swing, 1);
      const n = op(nonInverting(() => Part('LM741'), { vin: -5, r1: 1e6, r2: 9e6, rl }));
      expect(n.v('out')).toBeCloseTo(-swing, 1);
    }
  });

  it('short-circuit current limit: LM358 sources 30 mA into a short, sinks 20 mA (data typ, ±2 %)', () => {
    const shorted = (vin: number, to: 'gnd' | 'vcc') =>
      bench('short', tb => {
        const u = tb.add('U1', Part('LM358'));
        const vi = tb.add('VI', new VoltageSource(vin));
        // Sourcing: inp above inn drives the output high; sinking: the other way round.
        vi.pin('+').connect(u.pin(to === 'gnd' ? 'inp' : 'inn'));
        vi.pin('-').connect(tb.gnd);
        const rf = tb.add('RF', new Resistor('10k'));
        rf.pin('1').connect(u.pin(to === 'gnd' ? 'inn' : 'inp'));
        rf.pin('2').connect(tb.gnd);
        supplies(tb, u, 15, 0);
        if (to === 'gnd') u.pin('out').connect(tb.gnd);
        else u.pin('out').connect(u.pin('v+'));
        tb.expect.op('U1.i').toBeWithin(-1, 1);
      });
    const src = runLadder(shorted(1, 'gnd'));
    const iSrc = src.stages.op!.assertions![0].measured!;
    expect(rel(iSrc, 0.03)).toBeLessThan(0.02);
    const snk = runLadder(shorted(1, 'vcc'));
    expect(rel(snk.stages.op!.assertions![0].measured!, -0.02)).toBeLessThan(0.02);
    // R422: the output is at its short-circuit current limit.
    expect(src.stages.op!.ratings!.find(r => r.code === 'R422')!.verdict).toBe('fail');
  });

  it('every real op-amp part converges in and out of saturation and is deterministic', () => {
    for (const id of ['LM358', 'LM741', 'TL072', 'MCP6002', 'NE5532']) {
      const rails: [number, number] = id === 'LM358' || id === 'MCP6002' ? [5, 0] : [15, -15];
      for (const vin of [0.1, 0.4, 3, -3]) {
        const make = () => inverting(() => Part(id), { vin: rails[1] === 0 ? -Math.abs(vin) : vin, r1: 10e3, r2: 100e3, rails });
        const a = op(make());
        const b = op(make());
        expect(a.dc.telemetry.aids ?? []).toEqual([]);
        expect(a.v('out')).toBe(b.v('out'));
        expect(a.v('out')).toBeLessThanOrEqual(rails[0]);
        expect(a.v('out')).toBeGreaterThanOrEqual(rails[1]);
      }
    }
  });

  it('draws its quiescent current from the supply (LM358: 350 µA per channel at 5 V, ±1 %)', () => {
    const r = op(nonInverting(() => Part('LM358'), { vin: 1, r1: Infinity, r2: 0, rails: [5, 0] }));
    const vp = r.el.components.get('VP') as unknown as { current: number };
    expect(rel(-vp.current, 350e-6)).toBeLessThan(1e-2);
  });
});
