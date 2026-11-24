import { describe, it, expect } from 'vitest';
import { Clock, Stimulus, Const } from '../../src/digital';
import { compileVhdl } from '../../src/vhdl';
import { HDR, build, busValue, ns, codes } from './helpers';

// VHDL signal/variable semantics and numeric_std arithmetic. Exact comparisons.

const clocked = (body: string, decls = '', ports = '') => `${HDR}
entity t is port (clk : in std_logic${ports}); end entity;
architecture rtl of t is
${decls}
begin
${body}
end architecture;`;

const withClock = (c: import('../../src/digital').DigitalCircuit): void => {
  c.add('CK', new Clock({ period: '10n', start: '10n' }), { y: 'CLK' });
};

describe('delta-cycle semantics', () => {
  it('swapping two signals in one process works (signals update after the process suspends)', () => {
    const { u, sim } = build(
      clocked(
        `  process (clk)
  begin
    if rising_edge(clk) then
      a <= b;
      b <= a;
    end if;
  end process;`,
        `  signal a : std_logic := '0';
  signal b : std_logic := '1';`,
      ),
      { ports: { clk: 'CLK' } },
      withClock,
    );
    const seen: string[] = [];
    for (let k = 1; k <= 4; k++) {
      sim.advanceTo(ns(10 * k + 5));
      seen.push(`${u.read(sim, 'a')}${u.read(sim, 'b')}`);
    }
    expect(seen).toEqual(['10', '01', '10', '01']);
  });

  it('variables update immediately, signals at the next delta', () => {
    const { u, sim } = build(
      clocked(
        `  process (clk)
    variable v : unsigned(3 downto 0) := (others => '0');
  begin
    if rising_edge(clk) then
      v := v + 1;
      vout <= v;       -- the new value
      s <= s + 1;
      sout <= s;       -- the old value of s
    end if;
  end process;`,
        `  signal s, vout, sout : unsigned(3 downto 0) := (others => '0');`,
      ),
      { ports: { clk: 'CLK' } },
      withClock,
    );
    for (let k = 1; k <= 5; k++) {
      sim.advanceTo(ns(10 * k + 5));
      expect(u.readNumber(sim, 'vout')).toBe(k);
      expect(u.readNumber(sim, 's')).toBe(k);
      expect(u.readNumber(sim, 'sout')).toBe(k - 1);
    }
  });

  it('the last assignment in a process wins (default-then-override)', () => {
    const { sim } = build(
      `${HDR}
entity t is port (a, b : in std_logic; y : out std_logic_vector(1 downto 0)); end entity;
architecture rtl of t is
begin
  process (all)
  begin
    y <= "00";
    if a = '1' then y(0) <= '1'; end if;
    if b = '1' then y <= "10"; end if;
  end process;
end architecture;`,
      { ports: { a: 'A', b: 'B', y: 'Y' } },
      c => {
        c.input('A', { initial: 0 });
        c.input('B', { initial: 0 });
      },
    );
    const y = ['Y[0]', 'Y[1]'];
    expect(busValue(sim, y)).toBe(0);
    sim.drive('A', 1, '1n').advanceTo('2n');
    expect(busValue(sim, y)).toBe(1);
    sim.drive('B', 1, '3n').advanceTo('4n');
    expect(busValue(sim, y)).toBe(2);
    // no glitch is recorded inside a time point: y(1) went 0 → 1 once
    expect(sim.trace('Y[1]').v).toEqual([0, 1]);
  });

  it('a chain of zero-delay assignments settles in delta cycles at one instant', () => {
    const { sim } = build(
      `${HDR}
entity t is port (a : in std_logic; d : out std_logic); end entity;
architecture rtl of t is
  signal b, c : std_logic;
begin
  b <= a;
  c <= b;
  d <= c;
end architecture;`,
      { ports: { a: 'A', d: 'D' } },
      c => c.input('A', { initial: 0 }),
    );
    sim.drive('A', 1, '7n').advanceTo('10n');
    expect(sim.trace('D').t).toEqual([0, 7e-9]);
    expect(sim.stats().maxDelta).toBeGreaterThanOrEqual(3);
  });

  it("'event and process sensitivity: a process only resumes on its sensitivity list", () => {
    const { u, sim } = build(
      `${HDR}
entity t is port (clk, d : in std_logic; q_ev, q_lat : out std_logic); end entity;
architecture rtl of t is
begin
  process (clk)
  begin
    if clk'event and clk = '1' then q_ev <= d; end if;
  end process;
  -- incomplete list on purpose: q_lat only follows d when clk changes
  process (clk)
  begin
    q_lat <= d;
  end process;
end architecture;`,
      { ports: { clk: 'CLK', d: 'D', q_ev: 'QE', q_lat: 'QL' } },
      c => {
        c.add('CK', new Clock({ period: '20n', start: '20n' }), { y: 'CLK' });
        c.add('SD', new Stimulus({ initial: 0, changes: [['5n', 1], ['25n', 0]] }), { y: 'D' });
      },
    );
    sim.advanceTo('50n');
    expect(sim.trace('QE').v).toEqual(['X', 1, 0]); // edges 20 (d=1), 40 (d=0)
    expect(sim.trace('QL').t.map(t => Math.round(t * 1e12))).toEqual([0, 20000, 30000]); // wakes at 20 (rise), 30 (fall)
    expect(u.diagnostics.map(d => d.code)).toEqual(['V717']);
  });
});

