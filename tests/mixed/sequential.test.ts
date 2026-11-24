import { describe, it, expect } from 'vitest';
import {
  bench,
  runLadder,
  VoltageSource,
  Resistor,
  Capacitor,
  Part,
  Clock,
  Stimulus,
  DFF,
  Not,
  Counter,
} from '../../src/forge';
import type { LogicIC } from '../../src/mixed/device';
import { power, tieLow, waves, crossing } from './helpers';

function clockSource(tb: Parameters<Parameters<typeof bench>[1]>[0], id: string, per: string, vcc = 5) {
  const half = `${parseFloat(per) / 2}${per.replace(/[\d.]/g, '')}`;
  const v = tb.add(id, new VoltageSource({ pulse: { v1: 0, v2: vcc, td: half, tr: '5n', tf: '5n', pw: half, per } }));
  v.pin('-').connect(tb.gnd);
  return v.pin('+');
}

describe('74HC74', () => {
  const divider = (opts: { dataSkew?: boolean } = {}) =>
    bench('hc74-div', tb => {
      const u = tb.add('U1', Part('74HC74')) as LogicIC;
      const vcc = power(tb, u, 5);
      const clk = clockSource(tb, 'VCLK', '1u');
      clk.connect(u.pin('1CLK'));
      u.pin('~1PRE').connect(vcc);
      u.pin('~1CLR').connect(vcc);
      if (opts.dataSkew) {
        // D changes 5 ns before each rising edge of a 1 µs clock: tsu = 20 ns is violated.
        const vd = tb.add('VD', new VoltageSource({ pulse: { v1: 0, v2: 5, td: '1.495u', tr: '1n', tf: '1n', pw: '1u', per: '2u' } }));
        vd.pin('-').connect(tb.gnd);
        vd.pin('+').connect(u.pin('1D'));
      } else {
        u.pin('1D').connect(u.pin('~1Q'));
      }
      u.pin('~2PRE').connect(vcc);
      u.pin('~2CLR').connect(vcc);
      tieLow(tb, u, ['2D', '2CLK']);
      tb.name('q', u.pin('1Q'));
      const lg = tb.expect.logic('q', { tstop: '20u' });
      lg.toHaveFrequency('500k', 0.001, { from: '1u' });
      lg.toHaveDutyCycle(0.5, 0.01, { from: '1u' });
      tb.expect.logic('U1.1CLK').toToggle({ edge: 'rising', count: 20 });
    });

  it('toggle flip-flop (D = ~Q) divides the clock by 2', () => {
    const r = runLadder(divider());
    expect(r.exitCode, JSON.stringify(r.stages.tran?.assertions)).toBe(0);
    const a = r.stages.tran!.assertions!;
    expect(a[0].measured).toBeCloseTo(500e3, -1);
    expect(a[1].measured).toBeCloseTo(0.5, 3);
  });

  it('a setup violation (D 5 ns before CLK, tsu 20 ns) flows into the RunRecord as D502 with time and location', () => {
    const r = runLadder(divider({ dataSkew: true }), { stages: ['lint', 'tran'] });
    expect(r.exitCode).toBe(2);
    const d = r.diagnostics.find(x => x.code === 'D502')!;
    expect(d).toBeDefined();
    expect(d.subject?.components).toEqual(['U1']);
    expect(d.message).toContain('U1');
    expect(d.message).not.toMatch(/_U1_|__/);
    expect((d as { time?: number }).time).toBeGreaterThan(0.9e-6);
    expect(d.at).toMatch(/sequential\.test\.ts:\d+/);
  });
});

