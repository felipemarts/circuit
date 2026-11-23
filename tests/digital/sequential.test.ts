import { describe, it, expect } from 'vitest';
import {
  DigitalCircuit,
  DFF,
  JKFF,
  DLatch,
  Counter,
  ShiftRegister,
  Mux,
  Clock,
  Const,
  Stimulus,
  valueAt,
  edgeTimes,
} from '../../src/digital';
import type { DigitalSim, Logic } from '../../src/digital';

const ns = (x: number): number => x * 1e-9;

/** Integer value of bus nets name0..name(n-1) at time t (−1 if any bit is X/Z). */
function busAt(sim: DigitalSim, name: string, n: number, t: number): number {
  let v = 0;
  for (let i = 0; i < n; i++) {
    const b = valueAt(sim.trace(`${name}${i}`), t);
    if (b !== 0 && b !== 1) return -1;
    v += b * 2 ** i;
  }
  return v;
}

describe('D flip-flop', () => {
  it('captures on the rising clock edge only', () => {
    // Clock: rises at 0, 100n, 200n …, falls at 50n, 150n …
    const c = new DigitalCircuit();
    c.add('CLK', new Clock({ period: '100n' }), { y: 'clk' });
    // D is 1 around the falling edge at 50n (must NOT capture), and 1 from 130n (captured at 200n).
    c.add('SD', new Stimulus({ changes: [['30n', 1], ['70n', 0], ['130n', 1]] }), { y: 'D' });
    c.add('FF1', new DFF({ delay: '2n' }), { d: 'D', clk: 'clk', q: 'Q', qn: 'QN' });
    const sim = c.build();
    sim.advanceTo('250n');
    const q = sim.trace('Q');
    expect(q.v).toEqual([0, 1]);
    expect(q.t[1]).toBeCloseTo(ns(202), 15);
    expect(sim.trace('QN').v).toEqual([1, 0]);
    expect(sim.diagnostics()).toEqual([]);
  });

  it('asynchronous reset clears immediately and overrides the clock', () => {
    const c = new DigitalCircuit();
    c.add('CLK', new Clock({ period: '100n', start: '100n' }), { y: 'clk' });
    c.add('K1', new Const(1), { y: 'D' });
    c.add('SR', new Stimulus({ initial: 1, changes: [['10n', 0], ['130n', 1], ['260n', 0]] }), { y: 'RST' });
    c.add('FF1', new DFF({ delay: '2n', reset: true, init: 1 }), { d: 'D', clk: 'clk', reset: 'RST', q: 'Q' });
    const sim = c.build();
    expect(sim.value('Q')).toBe(0); // reset asserted at power-on beats init: 1
    sim.advanceTo('400n');
    const q = sim.trace('Q');
    // edge 100n → 1 @102n; reset @130n → 0 @132n; edge 200n ignored (reset held); edge 300n → 1 @302n
    expect(q.v).toEqual([0, 1, 0, 1]);
    [0, 102, 132, 302].forEach((t, i) => expect(q.t[i]).toBeCloseTo(ns(t), 15));
  });

  it('asynchronous set drives q = 1 and qn = 0', () => {
    const c = new DigitalCircuit();
    c.add('K0', new Const(0), { y: 'D' });
    c.add('K0c', new Const(0), { y: 'clk' });
    c.add('SS', new Stimulus({ changes: [['10n', 1], ['20n', 0]] }), { y: 'SET' });
    c.add('FF1', new DFF({ delay: '1n', set: true }), { d: 'D', clk: 'clk', set: 'SET', q: 'Q', qn: 'QN' });
    const sim = c.build().advanceTo('30n');
    expect(valueAt(sim.trace('Q'), '15n')).toBe(1);
    expect(valueAt(sim.trace('QN'), '15n')).toBe(0);
    expect(sim.value('Q')).toBe(1); // stays set after release (no clock)
  });

  function setupHoldBench(dataChange: string, onViolation: 'x' | 'keep' = 'x') {
    const c = new DigitalCircuit();
    c.add('CLK', new Clock({ period: '100n', start: '100n' }), { y: 'clk' });
    c.add('SD', new Stimulus({ changes: [[dataChange, 1]] }), { y: 'D' });
    c.add('FF1', new DFF({ delay: '2n', setup: '5n', hold: '3n', onViolation }), { d: 'D', clk: 'clk', q: 'Q' });
    return c.build().advanceTo('150n');
  }

  it('setup violation → D502 with flip-flop, time and margin; q goes X', () => {
    const sim = setupHoldBench('97n'); // 3 ns before the 100 ns edge, setup is 5 ns
    const [d] = sim.diagnostics();
    expect(d.code).toBe('D502');
    expect(d.severity).toBe('error');
    expect(d.subject?.components).toEqual(['FF1']);
    expect(d.subject?.pins).toEqual(['FF1.d']);
    expect(d.time).toBeCloseTo(ns(100), 15);
    expect(d.evidence?.measured as number).toBeCloseTo(ns(3), 15);
    expect(d.evidence?.margin as number).toBeCloseTo(ns(-2), 15);
    expect(d.message).toMatch(/setup violation on FF1\.d/);
    expect(valueAt(sim.trace('Q'), '110n')).toBe('X');
  });

  it('hold violation → D503; q goes X', () => {
    const sim = setupHoldBench('101n'); // 1 ns after the edge, hold is 3 ns
    const [d] = sim.diagnostics();
    expect(d.code).toBe('D503');
    expect(d.time).toBeCloseTo(ns(101), 15);
    expect(d.evidence?.margin as number).toBeCloseTo(ns(-2), 15);
    expect(valueAt(sim.trace('Q'), '110n')).toBe('X');
  });

  it("onViolation: 'keep' reports but still captures", () => {
    const sim = setupHoldBench('97n', 'keep');
    expect(sim.diagnostics().map(d => d.code)).toEqual(['D502']);
    expect(valueAt(sim.trace('Q'), '110n')).toBe(1);
  });

  it('data with enough margin passes cleanly', () => {
    const sim = setupHoldBench('94n');
    expect(sim.diagnostics()).toEqual([]);
    expect(valueAt(sim.trace('Q'), '110n')).toBe(1);
  });

  it('a clock edge through X makes q unknown (D506) only when it would matter', () => {
    const c = new DigitalCircuit();
    c.add('SC', new Stimulus({ changes: [['10n', 'X'], ['20n', 1]] }), { y: 'clk' });
    c.add('K1', new Const(1), { y: 'D' });
    c.add('FF1', new DFF({ delay: '1n' }), { d: 'D', clk: 'clk', q: 'Q' });
    const sim = c.build().advanceTo('30n');
    expect(sim.value('Q')).toBe('X');
    expect(sim.diagnostics()[0].code).toBe('D506');
  });
});

