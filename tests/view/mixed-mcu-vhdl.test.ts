import { describe, it, expect } from 'vitest';
import { toCircuitDoc, runLadderAsync, benchFromDoc, createShareLink, decodeShareUrl } from '../../src/forge';
import { simulateDoc } from '../../src/view/simulate';
import { diagnosticModels, highlightModels, logicModel, ratingGroups, scopeModel, serialModels, sourceLocation, sourceModels, verdictModel } from '../../src/view/models';
import { layoutCircuit } from '../../src/view/layout';
import { symbolFor } from '../../src/view/symbols';
import { highlightLines, languageOf } from '../../src/view/highlight';
import { eng } from '../../src/view/format';
import { load } from '../share/helpers';

// The viewer's data path for the release components: microcontroller
// benches (asynchronous ladder, firmware transpiled from the document's
// sources), VHDL blocks, op-amps/comparators — decode → run → panel models
// and symbols. Everything runs in Node exactly as it does in the worker.

async function docOf(rel: string) {
  const desc = await load(rel);
  const doc = toCircuitDoc(desc);
  const { url } = await createShareLink(doc, { baseUrl: 'http://localhost/app.html' });
  return decodeShareUrl(url);
}

describe('viewer: microcontroller benches', () => {
  it('uno-blink: async ladder, serial console, MCU pin in the logic analyzer, firmware source panel', async () => {
    const doc = await docOf('bench/mcu/uno-blink.bench.ts');
    expect(doc.sources?.map(s => s.path)).toEqual(['bench/mcu/blink.fw.ts']);
    const sim = await simulateDoc(doc, undefined, { yield: false });
    const cli = await runLadderAsync(benchFromDoc(doc), { overrides: doc.overrides });
    expect(sim.record.verdict).toBe('pass');
    expect(sim.record.exitCode).toBe(cli.exitCode);
    expect(sim.record.netlist.hash).toBe(cli.netlist.hash);
    expect(sim.notes).toEqual([]);
    // waveforms + logic + serial collected by the extra run
    const tr = sim.tran!;
    expect(tr.t.length).toBeGreaterThan(50);
    expect(Object.keys(tr.logic!.signals)).toEqual(['U1.D13']);
    expect(tr.serial).toHaveLength(1);
    expect(tr.serial![0].mcu).toBe('U1');
    expect(tr.serial![0].lines).toEqual([[0, 'blink ready']]);
    expect(tr.serial![0].config).toBe(tr.label);
    // panel models
    const serial = serialModels(sim.record, sim);
    expect(serial[0].lines.map(l => l.text)).toEqual(['blink ready']);
    expect(serial[0].verdict).toBe('pass'); // run.serial('U1').toContain('ready')
    const logic = logicModel(sim.record, tr.logic)!;
    expect(logic.signals.map(s => s.name)).toEqual(['U1.D13']);
    expect(logic.signals[0].verdict).toBe('pass');
    const sources = sourceModels(doc, sim.record);
    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({ path: 'bench/mcu/blink.fw.ts', name: 'blink.fw.ts', lang: 'ts', kind: 'firmware', owners: ['U1'], marks: [] });
    // MCU ratings land in the same panel as R40x
    const groups = ratingGroups(doc, sim.record);
    expect(groups.find(g => g.component === 'U1')!.rows.map(r => r.code).sort()).toEqual(['R410', 'R412', 'R413']);
    expect(groups.every(g => !g.failed)).toBe(true);
  });

  it('uno-button-interrupt: interrupt pin, named net and serial lines follow the transient', async () => {
    const doc = await docOf('bench/mcu/uno-button-interrupt.bench.ts');
    const sim = await simulateDoc(doc, undefined, { yield: false });
    expect(sim.record.verdict).toBe('pass');
    expect(Object.keys(sim.tran!.logic!.signals).sort()).toEqual(['U1.D13', 'U1.D2', 'button']);
    const serial = serialModels(sim.record, sim)[0];
    expect(serial.lines.map(l => l.text)).toEqual(['presses=1', 'presses=2', 'presses=3', 'presses=4', 'presses=5']);
    expect(serial.lines.map(l => l.t)).toEqual([0.025, 0.085, 0.145, 0.205, 0.265]);
    // analog probes of the same run stay in the scope
    expect(scopeModel(doc, sim.record, sim)!.traces.map(t => t.probe)).toContain('button');
  });

  it('mcu-led-no-resistor: R410 is a failed rating group with a highlight badge (exit 1)', async () => {
    const doc = await docOf('bench/broken/mcu-led-no-resistor.bench.ts');
    const sim = await simulateDoc(doc, undefined, { yield: false });
    expect(sim.record.exitCode).toBe(1);
    const u1 = ratingGroups(doc, sim.record).find(g => g.component === 'U1')!;
    expect(u1.failed).toBe(true);
    const r410 = u1.rows.find(r => r.code === 'R410')!;
    expect(r410.verdict).toBe('fail');
    expect(r410.utilization).toBeGreaterThan(1.5);
    expect(r410.fixes.length).toBeGreaterThan(0);
    expect(highlightModels(sim.record)).toContainEqual({ id: 'U1', kind: 'rating', badge: 'R410' });
    expect(verdictModel(doc, sim.record).firstFailure).toBe('R410');
  });

  it('mcu-firmware-exception: M601 carries the firmware file:line, which maps into the embedded source', async () => {
    const doc = await docOf('bench/broken/mcu-firmware-exception.bench.ts');
    const sim = await simulateDoc(doc, undefined, { yield: false });
    expect(sim.record.exitCode).toBe(2);
    const m601 = diagnosticModels(sim.record).find(d => d.code === 'M601')!;
    expect(m601.at).toBe('bench/broken/crash.fw.ts:13');
    expect(sourceLocation(m601.at, doc)).toEqual({ path: 'bench/broken/crash.fw.ts', line: 13, col: undefined });
    const src = sourceModels(doc, sim.record)[0];
    expect(src.marks).toEqual([{ line: 13, col: undefined, code: 'M601', severity: 'error', message: expect.stringContaining('firmware threw') }]);
    expect(sourceLocation('bench/x.bench.ts:3', doc)).toBeUndefined(); // the bench file is not embedded
  });
});

