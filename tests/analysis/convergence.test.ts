import { describe, it, expect } from 'vitest';
import {
  bench,
  runLadder,
  defineComponent,
  pnjlim,
  junctionVcrit,
  Circuit,
  VoltageSource,
  Resistor,
  Capacitor,
  Inductor,
  Diode,
} from '../../src/forge';
import type { TB } from '../../src/forge';

/**
 * A Shockley diode written as a custom component WITHOUT voltage limiting:
 * from a cold start plain Newton has to walk down the exponential ~Vt per
 * iteration and runs out of iterations — the textbook case for gmin stepping.
 */
const RawDiode = defineComponent({
  name: 'RawDiode',
  pins: ['a', 'k'],
  nonlinear: true,
  params: { Is: { default: 1e-14 }, nVt: { default: 0.02585 } },
  stamp(ctx) {
    const vd = ctx.voltage('a') - ctx.voltage('k');
    const e = Math.exp(vd / ctx.params.nVt);
    const g = (ctx.params.Is / ctx.params.nVt) * e;
    ctx.stampConductance('a', 'k', g);
    ctx.stampCurrentSource('a', 'k', -(ctx.params.Is * (e - 1) - g * vd));
  },
});

/** Never converges: its output current flips with the sign of its own input. */
const Chatter = defineComponent({
  name: 'Chatter',
  pins: ['in', 'gnd'],
  nonlinear: true,
  stamp(ctx) {
    if (ctx.mode === 'tran' && ctx.time < 1e-3) return;
    const v = ctx.voltage('in') - ctx.voltage('gnd');
    ctx.stampCurrentSource('in', 'gnd', v > 0 ? -1e-3 : 1e-3);
  },
});

const rawDiodeBench = (V: number) =>
  bench('raw-diode', (tb: TB) => {
    const v1 = tb.add('V1', new VoltageSource(V));
    const r1 = tb.add('R1', new Resistor('1k'));
    const u1 = tb.add('U1', new RawDiode());
    v1.pin('+').connect(r1.pin('1'));
    r1.pin('2').connect(u1.pin('a'));
    u1.pin('k').connect(tb.gnd);
    v1.pin('-').connect(tb.gnd);
    tb.expect.op('R1.i').toBeAbove(0);
  });

