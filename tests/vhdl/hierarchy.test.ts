import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DigitalCircuit, Clock, Const } from '../../src/digital';
import { compileVhdl } from '../../src/vhdl';
import { HDR, build, design, busValue, ns, codes } from './helpers';

// Hierarchy: entity/component instantiation, generic maps, generate. Exact.

const FULL_ADDER = `${HDR}
entity full_adder is
  port (a, b, cin : in std_logic; s, cout : out std_logic);
end entity;
architecture rtl of full_adder is
begin
  s    <= a xor b xor cin;
  cout <= (a and b) or (cin and (a xor b));
end architecture;
`;

const ADDER2 = `${HDR}
entity adder2 is
  port (a, b : in std_logic_vector(1 downto 0); cin : in std_logic;
        s : out std_logic_vector(1 downto 0); cout : out std_logic);
end entity;
architecture struct of adder2 is
  signal c1 : std_logic;
begin
  fa0: entity work.full_adder port map (a => a(0), b => b(0), cin => cin, s => s(0), cout => c1);
  fa1: entity work.full_adder port map (a(1), b(1), c1, s(1), cout);   -- positional
end architecture;
`;

const RIPPLE = `${HDR}
entity ripple is
  generic (N : positive := 4);
  port (a, b : in unsigned(N-1 downto 0); cin : in std_logic;
        s : out unsigned(N-1 downto 0); cout : out std_logic);
end entity;
architecture gen of ripple is
  component full_adder is
    port (a, b, cin : in std_logic; s, cout : out std_logic);
  end component;
  signal c : std_logic_vector(N downto 0);
begin
  c(0) <= cin;
  g: for i in 0 to N-1 generate
    fa: full_adder port map (a => a(i), b => b(i), cin => c(i), s => s(i), cout => c(i + 1));
  end generate;
  cout <= c(N);
end architecture;
`;

function driveBus(sim: import('../../src/digital').DigitalSim, base: string, n: number, v: number, t: number): void {
  for (let k = 0; k < n; k++) sim.drive(`${base}[${k}]`, ((v >> k) & 1) as 0 | 1, t);
}

