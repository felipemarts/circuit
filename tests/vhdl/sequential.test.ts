import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DigitalCircuit, Clock, Stimulus, Const, edgeTimes, dutyCycle, frequency, valueAt } from '../../src/digital';
import type { DigitalSim } from '../../src/digital';
import { HDR, build, design, busValue, ns } from './helpers';

// Sequential VHDL: hand-computed expectations, exact (logic values; times on
// the 1 ps grid, compared as integer picoseconds).

const file = (name: string): { text: string; path: string } => {
  const p = path.join('tests', 'vhdl', 'designs', name);
  return { text: fs.readFileSync(p, 'utf8'), path: p.split(path.sep).join('/') };
};
const ps = (ts: number[]): number[] => ts.map(t => Math.round(t * 1e12));

describe('counter (counter.vhd)', () => {
  it('counts on rising edges, wraps modulo 2^N and resets synchronously', () => {
    const { u, sim } = build(file('counter.vhd'), { ports: { clk: 'CLK', rst: 'RST', q: 'Q' } }, c => {
      c.add('CK', new Clock({ period: '10n', start: '10n' }), { y: 'CLK' });
      // reset held over the edges at 10n and 20n; pulsed again around the edge at 210n
      c.add('SR', new Stimulus({ initial: 1, changes: [['25n', 0], ['203n', 1], ['213n', 0]] }), { y: 'RST' });
    });
    const q = u.port('q').nets;
    expect(q).toEqual(['Q[0]', 'Q[1]', 'Q[2]', 'Q[3]']);
    sim.advanceTo('25n');
    expect(busValue(sim, q)).toBe(0);
    // edge k·10n (k ≥ 3) → count = k − 2
    for (let k = 3; k <= 20; k++) {
      sim.advanceTo(ns(k * 10 + 5));
      expect(busValue(sim, q), `after edge ${k * 10}n`).toBe((k - 2) % 16);
    }
    // the count changes exactly at the edges (zero-delay assignments)
    const q0 = sim.trace('Q[0]');
    expect(ps(q0.t).slice(0, 4)).toEqual([0, 30000, 40000, 50000]);
    // synchronous reset: asserted at 203n, nothing happens until the edge at 210n
    sim.advanceTo('205n');
    expect(busValue(sim, q)).toBe(2); // edge 200n → 18 mod 16
    sim.advanceTo('211n');
    expect(busValue(sim, q)).toBe(0);
    sim.advanceTo('225n');
    expect(busValue(sim, q)).toBe(1);
    expect(u.readNumber(sim, 'count')).toBe(1);
    expect(sim.diagnostics()).toEqual([]);
  });

  it('generics change behavior: N = 3 wraps at 8; en (default 1 when open) gates counting', () => {
    const { u, sim } = build(file('counter.vhd'), { generics: { N: 3 }, ports: { clk: 'CLK', rst: 'RST', en: 'EN', q: 'Q' } }, c => {
      c.add('CK', new Clock({ period: '10n', start: '10n' }), { y: 'CLK' });
      c.add('K0', new Const(0), { y: 'RST' });
      c.add('SE', new Stimulus({ initial: 1, changes: [['105n', 0], ['135n', 1]] }), { y: 'EN' });
    });
    expect(u.port('q')).toMatchObject({ type: 'unsigned(2 downto 0)', width: 3 });
    expect(u.generics).toEqual({ n: 3 });
    const seen: number[] = [];
    for (let k = 1; k <= 16; k++) {
      sim.advanceTo(ns(k * 10 + 5));
      seen.push(busValue(sim, u.port('q').nets));
    }
    // edges 10..100 count 1..10 (mod 8); en = 0 over the edges at 110, 120, 130; resumes at 140
    expect(seen).toEqual([1, 2, 3, 4, 5, 6, 7, 0, 1, 2, 2, 2, 2, 3, 4, 5]);
  });

  it('an open en port with a default is tied to that default', () => {
    const d = design(file('counter.vhd'));
    const c = new DigitalCircuit();
    const u = d.instantiate(c, 'U1', { ports: { clk: 'CLK', rst: 'RST' } });
    c.add('CK', new Clock({ period: '10n', start: '10n' }), { y: 'CLK' });
    c.add('K0', new Const(0), { y: 'RST' });
    const sim = c.build();
    sim.advanceTo('35n');
    expect(u.readNumber(sim, 'q')).toBe(3);
    expect(c.lint()).toEqual([]);
  });
});