describe('JK flip-flop', () => {
  it('J = K = 1 toggles on every rising edge', () => {
    const c = new DigitalCircuit();
    c.add('CLK', new Clock({ period: '10n', start: '5n' }), { y: 'clk' });
    c.add('KJ', new Const(1), { y: 'J' });
    c.add('KK', new Const(1), { y: 'K' });
    c.add('FF1', new JKFF({ delay: '1n' }), { j: 'J', k: 'K', clk: 'clk', q: 'Q' });
    const sim = c.build().advanceTo('100n');
    const q = sim.trace('Q');
    expect(q.v).toEqual([0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0]);
    expect(q.t[1]).toBeCloseTo(ns(6), 15);
    expect(q.t[2]).toBeCloseTo(ns(16), 15);
  });

  it('set / reset / hold modes', () => {
    const c = new DigitalCircuit();
    c.add('CLK', new Clock({ period: '10n', start: '10n' }), { y: 'clk' });
    // edges at 10n (J=1,K=0 → 1), 20n (0,0 → hold 1), 30n (0,1 → 0), 40n (0,0 → hold 0)
    c.add('SJ', new Stimulus({ pattern: '1000', step: '10n', from: '5n' }), { y: 'J' });
    c.add('SK', new Stimulus({ pattern: '0010', step: '10n', from: '5n' }), { y: 'K' });
    c.add('FF1', new JKFF({ delay: '1n' }), { j: 'J', k: 'K', clk: 'clk', q: 'Q' });
    const sim = c.build().advanceTo('50n');
    const q = sim.trace('Q');
    expect([15, 25, 35, 45].map(t => valueAt(q, ns(t)))).toEqual([1, 1, 0, 0]);
  });
});