describe('74HC595', () => {
  it('shifts a byte in on SRCLK and latches it on RCLK', () => {
    const bits = '10110010'; // first bit shifted in ends in QH
    const r = runLadder(
      bench('hc595', tb => {
        const u = tb.add('U1', Part('74HC595')) as LogicIC;
        const vcc = power(tb, u, 5);
        const ser = tb.add('SER', new Stimulus({ pattern: bits, step: '1u' }));
        const sck = tb.add('SCK', new Clock({ period: '1u', start: '0.5u', stop: '7.9u' }));
        const rck = tb.add('RCK', new Stimulus({ changes: [['8.2u', 1], ['8.7u', 0]] }));
        ser.pin('y').connect(u.pin('SER'));
        sck.pin('y').connect(u.pin('SRCLK'));
        rck.pin('y').connect(u.pin('RCLK'));
        u.pin('~SRCLR').connect(vcc);
        u.pin('~OE').connect(tb.gnd);
        const lg = tb.expect.logic('U1.QA', { tstop: '10u' });
        lg.toBe(0).at('8u'); // not latched yet
        const q = ['QA', 'QB', 'QC', 'QD', 'QE', 'QF', 'QG', 'QH'];
        q.forEach((name, i) => tb.expect.logic(`U1.${name}`).toBe(Number(bits[7 - i]) as 0 | 1).at('9.5u'));
        tb.expect.logic("U1.QH'").toBe(Number(bits[0]) as 0 | 1).at('9.5u');
      }),
    );
    expect(r.exitCode, JSON.stringify([r.diagnostics, r.stages.tran?.assertions?.filter(a => a.verdict === 'fail')])).toBe(0);
  });
});

describe('CD4017', () => {
  it('decade counter: one decoded output high per clock, CARRY OUT = clock / 10', () => {
    const r = runLadder(
      bench('cd4017', tb => {
        const u = tb.add('U1', Part('CD4017')) as LogicIC;
        power(tb, u, 5);
        clockSource(tb, 'VCLK', '10u').connect(u.pin('CLOCK'));
        tieLow(tb, u, ['RESET', 'CLOCK INHIBIT']);
        tb.expect.logic('U1.Q0', { tstop: '400u' }).toBe(1).at('2u');
        for (let k = 1; k <= 9; k++) tb.expect.logic(`U1.Q${k}`).toBe(1).at(`${10 * k + 2}u`);
        for (let k = 0; k <= 9; k++) tb.expect.logic(`U1.Q${k}`).toBe(0).at(`${10 * ((k + 1) % 10) + 2}u`);
        tb.expect.logic('U1.Q3').toBeStable('42u', '122u', { value: 0 });
        tb.expect.logic('U1.CARRY OUT').toHaveFrequency('10k', 0.001, { from: '5u' });
        tb.expect.logic('U1.pin12').toHaveDutyCycle(0.5, 0.01, { from: '5u' });
      }),
    );
    expect(r.exitCode, JSON.stringify([r.diagnostics, r.stages.tran?.assertions?.filter(a => a.verdict === 'fail')])).toBe(0);
  });
});

