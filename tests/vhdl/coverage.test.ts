import { describe, it, expect } from 'vitest';
import { DigitalCircuit } from '../../src/digital';
import { HDR, build, design } from './helpers';

// Constructs listed in src/vhdl/README.md that the other suites do not exercise.

describe('documented subset — remaining constructs', () => {
  it('attributes, enum loops, downto loops, unconstrained constants, vector generics, bit-string literals', () => {
    const { u, sim } = build(
      `${HDR}
entity t is
  generic (INIT : std_logic_vector(3 downto 0) := x"A"; MASK : std_logic_vector := "0011");
  port (a : in std_logic_vector(3 downto 0);
        rev : out std_logic_vector(3 downto 0); cnt_enum : out integer range 0 to 7; img_ok, asc : out boolean;
        init_o, mask_o : out std_logic_vector(3 downto 0); b8 : out std_logic_vector(7 downto 0); nxt : out integer range 0 to 3);
end entity;
architecture rtl of t is
  type st_t is (S0, S1, S2, S3);
  constant PAT : std_logic_vector := "1100";          -- unconstrained, length from the value
begin
  process (all)
    variable n : integer range 0 to 7;
    variable r : std_logic_vector(3 downto 0);
  begin
    for i in a'reverse_range loop                      -- 0 to 3
      r(3 - i) := a(i);
    end loop;
    rev <= r;
    n := 0;
    for s in st_t loop
      n := n + 1;
    end loop;
    for i in 3 downto 2 loop
      n := n + 1;
    end loop;
    cnt_enum <= n;                                     -- 4 literals + 2
    img_ok <= st_t'image(st_t'succ(S1)) = "s2" and st_t'pred(S3) = S2;
    asc <= a'ascending or PAT'ascending;              -- false or true (unconstrained constant: 0 to 3)
    init_o <= INIT;
    mask_o <= MASK and a;
    b8 <= 8x"5" or x"00";
    nxt <= st_t'pos(st_t'right) - st_t'pos(st_t'left);
  end process;
end architecture;`,
      { generics: { MASK: '0101' }, ports: { a: 'A' } },
      c => [1, 1, 0, 1].forEach((b, i) => c.input(`A[${i}]`, { initial: b as 0 | 1 })), // a = "1011"
    );
    expect(u.read(sim, 'rev')).toBe('1101');
    expect(u.read(sim, 'cnt_enum')).toBe(6);
    expect(u.read(sim, 'img_ok')).toBe(true);
    expect(u.read(sim, 'asc')).toBe(true);
    expect(u.read(sim, 'init_o')).toBe('1010');
    expect(u.read(sim, 'mask_o')).toBe('0001');
    expect(u.read(sim, 'b8')).toBe('00000101');
    expect(u.read(sim, 'nxt')).toBe(3);
    expect(u.generics).toMatchObject({ init: '1010', mask: '0101' });
  });

  it("unaffected, 'L' weak zero, generate-local signals, elsif-generate and entity work.e(arch)", () => {
    const LEAF = `${HDR}
entity leaf is port (x : in std_logic; z : out std_logic); end entity;
architecture inv of leaf is begin z <= not x; end architecture;
architecture buf of leaf is begin z <= x; end architecture;`;
    const { u, sim } = build(
      [
        LEAF,
        `${HDR}
entity top is
  generic (MODE : natural := 1);
  port (en, d : in std_logic; held, pulled : out std_logic; y : out std_logic_vector(1 downto 0); z_inv, z_buf, sel : out std_logic);
end entity;
architecture rtl of top is
begin
  held <= d when en = '1' else unaffected;          -- a latch: keeps its value while en = 0
  pulled <= 'L';
  pulled <= '1' when d = '1' else 'Z';
  g: for i in 0 to 1 generate
    signal t : std_logic;
  begin
    t <= d xor en;
    y(i) <= t;
  end generate;
  ui: entity work.leaf(inv) port map (x => d, z => z_inv);
  ub: entity work.leaf(buf) port map (x => d, z => z_buf);
  gm: if MODE = 0 generate
    sel <= '0';
  elsif MODE = 1 generate
    sel <= '1';
  else generate
    sel <= 'X';
  end generate;
end architecture;`,
      ],
      { entity: 'top', ports: { en: 'EN', d: 'D' } },
      c => {
        c.input('EN', { initial: 1 });
        c.input('D', { initial: 1 });
      },
    );
    expect(sim.value(u.net('held'))).toBe(1);
    expect(sim.value(u.net('pulled'))).toBe(1);
    expect(u.read(sim, 'y')).toBe('00');
    expect([sim.value(u.net('z_inv')), sim.value(u.net('z_buf')), sim.value(u.net('sel'))]).toEqual([0, 1, 1]);
    sim.drive('EN', 0, '1n').drive('D', 0, '1n').advanceTo('2n');
    expect(sim.value(u.net('held'))).toBe(1); // unaffected: kept
    expect(sim.value(u.net('pulled'))).toBe(0); // weak 'L' wins when the other driver releases
    expect(u.read(sim, 'y')).toBe('00');
    expect(u.signals.map(s => s.name)).toEqual(expect.arrayContaining(['g(0).t', 'g(1).t', 'ui.z', 'ub.x']));
    expect(sim.diagnostics()).toEqual([]);
  });

  it('a zero-delay VHDL combinational loop is reported by the digital lint (F133); with `after` it is not', () => {
    const lint = (after: string) => {
      const d = design(`${HDR}
entity ring is port (en : in std_logic; y : out std_logic); end entity;
architecture rtl of ring is
  signal n : std_logic := '0';
begin
  n <= not (n and en)${after};
  y <= n;
end architecture;`);
      const c = new DigitalCircuit();
      d.instantiate(c, 'U1', { ports: { en: 'EN' } });
      c.input('EN', { initial: 0 });
      return c.lint().map(x => x.code);
    };
    expect(lint('')).toEqual(['F133']);
    expect(lint(' after 1 ns')).toEqual([]);
  });
});