describe('aggregates, slices, concatenation', () => {
  const SRC = `${HDR}
entity t is port (a : in std_logic_vector(7 downto 0); i : in integer range 0 to 7;
  y_others, y_named, y_range, y_slice, y_cat, y_rot, y_pos, y_rev, y_dyn : out std_logic_vector(7 downto 0);
  bit_i : out std_logic); end entity;
architecture rtl of t is
  signal asc : std_logic_vector(0 to 3);
begin
  y_others <= (others => '1');
  y_named  <= (0 => '1', 7 => '1', others => '0');
  y_range  <= (7 downto 4 => a(0), others => '0');
  y_slice  <= a(3 downto 0) & a(7 downto 4);
  y_cat    <= "10" & a(5 downto 2) & '0' & '1';
  y_rot    <= a(6 downto 0) & a(7);
  y_pos    <= ('1', '0', '1', '0', a(3), a(2), a(1), a(0));
  asc      <= a(3 downto 0);
  y_rev    <= "0000" & asc(3) & asc(2) & asc(1) & asc(0);
  bit_i    <= a(i);
  process (all)
  begin
    y_dyn <= (others => '0');
    y_dyn(i) <= '1';
  end process;
end architecture;`;

  it('builds the expected vectors', () => {
    const { u, sim } = build(SRC, { ports: { a: 'A', i: 'I' } }, c => {
      const a = 0b10110110;
      for (let k = 0; k < 8; k++) c.add(`KA${k}`, new Const(((a >> k) & 1) as 0 | 1), { y: `A[${k}]` });
      for (let k = 0; k < 3; k++) c.input(`I[${k}]`, { initial: ((5 >> k) & 1) as 0 | 1 });
    });
    const r = (n: string): unknown => u.read(sim, n);
    expect(r('y_others')).toBe('11111111');
    expect(r('y_named')).toBe('10000001');
    expect(r('y_range')).toBe('00000000'); // a(0) = 0
    expect(r('y_slice')).toBe('01101011');
    expect(r('y_cat')).toBe('10' + '1101' + '01');
    expect(r('y_rot')).toBe('01101101');
    expect(r('y_pos')).toBe('1010' + '0110');
    // asc(0 to 3) <= a(3 downto 0) positionally: asc(0) = a(3)
    expect(r('asc')).toBe('0110');
    expect(r('y_rev')).toBe('0000' + '0110'.split('').reverse().join(''));
    expect(r('bit_i')).toBe(1); // a(5)
    expect(r('y_dyn')).toBe('00100000');
    sim.drive('I[0]', 0, '1n').advanceTo('2n'); // i = 4
    expect(r('bit_i')).toBe(1);
    expect(r('y_dyn')).toBe('00010000');
    expect(sim.diagnostics()).toEqual([]);
  });
});

