import { describe, it, expect } from 'vitest';
import { DigitalCircuit, Not, Buf, And, Stimulus } from '../../src/digital';
import type { DigitalPart, DigitalChange } from '../../src/digital';

/** Stimulus on A → part (a → y) → Y; run to tEnd. */
function run(part: DigitalPart, changes: [string, 0 | 1][], tEnd = '100n') {
  const c = new DigitalCircuit();
  c.add('SA', new Stimulus({ initial: 0, changes }), { y: 'A' });
  c.add('U1', part, { a: 'A', y: 'Y' });
  const sim = c.build();
  sim.advanceTo(tEnd);
  return sim;
}

const ns = (x: number): number => x * 1e-9;
const close = (a: number[], b: number[]) => {
  expect(a.length).toBe(b.length);
  a.forEach((v, i) => expect(v).toBeCloseTo(b[i], 15));
};

describe('propagation delay', () => {
  it('output changes exactly one delay after the input', () => {
    const sim = run(new Not({ delay: '5n' }), [['10n', 1], ['40n', 0]]);
    const y = sim.trace('Y');
    close(y.t, [0, ns(15), ns(45)]);
    expect(y.v).toEqual([1, 0, 1]);
  });

  it('default delay is 1 ns', () => {
    const y = run(new Buf(), [['10n', 1]]).trace('Y');
    close(y.t, [0, ns(11)]);
  });

  it('separate rise / fall delays (tpLH / tpHL)', () => {
    const y = run(new Buf({ delay: { rise: '3n', fall: '7n' } }), [['10n', 1], ['30n', 0]]).trace('Y');
    close(y.t, [0, ns(13), ns(37)]);
    expect(y.v).toEqual([0, 1, 0]);
  });

  it('times land on the integer picosecond grid (no float drift)', () => {
    const y = run(new Buf({ delay: '0.1n' }), [['0.3n', 1]]).trace('Y');
    expect(y.t[1]).toBe(0.4e-9); // 400 ps exactly, not 0.30000000000000004 + 0.1
  });
});

describe('inertial vs transport delay', () => {
  it('inertial (default): a pulse shorter than the delay is swallowed', () => {
    const sim = run(new Buf({ delay: '5n' }), [['10n', 1], ['12n', 0]]);
    expect(sim.trace('Y').v).toEqual([0]);
    expect(sim.stats().glitchesSuppressed).toBe(1);
  });

  it('inertial: a pulse at least as long as the delay passes', () => {
    const y = run(new Buf({ delay: '5n' }), [['10n', 1], ['16n', 0]]).trace('Y');
    close(y.t, [0, ns(15), ns(21)]);
    expect(y.v).toEqual([0, 1, 0]);
  });

  it('transport: every pulse passes, shifted by the delay', () => {
    const y = run(new Buf({ delay: '5n', delayMode: 'transport' }), [['10n', 1], ['12n', 0]]).trace('Y');
    close(y.t, [0, ns(15), ns(17)]);
    expect(y.v).toEqual([0, 1, 0]);
  });
});

describe('delta cycles', () => {
  it('zero-delay chains settle within the same time point', () => {
    const c = new DigitalCircuit();
    c.add('SA', new Stimulus({ changes: [['10n', 1]] }), { y: 'A' });
    c.add('N1', new Not({ delay: 0 }), { a: 'A', y: 'B' });
    c.add('N2', new Not({ delay: 0 }), { a: 'B', y: 'C' });
    c.add('N3', new Not({ delay: 0 }), { a: 'C', y: 'D' });
    const sim = c.build();
    sim.advanceTo('20n');
    expect(sim.trace('D').t).toEqual([0, ns(10)]);
    expect(sim.value('D')).toBe(0);
    expect(sim.stats().maxDelta).toBeGreaterThanOrEqual(3);
  });

  it('a zero-delay static hazard is resolved in deltas: no glitch recorded, no change reported', () => {
    // Y = A AND NOT(A): for one delta both inputs read 1 at the rising edge of A.
    const c = new DigitalCircuit();
    c.add('SA', new Stimulus({ changes: [['10n', 1]] }), { y: 'A' });
    c.add('N1', new Not({ delay: 0 }), { a: 'A', y: 'NA' });
    c.add('G1', new And({ delay: 0 }), { a: 'A', b: 'NA', y: 'Y' });
    const sim = c.build();
    const seen: DigitalChange[] = [];
    sim.onChange(ch => seen.push(ch), { nets: ['Y'] });
    sim.advanceTo('20n');
    expect(sim.trace('Y').v).toEqual([0]);
    expect(seen).toEqual([]);
  });
});