describe('hierarchy', () => {
  it('a 2-bit adder from two full adders (named and positional port maps) — all 32 input combinations', () => {
    const d = design([FULL_ADDER, ADDER2]);
    expect(d.topEntities()).toEqual(['adder2']);
    const c = new DigitalCircuit();
    const u = d.instantiate(c, 'ADD', { ports: { a: 'A', b: 'B', cin: 'CI', s: 'S', cout: 'CO' } });
    expect(u.entity).toBe('adder2');
    for (const n of ['A[0]', 'A[1]', 'B[0]', 'B[1]', 'CI']) c.input(n, { initial: 0 });
    expect(c.lint()).toEqual([]);
    const sim = c.build();
    let t = 0;
    for (let a = 0; a < 4; a++)
      for (let b = 0; b < 4; b++)
        for (let ci = 0; ci < 2; ci++) {
          t += 10e-9;
          driveBus(sim, 'A', 2, a, t);
          driveBus(sim, 'B', 2, b, t);
          sim.drive('CI', ci as 0 | 1, t);
          sim.advanceTo(t + 1e-9);
          expect(busValue(sim, ['S[0]', 'S[1]', 'CO']), `${a}+${b}+${ci}`).toBe(a + b + ci);
        }
    // hierarchical names: the instance path is in component ids, net names and signal names
    expect(u.components).toContain('ADD__fa0__assign_10'); // full_adder's first concurrent assignment (line 10)
    expect(u.signals.map(s => s.name)).toEqual(expect.arrayContaining(['a', 'c1', 'fa0.a', 'fa0.cout', 'fa1.s']));
    expect(u.signals.find(s => s.name === 'fa0.cout')!.nets).toEqual(['ADD__c1']); // the port aliases the actual signal
    expect(u.read(sim, 'fa1.cin')).toBe(u.read(sim, 'c1'));
  });

  it('a generic N-bit ripple adder built with for-generate and component instantiation', () => {
    for (const N of [1, 4]) {
      const d = design([RIPPLE, FULL_ADDER]);
      const c = new DigitalCircuit();
      const u = d.instantiate(c, 'R', { entity: 'ripple', generics: { N }, ports: { a: 'A', b: 'B', cin: 'CI', s: 'S', cout: 'CO' } });
      for (let k = 0; k < N; k++) {
        c.input(`A[${k}]`, { initial: 0 });
        c.input(`B[${k}]`, { initial: 0 });
      }
      c.input('CI', { initial: 0 });
      expect(c.lint()).toEqual([]);
      const sim = c.build();
      const out = [...u.port('s').nets, 'CO'];
      let t = 0;
      for (let a = 0; a < 2 ** N; a++)
        for (let b = 0; b < 2 ** N; b++)
          for (let ci = 0; ci < 2; ci++) {
            t += 10e-9;
            driveBus(sim, 'A', N, a, t);
            driveBus(sim, 'B', N, b, t);
            sim.drive('CI', ci as 0 | 1, t);
            sim.advanceTo(t + 1e-9);
            expect(busValue(sim, out), `N=${N} ${a}+${b}+${ci}`).toBe(a + b + ci);
          }
      expect(u.components.filter(id => id.includes('__fa__'))).toHaveLength(2 * N); // two assignments per full adder
      expect(u.signals.map(s => s.name)).toContain(`g(${N - 1}).fa.cout`);
      expect(sim.diagnostics()).toEqual([]);
    }
  });

  it('generic maps pass parent generics down; if-generate selects an implementation', () => {
    const counterVhd = fs.readFileSync(path.join('tests', 'vhdl', 'designs', 'counter.vhd'), 'utf8');
    const TOP = `${HDR}
entity top is
  generic (W : positive := 3; USE_AND : boolean := true);
  port (clk, a, b : in std_logic; q : out unsigned(W-1 downto 0); y : out std_logic);
end entity;
architecture rtl of top is
begin
  cnt: entity work.counter generic map (N => W) port map (clk => clk, rst => '0', q => q);
  g_and: if USE_AND generate
    y <= a and b;
  else generate
    y <= a or b;
  end generate;
end architecture;`;
    for (const USE_AND of [true, false]) {
      const { u, sim } = build([counterVhd, TOP], { entity: 'top', generics: { W: 2, USE_AND }, ports: { clk: 'CLK', a: 'A', b: 'B' } }, c => {
        c.add('CK', new Clock({ period: '10n', start: '10n' }), { y: 'CLK' });
        c.add('KA', new Const(1), { y: 'A' });
        c.add('KB', new Const(0), { y: 'B' });
      });
      expect(u.port('q').width).toBe(2);
      sim.advanceTo(ns(55));
      expect(u.readNumber(sim, 'q')).toBe(5 % 4);
      expect(sim.value(u.net('y'))).toBe(USE_AND ? 0 : 1);
      expect(u.signals.map(s => s.name)).toContain('cnt.count');
    }
  });

  it('constant port actuals and open outputs', () => {
    const { u, sim } = build(
      [
        FULL_ADDER,
        `${HDR}
entity top is port (a : in std_logic; s : out std_logic); end entity;
architecture rtl of top is
begin
  fa: entity work.full_adder port map (a => a, b => '1', cin => '0', s => s, cout => open);
end architecture;`,
      ],
      { entity: 'top', ports: { a: 'A' } },
      c => c.input('A', { initial: 0 }),
    );
    expect(sim.value(u.net('s'))).toBe(1);
    sim.drive('A', 1, '1n').advanceTo('2n');
    expect(sim.value(u.net('s'))).toBe(0);
    expect(u.read(sim, 'fa.cout')).toBe(1);
  });

  it('hierarchy errors: unknown entity / port, unconnected input, type mismatch, recursion, missing generic', () => {
    const first = (srcs: string[]) => compileVhdl(srcs).diagnostics;
    expect(codes(first([`${HDR}entity t is end; architecture a of t is begin u: entity work.nope; end;`]))).toEqual(['V709']);
    const d1 = first([FULL_ADDER, `${HDR}entity t is port (x : in std_logic); end; architecture a of t is begin u: entity work.full_adder port map (a => x, b => x, cin => x, sum => open); end;`]);
    expect(codes(d1)).toEqual(['V710']);
    expect(d1[0].message).toBe("entity 'full_adder' has no port 'sum' (ports: a, b, cin, s, cout)");
    const d2 = first([FULL_ADDER, `${HDR}entity t is port (x : in std_logic); end; architecture a of t is begin u: entity work.full_adder port map (a => x, b => x); end;`]);
    expect(codes(d2)).toEqual(['V710']);
    expect(d2[0].message).toBe("input port 'cin' of 'full_adder' is not connected and has no default value");
    const d3 = first([FULL_ADDER, `${HDR}entity t is port (x : in std_logic_vector(1 downto 0)); end; architecture a of t is begin u: entity work.full_adder port map (a => x, b => x(0), cin => x(1)); end;`]);
    expect(codes(d3)).toEqual(['V710']);
    expect(d3[0].message).toBe("port 'a' of 'full_adder' is std_logic but 'x' is std_logic_vector(1 downto 0)");
    const d4 = first([`${HDR}entity t is end; architecture a of t is begin u: entity work.t; end;`]);
    expect(codes(d4)).toEqual(['V722']);
    const d5 = first([`${HDR}entity sub is generic (K : natural); port (y : out natural); end; architecture a of sub is begin y <= K; end;
entity t is end; architecture a of t is begin u: entity work.sub; end;`]);
    expect(codes(d5)).toEqual(['V711']);
    expect(d5[0].message).toBe("generic 'k' of entity 'sub' has no value: it has no default and none was given");
  });
});