describe('viewer: VHDL benches', () => {
  it('counter-leds: port bits are logic signals, the block compiles into a bus symbol', async () => {
    const doc = await docOf('bench/vhdl/counter-leds.bench.ts');
    const sim = await simulateDoc(doc, undefined, { yield: false });
    expect(sim.record.verdict).toBe('pass');
    expect(Object.keys(sim.tran!.logic!.signals).sort()).toEqual(['U2.q[0]', 'U2.q[1]', 'U2.q[2]', 'U2.q[3]']);
    const u2 = doc.components.find(c => c.id === 'U2')!;
    const sym = symbolFor(u2, { sources: doc.sources });
    expect(sym.kind).toBe('ic');
    expect(sym.value).toBe('counter.vhd');
    expect(sym.pins.filter(p => p.side === 'l').map(p => p.name)).toEqual(['clk', 'rst', 'en']);
    expect(sym.pins.filter(p => p.side === 'r').map(p => p.name)).toEqual(['q[3]', 'q[2]', 'q[1]', 'q[0]']); // MSB on top
    expect(sym.svg).toContain('q[3:0]');
    const src = sourceModels(doc, sim.record)[0];
    expect(src).toMatchObject({ lang: 'vhdl', kind: 'vhdl', owners: ['U2'] });
  });

  it('vhdl-syntax-error: V701 points into the .vhd (line:col) and the symbol still draws', async () => {
    const doc = await docOf('bench/broken/vhdl-syntax-error.bench.ts');
    const sim = await simulateDoc(doc, undefined, { yield: false });
    expect(sim.record.exitCode).toBe(2);
    const v = diagnosticModels(sim.record).find(d => d.code === 'V701')!;
    expect(sourceLocation(v.at, doc)).toEqual({ path: 'bench/broken/counter-typo.vhd', line: 16, col: 5 });
    expect(sourceModels(doc, sim.record)[0].marks[0]).toMatchObject({ line: 16, col: 5, code: 'V701' });
    const u2 = doc.components.find(c => c.type === 'VhdlBlock')!;
    const sym = symbolFor(u2, { sources: doc.sources });
    expect(sym.label).toBe(u2.id);
    expect(sym.pins.map(p => p.name).sort()).toEqual(Object.keys(u2.pins).sort());
    expect(layoutCircuit(doc).components.length).toBe(doc.components.length);
  });
});

describe('viewer: logic analyzer signal selection', () => {
  it('an analog RC node that only feeds logic inputs stays out of the logic panel (ne555, hc14)', async () => {
    for (const [bench, expected] of [
      ['bench/digital/ne555-astable-led.bench.ts', ['out']],
      ['bench/digital/hc14-schmitt-oscillator.bench.ts', ['osc']],
    ] as const) {
      const doc = await docOf(bench);
      const sim = await simulateDoc(doc, undefined, { yield: false });
      expect(Object.keys(sim.tran!.logic!.signals), bench).toEqual(expected);
      // …but it is still a scope trace
      const scope = scopeModel(doc, sim.record, sim)!;
      expect(scope.traces.map(t => t.probe), bench).toContain(bench.includes('555') ? 'timing' : 'ramp');
    }
  });
});

