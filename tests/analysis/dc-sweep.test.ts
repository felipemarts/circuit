import { describe, it, expect } from 'vitest';
import { bench, elaborate, runLadder, runSweep, VoltageSource, Resistor, Diode } from '../../src/forge';
import type { TB } from '../../src/forge';
import { evaluateDcCheck } from '../../src/verify/measure';

const divider = (extra: (tb: TB) => void = () => {}) =>
  bench('divider', (tb: TB) => {
    const v1 = tb.add('V1', new VoltageSource(5));
    const r1 = tb.add('R1', new Resistor('1k'));
    const r2 = tb.add('R2', new Resistor('3k'));
    v1.pin('+').connect(r1.pin('1'));
    r1.pin('2').connect(r2.pin('1'));
    r2.pin('2').connect(tb.gnd);
    v1.pin('-').connect(tb.gnd);
    tb.name('out', r2.pin('1'));
    extra(tb);
  });

/** Diode current of V → R → D solved from V = I·R + nVt·ln(1 + I/Is) by bisection. */
function shockley(V: number, R: number, Is: number, nVt: number): number {
  if (V <= 0) return 0;
  let lo = 0;
  let hi = V / R;
  for (let k = 0; k < 200; k++) {
    const mid = (lo + hi) / 2;
    const f = mid * R + nVt * Math.log1p(mid / Is) - V;
    if (f > 0) hi = mid;
    else lo = mid;
  }
  return (lo + hi) / 2;
}

describe('DC sweep', () => {
  it('divider: out = 0.75·V1 exactly at every point (1e-12)', () => {
    const elab = elaborate(divider());
    const out = runSweep(elab, { source: 'V1', from: -2, to: 8, points: 11 }, ['out', 'R1.i']);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.curve.x).toEqual([-2, -1, 0, 1, 2, 3, 4, 5, 6, 7, 8]);
    out.curve.x.forEach((x, k) => {
      expect(Math.abs(out.curve.values.out[k] - 0.75 * x)).toBeLessThan(1e-12);
      expect(Math.abs(out.curve.values['R1.i'][k] - x / 4000)).toBeLessThan(1e-15);
    });
    expect(out.curve.linear).toBe(true);
  });

  it('curve assertions through the ladder: at / slopeAt / monotonic / toCross().between()', () => {
    const pass = runLadder(
      divider(tb => {
        tb.expect
          .dc({ source: 'V1', from: 0, to: 10, step: 0.5 })
          .probe('out')
          .at(2.25).toBeCloseTo(1.6875, 1e-9) // between swept points: linear interpolation
          .slopeAt('4').toBeWithin(0.7499, 0.7501)
          .toBeMonotonic('increasing')
          .toCross(3).between(3.99, 4.01);
      }),
    );
    expect(pass.exitCode).toBe(0);
    expect(pass.stages.dc?.verdict).toBe('pass');
    expect(pass.stages.dc?.solver).toEqual({ method: 'linear', iterations: 21, points: 21 });
    const cross = pass.stages.dc!.assertions!.find(a => a.check.op === 'crosses')!;
    expect(cross.measured).toBeCloseTo(4, 12);

    const fail = runLadder(
      divider(tb => {
        tb.expect.dc({ source: 'V1', from: 0, to: 10, points: 11 }).probe('out').toBeMonotonic('decreasing').toCross(20);
      }),
    );
    expect(fail.exitCode).toBe(1);
    const [mono, never] = fail.stages.dc!.assertions!;
    expect(mono.verdict).toBe('fail');
    expect(mono.xFirstViolation).toBe(1);
    expect(never.verdict).toBe('fail');
    expect(never.measured).toBeUndefined();
    expect(never.note).toMatch(/never crosses 20/);
  });

  it('a component value can be swept ({ param })', () => {
    const elab = elaborate(divider());
    const out = runSweep(elab, { param: 'R2', from: 1000, to: 9000, points: 5 }, ['out']);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    out.curve.x.forEach((r2, k) => expect(out.curve.values.out[k]).toBeCloseTo((5 * r2) / (1000 + r2), 12));
  });

  it('diode sweep matches the implicit Shockley solution (rel 1e-6 + 1e-11 A)', () => {
    const R = 1000;
    const Is = 1e-14;
    const nVt = 0.02585;
    const desc = bench('diode-sweep', (tb: TB) => {
      const v1 = tb.add('V1', new VoltageSource(0));
      const r1 = tb.add('R1', new Resistor(R));
      const d1 = tb.add('D1', new Diode({ Is, n: 1, Vt: nVt }));
      v1.pin('+').connect(r1.pin('1'));
      r1.pin('2').connect(d1.pin('anode'));
      d1.pin('cathode').connect(tb.gnd);
      v1.pin('-').connect(tb.gnd);
    });
    const out = runSweep(elaborate(desc), { source: 'V1', from: 0, to: 5, points: 51 }, ['D1.i', 'D1.v']);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    out.curve.x.forEach((v, k) => {
      const exact = shockley(v, R, Is, nVt);
      expect(Math.abs(out.curve.values['D1.i'][k] - exact)).toBeLessThan(1e-6 * exact + 1e-11);
    });
    // The knee: the diode voltage stays below ~0.75 V across the sweep.
    expect(Math.max(...out.curve.values['D1.v'])).toBeLessThan(0.75);
  });

  it('sweep config validation: exactly one of source/param, step must divide the range', () => {
    expect(() => elaborate(divider(tb => tb.expect.dc({ from: 0, to: 1 }).probe('out').toBeMonotonic()))).toThrow(/exactly one/);
    expect(() =>
      elaborate(divider(tb => tb.expect.dc({ source: 'V1', from: 0, to: 1, step: 0.3 }).probe('out').toBeMonotonic())),
    ).toThrow(/does not divide/);
    expect(() => elaborate(divider(tb => tb.expect.dc({ source: 'R1', from: 0, to: 1 }).probe('out').toBeMonotonic()))).toThrow(
      /use \{ param: 'R1' \}/,
    );
    expect(() => elaborate(divider(tb => tb.expect.dc({ source: 'V1', from: 0, to: 1 }).probe('out').at(2)))).toThrow(/outside the sweep/);
  });

  it('measurement kernel: curves swept downward are handled (x sorted internally)', () => {
    const xs = [5, 4, 3, 2, 1, 0];
    const ys = xs.map(x => 2 * x);
    expect(evaluateDcCheck({ op: 'monotonic', direction: 'increasing' }, xs, ys).pass).toBe(true);
    expect(evaluateDcCheck({ op: 'at', x: 2.5, check: { op: 'closeTo', value: 5, tol: 1e-12 } }, xs, ys).pass).toBe(true);
    expect(evaluateDcCheck({ op: 'crosses', level: 3 }, xs, ys).measured).toBeCloseTo(1.5, 12);
  });
});
