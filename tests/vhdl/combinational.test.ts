import { describe, it, expect } from 'vitest';
import { DigitalCircuit } from '../../src/digital';
import type { Logic } from '../../src/digital';
import { HDR, build, design, busValue } from './helpers';

// Combinational VHDL vs truth tables. All comparisons are exact (logic values).

const GATES = `${HDR}
entity gates is
  port (a, b : in std_logic;
        y_and, y_or, y_xor, y_nand, y_nor, y_xnor, y_not, y_buf : out std_logic);
end entity;
architecture rtl of gates is
begin
  y_and  <= a and b;
  y_or   <= a or b;
  y_xor  <= a xor b;
  y_nand <= a nand b;
  y_nor  <= a nor b;
  y_xnor <= a xnor b;
  y_not  <= not a;
  y_buf  <= a;
end architecture;
`;

// IEEE 1164 tables restricted to the engine's net values 0, 1, X, Z (Z reads as 'Z', which every operator treats like X).
const V: Logic[] = [0, 1, 'X', 'Z'];
const known = (v: Logic): v is 0 | 1 => v === 0 || v === 1;
const AND = (a: Logic, b: Logic): Logic => (a === 0 || b === 0 ? 0 : known(a) && known(b) ? 1 : 'X');
const OR = (a: Logic, b: Logic): Logic => (a === 1 || b === 1 ? 1 : known(a) && known(b) ? 0 : 'X');
const XOR = (a: Logic, b: Logic): Logic => (known(a) && known(b) ? ((a ^ b) as 0 | 1) : 'X');
const NOT = (a: Logic): Logic => (known(a) ? ((1 - a) as 0 | 1) : 'X');