describe('NE555', () => {
  const R1 = 4.7e3;
  const R2 = 10e3;
  const C = 10e-9;
  const astable = (vcc: number) =>
    bench('ne555-astable', tb => {
      const u = tb.add('U1', Part('NE555')) as LogicIC;
      const v = power(tb, u, vcc);
      const r1 = tb.add('R1', new Resistor(R1));
      const r2 = tb.add('R2', new Resistor(R2));
      const c1 = tb.add('C1', new Capacitor(C));
      u.pin('RESET').connect(v);
      r1.pin('1').connect(v);
      r1.pin('2').connect(u.pin('DISCH'));
      r2.pin('1').connect(u.pin('DISCH'));
      r2.pin('2').connect(u.pin('THRES'));
      u.pin('TRIG').connect(u.pin('THRES'));
      c1.pin('1').connect(u.pin('THRES'));
      c1.pin('2').connect(tb.gnd);
      tb.name('out', u.pin('OUT'));
      tb.name('cap', u.pin('THRES'));
      const f = 1 / (Math.LN2 * (R1 + 2 * R2) * C);
      const lg = tb.expect.logic('out', { tstop: '3m' });
      lg.toHaveFrequency(f, 0.02, { from: '0.5m' });
      lg.toHaveDutyCycle((R1 + R2) / (R1 + 2 * R2), 0.02, { from: '0.5m' });
    });

  for (const vcc of [5, 12]) {
    it(`astable at ${vcc} V: f ≈ 1/(ln2·(R1+2R2)·C) = 1.44/((R1+2R2)C), duty (R1+R2)/(R1+2R2), within 2 %`, () => {
      const r = runLadder(astable(vcc));
      expect(r.exitCode, JSON.stringify([r.diagnostics, r.stages.tran?.assertions])).toBe(0);
      const [f, d] = r.stages.tran!.assertions!;
      console.log(vcc, f.measured, d.measured);
      expect(Math.abs(f.measured! - 1.44 / ((R1 + 2 * R2) * C)) / (1.44 / ((R1 + 2 * R2) * C))).toBeLessThan(0.02);
    });
  }

  it('the capacitor swings between 1/3 and 2/3 VCC', () => {
    const { t, v } = waves(astable(5), 3e-3, ['cap'], 1e-5);
    const after = v.cap.filter((_, i) => t[i] > 0.5e-3);
    expect(Math.max(...after)).toBeCloseTo(10 / 3, 1);
    expect(Math.min(...after)).toBeCloseTo(5 / 3, 1);
    expect(crossing(t, v.cap, 3, 'rise')).toBeGreaterThan(0);
  });

  it('monostable: a trigger pulse gives an output pulse of 1.1·R·C within 2 %', () => {
    const R = 10e3;
    const Cm = 10e-9;
    const r = runLadder(
      bench('ne555-mono', tb => {
        const u = tb.add('U1', Part('NE555')) as LogicIC;
        const v = power(tb, u, 5);
        const r1 = tb.add('R1', new Resistor(R));
        const c1 = tb.add('C1', new Capacitor(Cm));
        const vt = tb.add('VT', new VoltageSource({ pwl: { points: [[0, 5], ['20u', 5], ['20.1u', 0], ['21u', 0], ['21.1u', 5]] } }));
        vt.pin('-').connect(tb.gnd);
        vt.pin('+').connect(u.pin('TRIG'));
        u.pin('RESET').connect(v);
        r1.pin('1').connect(v);
        r1.pin('2').connect(u.pin('THRES'));
        u.pin('DISCH').connect(u.pin('THRES'));
        c1.pin('1').connect(u.pin('THRES'));
        c1.pin('2').connect(tb.gnd);
        tb.name('out', u.pin('OUT'));
        const lg = tb.expect.logic('out', { tstop: '300u' });
        lg.toBe(0).at('10u');
        lg.toBe(1).at('50u');
        lg.toBe(0).at('200u');
        lg.toToggle({ count: 2 });
      }),
    );
    expect(r.exitCode, JSON.stringify([r.diagnostics, r.stages.tran?.assertions])).toBe(0);
    const edges = r.stages.tran!.logic![0].signals.out;
    const width = edges[2][0] - edges[1][0];
    console.log('mono', width, 1.1 * R * Cm);
    expect(Math.abs(width - 1.1 * R * Cm) / (1.1 * R * Cm)).toBeLessThan(0.02);
  });
});

