import { describe, it, expect } from 'vitest';
import {
  DigitalCircuit,
  Clock,
  valueAt,
  edgeCount,
  edgeTimes,
  frequency,
  period,
  dutyCycle,
  firstTime,
  checkValueAt,
  checkStable,
} from '../../src/digital';
import type { NetTrace } from '../../src/digital';

function clockTrace(opts: ConstructorParameters<typeof Clock>[0], tEnd: string): NetTrace {
  const c = new DigitalCircuit();
  c.add('CLK', new Clock(opts), { y: 'clk' });
  return c.build().advanceTo(tEnd).trace('clk');
}

describe('clock generator + frequency / duty measurement', () => {
  it('1 MHz, 25 % duty, first edge at 0.5 us', () => {
    const tr = clockTrace({ freq: '1M', duty: 0.25, start: '0.5u' }, '10u');
    expect(frequency(tr)).toBeCloseTo(1e6, 6);
    expect(period(tr)).toBeCloseTo(1e-6, 15);
    expect(dutyCycle(tr)).toBeCloseTo(0.25, 12);
    expect(edgeCount(tr, 'rising')).toBe(10); // 0.5u, 1.5u, …, 9.5u
    expect(edgeCount(tr, 'falling')).toBe(10); // 0.75u … 9.75u
    expect(edgeCount(tr, 'both', { from: '2u', to: '4u' })).toBe(4);
    expect(valueAt(tr, '0.4u')).toBe(0);
    expect(valueAt(tr, '0.5u')).toBe(1); // right-continuous at the edge
    expect(valueAt(tr, '0.8u')).toBe(0);
    expect(firstTime(tr, 1)).toBeCloseTo(0.5e-6, 15);
  });

  it('no drift: an awkward period stays on the ideal grid after thousands of cycles', () => {
    const tr = clockTrace({ freq: '3M' }, '1m'); // period 333.333… ns
    const rises = edgeTimes(tr, 'rising');
    // The edge at t = 0 is the power-on state (clock starts high), so edge n sits at rises[n - 1].
    expect(tr.v[0]).toBe(1);
    expect(rises.length).toBe(3000);
    for (const n of [1, 1000, 3000]) expect(Math.abs(rises[n - 1] - n / 3e6)).toBeLessThanOrEqual(0.5e-12);
    expect(Math.abs(frequency(tr)! - 3e6) / 3e6).toBeLessThan(1e-9);
    expect(dutyCycle(tr)).toBeCloseTo(0.5, 8); // each phase is rounded to the 1 ps grid
  });

  it('stop ends the clock; validation rejects bad configs', () => {
    const tr = clockTrace({ period: '10n', stop: '35n' }, '100n');
    expect(edgeCount(tr, 'rising')).toBe(3); // 10, 20, 30 (t = 0 is the power-on state)
    expect(valueAt(tr, '100n')).toBe(0);
    expect(() => new Clock({ freq: '1M', period: '1u' })).toThrow(/exactly one/);
    expect(() => new Clock({ freq: '1M', duty: 1 })).toThrow(/duty/);
    expect(() => new Clock({ freq: 0 })).toThrow(/> 0/);
  });
});

describe('measurements on hand-made traces', () => {
  const tr: NetTrace = { net: 'Q', t: [0, 1e-6, 2e-6, 3e-6, 5e-6], v: [0, 1, 'X', 1, 0] };

  it('valueAt / firstTime', () => {
    expect(valueAt(tr, 0)).toBe(0);
    expect(valueAt(tr, '1.5u')).toBe(1);
    expect(valueAt(tr, '2u')).toBe('X');
    expect(valueAt(tr, 1)).toBe(0);
    expect(firstTime(tr, 'X')).toBeCloseTo(2e-6, 15);
    expect(firstTime(tr, 1, { from: '1.5u' })).toBeCloseTo(1.5e-6, 15); // already 1 at from
    expect(firstTime(tr, 1, { from: '2u' })).toBeCloseTo(3e-6, 15);
    expect(firstTime(tr, 'Z')).toBeUndefined();
  });

  it('edges through X are not counted', () => {
    expect(edgeCount(tr, 'rising')).toBe(1); // 0→1 at 1u; X→1 at 3u is not an edge
    expect(edgeCount(tr, 'falling')).toBe(1); // 1→0 at 5u
    expect(frequency(tr)).toBeUndefined(); // < 2 rising edges
    expect(dutyCycle(tr)).toBeUndefined();
  });

  it('verdict-shaped checks are plain data', () => {
    expect(checkValueAt(tr, 1, '1.2u')).toEqual({ pass: true, measured: 1, expected: 1, t: 1.2e-6 });
    expect(checkValueAt(tr, 1, '2.5u')).toEqual({ pass: false, measured: 'X', expected: 1, t: 2.5e-6 });
    const stable = checkStable(tr, 1, { from: '1u', to: '4u' });
    expect(stable.pass).toBe(false);
    expect(stable.measured).toBe('X');
    expect(stable.t).toBeCloseTo(2e-6, 15);
    expect(checkStable(tr, 1, { from: '3u', to: '4.9u' }).pass).toBe(true);
    expect(JSON.parse(JSON.stringify(stable))).toEqual(stable);
  });
});