describe('convergence aids', () => {
  it('pnjlim limits large forward steps logarithmically and leaves small ones alone', () => {
    const nVt = 0.02585;
    const vcrit = junctionVcrit(nVt, 1e-14);
    expect(vcrit).toBeCloseTo(0.7294, 3);
    expect(pnjlim(0.5, 0.4, nVt, vcrit)).toEqual({ value: 0.5, limited: false }); // below vcrit
    const big = pnjlim(5, 0.6, nVt, vcrit);
    expect(big.limited).toBe(true);
    expect(big.value).toBeCloseTo(0.6 + nVt * Math.log(1 + 4.4 / nVt), 12);
    expect(pnjlim(5, -1, nVt, vcrit).value).toBeCloseTo(nVt * Math.log(5 / nVt), 12);
  });

  it('gmin stepping rescues a circuit plain Newton fails, and the telemetry says so', () => {
    const record = runLadder(rawDiodeBench(5));
    expect(record.exitCode).toBe(0);
    const solver = record.stages.op!.solver!;
    expect(solver.aids).toEqual(['gmin-stepping']);
    expect(solver.attempts![0]).toEqual({ strategy: 'newton', iterations: 100, converged: false });
    expect(solver.attempts![1].strategy).toBe('gmin-stepping');
    expect(solver.attempts![1].converged).toBe(true);
    // Same answer as the built-in (limited) diode, which needs no aid.
    const circuit = new Circuit();
    const v1 = new VoltageSource(5);
    const r1 = new Resistor(1000);
    const d1 = new Diode();
    v1.pin('+').connect(r1.pin('1'));
    r1.pin('2').connect(d1.pin('anode'));
    d1.pin('cathode').connect(circuit.ground);
    v1.pin('-').connect(circuit.ground);
    const dc = circuit.analyze('dc');
    expect(dc.telemetry.aids).toBeUndefined();
    expect(dc.telemetry.iterations).toBeLessThan(15);
    const iRaw = record.stages.op!.probes!['R1.i'];
    expect(Math.abs(iRaw - r1.current) / r1.current).toBeLessThan(1e-5);
  });

  it('source stepping takes over when gmin stepping also fails', () => {
    const record = runLadder(rawDiodeBench(50));
    expect(record.exitCode).toBe(0);
    const solver = record.stages.op!.solver!;
    expect(solver.aids).toEqual(['gmin-stepping', 'source-stepping']);
    expect(solver.attempts!.map(a => [a.strategy, a.converged])).toEqual([
      ['newton', false],
      ['gmin-stepping', false],
      ['source-stepping', true],
    ]);
    expect(record.stages.op!.probes!['R1.i']).toBeCloseTo((50 - 0.78) / 1000, 3);
  });

  it('when every aid fails, S201 still names the culprit device and lists the attempts', () => {
    const record = runLadder(
      bench('chatter-dc', (tb: TB) => {
        const v1 = tb.add('V1', new VoltageSource(0));
        const r1 = tb.add('R1', new Resistor('1k'));
        const u1 = tb.add('U1', new Chatter());
        v1.pin('+').connect(r1.pin('1'));
        r1.pin('2').connect(u1.pin('in'));
        u1.pin('gnd').connect(tb.gnd);
        v1.pin('-').connect(tb.gnd);
        tb.expect.op('R1.i').toBeAbove(0);
      }),
    );
    expect(record.exitCode).toBe(2);
    const d = record.diagnostics[0];
    expect(d.code).toBe('S201');
    expect(d.subject?.components).toEqual(['U1']);
    expect(d.message).toMatch(/gmin stepping and source stepping all failed/);
    expect((d.evidence!.attempts as unknown[]).length).toBe(3);
    expect(d.at).toMatch(/convergence\.test\.ts:\d+/);
  });

  it('transient: a Newton failure cuts the step and retries (telemetry counts it)', () => {
    const record = runLadder(
      bench('raw-diode-edge', (tb: TB) => {
        const v1 = tb.add('V1', new VoltageSource({ pulse: { v1: 0, v2: 5, td: '1m', pw: '1' } }));
        const r1 = tb.add('R1', new Resistor('1k'));
        const c1 = tb.add('C1', new Capacitor('100n'));
        const u1 = tb.add('U1', new RawDiode());
        v1.pin('+').connect(r1.pin('1'));
        r1.pin('2').connect(c1.pin('1'));
        c1.pin('1').connect(u1.pin('a'));
        c1.pin('2').connect(tb.gnd);
        u1.pin('k').connect(tb.gnd);
        v1.pin('-').connect(tb.gnd);
        tb.name('a', u1.pin('a'));
        tb.expect.tran({ tstop: '3m', dt: '100u', maxStep: '1m' }).probe('a').toEndCloseTo(0.72, 0.05);
      }),
    );
    expect(record.exitCode).toBe(0);
    const run = record.stages.tran!.solver!.runs![0];
    expect(run.newtonFailures).toBeGreaterThan(0);
    expect(record.stages.tran!.solver!.rejectedSteps).toBeGreaterThanOrEqual(run.newtonFailures);
  });

  it('S202 names the culprit and the time when no step size helps', () => {
    const record = runLadder(
      bench('chatter-tran', (tb: TB) => {
        const v1 = tb.add('V1', new VoltageSource(0));
        const r1 = tb.add('R1', new Resistor('1k'));
        const c1 = tb.add('C1', new Capacitor('1u'));
        const u1 = tb.add('U1', new Chatter());
        v1.pin('+').connect(r1.pin('1'));
        r1.pin('2').connect(u1.pin('in'));
        r1.pin('2').connect(c1.pin('1'));
        c1.pin('2').connect(tb.gnd);
        u1.pin('gnd').connect(tb.gnd);
        v1.pin('-').connect(tb.gnd);
        tb.name('in', u1.pin('in'));
        tb.expect.tran({ tstop: '2m', dt: '10u' }).probe('in').toStayBelow(1);
      }),
    );
    // Before 1 ms U1 is idle in transient, but at the DC operating point it already chatters.
    expect(record.diagnostics[0].code).toBe('S201');

    const tranOnly = runLadder(
      bench('chatter-tran-2', (tb: TB) => {
        const Late = defineComponent({
          name: 'Late',
          pins: ['in', 'gnd'],
          nonlinear: true,
          stamp(ctx) {
            if (ctx.mode !== 'tran' || ctx.time < 1e-3) return;
            const v = ctx.voltage('in') - ctx.voltage('gnd');
            ctx.stampCurrentSource('in', 'gnd', v > 0 ? -1e-3 : 1e-3);
          },
        });
        const v1 = tb.add('V1', new VoltageSource(0));
        const r1 = tb.add('R1', new Resistor('1k'));
        const u1 = tb.add('U1', new Late());
        v1.pin('+').connect(r1.pin('1'));
        r1.pin('2').connect(u1.pin('in'));
        u1.pin('gnd').connect(tb.gnd);
        v1.pin('-').connect(tb.gnd);
        tb.name('in', u1.pin('in'));
        tb.expect.tran({ tstop: '2m', dt: '10u' }).probe('in').toStayBelow(1);
      }),
    );
    expect(tranOnly.exitCode).toBe(2);
    const d = tranOnly.diagnostics[0];
    expect(d.code).toBe('S202');
    expect(d.subject?.components).toEqual(['U1']);
    expect(d.evidence!.time as number).toBeGreaterThanOrEqual(1e-3);
    expect(d.evidence!.time as number).toBeLessThan(1.001e-3);
  });

  it('S203: the step collapses below minStep on ringing the bench cannot resolve', () => {
    const record = runLadder(
      bench('lc', (tb: TB) => {
        const v1 = tb.add('V1', new VoltageSource(5));
        const r1 = tb.add('R1', new Resistor('10m'));
        const l1 = tb.add('L1', new Inductor('1n'));
        const c1 = tb.add('C1', new Capacitor('1n'));
        v1.pin('+').connect(r1.pin('1'));
        r1.pin('2').connect(l1.pin('1'));
        l1.pin('2').connect(c1.pin('1'));
        c1.pin('2').connect(tb.gnd);
        v1.pin('-').connect(tb.gnd);
        tb.expect.tran({ tstop: '1m', dt: '10u', minStep: '1u' }).probe('C1.v').toEndCloseTo(5, 0.1);
      }),
    );
    expect(record.exitCode).toBe(2);
    const d = record.diagnostics[0];
    expect(d.code).toBe('S203');
    expect(['L1', 'C1']).toContain(d.subject!.components![0]);
    expect(typeof d.evidence!.time).toBe('number');
  });
});