describe('pure-digital bench', () => {
  it('runs the event engine alone over tstop (no analog parts)', () => {
    const r = runLadder(
      bench('digital-only', tb => {
        const clk = tb.add('CLK', new Clock({ freq: '1M' }));
        const ff = tb.add('FF1', new DFF({ delay: '2n' }));
        const inv = tb.add('N1', new Not({ delay: '1n' }));
        const cnt = tb.add('C1', new Counter({ bits: 4 }));
        clk.pin('y').connect(ff.pin('clk'));
        clk.pin('y').connect(cnt.pin('clk'));
        ff.pin('q').connect(inv.pin('a'));
        inv.pin('y').connect(ff.pin('d'));
        tb.name('half', ff.pin('q'));
        tb.name('q3', cnt.pin('q3'));
        tb.expect.logic('half', { tstop: '100u' }).toHaveFrequency('500k', 1e-6);
        tb.expect.logic('q3').toHaveFrequency('62.5k', 1e-6);
        tb.expect.logic('C1.q0').toToggle({ edge: 'rising', count: 50 });
      }),
    );
    expect(r.exitCode, JSON.stringify(r.diagnostics)).toBe(0);
    expect(r.stages.op?.verdict).toBe('pass');
    expect(r.stages.tran!.solver!.runs![0].digitalEvents).toBeGreaterThan(100);
    expect(Object.keys(r.stages.tran!.logic![0].signals).sort()).toEqual(['C1.q0', 'half', 'q3']);
  });

  it('floating digital input → F130 at lint (bench level)', () => {
    const r = runLadder(
      bench('digital-float', tb => {
        const g = tb.add('G1', new Not());
        const ff = tb.add('FF1', new DFF());
        g.pin('y').connect(ff.pin('d'));
        const clk = tb.add('CLK', new Clock({ freq: '1M' }));
        clk.pin('y').connect(ff.pin('clk'));
        tb.expect.logic('FF1.q', { tstop: '10u' }).toToggle();
      }),
    );
    expect(r.exitCode).toBe(2);
    const d = r.diagnostics.find(x => x.code === 'F130')!;
    expect(d.subject?.components).toEqual(['G1']);
    expect(d.at).toMatch(/sequential\.test\.ts/);
  });
});

describe('logic assertions', () => {
  it('report measured values on failure', () => {
    const r = runLadder(
      bench('fail', tb => {
        const clk = tb.add('CLK', new Clock({ freq: '1M' }));
        tb.name('c', clk.pin('y'));
        const lg = tb.expect.logic('c', { tstop: '10u' });
        lg.toHaveFrequency('2M', 0.01);
        lg.toBe(0).at('0.2u');
        lg.toToggle({ count: 3 });
        lg.toHaveDutyCycle(0.25, 0.01);
        lg.toBeStable('1u', '3u');
        lg.toBe(1).at('0.2u');
      }),
    );
    expect(r.exitCode).toBe(1);
    const a = r.stages.tran!.assertions!;
    expect(a.map(x => x.verdict)).toEqual(['fail', 'fail', 'fail', 'fail', 'fail', 'pass']);
    expect(a[0].measured).toBeCloseTo(1e6, 0);
    expect(a[0].margin?.ratio).toBe(0.5);
    expect(a[1].measured).toBe(1);
    expect(a[2].measured).toBe(20); // falling 0.5u … rising 10u (power-on high, no edge at 0)
    expect(a[3].measured).toBeCloseTo(0.5, 9);
    expect(a[4].tFirstViolation).toBeCloseTo(1.5e-6, 12);
  });

  it('a mixed run is deterministic (byte-identical RunRecords)', () => {
    const b = bench('det', tb => {
      const u = tb.add('U1', Part('74HC14')) as LogicIC;
      power(tb, u, 5);
      const r1 = tb.add('R1', new Resistor('4.7k'));
      const c1 = tb.add('C1', new Capacitor('22n'));
      u.pin('1Y').connect(r1.pin('1'));
      r1.pin('2').connect(u.pin('1A'));
      c1.pin('1').connect(u.pin('1A'));
      c1.pin('2').connect(tb.gnd);
      tieLow(tb, u, ['2A', '3A', '4A', '5A', '6A']);
      tb.name('osc', u.pin('1Y'));
      tb.expect.logic('osc', { tstop: '2m' }).toToggle({ min: 10 });
      tb.expect.tran({ tstop: '2m' }).probe('R1.i').toNeverExceed('2m');
    });
    const a = JSON.stringify(runLadder(b));
    const c = JSON.stringify(runLadder(b));
    expect(a).toBe(c);
  });
});

void Counter;