describe('flip-flops and registers', () => {
  it('D flip-flop with asynchronous reset: reset acts immediately, data on rising edges only', () => {
    const { sim } = build(
      `${HDR}
entity dff_ar is port (clk, rst, d : in std_logic; q : out std_logic); end entity;
architecture rtl of dff_ar is
begin
  process (clk, rst)
  begin
    if rst = '1' then
      q <= '0';
    elsif rising_edge(clk) then
      q <= d;
    end if;
  end process;
end architecture;`,
      { ports: { clk: 'CLK', rst: 'RST', d: 'D', q: 'Q' } },
      c => {
        // rising edges at 20, 40, 60, 80 ns; falling at 30, 50, 70
        c.add('CK', new Clock({ period: '20n', start: '20n' }), { y: 'CLK' });
        c.add('SD', new Stimulus({ initial: 1, changes: [['25n', 0], ['32n', 1], ['65n', 0]] }), { y: 'D' });
        c.add('SR', new Stimulus({ initial: 0, changes: [['45n', 1], ['47n', 0]] }), { y: 'RST' });
      },
    );
    sim.advanceTo('100n');
    const q = sim.trace('Q');
    // 'U' (X) until the first edge; 1 @20; d=0 changes at 25 are not sampled on the falling edge at 30;
    // d=1 @32 sampled @40; reset @45 clears at once; sampled 1 @60; 0 @80
    expect(q.v).toEqual(['X', 1, 0, 1, 0]);
    expect(ps(q.t)).toEqual([0, 20000, 45000, 60000, 80000]);
  });

  it('shift register: serial in, parallel out, MSB out', () => {
    const pattern = '10110010';
    const { u, sim } = build(
      `${HDR}
entity shreg is
  generic (W : positive := 8);
  port (clk, din : in std_logic; q : out std_logic_vector(W-1 downto 0); dout : out std_logic);
end entity;
architecture rtl of shreg is
  signal r : std_logic_vector(W-1 downto 0) := (others => '0');
begin
  process (clk)
  begin
    if rising_edge(clk) then
      r <= r(W-2 downto 0) & din;
    end if;
  end process;
  q <= r;
  dout <= r(W-1);
end architecture;`,
      { ports: { clk: 'CLK', din: 'DIN', q: 'Q', dout: 'DOUT' } },
      c => {
        c.add('CK', new Clock({ period: '10n', start: '5n' }), { y: 'CLK' });
        c.add('SD', new Stimulus({ pattern: `${pattern}00000000`, step: '10n' }), { y: 'DIN' });
      },
    );
    let expectR = '00000000';
    for (let k = 0; k < 16; k++) {
      const bit = (pattern + '00000000')[k];
      expectR = expectR.slice(1) + bit;
      sim.advanceTo(ns(10 * k + 6));
      expect(u.read(sim, 'q'), `after edge ${10 * k + 5}n`).toBe(expectR);
      expect(sim.value('DOUT')).toBe(Number(expectR[0]));
    }
  });
});