describe('numeric_std arithmetic', () => {
  const SRC = `${HDR}
entity t is port (a, b : in unsigned(3 downto 0); sa, sb : in signed(3 downto 0);
  sum, diff : out unsigned(3 downto 0); prod : out unsigned(7 downto 0); wide : out unsigned(4 downto 0);
  inc : out unsigned(3 downto 0); ssum : out signed(3 downto 0); sneg : out signed(3 downto 0);
  sext : out signed(7 downto 0); trunc : out unsigned(1 downto 0); shl, shr : out unsigned(3 downto 0); sshr : out signed(3 downto 0);
  lt, eq_n, slt : out boolean; ai : out integer range 0 to 15; si : out integer range -8 to 7;
  quot, rmd : out unsigned(3 downto 0)); end entity;
architecture rtl of t is
begin
  sum  <= a + b;                 -- wraps modulo 16
  diff <= a - b;
  prod <= a * b;                 -- 4 x 4 = 8 bits
  wide <= resize(a, 5) + b;      -- no overflow
  inc  <= a + 1;
  ssum <= sa + sb;
  sneg <= -sa;
  sext <= resize(sa, 8);         -- sign extension
  trunc <= resize(a, 2);
  shl  <= shift_left(a, 1);
  shr  <= shift_right(a, 1);
  sshr <= shift_right(sa, 1);    -- arithmetic
  lt   <= a < b;
  eq_n <= a = 9;
  slt  <= sa < sb;
  ai   <= to_integer(a);
  si   <= to_integer(sa);
  quot <= a / b when b /= 0 else (others => '0');
  rmd  <= a mod b when b /= 0 else (others => '0');
end architecture;`;

  it('matches integer arithmetic modulo the result width for all 4-bit operand pairs', () => {
    const { u, sim } = build(SRC, { ports: { a: 'A', b: 'B', sa: 'SA', sb: 'SB' } }, c => {
      for (const n of ['A', 'B', 'SA', 'SB']) for (let k = 0; k < 4; k++) c.input(`${n}[${k}]`, { initial: 0 });
    });
    const s4 = (x: number): number => (x & 8 ? x - 16 : x);
    let t = 0;
    for (let a = 0; a < 16; a++) {
      for (let b = 0; b < 16; b++) {
        t += 1e-9;
        for (let k = 0; k < 4; k++) {
          for (const [n, v] of [
            ['A', a],
            ['B', b],
            ['SA', a],
            ['SB', b],
          ] as const)
            sim.drive(`${n}[${k}]`, ((v >> k) & 1) as 0 | 1, t);
        }
        sim.advanceTo(t);
        const n = (x: string): number | undefined => u.readNumber(sim, x);
        const ctx = `a=${a} b=${b}`;
        expect(n('sum'), ctx).toBe((a + b) % 16);
        expect(n('diff'), ctx).toBe((a - b + 16) % 16);
        expect(n('prod'), ctx).toBe(a * b);
        expect(n('wide'), ctx).toBe(a + b);
        expect(n('inc'), ctx).toBe((a + 1) % 16);
        expect(n('ssum'), ctx).toBe(s4((s4(a) + s4(b)) & 15));
        expect(n('sneg'), ctx).toBe(s4(-s4(a) & 15));
        expect(n('sext'), ctx).toBe(s4(a));
        expect(n('trunc'), ctx).toBe(a & 3);
        expect(n('shl'), ctx).toBe((a << 1) & 15);
        expect(n('shr'), ctx).toBe(a >> 1);
        expect(n('sshr'), ctx).toBe(s4(a) >> 1);
        expect(u.read(sim, 'lt'), ctx).toBe(a < b);
        expect(u.read(sim, 'eq_n'), ctx).toBe(a === 9);
        expect(u.read(sim, 'slt'), ctx).toBe(s4(a) < s4(b));
        expect(n('ai'), ctx).toBe(a);
        expect(n('si'), ctx).toBe(s4(a));
        expect(n('quot'), ctx).toBe(b ? Math.floor(a / b) : 0);
        expect(n('rmd'), ctx).toBe(b ? a % b : 0);
      }
    }
    expect(sim.diagnostics()).toEqual([]);
  });

  it('metavalues: arithmetic gives all X with a V753 warning', () => {
    const { u, sim } = build(SRC, { ports: { a: 'A', b: 'B', sa: 'SA', sb: 'SB' } }, c => {
      for (const n of ['A', 'B', 'SA', 'SB']) for (let k = 0; k < 4; k++) c.input(`${n}[${k}]`, { initial: 0 });
    });
    sim.drive('A[2]', 'X', '1n').advanceTo('2n');
    expect(u.read(sim, 'sum')).toBe('XXXX');
    expect(u.read(sim, 'lt')).toBe(false);
    expect(u.read(sim, 'ai')).toBe(0);
    expect(new Set(sim.diagnostics().map(d => d.code))).toEqual(new Set(['V753']));
  });

  it('static integer arithmetic folds at elaboration (VHDL / mod rem rules)', () => {
    const r = compileVhdl(`${HDR}
entity t is port (y : out integer range -100 to 100); end entity;
architecture rtl of t is
  constant A : integer := (-7) / 2;   -- -3 (truncates toward zero)
  constant B : integer := (-7) mod 3; -- 2 (sign of the divisor)
  constant C : integer := (-7) rem 3; -- -1 (sign of the dividend)
  constant D : integer := 7 mod (-3); -- -2 (VHDL needs the parentheses)
  constant E : integer := 2 ** 5 + abs (-4);
begin
  y <= A + B + C + D + E;   -- -3 + 2 - 1 - 2 + 36 = 32
end architecture;`);
    expect(r.diagnostics).toEqual([]);
    const { u, sim } = build(`${HDR}
entity t is port (a, b, c, d, e, f : out integer range -100 to 100); end entity;
architecture rtl of t is
begin
  a <= (-7) / 2; b <= (-7) mod 3; c <= (-7) rem 3; d <= 7 mod (-3); e <= 2 ** 5 + abs (-4);
  f <= -7 mod 3;   -- the sign applies to the whole term: -(7 mod 3)
end architecture;`);
    expect(['a', 'b', 'c', 'd', 'e', 'f'].map(n => u.read(sim, n))).toEqual([-3, 2, -1, -2, 36, -1]);
  });
});

