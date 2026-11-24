import { describe, it, expect } from 'vitest';
import { evaluateScalarCheck, evaluateTranCheck } from '../../src/verify/measure';

// Exponential rise to 5 with tau=1e-3, sampled at 10us for 6ms.
function riseWaveform() {
  const t: number[] = [];
  const y: number[] = [];
  for (let i = 0; i <= 600; i++) {
    const time = i * 1e-5;
    t.push(time);
    y.push(5 * (1 - Math.exp(-time / 1e-3)));
  }
  return { t, y };
}

describe('scalar checks (op)', () => {
  it('within', () => {
    expect(evaluateScalarCheck({ op: 'within', min: 1, max: 2 }, 1.5).pass).toBe(true);
    const fail = evaluateScalarCheck({ op: 'within', min: 1, max: 2 }, 2.5);
    expect(fail.pass).toBe(false);
    expect(fail.outsideBy).toBeCloseTo(0.5);
    expect(fail.ratio).toBeCloseTo(1.25);
  });

  it('closeTo / above / below', () => {
    expect(evaluateScalarCheck({ op: 'closeTo', value: 5, tol: 0.1 }, 5.05).pass).toBe(true);
    expect(evaluateScalarCheck({ op: 'closeTo', value: 5, tol: 0.1 }, 5.2).pass).toBe(false);
    expect(evaluateScalarCheck({ op: 'above', value: 1 }, 2).pass).toBe(true);
    expect(evaluateScalarCheck({ op: 'below', value: 1 }, 2).pass).toBe(false);
  });
});

describe('waveform checks (tran)', () => {
  const wf = riseWaveform();

  it('settleWithin: passes when the curve settles in time', () => {
    // Enters the 5±5% band at t = -tau*ln(0.05) ≈ 3ms
    const ok = evaluateTranCheck({ op: 'settleWithin', target: 5, tol: 0.05, by: 0.004 }, wf, 0.006);
    expect(ok.pass).toBe(true);
    expect(ok.measured).toBeGreaterThan(0.0025);
    expect(ok.measured).toBeLessThan(0.0035);

    const late = evaluateTranCheck({ op: 'settleWithin', target: 5, tol: 0.05, by: 0.002 }, wf, 0.006);
    expect(late.pass).toBe(false);
    expect(late.tFirstViolation).toBeGreaterThan(0.002);
  });

  it('neverExceed: reports max and first crossing', () => {
    expect(evaluateTranCheck({ op: 'neverExceed', value: 5.1 }, wf, 0.006).pass).toBe(true);
    const fail = evaluateTranCheck({ op: 'neverExceed', value: 3 }, wf, 0.006);
    expect(fail.pass).toBe(false);
    expect(fail.measured).toBeCloseTo(5, 1);
    // Crosses 3 at t = -tau*ln(1 - 3/5) ≈ 0.916ms
    expect(fail.tFirstViolation).toBeGreaterThan(0.0008);
    expect(fail.tFirstViolation).toBeLessThan(0.001);
  });

  it('stayAbove with a from-window', () => {
    const ok = evaluateTranCheck({ op: 'stayAbove', value: 4, from: 0.003 }, wf, 0.006);
    expect(ok.pass).toBe(true);
    const fail = evaluateTranCheck({ op: 'stayAbove', value: 4, from: 0.001 }, wf, 0.006);
    expect(fail.pass).toBe(false);
  });

  it('rippleBelow over the tail window', () => {
    const ok = evaluateTranCheck({ op: 'rippleBelow', amplitude: 0.5, from: 0.004 }, wf, 0.006);
    expect(ok.pass).toBe(true);
    const fail = evaluateTranCheck({ op: 'rippleBelow', amplitude: 0.1, from: 0.001 }, wf, 0.006);
    expect(fail.pass).toBe(false);
  });

  it('finalCloseTo', () => {
    expect(evaluateTranCheck({ op: 'finalCloseTo', value: 5, tol: 0.05 }, wf, 0.006).pass).toBe(true);
    expect(evaluateTranCheck({ op: 'finalCloseTo', value: 4, tol: 0.05 }, wf, 0.006).pass).toBe(false);
  });

  it('rejects empty or mismatched waveforms', () => {
    expect(() => evaluateTranCheck({ op: 'neverExceed', value: 1 }, { t: [], y: [] }, 1)).toThrow(/malformed/);
    expect(() =>
      evaluateTranCheck({ op: 'stayAbove', value: 1, from: 2 }, { t: [0, 1], y: [0, 1] }, 1),
    ).toThrow(/no samples/);
  });
});

describe('waveform checks on non-uniform samples (adaptive steps)', () => {
  // A ramp 0 → 10 over [0, 1] sampled at irregular instants.
  const t = [0, 0.05, 0.4, 0.41, 0.9, 1, 2, 5];
  const y = [0, 0.5, 4, 4.1, 9, 10, 10, 10];
  const wf = { t, y };

  it('settle time is the interpolated band entry, not the next sample', () => {
    const r = evaluateTranCheck({ op: 'settleWithin', target: 10, tol: 0.05, by: 4 }, wf, 5);
    expect(r.pass).toBe(true);
    expect(r.measured).toBeCloseTo(0.95, 12); // enters 9.5 at t = 0.95 (between the 0.9 and 1 samples)
  });

  it('neverExceed reports the interpolated crossing time', () => {
    const r = evaluateTranCheck({ op: 'neverExceed', value: 2 }, wf, 5);
    expect(r.pass).toBe(false);
    expect(r.tFirstViolation).toBeCloseTo(0.2, 12);
  });

  it('stayAbove/stayBelow/ripple windows start at the interpolated value at `from`', () => {
    // from = 0.2 falls between samples; the signal there is 2 (not the next sample's 4).
    const above = evaluateTranCheck({ op: 'stayAbove', value: 3, from: 0.2 }, wf, 5);
    expect(above.pass).toBe(false);
    expect(above.measured).toBeCloseTo(2, 12);
    expect(above.tFirstViolation).toBeCloseTo(0.2, 12);
    const ripple = evaluateTranCheck({ op: 'rippleBelow', amplitude: 1, from: 0.95 }, wf, 5);
    expect(ripple.measured).toBeCloseTo(0.5, 12); // 9.5 at 0.95 up to 10
    const below = evaluateTranCheck({ op: 'stayBelow', value: 9, from: 0.2 }, wf, 5);
    expect(below.tFirstViolation).toBeCloseTo(0.9, 12);
  });
});
