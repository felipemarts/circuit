import { describe, it, expect } from 'vitest';
import { parseVhdl, printVhdl } from '../../src/vhdl';
import type { DesignFile } from '../../src/vhdl';

// Parser: every supported construct parses to the expected AST, printing and
// re-parsing gives the same AST (round trip), syntax errors carry exact
// line:col, and recovery resumes at the next design unit.

/** Strip locations and redundant parentheses so ASTs compare structurally. */
function strip(x: unknown): unknown {
  if (Array.isArray(x)) return x.map(strip);
  if (x && typeof x === 'object') {
    const o = x as Record<string, unknown>;
    if (o.kind === 'paren') return strip(o.expr);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(o)) if (k !== 'loc' && k !== 'raw') out[k] = strip(v);
    return out;
  }
  return x;
}

function parseOk(text: string): DesignFile {
  const r = parseVhdl(text);
  expect(r.diagnostics, r.diagnostics.map(d => `${d.code} ${d.message} @ ${d.at}`).join('\n')).toEqual([]);
  return r.files[0];
}

const CORPUS = `
library ieee;
use ieee.std_logic_1164.all, ieee.numeric_std.all;

entity everything is
  generic (
    N     : natural  := 8;
    W     : positive := 4;
    EN    : boolean  := true;
    T_DLY : time     := 2 ns;
    INIT  : std_logic_vector(3 downto 0) := x"A"
  );
  port (
    clk, rst  : in    std_logic;
    a, b      : in    std_logic_vector(N-1 downto 0);
    u         : in    unsigned(0 to W-1);
    s         : in    signed(7 downto 0);
    sel       : in    integer range 0 to 3;
    flag      : in    boolean := false;
    y         : out   std_logic_vector(N-1 downto 0);
    bidir     : inout std_logic;
    q         : buffer std_logic
  );
end entity everything;

architecture rtl of everything is
  type state_t is (IDLE, RUN, DONE);
  subtype byte_t is std_logic_vector(7 downto 0);
  subtype small_t is integer range -4 to 3;
  constant C1 : integer := 16#FF# + 2#1010# - 3 * 4 / 2 mod 5 rem 3 ** 2;
  constant C2 : byte_t := (others => '0');
  constant C3 : byte_t := (0 => '1', 7 downto 4 => '1', others => '0');
  constant C4 : std_logic_vector(3 downto 0) := ('1', '0', '1', '0');
  constant C5 : unsigned(7 downto 0) := b"1010_0101";
  signal st : state_t := IDLE;
  signal r1, r2 : std_logic := '0';
  signal cnt : unsigned(3 downto 0);
  signal i1 : small_t;
  component leaf is
    generic (K : natural := 1);
    port (x : in std_logic; z : out std_logic);
  end component;
begin
  -- concurrent assignments
  y <= a and b;
  r1 <= not r2 after 5 ns;
  lbl_cond: r2 <= '1' when a = b else 'Z' when flag else '0';
  with sel select
    bidir <= '0' when 0, '1' when 1 | 2, 'Z' when others;
  q <= a(0) xor b(N-1);

  p_seq: process (clk, rst)
    variable v : integer range 0 to 15 := 0;
    constant K : natural := 3;
  begin
    if rst = '1' then
      cnt <= (others => '0');
      v := 0;
    elsif rising_edge(clk) then
      cnt <= cnt + 1;
      v := v + 1;
      case st is
        when IDLE => st <= RUN;
        when RUN | DONE => st <= IDLE;
      end case;
      for i in 0 to 3 loop
        exit when i = 2;
        next when i = 0;
        cnt(i) <= a(i);
      end loop;
      lp: for k in a'range loop
        null;
      end loop lp;
    end if;
  end process p_seq;

  process (all)
  begin
    if falling_edge(clk) and (a(1) = '1' or b(1) = '1') then
      i1 <= -1;
    else
      i1 <= small_t'high;
    end if;
    assert cnt /= "1111" report "count=" & integer'image(to_integer(cnt)) severity warning;
    report "hello";
  end process;

  process
  begin
    wait until rising_edge(clk);
    r2 <= transport '1' after 1 ns;
  end process;

  u1: entity work.leaf generic map (K => 2) port map (x => a(0), z => open);
  u2: leaf port map (a(1), open);
  u3: component leaf generic map (3) port map (x => '1', z => open);

  gen: for i in 0 to N-1 generate
    signal t : std_logic;
  begin
    t <= a(i);
  end generate gen;

  gi: if EN generate
    q2: assert flag report "x";
  elsif N > 4 generate
  else generate
  end generate;
end architecture rtl;

entity leaf is
  generic (K : natural := 1);
  port (x : in std_logic; z : out std_logic);
end entity;
architecture a of leaf is
begin
  z <= x when K > 0 else '0';
end architecture;
`;