describe('types, enums and loops', () => {
  it("case with ranges, enum attributes and a for loop with exit/next", () => {
    const { u, sim } = build(
      `${HDR}
entity t is port (n : in integer range 0 to 15; cls : out integer range 0 to 3; ones : out integer range 0 to 4;
  first_one : out integer range -1 to 3; st_pos : out integer range 0 to 7; st_last : out boolean); end entity;
architecture rtl of t is
  type color_t is (RED, GREEN, BLUE, BLACK);
begin
  process (all)
    variable cnt : integer range 0 to 4;
    variable u4 : unsigned(3 downto 0);
    variable c : color_t;
  begin
    case n is
      when 0 => cls <= 0;
      when 1 to 4 | 7 => cls <= 1;
      when 5 | 6 | 8 to 10 => cls <= 2;
      when others => cls <= 3;
    end case;
    u4 := to_unsigned(n, 4);
    cnt := 0;
    first_one <= -1;
    for k in 0 to 3 loop
      next when u4(k) = '0';
      cnt := cnt + 1;
    end loop;
    ones <= cnt;
    for k in 0 to 3 loop
      if u4(k) = '1' then
        first_one <= k;
        exit;
      end if;
    end loop;
    c := color_t'val(n mod 4);
    st_pos <= color_t'pos(c) + color_t'pos(color_t'high);
    st_last <= c = color_t'right;
  end process;
end architecture;`,
      { ports: { n: 'N' } },
      c => {
        for (let k = 0; k < 4; k++) c.input(`N[${k}]`, { initial: 0 });
      },
    );
    const cls = (n: number): number => (n === 0 ? 0 : (n >= 1 && n <= 4) || n === 7 ? 1 : n === 5 || n === 6 || (n >= 8 && n <= 10) ? 2 : 3);
    let t = 0;
    for (let n = 0; n < 16; n++) {
      t += 1e-9;
      for (let k = 0; k < 4; k++) sim.drive(`N[${k}]`, ((n >> k) & 1) as 0 | 1, t);
      sim.advanceTo(t);
      expect(u.read(sim, 'cls'), `n=${n}`).toBe(cls(n));
      expect(u.read(sim, 'ones'), `n=${n}`).toBe(n.toString(2).split('').filter(x => x === '1').length);
      expect(u.read(sim, 'first_one'), `n=${n}`).toBe(n === 0 ? -1 : Math.log2(n & -n));
      expect(u.read(sim, 'st_pos'), `n=${n}`).toBe((n % 4) + 3);
      expect(u.read(sim, 'st_last'), `n=${n}`).toBe(n % 4 === 3);
    }
    expect(sim.diagnostics()).toEqual([]);
  });

  it('a process starting with `wait until rising_edge(clk)` behaves like a clocked process', () => {
    const { u, sim } = build(
      clocked(
        `  process
  begin
    wait until rising_edge(clk);
    cnt <= cnt + 1;
  end process;`,
        `  signal cnt : unsigned(3 downto 0) := "0000";`,
      ),
      { ports: { clk: 'CLK' } },
      withClock,
    );
    sim.advanceTo('55n');
    expect(u.readNumber(sim, 'cnt')).toBe(5);
  });
});

