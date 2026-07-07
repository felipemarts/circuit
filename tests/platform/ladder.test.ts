import { describe, it, expect } from 'vitest';
import {
  bench,
  runLadder,
  VoltageSource,
  Resistor,
  Capacitor,
  LED,
} from '../../src/forge';
import type { TB, BenchDescriptor } from '../../src/forge';

function ledDriver(r: number | string): BenchDescriptor {
  return bench('led-driver', (tb: TB) => {
    const v1 = tb.add('V1', new VoltageSource(5));
    const r1 = tb.add('R1', new Resistor(r));
    const d1 = tb.add('D1', new LED());
    v1.pin('+').connect(r1.pin('1'));
    r1.pin('2').connect(d1.pin('anode'));
    d1.pin('cathode').connect(tb.gnd);
    v1.pin('-').connect(tb.gnd);
    tb.param('R1', { min: '100', max: '10k', scale: 'log' });
    tb.expect.op('D1.i').toBeWithin('8m', '12m');
  });
}

describe('runLadder — the verification loop', () => {
  it('exit 0: passing circuit runs lint → op and reports probes', () => {
    const record = runLadder(ledDriver(280));
    expect(record.verdict).toBe('pass');
    expect(record.exitCode).toBe(0);
    expect(record.stages.lint?.verdict).toBe('pass');
    expect(record.stages.op?.verdict).toBe('pass');
    expect(record.stages.op?.probes?.['D1.i']).toBeGreaterThan(0.008);
    expect(record.stages.op?.solver?.method).toBe('newton-raphson');
  });

  it('exit 1: assertion failure carries measured value, margin and a VERIFIED hint', () => {
    const record = runLadder(ledDriver(100));
    expect(record.verdict).toBe('fail');
    expect(record.exitCode).toBe(1);
    expect(record.firstFailure).toBe('a1');

    const a1 = record.stages.op!.assertions![0];
    expect(a1.verdict).toBe('fail');
    expect(a1.measured!).toBeGreaterThan(0.012);
    expect(a1.margin!.outsideBy).toBeGreaterThan(0);

    const hint = a1.hint!;
    expect(hint.kind).toBe('verified-param-range');
    expect(hint.param).toBe('R1');
    expect(hint.passingRange[0]).toBeGreaterThan(100);
    expect(hint.passingRange[1]).toBeLessThan(10000);

    // The trust contract: applying the verified hint MUST turn the run green.
    const fixed = runLadder(ledDriver(100), { overrides: { R1: hint.suggestedValue } });
    expect(fixed.verdict).toBe('pass');
    expect(fixed.exitCode).toBe(0);
  });

  it('exit 2: lint errors gate op/tran (skipped, never run)', () => {
    const desc = bench('floating', (tb) => {
      const v1 = tb.add('V1', new VoltageSource(5));
      const r1 = tb.add('R1', new Resistor(1000));
      const c1 = tb.add('C1', new Capacitor(1e-7));
      const r2 = tb.add('R2', new Resistor(1000));
      v1.pin('+').connect(r1.pin('1'));
      r1.pin('2').connect(tb.gnd);
      v1.pin('-').connect(tb.gnd);
      v1.pin('+').connect(c1.pin('1'));
      c1.pin('2').connect(r2.pin('1'));
      tb.expect.op('R1.i').toBeAbove(0);
      tb.expect.tran({ tstop: '1m', dt: '10u' }).probe('R1.i').toNeverExceed(1);
    });
    const record = runLadder(desc);
    expect(record.exitCode).toBe(2);
    expect(record.verdict).toBe('error');
    expect(record.firstFailure).toBe('F101');
    expect(record.stages.op?.verdict).toBe('skipped');
    expect(record.stages.tran?.verdict).toBe('skipped');
  });

  it('exit 2: F105 catches the LED-without-resistor classic before the solver', () => {
    const desc = bench('led-direct', (tb) => {
      const v1 = tb.add('V1', new VoltageSource(5));
      const d1 = tb.add('D1', new LED());
      v1.pin('+').connect(d1.pin('anode'));
      d1.pin('cathode').connect(tb.gnd);
      v1.pin('-').connect(tb.gnd);
      tb.expect.op('D1.i').toBeWithin('5m', '15m');
    });
    const record = runLadder(desc);
    expect(record.exitCode).toBe(2);
    expect(record.diagnostics.some(d => d.code === 'F105')).toBe(true);
  });

  it('exit 3: a throwing bench maps to T001, never a crash', () => {
    const desc = bench('boom', () => {
      throw new Error('kaboom');
    });
    const record = runLadder(desc);
    expect(record.exitCode).toBe(3);
    expect(record.verdict).toBe('error');
    expect(record.diagnostics[0].code).toBe('T001');
    expect(record.diagnostics[0].message).toContain('kaboom');
  });

  it('tran assertions: RC step response passes, and failures carry violation evidence', () => {
    const rc = (limit: string) =>
      bench('rc', (tb: TB) => {
        const v1 = tb.add('V1', new VoltageSource(5));
        const r1 = tb.add('R1', new Resistor('1k'));
        const c1 = tb.add('C1', new Capacitor('1u'));
        v1.pin('+').connect(r1.pin('1'));
        r1.pin('2').connect(c1.pin('1'));
        c1.pin('2').connect(tb.gnd);
        v1.pin('-').connect(tb.gnd);
        tb.expect
          .tran({ tstop: '6m', dt: '10u' })
          .probe('C1.v')
          .toSettleWithin({ target: 5, tol: 0.05, by: '4m' })
          .toNeverExceed(limit);
      });

    const pass = runLadder(rc('5.5'));
    expect(pass.exitCode).toBe(0);
    expect(pass.stages.tran?.verdict).toBe('pass');

    const fail = runLadder(rc('3'));
    expect(fail.exitCode).toBe(1);
    const violation = fail.stages.tran!.assertions!.find(a => a.verdict === 'fail')!;
    expect(violation.tFirstViolation).toBeGreaterThan(0.0008);
    expect(violation.tFirstViolation).toBeLessThan(0.0011);
    expect(violation.excerpt!.length).toBeGreaterThan(3);
  });

  it('determinism: two identical runs produce identical records', () => {
    const a = runLadder(ledDriver(100));
    const b = runLadder(ledDriver(100));
    expect(a).toEqual(b);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('stage filtering: --stage lint runs lint only', () => {
    const record = runLadder(ledDriver(280), { stages: ['lint'] });
    expect(record.stages.lint?.verdict).toBe('pass');
    expect(record.stages.op).toBeUndefined();
    expect(record.exitCode).toBe(0);
  });
});