describe('viewer: symbols for the release components', () => {
  it('op-amp / comparator triangles map inp, inn, out, v+, v- and the LM311 emit pin', () => {
    const lm311 = symbolFor({ id: 'U1', type: 'Comparator', params: { part: 'LM311' }, pins: { inp: 'a', inn: 'b', out: 'c', 'v+': 'vcc', 'v-': 'gnd', emit: 'gnd' } });
    expect(lm311.kind).toBe('opamp');
    expect(lm311.value).toBe('LM311');
    const by = Object.fromEntries(lm311.pins.map(p => [p.name, p]));
    expect(by.inp.side).toBe('l');
    expect(by.inn.side).toBe('l');
    expect(by.out.side).toBe('r');
    expect(by['v+'].side).toBe('t');
    expect(by['v-'].side).toBe('b');
    expect(by.emit.side).toBe('b');
    expect(by.emit.x).not.toBe(by['v-'].x);
    for (const p of lm311.pins) expect(Math.abs(p.x) === lm311.w / 2 || Math.abs(p.y) === lm311.h / 2, `${p.name} on the bounding box`).toBe(true);
    const ideal = symbolFor({ id: 'U2', type: 'IdealOpAmp', params: {}, pins: { inp: 'a', inn: 'b', out: 'c' } });
    expect(ideal.value).toBe('ideal');
    expect(ideal.pins.map(p => p.name).sort()).toEqual(['inn', 'inp', 'out']);
  });

  it('Arduino Uno: header rows, supply pins, firmware label; bare profiles get a VCC/GND box', () => {
    const pins = Object.fromEntries(['D0', 'D1', 'D2', 'D13', 'A0', 'A5', 'AREF', '5V', 'GND'].map((n, k) => [n, n === 'GND' ? 'gnd' : `n${k}`]));
    const uno = symbolFor({ id: 'U1', type: 'ArduinoUno', params: { firmware: 'bench/mcu/blink.fw.ts' }, pins });
    expect(uno.kind).toBe('ic');
    expect(uno.value).toBe('blink.fw.ts');
    expect(uno.svg).toContain('Arduino Uno');
    expect(uno.pins.filter(p => p.side === 'r').map(p => p.name)).toEqual(['D13', 'D2', 'D1', 'D0']);
    expect(uno.pins.filter(p => p.side === 'l').map(p => p.name)).toEqual(['A0', 'A5']);
    expect(uno.pins.find(p => p.name === '5V')).toMatchObject({ side: 't', role: 'vcc' });
    expect(uno.pins.find(p => p.name === 'GND')).toMatchObject({ side: 'b', role: 'gnd' });
    const tiny = symbolFor({ id: 'U2', type: 'Mcu', params: { profile: 'attiny85', firmware: 'x/app.fw.ts' }, pins: { PB0: 'n1', PB2: 'n2', VCC: 'vcc', GND: 'gnd' } });
    expect(tiny.svg).toContain('ATtiny85');
    expect(tiny.pins.find(p => p.name === 'VCC')!.side).toBe('t');
    expect(tiny.pins.find(p => p.name === 'PB2')!.side).toBe('l'); // ADC-capable → left
    expect(tiny.pins.find(p => p.name === 'PB0')!.side).toBe('r');
    const esp = symbolFor({ id: 'U3', type: 'Mcu', params: { profile: 'esp32', firmware: 'a.fw.ts' }, pins: { GPIO2: 'n1', VCC: 'vcc', GND: 'gnd' } });
    expect(esp.svg).toContain('ESP32');
  });
});

describe('viewer: sources panel helpers', () => {
  it('highlights TypeScript and VHDL line by line, carrying open spans across lines', () => {
    expect(languageOf('bench/mcu/blink.fw.ts')).toBe('ts');
    expect(languageOf('counter.vhd')).toBe('vhdl');
    const ts = highlightLines("import { delay } from 'circuitsvibe/arduino';\n/* a\nb */\nawait delay(500);", 'ts');
    expect(ts).toHaveLength(4);
    expect(ts[0]).toContain('tok-k');
    expect(ts[1]).toMatch(/^<span class="tok-c">/);
    expect(ts[1]).toMatch(/<\/span>$/);
    expect(ts[2]).toMatch(/^<span class="tok-c">/);
    const vhdl = highlightLines("signal count : unsigned(3 downto 0) := (others => '0'); -- counter\nif rising_edge(clk) then", 'vhdl');
    expect(vhdl[0]).toContain('tok-k">signal<');
    expect(vhdl[0]).toContain('tok-t">unsigned<');
    expect(vhdl[0]).toContain('tok-c">-- counter<');
    expect(vhdl[1]).toContain('tok-f">rising_edge<');
    // no raw tags survive
    for (const l of [...ts, ...vhdl]) expect(l.replace(/<\/?span[^>]*>/g, '')).not.toMatch(/[<>]/);
  });

  it('sub-femto values read as zero', () => {
    expect(eng(4.36e-29, 'A')).toBe('0 A');
    expect(eng(2e-15, 'A')).toBe('2 fA');
  });
});