describe('VHDL parser', () => {
  it('parses the supported subset without diagnostics', () => {
    const f = parseOk(CORPUS);
    expect(f.units.map(u => `${u.kind} ${u.name}`)).toEqual(['entity everything', 'architecture rtl', 'entity leaf', 'architecture a']);
  });

  it('round-trips: print(parse(x)) re-parses to the same AST', () => {
    const a = parseOk(CORPUS);
    const printed = printVhdl(a);
    const b = parseOk(printed);
    expect(strip(b)).toEqual(strip(a));
    // printing is a fixpoint after one round
    expect(printVhdl(b)).toBe(printed);
  });

  it('builds the expected AST for entity, generics and ports', () => {
    const f = parseOk(CORPUS);
    const ent = strip(f.units[0]) as Record<string, unknown>;
    expect((ent.context as unknown[]).length).toBe(3);
    expect(ent.context).toEqual([
      { kind: 'library', names: ['ieee'] },
      { kind: 'use', names: ['ieee', 'std_logic_1164', 'all'] },
      { kind: 'use', names: ['ieee', 'numeric_std', 'all'] },
    ]);
    const gens = ent.generics as Record<string, unknown>[];
    expect(gens.map(g => (g.names as string[])[0])).toEqual(['n', 'w', 'en', 't_dly', 'init']);
    expect(gens[3].init).toEqual({ kind: 'phys', value: { kind: 'int', value: 2 }, unit: 'ns' });
    expect(gens[4].init).toEqual({ kind: 'bitstr', value: '1010' });
    const ports = ent.ports as Record<string, unknown>[];
    expect(ports[0]).toEqual({ names: ['clk', 'rst'], mode: 'in', type: { name: 'std_logic' } });
    expect(ports[1].type).toEqual({
      name: 'std_logic_vector',
      index: [{ kind: 'range', left: { kind: 'binary', op: '-', left: { kind: 'id', name: 'n' }, right: { kind: 'int', value: 1 } }, dir: 'downto', right: { kind: 'int', value: 0 } }],
    });
    expect(ports[4].type).toEqual({ name: 'integer', range: { kind: 'range', left: { kind: 'int', value: 0 }, dir: 'to', right: { kind: 'int', value: 3 } } });
    expect(ports.map(p => p.mode)).toEqual(['in', 'in', 'in', 'in', 'in', 'in', 'out', 'inout', 'buffer']);
    expect(ports[5].init).toEqual({ kind: 'id', name: 'false' });
  });

  it('builds the expected AST for statements', () => {
    const f = parseOk(CORPUS);
    const arch = strip(f.units[1]) as { decls: Record<string, unknown>[]; stmts: Record<string, unknown>[] };
    expect(arch.decls.map(d => d.kind)).toEqual(['enum-type', 'subtype', 'subtype', 'constant', 'constant', 'constant', 'constant', 'constant', 'signal', 'signal', 'signal', 'signal', 'component']);
    expect(arch.decls[0]).toEqual({ kind: 'enum-type', name: 'state_t', literals: ['idle', 'run', 'done'] });
    expect(arch.decls[5].init).toEqual({
      kind: 'agg',
      items: [
        { choices: [{ kind: 'expr', expr: { kind: 'int', value: 0 } }], value: { kind: 'char', value: '1' } },
        { choices: [{ kind: 'range', range: { kind: 'range', left: { kind: 'int', value: 7 }, dir: 'downto', right: { kind: 'int', value: 4 } } }], value: { kind: 'char', value: '1' } },
        { choices: [{ kind: 'others' }], value: { kind: 'char', value: '0' } },
      ],
    });
    expect(arch.decls[7].init).toEqual({ kind: 'bitstr', value: '10100101' });
    const kinds = arch.stmts.map(s => `${s.kind}${'form' in s ? `:${s.form}` : ''}`);
    expect(kinds).toEqual([
      'cassign:simple',
      'cassign:simple',
      'cassign:cond',
      'cassign:sel',
      'cassign:simple',
      'process',
      'process',
      'process',
      'instance',
      'instance',
      'instance',
      'for-generate',
      'if-generate',
    ]);
    expect(arch.stmts[1]).toMatchObject({ wave: { elements: [{ value: { kind: 'unary', op: 'not' }, after: { kind: 'phys', unit: 'ns' } }] } });
    expect(arch.stmts[2]).toMatchObject({ label: 'lbl_cond', arms: [{ cond: { kind: 'binary', op: '=' } }, { cond: { kind: 'id', name: 'flag' } }, {}] });
    expect(arch.stmts[3]).toMatchObject({ selector: { kind: 'id', name: 'sel' }, arms: [{ choices: [{ kind: 'expr' }] }, { choices: [{ kind: 'expr' }, { kind: 'expr' }] }, { choices: [{ kind: 'others' }] }] });
    const p = arch.stmts[5] as { label: string; sensitivity: unknown[]; decls: unknown[]; body: Record<string, unknown>[] };
    expect(p.label).toBe('p_seq');
    expect(p.sensitivity).toEqual([{ kind: 'id', name: 'clk' }, { kind: 'id', name: 'rst' }]);
    expect(p.body[0]).toMatchObject({ kind: 'if', arms: [{ cond: { op: '=' } }, { cond: { kind: 'call', prefix: { kind: 'id', name: 'rising_edge' } } }] });
    const elsif = (p.body[0] as { arms: { body: Record<string, unknown>[] }[] }).arms[1].body;
    expect(elsif.map(s => s.kind)).toEqual(['sassign', 'vassign', 'case', 'for', 'for']);
    expect(elsif[3]).toMatchObject({ kind: 'for', param: 'i', body: [{ kind: 'exit', cond: {} }, { kind: 'next' }, { kind: 'sassign', target: { kind: 'call' } }] });
    expect(elsif[4]).toMatchObject({ kind: 'for', label: 'lp', range: { kind: 'attr-range', attr: 'range' } });
    expect((arch.stmts[6] as { sensitivity: unknown }).sensitivity).toBe('all');
    expect((arch.stmts[6] as { body: unknown[] }).body[1]).toMatchObject({ kind: 'assert', severity: { kind: 'id', name: 'warning' }, report: { kind: 'binary', op: '&' } });
    expect((arch.stmts[6] as { body: unknown[] }).body[2]).toMatchObject({ kind: 'assert', report: { kind: 'str', value: 'hello' } });
    expect((arch.stmts[7] as { sensitivity: unknown; body: unknown[] })).toMatchObject({ sensitivity: null, body: [{ kind: 'wait', until: {} }, { kind: 'sassign', wave: { mechanism: 'transport' } }] });
    expect(arch.stmts[8]).toMatchObject({ kind: 'instance', label: 'u1', unit: { kind: 'entity', library: 'work', name: 'leaf' }, generics: [{ formal: { name: 'k' } }], ports: [{ formal: { name: 'x' } }, { actual: { kind: 'open' } }] });
    expect(arch.stmts[9]).toMatchObject({ unit: { kind: 'component', name: 'leaf' }, ports: [{ actual: { kind: 'call' } }, { actual: { kind: 'open' } }] });
    expect(arch.stmts[11]).toMatchObject({ kind: 'for-generate', label: 'gen', param: 'i', decls: [{ kind: 'signal' }], stmts: [{ kind: 'cassign' }] });
    expect((arch.stmts[12] as { arms: unknown[] }).arms).toHaveLength(3);
  });

  it('keeps operator precedence (VHDL: logical < relational < shift < adding < multiplying < **/abs/not)', () => {
    const f = parseOk(`entity e is end; architecture a of e is constant c : integer := -2 + 3 * 4 ** 2; constant d : boolean := 1 + 2 < 4 and 2 = 2; begin end;`);
    const d = strip((f.units[1] as { decls: unknown[] }).decls) as { init: unknown }[];
    expect(d[0].init).toEqual({
      kind: 'binary',
      op: '+',
      left: { kind: 'unary', op: '-', operand: { kind: 'int', value: 2 } },
      right: { kind: 'binary', op: '*', left: { kind: 'int', value: 3 }, right: { kind: 'binary', op: '**', left: { kind: 'int', value: 4 }, right: { kind: 'int', value: 2 } } },
    });
    expect(d[1].init).toMatchObject({ kind: 'binary', op: 'and', left: { op: '<', left: { op: '+' } }, right: { op: '=' } });
  });

  it('lexes literals: based, bit strings with widths, physical, characters vs attribute ticks', () => {
    const f = parseOk(`entity e is end; architecture a of e is
      constant a : integer := 16#1F# + 2#1_0#;
      constant b : std_logic_vector(7 downto 0) := 8x"F";
      constant c : std_logic_vector(5 downto 0) := o"17";
      constant d : time := 1.5 us;
      constant e2 : integer := b'length;
    begin end;`);
    const d = strip((f.units[1] as { decls: unknown[] }).decls) as { init: unknown }[];
    expect(d[0].init).toEqual({ kind: 'binary', op: '+', left: { kind: 'int', value: 31 }, right: { kind: 'int', value: 2 } });
    expect(d[1].init).toEqual({ kind: 'bitstr', value: '00001111' });
    expect(d[2].init).toEqual({ kind: 'bitstr', value: '001111' });
    expect(d[3].init).toEqual({ kind: 'phys', value: { kind: 'real', value: 1.5 }, unit: 'us' });
    expect(d[4].init).toEqual({ kind: 'attr', prefix: { kind: 'id', name: 'b' }, attr: 'length' });
  });

  it('is case-insensitive for keywords and identifiers', () => {
    const f = parseOk(`ENTITY Foo IS PORT (Clk : IN STD_LOGIC); END ENTITY Foo; Architecture RTL of FOO is Begin End;`);
    expect(f.units.map(u => u.name)).toEqual(['foo', 'rtl']);
  });
});

