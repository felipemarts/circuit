import { describe, it, expect } from 'vitest';
import {
  bench,
  elaborate,
  runLadder,
  runLint,
  defineComponent,
  VoltageSource,
  Resistor,
  Capacitor,
  Inductor,
  LED,
  Diode,
} from '../../src/forge';
import type { TB } from '../../src/forge';

/** Regression tests for the confirmed findings of the adversarial review. */
describe('review regressions', () => {
  it('tb.name rejects reserved auto-net names (n1, n2, ...) — netlist corruption guard', () => {
    const desc = bench('collision', (tb: TB) => {
      const v1 = tb.add('V1', new VoltageSource(5));
      const r1 = tb.add('R1', new Resistor(100));
      v1.pin('+').connect(r1.pin('1'));
      r1.pin('2').connect(tb.gnd);
      v1.pin('-').connect(tb.gnd);
      tb.name('n1', v1.pin('+'));
    });
    expect(() => elaborate(desc)).toThrow(/reserved/);
  });

  it('components wired into the circuit but never tb.add()ed are an elaboration error', () => {
    const desc = bench('ghost', (tb: TB) => {
      const v1 = tb.add('V1', new VoltageSource(5));
      const r1 = tb.add('R1', new Resistor(100));
      const ghost = new Resistor(1000); // never registered
      v1.pin('+').connect(r1.pin('1'));
      r1.pin('2').connect(tb.gnd);
      v1.pin('-').connect(tb.gnd);
      v1.pin('+').connect(ghost.pin('1'));
      ghost.pin('2').connect(tb.gnd);
    });
    expect(() => elaborate(desc)).toThrow(/never registered/);
    // And the ladder maps it to T001 / exit 3, never a fabricated result.
    expect(runLadder(desc).exitCode).toBe(3);
  });

  it('registering the same instance under two ids throws', () => {
    const desc = bench('twice', (tb: TB) => {
      const r = new Resistor(100);
      tb.add('R1', r);
      tb.add('R2', r);
    });
    expect(() => elaborate(desc)).toThrow(/already registered/);
  });

  it('--stage op cannot bypass the lint gate (silently dropped components)', () => {
    const desc = bench('island-op-only', (tb: TB) => {
      const v1 = tb.add('V1', new VoltageSource(5));
      const r1 = tb.add('R1', new Resistor(100));
      v1.pin('+').connect(r1.pin('1'));
      r1.pin('2').connect(tb.gnd);
      v1.pin('-').connect(tb.gnd);
      const r2 = tb.add('R2', new Resistor(100));
      const r3 = tb.add('R3', new Resistor(100));
      r2.pin('1').connect(r3.pin('1'));
      r2.pin('2').connect(r3.pin('2'));
      tb.expect.op('R1.i').toBeAbove(0);
    });
    const record = runLadder(desc, { stages: ['op'] });
    expect(record.exitCode).toBe(2);
    expect(record.stages.lint?.verdict).toBe('error');
    expect(record.stages.op?.verdict).toBe('skipped');
  });

  it('probes on quantities a component does not expose fail at elaboration, not with a silent 0', () => {
    const Box = defineComponent({
      name: 'Box',
      pins: ['a', 'b'],
      params: { g: { default: 0.001, unit: 'S' } },
      stamp(ctx) {
        ctx.stampConductance('a', 'b', ctx.params.g);
      },
    });
    const desc = bench('custom-current', (tb: TB) => {
      const v1 = tb.add('V1', new VoltageSource(5));
      const u1 = tb.add('U1', new Box());
      v1.pin('+').connect(u1.pin('a'));
      u1.pin('b').connect(tb.gnd);
      v1.pin('-').connect(tb.gnd);
      tb.expect.tran({ tstop: '1m', dt: '10u' }).probe('U1.i').toNeverExceed('1'); // U1 has no current
    });
    expect(() => elaborate(desc)).toThrow(/does not expose current/);
  });

  it('custom component params land in the netlist hash', () => {
    const Box = defineComponent({
      name: 'Box2',
      pins: ['a', 'b'],
      params: { g: { default: 0.001, unit: 'S' } },
      stamp(ctx) {
        ctx.stampConductance('a', 'b', ctx.params.g);
      },
    });
    const make = (g: number) =>
      bench('c', (tb: TB) => {
        const v1 = tb.add('V1', new VoltageSource(5));
        const u1 = tb.add('U1', new Box({ g }));
        v1.pin('+').connect(u1.pin('a'));
        u1.pin('b').connect(tb.gnd);
        v1.pin('-').connect(tb.gnd);
      });
    expect(elaborate(make(0.001)).netlist.hash).not.toBe(elaborate(make(0.002)).netlist.hash);
  });

  it('F105 does not fire on a low-voltage diode across a source that converges fine', () => {
    const desc = bench('lowv', (tb: TB) => {
      const v1 = tb.add('V1', new VoltageSource(0.6));
      const d1 = tb.add('D1', new Diode());
      v1.pin('+').connect(d1.pin('anode'));
      d1.pin('cathode').connect(tb.gnd);
      v1.pin('-').connect(tb.gnd);
      tb.expect.op('D1.i').toBeBelow('100m');
    });
    const record = runLadder(desc);
    expect(record.diagnostics.some(d => d.code === 'F105')).toBe(false);
    expect(record.exitCode).toBe(0);
  });

  it('F105 catches a forward clamp built from a series source chain', () => {
    const diags = runLint(
      elaborate(
        bench('chain', (tb: TB) => {
          const v1 = tb.add('V1', new VoltageSource(3));
          const v2 = tb.add('V2', new VoltageSource(2));
          const d1 = tb.add('D1', new LED());
          v1.pin('-').connect(tb.gnd);
          v1.pin('+').connect(v2.pin('-'));
          v2.pin('+').connect(d1.pin('anode'));
          d1.pin('cathode').connect(tb.gnd);
        }),
      ),
    );
    expect(diags.some(d => d.code === 'F105')).toBe(true);
  });

  it('inductor across a source stays F104, not F105', () => {
    const diags = runLint(
      elaborate(
        bench('l-src', (tb: TB) => {
          const v1 = tb.add('V1', new VoltageSource(5));
          const l1 = tb.add('L1', new Inductor(0.01));
          v1.pin('+').connect(l1.pin('1'));
          v1.pin('-').connect(l1.pin('2'));
          v1.pin('-').connect(tb.gnd);
        }),
      ),
    );
    expect(diags.some(d => d.code === 'F104')).toBe(true);
  });

  it('settleWithin that never settles reports a finite measured value (JSON-safe)', () => {
    // L/R rise with tau = 100ms barely moves within 1ms — never settles to 5.
    const desc = bench('never-settles', (tb: TB) => {
      const v1 = tb.add('V1', new VoltageSource(5));
      const r1 = tb.add('R1', new Resistor(10));
      const c1 = tb.add('C1', new Capacitor('100u')); // tau = 1ms... use big tau
      v1.pin('+').connect(r1.pin('1'));
      r1.pin('2').connect(c1.pin('1'));
      c1.pin('2').connect(tb.gnd);
      v1.pin('-').connect(tb.gnd);
      tb.expect.tran({ tstop: '0.1m', dt: '1u' }).probe('C1.v').toSettleWithin({ target: 5, tol: 0.02, by: '0.05m' });
    });
    const record = runLadder(desc);
    expect(record.exitCode).toBe(1);
    const a = record.stages.tran!.assertions![0];
    expect(Number.isFinite(a.measured!)).toBe(true);
    // The whole record must JSON round-trip without nulling any number.
    const roundTripped = JSON.parse(JSON.stringify(record));
    expect(roundTripped.stages.tran.assertions[0].measured).toBe(a.measured);
  });

  it('toSettleWithin(target: 0) is rejected at authoring time', () => {
    const desc = bench('zero-target', (tb: TB) => {
      const v1 = tb.add('V1', new VoltageSource(5));
      const r1 = tb.add('R1', new Resistor(10));
      v1.pin('+').connect(r1.pin('1'));
      r1.pin('2').connect(tb.gnd);
      v1.pin('-').connect(tb.gnd);
      tb.expect.tran({ tstop: '1m', dt: '10u' }).probe('R1.v').toSettleWithin({ target: 0, tol: 0.05, by: '0.5m' });
    });
    expect(() => elaborate(desc)).toThrow(/zero-width/);
  });

  it('inductor transient current probe has no one-step lag (matches series resistor)', () => {
    const desc = bench('rl', (tb: TB) => {
      const v1 = tb.add('V1', new VoltageSource(5));
      const r1 = tb.add('R1', new Resistor(100));
      const l1 = tb.add('L1', new Inductor('10m'));
      v1.pin('+').connect(r1.pin('1'));
      r1.pin('2').connect(l1.pin('1'));
      l1.pin('2').connect(tb.gnd);
      v1.pin('-').connect(tb.gnd);
      tb.expect.tran({ tstop: '0.5m', dt: '1u' }).probe('L1.i').toEndCloseTo('50m', '1m');
      tb.expect.tran({ tstop: '0.5m', dt: '1u' }).probe('R1.i').toEndCloseTo('50m', '1m');
    });
    const record = runLadder(desc);
    expect(record.exitCode).toBe(0);
  });

  it('connecting pins before tb.add with an active override is refused (hint trust contract)', () => {
    const desc = bench('pre-wired', (tb: TB) => {
      const v1 = tb.add('V1', new VoltageSource(5));
      const r = new Resistor(100);
      v1.pin('+').connect(r.pin('1')); // wired BEFORE registration
      const r1 = tb.add('R1', r);
      r1.pin('2').connect(tb.gnd);
      v1.pin('-').connect(tb.gnd);
    });
    // Without override it elaborates (same instance is returned)...
    expect(() => elaborate(desc)).not.toThrow();
    // ...but with an override the rebuild would orphan the wiring: refuse.
    expect(() => elaborate(desc, { R1: 220 })).toThrow(/connected before tb.add/);
  });
});
