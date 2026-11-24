import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { DigitalCircuit } from '../../src/digital';
import { compileVhdl, instantiateVhdl, VHDL_CODES, VhdlError } from '../../src/vhdl';
import type { VhdlDiagnostic } from '../../src/vhdl';
import { findDiagnosticDoc } from '../../src/verify/registry';
import { HDR, design, codes } from './helpers';

// Every user error is a V7xx diagnostic with a location, a message, a note
// and fixes with a confidence. Unsupported constructs are named, never ignored.

const diags = (src: string | string[]): VhdlDiagnostic[] => compileVhdl(src).diagnostics;
const one = (src: string): VhdlDiagnostic => {
  const d = diags(src);
  expect(d.length, d.map(x => `${x.code} ${x.message}`).join('\n')).toBe(1);
  return d[0];
};
/** Wrap statements into an architecture of a small entity. */
const arch = (decls: string, stmts: string, ports = 'a, b : in std_logic; y : out std_logic') => `${HDR}
entity t is port (${ports}); end entity;
architecture rtl of t is
${decls}
begin
${stmts}
end architecture;`;
const proc = (body: string, decls = '', ports?: string) => arch('', `  process (all)\n${decls}\n  begin\n${body}\n  end process;`, ports);

describe('unsupported constructs (V703) name the construct and list the subset', () => {
  const cases: [string, string, RegExp][] = [
    ['wait for', arch('', `  process\n  begin\n    y <= '1';\n    wait for 10 ns;\n    y <= '0';\n    wait for 10 ns;\n  end process;`), /'wait for' \(time delays in a process\) is not supported/],
    ['wait on', arch('', `  process\n  begin\n    y <= a;\n    wait on a;\n  end process;`), /'wait on' is not supported/],
    ['bare wait', arch('', `  process\n  begin\n    y <= a;\n    wait;\n  end process;`), /a bare 'wait;'/],
    ['while loop', proc(`    while true loop\n      exit;\n    end loop;\n    y <= a;`), /while loops are not supported/],
    ['transport', arch('', `  y <= transport a after 1 ns;`), /'transport' delays are not supported/],
    ['multi-element waveform', arch('', `  y <= '1', '0' after 10 ns;`), /multi-element waveforms/],
    ['real', arch('  constant r : integer := 1.5;', `  y <= a;`), /real \(floating-point\) values are not supported/],
    ["'last_value", proc(`    if a'event and a'last_value = '0' then y <= '1'; end if;`), /signal attribute 'last_value is not supported/],
    ['procedure call', proc(`    my_proc(a);\n    y <= a;`), /procedure calls \('my_proc'\) are not supported/],
    ['file I/O call', proc(`    writeline(output, a);\n    y <= a;`), /'writeline' \(file I\/O \/ simulation control\)/],
    ['bit type', arch('  signal s : bit;', `  y <= a;`), /type 'bit' — use std_logic is not supported/],
    ['records', arch('  type r_t is record x : std_logic; end record;', `  y <= a;`), /record types are not supported/],
    ['array types', arch('  type m_t is array (0 to 3) of std_logic;', `  y <= a;`), /array types are not supported/],
    ['functions', arch('  function f(x : std_logic) return std_logic is begin return not x; end function;', `  y <= a;`), /user-defined functions are not supported/],
    ['file declarations', arch('  file f : text;', `  y <= a;`), /file declarations \(file I\/O\)/],
    ['shared variables', arch('  shared variable v : integer;', `  y <= a;`), /shared variables are not supported/],
    ['aliases', arch('  alias aa : std_logic is a;', `  y <= a;`), /alias declarations are not supported/],
    ['packages', `${HDR}package p is constant c : integer := 1; end package;\n${arch('', '  y <= a;')}`, /packages are not supported/],
    ['blocks', arch('', `  blk: block begin y <= a; end block;`), /block statements are not supported/],
    ['records fields', proc(`    y <= a.x;`), /record fields and selected names are not supported/],
    ['matching case', proc(`    case? a is when '1' => y <= '1'; when others => y <= '0'; end case?;`), /matching case statements/],
    ['aggregate target', proc(`    (y, y) <= std_logic_vector'("10");`), /aggregate assignment targets/],
  ];
  for (const [name, src, re] of cases) {
    it(name, () => {
      const ds = diags(src);
      const d = ds.find(x => x.code === 'V703');
      expect(d, ds.map(x => `${x.code} ${x.message}`).join('\n')).toBeDefined();
      expect(d!.message).toMatch(re);
      expect(d!.note).toMatch(/supported: library\/use \(ieee\.std_logic_1164, ieee\.numeric_std\), entity/);
      expect(d!.at).toMatch(/\(vhdl \d+:\d+\)$/);
      expect(compileVhdl(src).ok).toBe(false);
    });
  }
});

describe('compile-time diagnostics', () => {
  it('V704 undeclared name with a did-you-mean fix', () => {
    const d = one(arch('  signal count : std_logic;', '  y <= cuont;'));
    expect(d).toMatchObject({ code: 'V704', severity: 'error', stage: 'lint', message: "name 'cuont' is not declared — did you mean 'count'?" });
    expect(d.fixes).toEqual([{ kind: 'rename', confidence: 'suggested', detail: "replace 'cuont' with 'count'" }]);
    expect(d.at).toMatch(/diagnostics\.test\.ts:\d+ \(vhdl 9:8\)$/);
  });

  it('V705 type errors carry the exact conversion', () => {
    const slvAdd = one(arch('  signal v : std_logic_vector(3 downto 0);', '  v <= v + 1;\n  y <= a;'));
    expect(slvAdd.code).toBe('V705');
    expect(slvAdd.message).toBe("'+' is not defined for std_logic_vector (it has no numeric meaning in ieee.numeric_std)");
    expect(slvAdd.fixes[0]).toMatchObject({ confidence: 'mechanical', detail: 'do the arithmetic on unsigned: std_logic_vector(unsigned(v) + …), or declare the signal as unsigned' });
    const mix = one(arch('', "  y <= '1' when a and (b = '1') else '0';"));
    expect(mix.message).toBe("'and' cannot combine std_logic and boolean");
    const conv = one(arch('  signal u : unsigned(3 downto 0); signal v : std_logic_vector(3 downto 0);', '  v <= u;\n  y <= a;'));
    expect(conv.message).toBe("type mismatch: cannot assign unsigned(3 downto 0) to signal 'v' of type std_logic_vector(3 downto 0)");
    expect(conv.fixes[0]).toEqual({ kind: 'convert', confidence: 'mechanical', detail: 'wrap the value in std_logic_vector(…)' });
    const toInt = one(arch('  signal v : std_logic_vector(3 downto 0); signal n : integer;', '  n <= to_integer(v);\n  y <= a;'));
    expect(toInt.fixes[0].detail).toBe('use to_integer(unsigned(v)) (or signed(…) for two\'s complement)');
    const strBit = one(arch('', '  y <= "1";'));
    expect(strBit.message).toBe('"1" is a string (a vector); a std_logic needs a character literal \'1\'');
  });

  it('V706 length mismatch with a resize fix and both lengths as evidence', () => {
    const d = one(arch('  signal a8 : unsigned(7 downto 0); signal a4 : unsigned(3 downto 0);', '  a4 <= a8;\n  y <= a;'));
    expect(d).toMatchObject({ code: 'V706', evidence: { targetLength: 4, valueLength: 8 } });
    expect(d.fixes[0]).toEqual({ kind: 'resize', confidence: 'mechanical', detail: 'wrap the value in resize(…, 4)' });
  });

  it('V707 missing library/use clause, V708 unsupported packages', () => {
    const d = diags(`entity t is port (a : in std_logic); end; architecture r of t is begin end;`);
    expect(codes(d)).toEqual(['V707']);
    expect(d[0].fixes[0]).toMatchObject({ confidence: 'mechanical', patch: 'library ieee;\nuse ieee.std_logic_1164.all;' });
    const lib = diags(`use ieee.std_logic_1164.all; entity t is end; architecture r of t is begin end;`);
    expect(codes(lib)).toEqual(['V707']);
    expect(lib[0].message).toBe("'use ieee.std_logic_1164…' needs 'library ieee;' first");
    const arith = diags(`library ieee; use ieee.std_logic_1164.all; use ieee.std_logic_arith.all; use ieee.std_logic_unsigned.all;
entity t is end; architecture r of t is begin end;`);
    expect(codes(arith)).toEqual(['V708', 'V708']);
    expect(arith[0].fixes[0]).toMatchObject({ confidence: 'mechanical', patch: 'use ieee.numeric_std.all;' });
    expect(codes(diags(`library ieee; use ieee.std_logic_1164.all; use std.textio.all; entity t is end; architecture r of t is begin end;`))).toEqual(['V708']);
    expect(codes(diags(`use work.my_pkg.all; entity t is end; architecture r of t is begin end;`))).toEqual(['V708']);
    const conv = diags(arch('  signal n : integer;', '  n <= conv_integer(a);\n  y <= a;'));
    expect(conv[0]).toMatchObject({ code: 'V708', message: "'conv_integer' comes from the non-standard ieee.std_logic_arith package, which is not supported" });
  });

  it('V709 architecture without entity; V723 entity without architecture', () => {
    expect(codes(diags(`architecture r of nope is begin end;`))).toEqual(['V709']);
    expect(codes(diags(`entity lonely is end;`))).toEqual(['V723']);
  });

  it('V712 illegal targets', () => {
    expect(one(arch('', "  a <= '1';\n  y <= b;")).message).toBe("'a' is an input port and cannot be assigned");
    expect(one(arch('  constant k : std_logic := \'0\';', "  k <= '1';\n  y <= b;")).message).toBe("'k' is a constant and cannot be assigned");
    const sv = one(proc(`    y := a;`));
    expect(sv).toMatchObject({ code: 'V712', message: "'y' is a signal: assign it with '<=' (':=' is for variables)" });
    expect(sv.fixes[0].confidence).toBe('mechanical');
    expect(one(proc(`    v <= a;\n    y <= v;`, '    variable v : std_logic;')).message).toBe("'v' is a variable: assign it with ':=' ('<=' is for signals)");
  });

  it('V713 non-static widths and bounds', () => {
    const d = one(arch('  signal n : integer range 0 to 7; signal u : unsigned(7 downto 0);', '  u <= to_unsigned(3, n);\n  y <= a;'));
    expect(d.code).toBe('V713');
    expect(d.message).toBe("to_unsigned: the size must be static (a literal, constant, generic or x'length)");
  });

  it('V714 unresolved signal with two drivers; V715 duplicate (case-insensitive) names', () => {
    const d = diags(arch('  signal n : integer range 0 to 3;', '  n <= 1 when a = \'1\' else 0;\n  n <= 2;\n  y <= b;'));
    expect(codes(d)).toEqual(['V714']);
    expect(d[0].message).toMatch(/^integer range 0 to 3 signal 'n' is driven by 2 processes \(assign@10, assign@9\)/); // sorted names
    expect(codes(diags(arch('  signal Count : std_logic;\n  signal count : std_logic;', '  y <= a;')))).toEqual(['V715']);
  });

  it('V716 process without sensitivity list or wait', () => {
    const d = one(arch('', '  process\n  begin\n    y <= a;\n  end process;'));
    expect(d.code).toBe('V716');
    expect(d.fixes[0]).toMatchObject({ confidence: 'mechanical', detail: 'add a sensitivity list: process(clk) for clocked logic, process(all) for combinational logic' });
  });

  it('V717 incomplete sensitivity list is a warning (compiles)', () => {
    const r = compileVhdl(arch('', '  process (a)\n  begin\n    y <= a and b;\n  end process;'));
    expect(r.ok).toBe(true);
    expect(r.diagnostics.map(d => [d.code, d.severity])).toEqual([['V717', 'warning']]);
    expect(r.diagnostics[0].message).toBe("process reads 'b' outside a clock edge, but it is not in the sensitivity list");
    expect(r.diagnostics[0].fixes[0].detail).toBe('add b to the sensitivity list, or use process(all)');
  });

  it('V718 case coverage and duplicate choices', () => {
    const slv = one(proc(`    case s is\n      when "00" => y <= a;\n      when "01" => y <= b;\n    end case;`, '', 'a, b : in std_logic; s : in std_logic_vector(1 downto 0); y : out std_logic'));
    expect(slv).toMatchObject({ code: 'V718', message: 'the case statement does not cover the other 2-bit values (std_logic has 9 values per bit, including X, Z, U, -)' });
    expect(slv.fixes[0]).toEqual({ kind: 'add-others', confidence: 'mechanical', detail: "add a final 'when others => null;'" });
    const en = one(
      arch(
        '  type st_t is (A0, A1, A2);\n  signal st : st_t;',
        "  process (all)\n  begin\n    case st is\n      when A0 => y <= '0';\n      when A1 => y <= '1';\n    end case;\n  end process;",
      ),
    );
    expect(en.message).toBe('the case statement does not cover a2');
    const dup = one(proc(`    case a is\n      when '0' => y <= '0';\n      when '0' => y <= '1';\n      when others => y <= b;\n    end case;`));
    expect(dup.message).toBe("choice '0' appears twice");
  });

  it('V719 static index / slice errors, V720 invalid literals', () => {
    expect(one(arch('  signal v : std_logic_vector(3 downto 0);', '  y <= v(4);')).message).toBe('index 4 is outside the range of v (3 downto 0)');
    const dir = one(arch('  signal v : std_logic_vector(3 downto 0); signal w : std_logic_vector(1 downto 0);', '  w <= v(0 to 1);\n  y <= a;'));
    expect(dir).toMatchObject({ code: 'V719', message: "slice direction 'to' does not match v (3 downto 0)" });
    expect(dir.fixes[0].detail).toBe('write v(1 downto 0)');
    const lit = one(arch('', "  y <= 'x';"));
    expect(lit).toMatchObject({ code: 'V720', message: "'x' is not a std_logic value (std_logic literals are case-sensitive: write 'X')" });
    expect(lit.fixes[0]).toEqual({ kind: 'replace-text', confidence: 'mechanical', detail: "replace 'x' with 'X'" });
  });

  it('every diagnostic has the platform Diagnostic shape', () => {
    const all = [
      ...diags(arch('', '  y <= nope;')),
      ...diags(arch('', "  y <= 'x';")),
      ...diags(`entity t is port (a : in std_logic); end; architecture r of t is begin end;`),
    ];
    for (const d of all) {
      expect(Object.keys(VHDL_CODES)).toContain(d.code);
      expect(d.slug).toBe(VHDL_CODES[d.code].slug);
      expect(['error', 'warning']).toContain(d.severity);
      expect(d.stage).toBe('lint');
      expect(d.message.length).toBeGreaterThan(10);
      expect(Array.isArray(d.fixes)).toBe(true);
      for (const f of d.fixes) expect(['verified', 'mechanical', 'suggested']).toContain(f.confidence);
      expect(d.at).toBeDefined();
    }
  });
});

describe('source locations', () => {
  const bad = `${HDR}entity t is port (y : out std_logic); end;\narchitecture r of t is begin\n  y <= undefined_thing;\nend;`;

  it('a source with a path reports path:line:col', () => {
    const d = compileVhdl({ text: bad, path: 'rtl/t.vhd' }).diagnostics[0];
    expect(d.at).toBe('rtl/t.vhd:6:8');
  });

  it('inline text reports the calling bench line plus the VHDL line:col', () => {
    const d = compileVhdl(bad).diagnostics[0];
    expect(d.at).toMatch(/^tests\/vhdl\/diagnostics\.test\.ts:\d+ \(vhdl 6:8\)$/);
    expect(compileVhdl(bad, { origin: 'x.bench.ts:12' }).diagnostics[0].at).toBe('x.bench.ts:12 (vhdl 6:8)');
  });

  it('several sources keep their own locations', () => {
    const ds = compileVhdl([{ text: `${HDR}entity a is end;\narchitecture r of a is begin end;`, path: 'a.vhd' }, { text: bad, path: 'b.vhd' }]).diagnostics;
    expect(ds.map(d => d.at)).toEqual(['b.vhd:6:8']);
  });

  it('a compiled process carries its VHDL location to the digital lint', () => {
    const d = design({ text: `${HDR}entity t is port (a : in std_logic; y : out std_logic); end;\narchitecture r of t is begin\n  y <= not a;\nend;`, path: 'rtl/inv.vhd' });
    const c = new DigitalCircuit();
    d.instantiate(c, 'U1');
    const lint = c.lint();
    expect(lint.map(x => [x.code, x.at])).toEqual([['F130', 'rtl/inv.vhd:6:3']]); // input a is not driven
  });
});

describe('instantiate API errors (V721)', () => {
  const SRC = `${HDR}entity t is generic (N : natural := 2); port (a : in std_logic_vector(N-1 downto 0); y : out std_logic); end;
architecture r of t is begin y <= a(0); end;`;

  it('throws VhdlError carrying diagnostics', () => {
    const c = new DigitalCircuit();
    const attempt = (fn: () => unknown): VhdlDiagnostic[] => {
      try {
        fn();
      } catch (e) {
        expect(e).toBeInstanceOf(VhdlError);
        return (e as VhdlError).diagnostics;
      }
      throw new Error('expected a VhdlError');
    };
    expect(attempt(() => instantiateVhdl(c, '1bad', SRC))[0]).toMatchObject({ code: 'V721', message: expect.stringMatching(/invalid instance id/) });
    expect(attempt(() => instantiateVhdl(c, 'U1', SRC, { ports: { nope: 'X' } }))[0].message).toBe("entity 't' has no port 'nope' (ports: a, y)");
    expect(attempt(() => instantiateVhdl(c, 'U1', SRC, { ports: { a: ['A0'] } }))[0].message).toBe("port 'a' (std_logic_vector(1 downto 0)) has 2 nets, but 1 were mapped");
    expect(attempt(() => instantiateVhdl(c, 'U1', SRC, { generics: { M: 1 } }))[0].message).toMatch(/entity 't' has no generic 'm'/);
    expect(attempt(() => instantiateVhdl(c, 'U1', SRC, { generics: { N: 'two' } }))[0].message).toMatch(/generic 'n' of 't' expects an integer \(natural\), got "two"/);
    expect(attempt(() => instantiateVhdl(c, 'U1', [SRC, `${HDR}entity t2 is end; architecture r of t2 is begin end;`]))[0].message).toMatch(/2 top-level entities \(t, t2\)/);
    const err = (() => {
      try {
        instantiateVhdl(c, 'U1', `${HDR}entity t is port (y : out std_logic); end; architecture r of t is begin y <= nope; end;`);
      } catch (e) {
        return e as Error;
      }
    })();
    expect(err!.message).toMatch(/^V704 name 'nope' is not declared.* at .*\(vhdl 4:/);
  });
});

describe('registry', () => {
  const md = fs.readFileSync(path.resolve(__dirname, '../../docs/DIAGNOSTICS.md'), 'utf8');
  for (const info of Object.values(VHDL_CODES)) {
    it(`${info.code} (${info.slug}) is registered and documented`, () => {
      expect(info.code).toMatch(/^V7\d\d$/);
      expect(info.stage).toBe(Number(info.code.slice(1)) >= 750 ? 'tran' : 'lint');
      const doc = findDiagnosticDoc(info.code);
      expect(doc, `registry entry for ${info.code}`).toBeDefined();
      expect(doc!.slug).toBe(info.slug);
      expect(doc!.explanation.length).toBeGreaterThan(80);
      expect(md).toContain(`| \`${info.code}\` | ${info.slug} | ${info.severity} |`);
    });
  }
});