describe('FSM with after delays (traffic_light.vhd)', () => {
  it('cycles RED 4 → GREEN 3 → YELLOW 1 clock cycles, lamps switch T_OUT after the state', () => {
    const { u, sim } = build(file('traffic_light.vhd'), { ports: { clk: 'CLK', rst: 'RST', red: 'RED', yellow: 'YEL', green: 'GRN' } }, c => {
      c.add('CK', new Clock({ period: '10n', start: '10n' }), { y: 'CLK' });
      c.add('SR', new Stimulus({ initial: 1, changes: [['15n', 0]] }), { y: 'RST' });
    });
    sim.advanceTo('300n');
    // edge 10 = reset; RED counts edges 20,30,40,50 → GREEN @50; 60,70,80 → YELLOW @80; 90 → RED @90; …
    // lamps: 'U' (X) until T_OUT = 2 ns after power-on, then follow the state 2 ns late.
    // one cycle = 4 + 3 + 1 = 8 clocks = 80 ns
    expect(sim.trace('RED').v).toEqual(['X', 1, 0, 1, 0, 1, 0, 1, 0]);
    expect(ps(sim.trace('RED').t)).toEqual([0, 2000, 52000, 92000, 132000, 172000, 212000, 252000, 292000]);
    expect(sim.trace('GRN').v).toEqual(['X', 0, 1, 0, 1, 0, 1, 0, 1]);
    expect(ps(sim.trace('GRN').t)).toEqual([0, 2000, 52000, 82000, 132000, 162000, 212000, 242000, 292000]);
    expect(sim.trace('YEL').v).toEqual(['X', 0, 1, 0, 1, 0, 1, 0]);
    expect(ps(sim.trace('YEL').t)).toEqual([0, 2000, 82000, 92000, 162000, 172000, 242000, 252000]);
    // the state itself changes at the edge (edge 290 → GREEN), the lamps 2 ns later
    expect(u.read(sim, 'state')).toBe('s_green');
    expect(u.read(sim, 'timer')).toBe(1); // the edge at 300n itself has been processed
    expect(sim.diagnostics()).toEqual([]);
  });

  it('generics change the timing', () => {
    const { sim } = build(file('traffic_light.vhd'), { generics: { RED_CYCLES: 2, GREEN_CYCLES: 1, YELLOW_CYCLES: 1, T_OUT: '5 ns' }, ports: { clk: 'CLK', rst: 'RST', red: 'RED', yellow: 'YEL', green: 'GRN' } }, c => {
      c.add('CK', new Clock({ period: '10n', start: '10n' }), { y: 'CLK' });
      c.add('SR', new Stimulus({ initial: 1, changes: [['15n', 0]] }), { y: 'RST' });
    });
    sim.advanceTo('100n');
    // RED edges 20,30 → GREEN @30; → YELLOW @40; → RED @50; GREEN @70; YELLOW @80; RED @90
    expect(ps(edgeTimes(sim.trace('GRN'), 'rising'))).toEqual([35000, 75000]);
    expect(ps(edgeTimes(sim.trace('RED'), 'falling'))).toEqual([35000, 75000]);
  });
});

describe('PWM with a generic duty (pwm.vhd)', () => {
  const run = (generics: Record<string, number>, until = '2u'): DigitalSim =>
    build(file('pwm.vhd'), { generics, ports: { clk: 'CLK', rst: 'RST', pwm_out: 'PWM' } }, c => {
      c.add('CK', new Clock({ freq: '100M' }), { y: 'CLK' });
      c.add('K0', new Const(0), { y: 'RST' });
    }).sim.advanceTo(until);

  it('duty cycle = DUTY / PERIOD exactly, frequency = fclk / PERIOD', () => {
    for (const [period, duty] of [
      [10, 3],
      [8, 4],
      [5, 1],
      [16, 15],
    ]) {
      const sim = run({ PERIOD: period, DUTY: duty });
      const tr = sim.trace('PWM');
      expect(dutyCycle(tr), `${duty}/${period}`).toBeCloseTo(duty / period, 12);
      expect(frequency(tr), `${duty}/${period}`).toBeCloseTo(100e6 / period, 3);
    }
  });

  it('DUTY = 0 never goes high; DUTY = PERIOD stays high', () => {
    expect(run({ PERIOD: 5, DUTY: 0 }).trace('PWM').v).toEqual([0]);
    expect(run({ PERIOD: 5, DUTY: 5 }).trace('PWM').v).toEqual([1]);
  });
});

