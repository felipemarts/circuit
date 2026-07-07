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