describe('runtime diagnostics (V75x)', () => {
  it('V751: an integer counter that overflows its range (VHDL integers do not wrap)', () => {
    const { u, sim } = build(
      clocked(
        `  process (clk)
  begin
    if rising_edge(clk) then
      count <= count + 1;
    end if;
  end process;`,
        `  signal count : integer range 0 to 3 := 0;`,
      ),
      { ports: { clk: 'CLK' } },
      withClock,
    );
    sim.advanceTo('35n'); // edges 10, 20, 30 → 1, 2, 3
    expect(u.read(sim, 'count')).toBe(3);
    expect(sim.diagnostics()).toEqual([]);
    sim.advanceTo('45n'); // edge 40: 3 + 1 is outside 0 to 3
    expect(u.read(sim, 'count')).toBe(3); // assignment skipped
    const d = sim.diagnostics();
    expect(d.map(x => x.code)).toEqual(['V751']);
    expect(d[0]).toMatchObject({
      severity: 'error',
      stage: 'tran',
      time: 40e-9,
      subject: { components: ['U1__process_9'] }, // unlabeled process on line 9
      evidence: { value: 4, low: 0, high: 3 },
    });
    expect(d[0].message).toMatch(/signal 'count': value 4 is outside 0 to 3/);
    expect(d[0].at).toMatch(/\(vhdl 12:7\)$/); // the assignment's line:col inside the inline VHDL
    expect(d[0].fixes[0].confidence).toBe('suggested');
  });

  it('V750: dynamic index out of range; V754: division by zero; V752: assert with a formatted message', () => {
    const { sim } = build(
      `${HDR}
entity t is port (i : in integer range 0 to 15; v : in std_logic_vector(3 downto 0); y : out std_logic; q : out integer range -100 to 100); end entity;
architecture rtl of t is
begin
  y <= v(i);
  q <= 100 / i;
  assert i < 12 report "i too large: " & integer'image(i) severity warning;
end architecture;`,
      { ports: { i: 'I', v: 'V' } },
      c => {
        for (let k = 0; k < 4; k++) c.input(`I[${k}]`, { initial: 1 - (k > 0 ? 1 : 0) as 0 | 1 });
        for (let k = 0; k < 4; k++) c.input(`V[${k}]`, { initial: 1 });
      },
    );
    sim.drive('I[0]', 0, '1n').advanceTo('2n'); // i = 0
    sim.drive('I[2]', 1, '3n').drive('I[3]', 1, '3n').advanceTo('4n'); // i = 12
    const d = sim.diagnostics();
    // same time point: components run in id order (U1__assert_8 before U1__assign_6)
    expect(d.map(x => x.code)).toEqual(['V754', 'V752', 'V750']);
    expect(d[2].message).toMatch(/index 12 is outside the range of v \(3 downto 0\)/);
    expect(d[1]).toMatchObject({ severity: 'warning', evidence: { severity: 'warning', message: 'i too large: 12' } });
    expect(sim.value('U1__y')).toBe('X');
  });
});