describe('UART transmitter (uart_tx.vhd)', () => {
  it('sends 0xA5 as 8N1: start 0, LSB first, stop 1, at CLKS_PER_BIT clocks per bit', () => {
    const { sim, u } = build(file('uart_tx.vhd'), { ports: { clk: 'CLK', rst: 'RST', start: 'GO', data: 'D', tx: 'TX', busy: 'BUSY' } }, c => {
      c.add('CK', new Clock({ period: '10n', start: '10n' }), { y: 'CLK' });
      c.add('K0', new Const(0), { y: 'RST' });
      c.add('SG', new Stimulus({ changes: [['25n', 1], ['35n', 0]] }), { y: 'GO' });
      const byte = 0xa5;
      for (let i = 0; i < 8; i++) c.add(`KD${i}`, new Const(((byte >> i) & 1) as 0 | 1), { y: `D[${i}]` });
    });
    expect(u.port('data').nets[0]).toBe('D[0]');
    sim.advanceTo('600n');
    const tx = sim.trace('TX');
    // idle high from power-on (port default '1'); start bit at the second edge after `start` (40 ns)
    expect(tx.v[0]).toBe(1);
    const start = edgeTimes(tx, 'falling')[0];
    expect(Math.round(start * 1e12)).toBe(40000);
    const tbit = 40e-9;
    let byte = 0;
    for (let k = 0; k < 8; k++) byte |= (valueAt(tx, start + (k + 1.5) * tbit) as number) << k;
    expect(byte).toBe(0xa5);
    expect(valueAt(tx, start + 0.5 * tbit)).toBe(0); // start bit
    expect(valueAt(tx, start + 9.5 * tbit)).toBe(1); // stop bit
    // busy from the edge that accepted `start` (30n); the stop bit's last edge (430n) returns to IDLE, which clears busy at 440n
    expect(sim.trace('BUSY').v).toEqual([0, 1, 0]);
    expect(ps(sim.trace('BUSY').t)).toEqual([0, 30000, 440000]);
    expect(sim.diagnostics()).toEqual([]);
  });
});

describe('debouncer (debounce.vhd)', () => {
  it('rejects a 3-cycle glitch, accepts a press after STABLE_CYCLES edges', () => {
    const { sim } = build(file('debounce.vhd'), { ports: { clk: 'CLK', noisy: 'IN', clean: 'OUT' } }, c => {
      c.add('CK', new Clock({ period: '10n', start: '10n' }), { y: 'CLK' });
      c.add('SB', new Stimulus({ changes: [['205n', 1], ['235n', 0], ['405n', 1], ['605n', 0]] }), { y: 'IN' });
    });
    sim.advanceTo('800n');
    // press at 405: sync0 @410, sync1 @420, cnt 1,2,3 @430..450, clean @460; release mirrors it (@660)
    expect(sim.trace('OUT').v).toEqual([0, 1, 0]);
    expect(ps(sim.trace('OUT').t)).toEqual([0, 460000, 660000]);
  });

  it('a shorter STABLE_CYCLES generic reacts sooner', () => {
    const { sim } = build(file('debounce.vhd'), { generics: { STABLE_CYCLES: 2 }, ports: { clk: 'CLK', noisy: 'IN', clean: 'OUT' } }, c => {
      c.add('CK', new Clock({ period: '10n', start: '10n' }), { y: 'CLK' });
      c.add('SB', new Stimulus({ changes: [['405n', 1]] }), { y: 'IN' });
    });
    sim.advanceTo('500n');
    expect(ps(sim.trace('OUT').t)).toEqual([0, 440000]);
  });
});