describe('D latch', () => {
  it('is transparent while en = 1 and holds while en = 0', () => {
    const c = new DigitalCircuit();
    c.add('SD', new Stimulus({ changes: [['10n', 1], ['20n', 0], ['30n', 1], ['60n', 0], ['80n', 1]] }), { y: 'D' });
    c.add('SE', new Stimulus({ initial: 1, changes: [['50n', 0], ['100n', 1]] }), { y: 'EN' });
    c.add('L1', new DLatch({ delay: '1n' }), { d: 'D', en: 'EN', q: 'Q' });
    const sim = c.build().advanceTo('120n');
    const q = sim.trace('Q');
    // follows D (10n→1, 20n→0, 30n→1) while open; holds 1 while closed (60n/80n ignored); reopens at 100n with D = 1.
    expect(q.v).toEqual([0, 1, 0, 1]);
    [0, 11, 21, 31].forEach((t, i) => expect(q.t[i]).toBeCloseTo(ns(t), 15));
    expect(valueAt(q, '70n')).toBe(1);
  });

  it('setup before the closing edge is checked', () => {
    const c = new DigitalCircuit();
    c.add('SD', new Stimulus({ changes: [['49n', 1]] }), { y: 'D' });
    c.add('SE', new Stimulus({ initial: 1, changes: [['50n', 0]] }), { y: 'EN' });
    c.add('L1', new DLatch({ delay: '1n', setup: '2n' }), { d: 'D', en: 'EN', q: 'Q' });
    const sim = c.build().advanceTo('60n');
    expect(sim.diagnostics().map(d => d.code)).toEqual(['D502']);
    expect(sim.value('Q')).toBe('X');
  });
});

describe('counter', () => {
  it('4-bit: counts every rising edge and wraps 15 → 0', () => {
    const c = new DigitalCircuit();
    c.add('CLK', new Clock({ period: '10n', start: '5n' }), { y: 'clk' });
    c.add('C1', new Counter({ bits: 4, delay: '1n' }), { clk: 'clk', q0: 'Q0', q1: 'Q1', q2: 'Q2', q3: 'Q3' });
    const sim = c.build().advanceTo('200n');
    // Edge k (k = 1, 2, …) at 5n + 10n·(k−1); sample mid-cycle at 10n·k + 1n… use 10n·k.
    const seq = Array.from({ length: 19 }, (_, k) => busAt(sim, 'Q', 4, ns(10 * (k + 1))));
    expect(seq).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 0, 1, 2, 3]);
    expect(busAt(sim, 'Q', 4, ns(3))).toBe(0);
  });

  it('enable, up/down and synchronous reset', () => {
    const c = new DigitalCircuit();
    c.add('CLK', new Clock({ period: '10n', start: '10n' }), { y: 'clk' });
    // edges at 10n,20n,…; inputs change mid-cycle (at 5n + 10n·i)
    c.add('SE', new Stimulus({ pattern: '1110111111', step: '10n', from: '5n' }), { y: 'EN' });
    c.add('SU', new Stimulus({ pattern: '1111110011', step: '10n', from: '5n' }), { y: 'UP' });
    c.add('SR', new Stimulus({ pattern: '0000000001', step: '10n', from: '5n' }), { y: 'RST' });
    c.add('C1', new Counter({ bits: 3, enable: true, upDown: true, reset: true, resetMode: 'sync', delay: '1n' }), {
      clk: 'clk', en: 'EN', up: 'UP', reset: 'RST', q0: 'Q0', q1: 'Q1', q2: 'Q2',
    });
    const sim = c.build().advanceTo('110n');
    const seq = Array.from({ length: 10 }, (_, k) => busAt(sim, 'Q', 3, ns(10 * (k + 1) + 3)));
    // up,up,up, hold, up,up, down,down, up, reset
    expect(seq).toEqual([1, 2, 3, 3, 4, 5, 4, 3, 4, 0]);
  });
});