describe('combinational logic', () => {
  it('gates match the std_logic truth tables for 0/1/X/Z inputs', () => {
    const { u, sim } = build(GATES, { ports: { a: 'A', b: 'B' } }, c => {
      c.input('A', { initial: 0 });
      c.input('B', { initial: 0 });
    });
    let t = 0;
    for (const a of V) {
      for (const b of V) {
        t += 10e-9;
        sim.drive('A', a, t).drive('B', b, t).advanceTo(t + 1e-9);
        const got = (p: string): Logic => sim.value(u.net(p));
        const ctx = `a=${a} b=${b}`;
        expect(got('y_and'), ctx).toBe(AND(a, b));
        expect(got('y_or'), ctx).toBe(OR(a, b));
        expect(got('y_xor'), ctx).toBe(XOR(a, b));
        expect(got('y_nand'), ctx).toBe(NOT(AND(a, b)));
        expect(got('y_nor'), ctx).toBe(NOT(OR(a, b)));
        expect(got('y_xnor'), ctx).toBe(NOT(XOR(a, b)));
        expect(got('y_not'), ctx).toBe(NOT(a));
        // a plain assignment passes 'Z' through (std_logic is not a gate input)
        expect(got('y_buf'), ctx).toBe(a);
      }
    }
    expect(sim.diagnostics()).toEqual([]);
  });

  it('zero-delay assignments settle within the same time point (delta cycles)', () => {
    const { u, sim } = build(GATES, { ports: { a: 'A', b: 'B' } }, c => {
      c.input('A', { initial: 0 });
      c.input('B', { initial: 1 });
    });
    sim.drive('A', 1, '5n').advanceTo('10n');
    const tr = sim.trace(u.net('y_and'));
    expect(tr.v).toEqual([0, 1]);
    expect(tr.t[1]).toBe(5e-9);
  });

  const MUXES = `${HDR}
entity mux4 is
  port (d : in std_logic_vector(3 downto 0); sel : in std_logic_vector(1 downto 0);
        y_when, y_with, y_case, y_index : out std_logic);
end entity;
architecture rtl of mux4 is
begin
  y_when <= d(0) when sel = "00" else
            d(1) when sel = "01" else
            d(2) when sel = "10" else
            d(3);
  with sel select
    y_with <= d(0) when "00",
              d(1) when "01",
              d(2) when "10",
              d(3) when others;
  process (all)
  begin
    case sel is
      when "00" => y_case <= d(0);
      when "01" => y_case <= d(1);
      when "10" => y_case <= d(2);
      when others => y_case <= d(3);
    end case;
  end process;
  y_index <= d(to_integer(unsigned(sel)));
end architecture;
`;

  it('4:1 mux — when/else, with/select, case and dynamic indexing agree with d(sel) for all 64 inputs', () => {
    const d = design(MUXES);
    const c = new DigitalCircuit();
    const u = d.instantiate(c, 'M', { ports: { d: 'D', sel: 'S' } });
    for (let i = 0; i < 4; i++) c.input(`D[${i}]`, { initial: 0 });
    for (let i = 0; i < 2; i++) c.input(`S[${i}]`, { initial: 0 });
    const sim = c.build();
    let t = 0;
    for (let dv = 0; dv < 16; dv++) {
      for (let s = 0; s < 4; s++) {
        t += 10e-9;
        for (let i = 0; i < 4; i++) sim.drive(`D[${i}]`, ((dv >> i) & 1) as 0 | 1, t);
        for (let i = 0; i < 2; i++) sim.drive(`S[${i}]`, ((s >> i) & 1) as 0 | 1, t);
        sim.advanceTo(t + 1e-9);
        const want = (dv >> s) & 1;
        for (const y of ['y_when', 'y_with', 'y_case', 'y_index']) expect(sim.value(u.net(y)), `${y} d=${dv} s=${s}`).toBe(want);
      }
    }
    expect(sim.diagnostics()).toEqual([]);
  });

  it('an X select bit: case/with go to others, when/else compares false, indexing reads X with a metavalue warning', () => {
    const d = design(MUXES);
    const c = new DigitalCircuit();
    const u = d.instantiate(c, 'M', { ports: { d: 'D', sel: 'S' } });
    c.input('D[0]', { initial: 1 });
    c.input('D[1]', { initial: 0 });
    c.input('D[2]', { initial: 1 });
    c.input('D[3]', { initial: 0 });
    c.input('S[0]', { initial: 0 });
    c.input('S[1]', { initial: 0 });
    const sim = c.build();
    sim.drive('S[1]', 'X', '1n').advanceTo('2n');
    expect(sim.value(u.net('y_case'))).toBe(0); // others → d(3)
    expect(sim.value(u.net('y_with'))).toBe(0);
    expect(sim.value(u.net('y_when'))).toBe(0); // falls through to d(3)
    // to_integer of a metavalue is 0 (numeric_std) → d(0) = 1, with a V753 warning
    expect(sim.value(u.net('y_index'))).toBe(1);
    expect(sim.diagnostics().map(x => x.code)).toEqual(['V753']);
    expect(sim.diagnostics()[0]).toMatchObject({ severity: 'warning', stage: 'tran', time: 1e-9 });
  });

  it('3-to-8 decoder with a for loop and a variable', () => {
    const { u, sim } = build(
      `${HDR}
entity dec3 is port (a : in unsigned(2 downto 0); en : in std_logic; y : out std_logic_vector(7 downto 0)); end entity;
architecture rtl of dec3 is
begin
  process (a, en)
    variable v : std_logic_vector(7 downto 0);
  begin
    v := (others => '0');
    for i in v'range loop
      if en = '1' and to_integer(a) = i then
        v(i) := '1';
      end if;
    end loop;
    y <= v;
  end process;
end architecture;`,
      { ports: { a: 'A', en: 'EN' } },
      c => {
        for (let i = 0; i < 3; i++) c.input(`A[${i}]`, { initial: 0 });
        c.input('EN', { initial: 0 });
      },
    );
    const y = u.port('y').nets;
    expect(busValue(sim, y)).toBe(0);
    let t = 0;
    for (let a = 0; a < 8; a++) {
      t += 10e-9;
      for (let i = 0; i < 3; i++) sim.drive(`A[${i}]`, ((a >> i) & 1) as 0 | 1, t);
      sim.drive('EN', 1, t);
      sim.advanceTo(t + 1e-9);
      expect(busValue(sim, y)).toBe(1 << a);
      expect(u.read(sim, 'y')).toBe([...Array(8)].map((_, k) => (7 - k === a ? '1' : '0')).join(''));
    }
  });

  it("tri-state bus: 'Z' releases, two drivers resolve, 0 vs 1 is X with the engine's D501", () => {
    const { u, sim } = build(
      `${HDR}
entity bus2 is port (en1, en2, d1, d2 : in std_logic; b : inout std_logic); end entity;
architecture rtl of bus2 is
begin
  b <= d1 when en1 = '1' else 'Z';
  b <= d2 when en2 = '1' else 'Z';
end architecture;`,
      { ports: { en1: 'EN1', en2: 'EN2', d1: 'D1', d2: 'D2', b: 'BUS' } },
      c => {
        for (const n of ['EN1', 'EN2', 'D1', 'D2']) c.input(n, { initial: 0 });
      },
    );
    expect(sim.value('BUS')).toBe('Z');
    sim.drive('EN1', 1, '10n').drive('D1', 1, '10n').advanceTo('11n');
    expect(sim.value('BUS')).toBe(1);
    sim.drive('EN2', 1, '20n').advanceTo('21n'); // d2 = 0 fights d1 = 1
    expect(sim.value('BUS')).toBe('X');
    expect(sim.diagnostics().map(d => d.code)).toEqual(['D501']);
    expect(sim.diagnostics()[0].subject?.net).toBe('BUS');
    sim.drive('EN1', 0, '30n').advanceTo('31n');
    expect(sim.value('BUS')).toBe(0);
    expect(u.port('b').mode).toBe('inout');
  });

  it("weak values: 'H' is a pull-up overridden by a strong '0'; 'L'/'H' read as 0/1", () => {
    const { sim } = build(
      `${HDR}
entity od is port (pull_dn : in std_logic; line : inout std_logic; seen : out std_logic); end entity;
architecture rtl of od is
begin
  line <= 'H';                                  -- pull-up resistor
  line <= '0' when pull_dn = '1' else 'Z';      -- open-drain driver
  seen <= line;
end architecture;`,
      { ports: { pull_dn: 'PD', line: 'LINE', seen: 'SEEN' } },
      c => c.input('PD', { initial: 0 }),
    );
    expect(sim.value('LINE')).toBe(1);
    expect(sim.value('SEEN')).toBe(1);
    sim.drive('PD', 1, '5n').advanceTo('6n');
    expect(sim.value('LINE')).toBe(0);
    expect(sim.value('SEEN')).toBe(0);
    expect(sim.diagnostics()).toEqual([]);
  });

  it('boolean and integer ports are encoded on nets (integer LSB first)', () => {
    const { u, sim } = build(
      `${HDR}
entity enc is port (n : in integer range 0 to 9; big : out boolean; twice : out integer range 0 to 18; neg : out integer range -9 to 0); end entity;
architecture rtl of enc is
begin
  big <= n > 5;
  twice <= n * 2;
  neg <= -n;
end architecture;`,
      { ports: { n: 'N' } },
      c => {
        for (let i = 0; i < 4; i++) c.input(`N[${i}]`, { initial: 0 });
      },
    );
    expect(u.port('n')).toMatchObject({ kind: 'integer', width: 4, nets: ['N[0]', 'N[1]', 'N[2]', 'N[3]'], low: 0, high: 9 });
    expect(u.port('neg')).toMatchObject({ width: 5, signed: true });
    let t = 0;
    for (let n = 0; n <= 9; n++) {
      t += 10e-9;
      for (let i = 0; i < 4; i++) sim.drive(`N[${i}]`, ((n >> i) & 1) as 0 | 1, t);
      sim.advanceTo(t + 1e-9);
      expect(u.read(sim, 'big')).toBe(n > 5);
      expect(u.read(sim, 'twice')).toBe(2 * n);
      expect(u.read(sim, 'neg')).toBe(0 - n);
      expect(u.readNumber(sim, 'n')).toBe(n);
    }
    expect(sim.diagnostics()).toEqual([]);
  });
});
