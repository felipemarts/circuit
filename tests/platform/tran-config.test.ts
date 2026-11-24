import { describe, it, expect } from 'vitest';
import { bench, runLadder, VoltageSource, Resistor, Capacitor } from '../../src/forge';
import type { TB, TranInput } from '../../src/forge';
import { normalizeTran } from '../../src/elab/bench';

const rc = (cfg: TranInput) =>
  bench('rc', (tb: TB) => {
    const v1 = tb.add('V1', new VoltageSource(5));
    const r1 = tb.add('R1', new Resistor('1k'));
    const c1 = tb.add('C1', new Capacitor('1u'));
    v1.pin('+').connect(r1.pin('1'));
    r1.pin('2').connect(c1.pin('1'));
    c1.pin('2').connect(tb.gnd);
    v1.pin('-').connect(tb.gnd);
    tb.name('out', c1.pin('1'));
    // 5·(1 − e^-2) = 4.3233 V at t = 2τ.
    tb.expect.tran(cfg).probe('out').toEndCloseTo(4.3233, 0.01).toSettleWithin({ target: 5, tol: 0.2, by: '2m' });
  });

describe('tb.expect.tran configuration', () => {
  it('dt is the initial step and the ceiling; maxStep overrides the ceiling; defaults without dt', () => {
    expect(normalizeTran({ tstop: '2m', dt: '10u' })).toEqual({ tstop: 2e-3, dt: 1e-5, maxStep: 1e-5, method: 'trap', ic: 'zero' });
    expect(normalizeTran({ tstop: '2m', dt: '1u', maxStep: '100u' }).maxStep).toBe(1e-4);
    expect(normalizeTran({ tstop: '2m' })).toEqual({ tstop: 2e-3, dt: 2e-6, maxStep: 4e-5, method: 'trap', ic: 'zero' });
    expect(() => normalizeTran({ tstop: '1', dt: '1n' })).toThrow(/too many/);
    expect(() => normalizeTran({ tstop: '1m', minStep: '1m', maxStep: '10u' })).toThrow(/minStep/);
    expect(() => normalizeTran({ tstop: '1m', method: 'gear' as never })).toThrow(/'trap' or 'be'/);
  });

  it('trap (default), be, a custom reltol and a dt-less config all meet the analytic value', () => {
    for (const cfg of [
      { tstop: '2m', dt: '10u' },
      { tstop: '2m', dt: '10u', method: 'be' as const },
      { tstop: '2m', dt: '1u', maxStep: '200u', reltol: 1e-5 },
      { tstop: '2m' },
    ]) {
      const record = runLadder(rc(cfg));
      expect(record.exitCode, JSON.stringify(cfg)).toBe(0);
      const run = record.stages.tran!.solver!.runs![0];
      expect(run.method).toBe(cfg.method ?? 'trap');
    }
  });

  it('transient probe keys and telemetry are stable', () => {
    const record = runLadder(rc({ tstop: '2m', dt: '1u', maxStep: '200u' }));
    expect(Object.keys(record.stages.tran!.probes!)).toEqual(['out@tstop=0.002s,dt=0.000001s,maxStep=0.0002s']);
    const s = record.stages.tran!.solver!;
    expect(s.acceptedSteps).toBeGreaterThan(10);
    expect(s.minStep).toBeGreaterThan(0);
  });
});