describe('shift register', () => {
  it('SIPO: serial in, parallel out', () => {
    const c = new DigitalCircuit();
    c.add('CLK', new Clock({ period: '10n', start: '10n' }), { y: 'clk' });
    c.add('SI', new Stimulus({ pattern: '1011', step: '10n', from: '5n' }), { y: 'SIN' });
    c.add('SR1', new ShiftRegister({ bits: 4, delay: '1n' }), { si: 'SIN', clk: 'clk', q0: 'Q0', q1: 'Q1', q2: 'Q2', q3: 'Q3', so: 'SO' });
    const sim = c.build().advanceTo('45n');
    // shifted in 1, 0, 1, 1 (first bit ends up in q3)
    expect([0, 1, 2, 3].map(i => sim.value(`Q${i}`))).toEqual([1, 1, 0, 1]);
    expect(sim.value('SO')).toBe(1);
    expect(busAt(sim, 'Q', 4, ns(25))).toBe(0b10); // after 2 edges: q0 = 0, q1 = 1
  });

  it('PISO: parallel load, serial out', () => {
    const c = new DigitalCircuit();
    c.add('CLK', new Clock({ period: '10n', start: '10n' }), { y: 'clk' });
    c.add('SL', new Stimulus({ initial: 1, changes: [['15n', 0]] }), { y: 'LOAD' });
    const p: Logic[] = [0, 1, 0, 1];
    p.forEach((v, i) => c.add(`P${i}`, new Const(v), { y: `PIN${i}` }));
    c.add('SR1', new ShiftRegister({ bits: 4, mode: 'piso', delay: '1n' }), {
      load: 'LOAD', clk: 'clk', p0: 'PIN0', p1: 'PIN1', p2: 'PIN2', p3: 'PIN3', so: 'SO',
    });
    const sim = c.build().advanceTo('70n');
    const so = sim.trace('SO');
    // load at 10n → so = p3; then shifts p2, p1, p0, then zeros.
    expect([12, 22, 32, 42, 52].map(t => valueAt(so, ns(t)))).toEqual([1, 0, 1, 0, 0]);
  });
});

describe('multiplexer in time', () => {
  it('follows the selected input with its delay', () => {
    const c = new DigitalCircuit();
    c.add('CLK', new Clock({ period: '20n', start: '0' }), { y: 'A' });
    c.add('K0', new Const(0), { y: 'B' });
    c.add('SS', new Stimulus({ changes: [['50n', 1]] }), { y: 'S' });
    c.add('M1', new Mux({ delay: '2n' }), { s0: 'S', d0: 'A', d1: 'B', y: 'Y' });
    const sim = c.build().advanceTo('100n');
    const y = sim.trace('Y');
    // the clock starts high at power-on (edge at t = 0 is the initial state), so Y = 1 from t = 0
    expect(y.v[0]).toBe(1);
    expect(edgeTimes(y, 'rising').map(t => Math.round(t * 1e9))).toEqual([22, 42]);
    expect(valueAt(y, '60n')).toBe(0);
    expect(valueAt(y, '95n')).toBe(0);
  });
});