describe('VHDL-2008 conveniences and small operators', () => {
  it('reduction operators, sll/srl/rotate, ??, sequential conditional assignment, qualified expressions, to_string', () => {
    const { u, sim } = build(
      `${HDR}
entity t is port (v : in std_logic_vector(3 downto 0); en : in std_logic;
  r_and, r_or, r_xor, pick : out std_logic; l, r, rl : out std_logic_vector(3 downto 0); k : out unsigned(3 downto 0)); end entity;
architecture rtl of t is
begin
  r_and <= and v;
  r_or  <= or v;
  r_xor <= xor v;
  l  <= v sll 1;
  r  <= v srl 2;
  rl <= std_logic_vector(rotate_left(unsigned(v), 1));
  k  <= unsigned'("1001");
  process (all)
  begin
    pick <= v(0) when ?? en else v(3);
    if en then
      report "v=" & to_string(v) severity note;
    end if;
  end process;
end architecture;`,
      { ports: { v: 'V', en: 'EN' } },
      c => {
        [1, 0, 1, 1].forEach((b, i) => c.input(`V[${i}]`, { initial: b as 0 | 1 })); // v = "1101"
        c.input('EN', { initial: 0 });
      },
    );
    expect([u.read(sim, 'r_and'), u.read(sim, 'r_or'), u.read(sim, 'r_xor')]).toEqual([0, 1, 1]);
    expect(u.read(sim, 'l')).toBe('1010');
    expect(u.read(sim, 'r')).toBe('0011');
    expect(u.read(sim, 'rl')).toBe('1011');
    expect(u.readNumber(sim, 'k')).toBe(9);
    expect(u.read(sim, 'pick')).toBe(1); // v(3)
    sim.drive('EN', 1, '1n').advanceTo('2n');
    expect(u.read(sim, 'pick')).toBe(1); // v(0)
    const d = sim.diagnostics();
    expect(d.map(x => [x.code, x.severity, x.evidence?.message])).toEqual([['V752', 'warning', 'v=1101']]);
  });
});

describe('codes of the semantic errors are stable', () => {
  it('assigning an integer to a vector is V705 with a mechanical conversion fix', () => {
    const r = compileVhdl(`${HDR}
entity t is port (q : out unsigned(3 downto 0)); end entity;
architecture rtl of t is begin q <= 5; end architecture;`);
    expect(codes(r.diagnostics)).toEqual(['V705']);
    expect(r.diagnostics[0].fixes[0]).toMatchObject({ confidence: 'mechanical', detail: 'use to_unsigned(value, 4)' });
  });
});
