import { describe, it, expect } from 'vitest';
import {
  bench,
  runLadderAsync,
  VhdlBlock,
  Part,
  VoltageSource,
  Resistor,
  Capacitor,
  Clock,
  Not,
  toCircuitDoc,
  benchFromDoc,
  canonicalJson,
  createShareLink,
  decodeShareUrl,
  stripLocations,
  type RunRecord,
} from '../../src/forge';
import { logicFamilyModel } from '../../src/mixed/families';
import { frequency } from '../../src/digital/measure';
import { load, withoutAt } from '../share/helpers';
import { wavesAsync, at } from './helpers';

const COUNTER = `library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;
entity cnt is
  generic (N : positive := 3);
  port (clk : in std_logic; q : out unsigned(N - 1 downto 0));
end entity;
architecture rtl of cnt is
  signal c : unsigned(N - 1 downto 0) := (others => '0');
begin
  process (clk) begin
    if rising_edge(clk) then c <= c + 1; end if;
  end process;
  q <= c;
end architecture;`;

describe('VHDL blocks in benches', () => {
  it('pins are port bits; a 4-bit counter on a PULSE clock drives LEDs through resistors (bench/vhdl/counter-leds)', async () => {
    const desc = await load('bench/vhdl/counter-leds.bench.ts');
    const r = await runLadderAsync(desc);
    expect(r.exitCode).toBe(0);
    const u2 = r.netlist.components.find(c => c.id === 'U2')!;
    expect(u2.type).toBe('VhdlBlock');
    expect(Object.keys(u2.pins).sort()).toEqual(['clk', 'en', 'q[0]', 'q[1]', 'q[2]', 'q[3]', 'rst']);
    expect(u2.params).toEqual({ source: 'bench/vhdl/counter.vhd', entity: 'counter', generics: { N: 4 }, family: 'HC', vcc: 5 });
    // LED current while q[0] is high: (VOH − Vf) / R with VOH = 5 V − Rout·I (74HC Rout at 5 V).
    const w = await wavesAsync(desc, 4e-3, ['D0.i', 'D0.v'], 50e-6);
    const i = at(w.t, w.v['D0.i'], 0.9e-3); // count 1 after the edge at 0.5 ms
    const rout = logicFamilyModel('74HC04').rOutHigh(5, 'typ');
    expect(i * (470 + rout)).toBeCloseTo(5 - at(w.t, w.v['D0.v'], 0.9e-3), 4);
    const q0 = w.elab.mixed!.controller.trace(w.elab.mixed!.logicSignal('U2.q[0]')!)!;
    // Zero-delay VHDL process: q[0] changes at the clock's VIH (3.5 V) crossing, 70 ns into its 100 ns rise.
    expect(q0.t.slice(1, 4).map(t => Number(t.toPrecision(6)))).toEqual([0.00050007, 0.00150007, 0.00250007]);
  });

  it('an NE555 astable clocks a VHDL counter: q[0] runs at half the 555 frequency', async () => {
    const desc = bench('555-vhdl', tb => {
      const vcc = tb.add('VCC', new VoltageSource(5));
      const u1 = tb.add('U1', Part('NE555'));
      const r1 = tb.add('R1', new Resistor('1k'));
      const r2 = tb.add('R2', new Resistor('10k'));
      const c1 = tb.add('C1', new Capacitor('100n'));
      const u2 = tb.add('U2', new VhdlBlock({ source: COUNTER }));
      vcc.pin('-').connect(tb.gnd);
      u1.pin('VCC').connect(vcc.pin('+'));
      u1.pin('GND').connect(tb.gnd);
      u1.pin('RESET').connect(vcc.pin('+'));
      r1.pin('1').connect(vcc.pin('+'));
      r1.pin('2').connect(u1.pin('DISCH'));
      r2.pin('1').connect(u1.pin('DISCH'));
      r2.pin('2').connect(u1.pin('THRES'));
      u1.pin('TRIG').connect(u1.pin('THRES'));
      c1.pin('1').connect(u1.pin('THRES'));
      c1.pin('2').connect(tb.gnd);
      u1.pin('OUT').connect(u2.pin('clk'));
      for (let k = 0; k < 3; k++) {
        const rl = tb.add(`RL${k}`, new Resistor('10k'));
        u2.pin(`q[${k}]`).connect(rl.pin('1'));
        rl.pin('2').connect(tb.gnd);
      }
      const run = tb.expect.tran({ tstop: '30m', maxStep: '20u' });
      run.logic('U1.OUT').toToggle({ min: 20 });
      run.logic('U2.q[0]').toToggle({ min: 10 });
    });
    const r = await runLadderAsync(desc);
    expect(r.exitCode).toBe(0);
    const w = await wavesAsync(desc, 30e-3, [], 20e-6);
    const c = w.elab.mixed!.controller;
    const fClk = frequency(c.trace(w.elab.mixed!.logicSignal('U1.OUT')!)!, { from: 5e-3, to: 30e-3 })!;
    const fQ0 = frequency(c.trace(w.elab.mixed!.logicSignal('U2.q[0]')!)!, { from: 5e-3, to: 30e-3 })!;
    expect(fClk).toBeGreaterThan(550);
    expect(fClk).toBeLessThan(750);
    expect(Math.abs(fQ0 / (fClk / 2) - 1)).toBeLessThan(0.01);
  });

  it('ports connect directly to logic primitives (pure-digital nets): bench/vhdl/pwm-generic, and a Clock → VHDL → Not chain on the event engine alone', async () => {
    const r = await runLadderAsync(await load('bench/vhdl/pwm-generic.bench.ts'));
    expect(r.exitCode).toBe(0);
    const pure = bench('vhdl-pure', tb => {
      const ck = tb.add('CK', new Clock({ freq: '1M' }));
      const u3 = tb.add('U3', new VhdlBlock({ source: COUNTER, generics: { N: 2 } }));
      const g1 = tb.add('G1', new Not({ delay: '5n' }));
      ck.pin('y').connect(u3.pin('clk'));
      u3.pin('q[1]').connect(g1.pin('a'));
      tb.name('nq1', g1.pin('y'));
      tb.expect.logic('nq1', { tstop: '10u' }).toHaveFrequency('250k', 1e-6, { from: '1u' });
      tb.expect.logic('U3.q[0]').toHaveFrequency('500k', 1e-6, { from: '1u' });
    });
    const p = await runLadderAsync(pure);
    expect(p.exitCode).toBe(0);
    expect(p.stages.op).toMatchObject({ verdict: 'pass' });
    expect(p.stages.tran!.solver!.acceptedSteps).toBe(0); // digital engine alone
  });

  it('a VHDL syntax error is V701 with the .vhd file:line:col in the RunRecord (bench/broken/vhdl-syntax-error)', async () => {
    const r = await runLadderAsync(await load('bench/broken/vhdl-syntax-error.bench.ts'));
    expect(r.exitCode).toBe(2);
    expect(r.diagnostics).toHaveLength(1);
    expect(r.diagnostics[0]).toMatchObject({ code: 'V701', stage: 'lint', at: 'bench/broken/counter-typo.vhd:16:5', subject: { components: ['U2'] } });
    expect(r.stages.tran).toMatchObject({ verdict: 'skipped' });
  });

  it('inline VHDL text: diagnostics point at the tb.add line plus the VHDL line:col; runtime errors keep their VHDL location', async () => {
    const bad = bench('inline-bad', tb => {
      const u2 = tb.add('U2', new VhdlBlock({ source: COUNTER.replace('c <= c + 1;', 'c <= c + 1') }));
      const k = tb.add('K', new Clock({ freq: '1M' }));
      k.pin('y').connect(u2.pin('clk'));
      tb.expect.logic('U2.q[0]', { tstop: '5u' }).toBe(1);
    });
    const r = await runLadderAsync(bad);
    expect(r.exitCode).toBe(2);
    expect(r.diagnostics[0].code).toBe('V701');
    expect(r.diagnostics[0].at).toMatch(/^tests\/mcuint\/vhdl\.test\.ts:\d+ \(vhdl 12:\d+\)$/);
    const range = `library ieee; use ieee.std_logic_1164.all;
entity sat is port (clk : in std_logic; o : out std_logic); end entity;
architecture rtl of sat is
  signal n : integer range 0 to 3 := 0;
begin
  process (clk) begin
    if rising_edge(clk) then n <= n + 1; end if;
  end process;
  o <= '1' when n = 3 else '0';
end architecture;`;
    const run = bench('inline-range', tb => {
      const u2 = tb.add('U2', new VhdlBlock({ source: range }));
      const k = tb.add('K', new Clock({ freq: '1M' }));
      k.pin('y').connect(u2.pin('clk'));
      tb.expect.logic('U2.o', { tstop: '6u' }).toBe(1);
    });
    const rr = await runLadderAsync(run);
    const v751 = rr.diagnostics.find(d => d.code === 'V751') as RunRecord['diagnostics'][number] & { time?: number };
    expect(v751).toBeDefined();
    expect(v751.at).toMatch(/\(vhdl 7:\d+\)$/);
    expect(v751.time).toBeCloseTo(4e-6, 12); // 4th rising edge (1, 2, 3, 4 µs): n would become 4
  });

  it('documents embed the VHDL and firmware sources; bench, document and share link give byte-identical RunRecords', async () => {
    for (const rel of ['bench/vhdl/counter-leds.bench.ts', 'bench/vhdl/pwm-generic.bench.ts', 'bench/mcu/uno-blink.bench.ts', 'bench/mcu/uno-button-interrupt.bench.ts']) {
      const desc = await load(rel);
      const original = await runLadderAsync(desc);
      const doc = toCircuitDoc(desc);
      const kinds = doc.sources!.map(s => [s.path, s.language]);
      if (rel.includes('vhdl')) expect(kinds).toEqual([[rel.includes('counter') ? 'bench/vhdl/counter.vhd' : 'bench/vhdl/pwm.vhd', 'vhdl']]);
      else expect(kinds).toEqual([[rel.includes('blink') ? 'bench/mcu/blink.fw.ts' : 'bench/mcu/button-counter.fw.ts', 'typescript']]);
      const replayed = await runLadderAsync(benchFromDoc(JSON.parse(canonicalJson(doc, 2))));
      expect(JSON.stringify(replayed)).toBe(JSON.stringify(original));
      const link = await createShareLink(doc);
      const decoded = await decodeShareUrl(link.url);
      expect(canonicalJson(decoded)).toBe(canonicalJson(stripLocations(doc)));
      expect(decoded.sources).toEqual(doc.sources);
      const fromLink = await runLadderAsync(benchFromDoc(decoded));
      // Bench `at` lines are dropped; firmware / VHDL locations (paths of embedded sources) remain.
      expect(JSON.stringify(withoutAt(fromLink))).toBe(JSON.stringify(withoutAt(original)));
    }
  }, 30000);

  it('a share link keeps firmware locations (they point into the embedded sources)', async () => {
    const doc = toCircuitDoc(await load('bench/broken/mcu-firmware-exception.bench.ts'));
    const decoded = await decodeShareUrl((await createShareLink(doc)).url);
    const r = await runLadderAsync(benchFromDoc(decoded));
    expect(r.diagnostics.find(d => d.code === 'M601')!.at).toBe('bench/broken/crash.fw.ts:13');
    expect(decoded.components.every(c => c.at === undefined)).toBe(true);
  });

  it('a document whose firmware/VHDL source is missing is T014; an inout port on an analog net is refused', async () => {
    const doc = toCircuitDoc(await load('bench/mcu/uno-blink.bench.ts'));
    let err: unknown;
    try {
      benchFromDoc({ ...doc, sources: [] });
    } catch (e) {
      err = e;
    }
    expect((err as { code?: string }).code).toBe('T014');
    expect(String((err as Error).message)).toMatch(/firmware 'bench\/mcu\/blink\.fw\.ts' is not among the document's sources/);
    const io = `library ieee; use ieee.std_logic_1164.all;
entity bidi is port (d : inout std_logic); end entity;
architecture rtl of bidi is begin d <= 'Z'; end architecture;`;
    const r = await runLadderAsync(
      bench('inout', tb => {
        const u = tb.add('U', new VhdlBlock({ source: io }));
        const r1 = tb.add('R1', new Resistor('1k'));
        u.pin('d').connect(r1.pin('1'));
        r1.pin('2').connect(tb.gnd);
        tb.expect.logic('U.d', { tstop: '1u' }).toBe('Z');
      }),
    );
    expect(r.exitCode).toBe(3);
    expect(r.diagnostics[0].message).toMatch(/inout port bit 'd' of U|'U': inout port bit 'd'/);
  });
});

describe('catalog entries (MCU profiles, board, VhdlBlock)', () => {
  it('lists Mcu, ArduinoUno, the four profiles and VhdlBlock with pins, PWM, limits and citations', async () => {
    const { COMPONENT_CATALOG, GRAMMAR_NOTES } = await import('../../src/cli/catalog');
    const byType = new Map(COMPONENT_CATALOG.map(e => [e.type, e]));
    for (const t of ['Mcu', 'ArduinoUno', 'ATmega328P', 'ATtiny85', 'ESP32', 'RP2040', 'VhdlBlock']) expect(byType.has(t), t).toBe(true);
    const uno = byType.get('ArduinoUno')!;
    expect(uno.pins).toContain('D9 (PWM 490 Hz)');
    expect(uno.pins).toContain('5V (supply, = VCC)');
    const details = uno.details!.join('\n');
    expect(details).toContain('Rout high 40 Ω, low 45 Ω');
    expect(details).toContain('per pin 40 mA absolute (R410)');
    expect(details).toMatch(/source: https:\/\/ww1\.microchip\.com\/.*DS40002061B/);
    expect(byType.get('ESP32')!.details!.join('\n')).toContain('(ESTIMATED)');
    expect(byType.get('VhdlBlock')!.details!.join('\n')).toContain('not supported (clear V703/V708)');
    expect(GRAMMAR_NOTES).toContain('SERIAL ASSERTIONS');
  });
});
