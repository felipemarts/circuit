import { describe, it, expect } from 'vitest';
import { bench, Part, OpAmp, Resistor, VoltageSource, runLadder, renderHuman, type BenchDescriptor } from '../../src/forge';
import { inverting, nonInverting, supplies } from './helpers';

const ratings = (b: BenchDescriptor) => {
  const r = runLadder(b);
  return { r, list: r.stages.op?.ratings ?? [] };
};
const failing = (b: BenchDescriptor) => ratings(b).list.filter(x => x.verdict === 'fail').map(x => x.code);

describe('real op-amp / comparator ratings at the operating point (R420–R425)', () => {
  it('a healthy LM358 stage passes every check, reported in stages.op.ratings with citations', () => {
    const { r, list } = ratings(nonInverting(() => Part('LM358'), { vin: 1, r1: 10e3, r2: 10e3, rails: [5, 0] }));
    expect(r.exitCode).toBe(0);
    expect(list.map(x => x.code)).toEqual(['R420', 'R421', 'R422', 'R423', 'R424', 'R424', 'R424', 'R424', 'R425']);
    for (const x of list) {
      expect(x.verdict).toBe('pass');
      expect(x.part).toBe('LM358');
      expect(x.source).toMatch(/SLOS068AB/);
      expect(x.confidence).toBe('verified');
    }
  });

  it('generic OpAmp/IdealOpAmp have no datasheet: no ratings', () => {
    const { list } = ratings(nonInverting(() => new OpAmp(), { vin: 1, r1: 10e3, r2: 10e3 }));
    expect(list).toEqual([]);
  });

  it('R420: LM358 on ±18 V (36 V > 32 V abs max) fails the op stage, exit 1', () => {
    const { r, list } = ratings(inverting(() => Part('LM358'), { vin: 0.1, r1: 10e3, r2: 100e3, rails: [18, -18] }));
    const x = list.find(y => y.code === 'R420')!;
    expect(x.verdict).toBe('fail');
    expect(x.value).toBeCloseTo(36, 6);
    expect(x.limit).toBe(32);
    expect(x.message).toMatch(/LM358.*36V.*32V/);
    expect(x.at).toMatch(/helpers\.ts/);
    expect(r.exitCode).toBe(1);
    expect(r.firstFailure).toBe('R420');
    expect(renderHuman(r)).toMatch(/R420 ratings:/);
  });

  it('R421: an LM393 with 40 V between its inputs (36 V abs max)', () => {
    const b = bench('diff', tb => {
      const u = tb.add('U1', Part('LM393'));
      const va = tb.add('VA', new VoltageSource(20));
      const vb = tb.add('VB', new VoltageSource(-20));
      const rp = tb.add('RP', new Resistor('10k'));
      va.pin('+').connect(u.pin('inp'));
      va.pin('-').connect(tb.gnd);
      vb.pin('+').connect(u.pin('inn'));
      vb.pin('-').connect(tb.gnd);
      supplies(tb, u, 15, -15);
      rp.pin('1').connect(u.pin('out'));
      rp.pin('2').connect(u.pin('v+'));
    });
    expect(failing(b)).toContain('R421');
  });

  it('R422: an LM358 output shorted to ground is at its current limit', () => {
    const b = nonInverting(() => Part('LM358'), { vin: 1, r1: Infinity, r2: 0, rails: [5, 0], rl: 1 });
    expect(failing(b)).toEqual(['R422']);
  });

  it('R423: an LM358 follower with its input above V+ − 1.5 V (common-mode range)', () => {
    const b = nonInverting(() => Part('LM358'), { vin: 4, r1: Infinity, r2: 0, rails: [5, 0] });
    const { list } = ratings(b);
    const x = list.find(y => y.code === 'R423')!;
    expect(x.verdict).toBe('fail');
    expect(x.rating).toBe('inputCommonModeHigh');
    // A rail-to-rail-input part is fine there.
    expect(failing(nonInverting(() => Part('MCP6002'), { vin: 4, r1: Infinity, r2: 0, rails: [5, 0] }))).toEqual([]);
  });

  it('R423 for a comparator only when BOTH inputs are outside the range', () => {
    const cmp = (va: number, vb: number) =>
      bench('cm', tb => {
        const u = tb.add('U1', Part('LM393'));
        const a = tb.add('VA', new VoltageSource(va));
        const b2 = tb.add('VB', new VoltageSource(vb));
        const rp = tb.add('RP', new Resistor('10k'));
        a.pin('+').connect(u.pin('inp'));
        a.pin('-').connect(tb.gnd);
        b2.pin('+').connect(u.pin('inn'));
        b2.pin('-').connect(tb.gnd);
        supplies(tb, u, 5, 0);
        rp.pin('1').connect(u.pin('out'));
        rp.pin('2').connect(u.pin('v+'));
      });
    expect(failing(cmp(4.8, 1))).toEqual([]);
    expect(failing(cmp(4.8, 4.9))).toEqual(['R423']);
  });

  it('R424: an LM358 input pulled 1 V below V− (abs max −0.3 V)', () => {
    const b = inverting(() => Part('LM358'), {
      vin: 0.1, r1: 10e3, r2: 100e3, rails: [5, 0],
      build: (tb, u) => void u,
    });
    const neg = bench('below', tb => {
      const u = tb.add('U1', Part('LM358'));
      const vi = tb.add('VI', new VoltageSource(-1));
      vi.pin('+').connect(u.pin('inp'));
      vi.pin('-').connect(tb.gnd);
      u.pin('inn').connect(u.pin('out'));
      supplies(tb, u, 5, 0);
    });
    expect(failing(b)).toEqual([]);
    expect(failing(neg)).toContain('R424');
  });

  it('R425: an LM741 on ±5 V (recommended minimum 20 V total)', () => {
    const b = inverting(() => Part('LM741'), { vin: 0.1, r1: 10e3, r2: 20e3, rails: [5, -5] });
    expect(failing(b)).toEqual(['R425']);
  });

  it('a verified hint keeps the part inside its ratings', () => {
    const b = bench('hint', tb => {
      const u = tb.add('U1', Part('LM358'));
      const vp = tb.add('VP', new VoltageSource(40));
      const vi = tb.add('VI', new VoltageSource(1));
      vp.pin('+').connect(u.pin('v+'));
      vp.pin('-').connect(tb.gnd);
      u.pin('v-').connect(tb.gnd);
      vi.pin('+').connect(u.pin('inp'));
      vi.pin('-').connect(tb.gnd);
      u.pin('inn').connect(u.pin('out'));
      tb.param('VP', { min: 5, max: 40 });
    });
    const { r, list } = ratings(b);
    const x = list.find(y => y.code === 'R420')!;
    expect(x.verdict).toBe('fail');
    expect(x.hint!.passingRange[1]).toBeLessThanOrEqual(32);
    expect(x.fixes![0].confidence).toBe('verified');
    expect(r.exitCode).toBe(1);
  });
});