describe('VHDL syntax errors', () => {
  const first = (text: string) => {
    const r = parseVhdl(text);
    expect(r.diagnostics.length).toBeGreaterThan(0);
    return r.diagnostics[0];
  };

  it('missing semicolon: exact line:col of the next token', () => {
    const d = first(`entity e is\n  port (a : in std_logic)\nend entity;\n`);
    expect(d.code).toBe('V701');
    expect(d.message).toBe("expected ';' after the port clause, found 'end'");
    expect(d.at).toMatch(/\(vhdl 3:1\)$|^vhdl:3:1$/);
    expect(d.evidence).toMatchObject({ line: 3, col: 1 });
    expect(d.fixes[0]).toMatchObject({ confidence: 'mechanical' });
  });

  it('elseif / endif get a targeted mechanical fix', () => {
    const d = first(`entity e is end; architecture a of e is begin process(all) begin\n  if true then null;\n  elseif false then null;\n  end if;\nend process; end;`);
    expect(d.code).toBe('V701');
    expect(d.message).toBe("'elseif' is not VHDL; write 'elsif'");
    expect(d.evidence).toMatchObject({ line: 3, col: 3 });
    expect(d.fixes[0]).toEqual({ kind: 'replace-text', confidence: 'mechanical', detail: "replace 'elseif' with 'elsif'" });
  });

  it('mixing and/or without parentheses', () => {
    const d = first(`entity e is end; architecture a of e is constant c : boolean := true and false or true; begin end;`);
    expect(d.code).toBe('V701');
    expect(d.message).toBe("mixing 'and' and 'or' needs parentheses");
    expect(d.evidence).toMatchObject({ line: 1, col: 80 });
  });

  it('trailing semicolon in a port list and comma between declarations', () => {
    expect(first(`entity e is port (a : in std_logic;); end;`).message).toMatch(/unexpected ';' before '\)'/);
    expect(first(`entity e is port (a : in std_logic, b : in std_logic); end;`).message).toMatch(/expected an identifier|expected ';' between port declarations/);
  });

  it('mismatched end names', () => {
    const d = first(`entity e is end entity f;`);
    expect(d.message).toBe("'end entity f' does not match entity 'e'");
    expect(d.evidence).toMatchObject({ line: 1, col: 24 });
  });

  it('lexical errors (V702): unterminated string, glued unit, double underscore, stray characters', () => {
    expect(first(`entity e is end; architecture a of e is constant s : string := "abc;\nbegin end;`)).toMatchObject({ code: 'V702', message: 'unterminated string literal', evidence: { line: 1, col: 64 } });
    expect(first(`entity e is end; architecture a of e is constant t : time := 10ns; begin end;`)).toMatchObject({ code: 'V702', message: "invalid literal '10ns'" });
    expect(first(`entity e is port (my__sig : in bit); end;`)).toMatchObject({ code: 'V702' });
    expect(first(`entity e is end; { }`)).toMatchObject({ code: 'V702', message: 'invalid character "{" in VHDL source' });
  });

  it('recovers at the next design unit: one first error per broken unit', () => {
    const r = parseVhdl(`entity a is port (x : in std_logic) end;\nentity b is end;\narchitecture r of b is begin y <= ; end;\nentity c is end;\n`);
    expect(r.diagnostics.map(d => [d.code, d.evidence?.line])).toEqual([
      ['V701', 1],
      ['V701', 3],
    ]);
    expect(r.files[0].units.map(u => u.name)).toEqual(['b', 'c']);
  });

  it('reports unsupported constructs (V703) without aborting the unit', () => {
    const r = parseVhdl(`library ieee; use ieee.std_logic_1164.all;
entity e is port (a : in std_logic; y : out std_logic); end;
architecture rtl of e is
  type mem_t is array (0 to 3) of std_logic;
  type rec_t is record x : std_logic; end record;
  function f(x : std_logic) return std_logic is begin return x; end function;
  file fh : text;
begin
  y <= a;
end;`);
    expect(r.diagnostics.map(d => [d.code, d.evidence?.construct])).toEqual([
      ['V703', 'array types'],
      ['V703', 'record types'],
      ['V703', 'user-defined functions'],
      ['V703', 'file declarations (file I/O)'],
    ]);
    expect(r.diagnostics[0].note).toMatch(/supported: library\/use/);
    // the architecture still parsed
    expect(r.files[0].units.map(u => u.kind)).toEqual(['entity', 'architecture']);
  });
});
