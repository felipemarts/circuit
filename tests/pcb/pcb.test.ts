import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  bench,
  runLadder,
  elaborate,
  toCircuitDoc,
  benchFromDoc,
  stripLocations,
  validateCircuitDoc,
  findDiagnosticDoc,
  VoltageSource,
  Resistor,
  Capacitor,
  LED,
  NPN,
  Part,
  ArduinoUno,
  Mcu,
  Clock,
  getFootprint,
  footprintCatalog,
  defaultFootprint,
  pinMap,
  layoutBoard,
  normalizeBoard,
  normalizePlacement,
  parseLength,
  partIds,
} from '../../src/forge';
import type { TB, BenchDescriptor, NetlistComponent, PcbSpec, FootprintDef, Diagnostic } from '../../src/forge';
import { validateJsonSchema } from '../share/mini-json-schema';

const repo = path.resolve(__dirname, '..', '..');
const schema = JSON.parse(fs.readFileSync(path.join(repo, 'schema', 'circuit.schema.json'), 'utf8'));

/** LED driver on a 30 × 20 mm board; `place` customizes the placements. */
function board(place: (tb: TB) => void = tb => {
  tb.place('V1', { x: 5, y: 12, rot: 90 });
  tb.place('R1', { x: 15, y: 10 });
  tb.place('D1', { x: 25, y: 8, rot: 90 });
}, boardSpec: Parameters<TB['board']>[0] = { width: 30, height: 20 }): BenchDescriptor {
  return bench('board', tb => {
    const v1 = tb.add('V1', new VoltageSource(5));
    const r1 = tb.add('R1', new Resistor('330'));
    const d1 = tb.add('D1', new LED());
    v1.pin('+').connect(r1.pin('1'));
    r1.pin('2').connect(d1.pin('anode'));
    d1.pin('cathode').connect(tb.gnd);
    v1.pin('-').connect(tb.gnd);
    tb.name('led', d1.pin('anode'));
    tb.expect.op('D1.i').toBeWithin('5m', '15m');
    tb.board(boardSpec);
    place(tb);
  });
}

const codes = (diags: Diagnostic[]) => diags.filter(d => d.stage === 'pcb').map(d => d.code);

/** The netlist component of a single part (all pins on their own nets). */
function single(make: () => Parameters<TB['add']>[1]): NetlistComponent {
  return elaborate(bench('one', tb => void tb.add('U1', make()))).netlist.components[0];
}

describe('footprint library', () => {
  it('every footprint has pads inside its courtyard', () => {
    const names = [...footprintCatalog().filter(f => !f.name.includes('<')).map(f => f.name), 'DIP-14', 'DIP-28', 'SOIC-16', 'HDR-1x5', 'HDR-2x3', 'TERM-3'];
    for (const name of names) {
      const fp = getFootprint(name)!;
      expect(fp, name).toBeDefined();
      expect(fp.pads.length, name).toBeGreaterThan(0);
      for (const p of fp.pads) {
        const inside = fp.courtyard.some(k => p.x - p.w / 2 >= k.x - k.w / 2 - 1e-9 && p.x + p.w / 2 <= k.x + k.w / 2 + 1e-9 && p.y - p.h / 2 >= k.y - k.h / 2 - 1e-9 && p.y + p.h / 2 <= k.y + k.h / 2 + 1e-9);
        expect(inside, `${name} pad ${p.name}`).toBe(true);
        if (p.drill !== undefined) expect(p.drill, `${name} pad ${p.name}`).toBeLessThan(Math.min(p.w, p.h));
      }
    }
  });

  it('DIP numbering: pin 1 top-left, counter-clockwise; rows 7.62 mm apart', () => {
    const dip = getFootprint('dip-8')!;
    expect(dip.name).toBe('DIP-8');
    const at = (n: string) => dip.pads.find(p => p.name === n)!;
    expect([at('1').x, at('1').y]).toEqual([-3.81, 3.81]);
    expect([at('4').x, at('4').y]).toEqual([-3.81, -3.81]);
    expect([at('5').x, at('5').y]).toEqual([3.81, -3.81]);
    expect([at('8').x, at('8').y]).toEqual([3.81, 3.81]);
    expect(at('1').shape).toBe('rect');
  });

  it('parametric families validate their size; unknown names are undefined', () => {
    expect(getFootprint('DIP-7')).toBeUndefined();
    expect(getFootprint('HDR-1x41')).toBeUndefined();
    expect(getFootprint('NOPE')).toBeUndefined();
    expect(getFootprint('hdr-2x4')!.pads.map(p => p.name)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8']);
  });

  it('UNO-SHIELD matches the Uno R3 header positions (Arduino board file)', () => {
    const uno = getFootprint('UNO-SHIELD')!;
    const abs = (name: string) => uno.pads.filter(p => p.name === name).map(p => [Math.round((p.x + 34.29) * 1000) / 1000, Math.round((p.y + 26.67) * 1000) / 1000]);
    expect(abs('D8')).toEqual([[41.656, 50.8]]);
    expect(abs('D7')).toEqual([[45.72, 50.8]]); // the 160-mil gap
    expect(abs('A0')).toEqual([[50.8, 2.54]]);
    expect(abs('5V')).toEqual([[38.1, 2.54]]);
    expect(abs('GND')).toHaveLength(3);
    expect(uno.holes).toHaveLength(4);
  });
});

describe('default footprints and pin maps', () => {
  it('generic parts follow the board tech', () => {
    const r = single(() => new Resistor('1k'));
    expect(defaultFootprint(r, 'tht').name).toBe('AXIAL-0.4');
    expect(defaultFootprint(r, 'smd').name).toBe('0805');
    expect(defaultFootprint(single(() => new Capacitor('100n')), 'tht').name).toBe('DISC-5MM');
    expect(defaultFootprint(single(() => new Capacitor('10u')), 'tht').name).toBe('RADIAL-5MM');
    expect(defaultFootprint(single(() => new LED()), 'smd').name).toBe('LED-0805');
    const q = single(() => new NPN());
    expect(pinMap(q, getFootprint('TO-92')!).map).toEqual({ e: ['1'], b: ['2'], c: ['3'] });
    expect(pinMap(q, getFootprint('SOT-23')!).map).toEqual({ b: ['1'], e: ['2'], c: ['3'] });
    expect(pinMap(single(() => new LED()), getFootprint('LED-5MM')!).map).toEqual({ anode: ['A'], cathode: ['K'] });
  });

  it('catalog parts keep their datasheet package and pin numbers', () => {
    const cases: [string, string, Record<string, string[]>][] = [
      ['2N3904', 'TO-92', { e: ['1'], b: ['2'], c: ['3'] }],
      ['BC547B', 'TO-92', { c: ['1'], b: ['2'], e: ['3'] }],
      ['IRLZ44N', 'TO-220', { g: ['1'], d: ['2'], s: ['3'] }],
      ['AO3400A', 'SOT-23', { g: ['1'], s: ['2'], d: ['3'] }],
      ['LM358', 'DIP-8', { out: ['1'], inn: ['2'], inp: ['3'], 'v-': ['4'], 'v+': ['8'] }],
      ['LM741', 'DIP-8', { inn: ['2'], inp: ['3'], 'v-': ['4'], out: ['6'], 'v+': ['7'] }],
      ['LM311', 'DIP-8', { emit: ['1'], inp: ['2'], inn: ['3'], 'v-': ['4'], out: ['7'], 'v+': ['8'] }],
      ['1N4148', 'DO-35', { anode: ['A'], cathode: ['K'] }],
    ];
    for (const [id, fpName, map] of cases) {
      const c = single(() => Part(id));
      const choice = defaultFootprint(c, 'tht');
      expect(choice.name, id).toBe(fpName);
      expect(pinMap(c, getFootprint(fpName)!).map, id).toEqual(map);
    }
    // ICs follow the board tech with the same numbering.
    const hc = single(() => Part('74HC04'));
    expect(defaultFootprint(hc, 'tht').name).toBe('DIP-14');
    expect(defaultFootprint(hc, 'smd').name).toBe('SOIC-14');
    expect(pinMap(hc, getFootprint('SOIC-14')!).map.VCC).toEqual(['14']);
  });

  it('every simulatable catalog part maps all of its pins on its default footprint', () => {
    const noFootprint = ['ESP32', 'RP2040'];
    for (const { ids } of partIds()) {
      for (const id of ids) {
        if (noFootprint.some(n => id.toUpperCase().startsWith(n))) continue;
        const c = single(() => (id === 'ArduinoUno' ? new ArduinoUno({ firmware: { setup() {}, loop() {} } as never }) : Part(id)));
        const choice = defaultFootprint(c, 'tht');
        expect(choice.name, `${id}: ${choice.reason}`).toBeDefined();
        const { map } = pinMap(c, getFootprint(choice.name!)!);
        for (const pin of Object.keys(c.pins)) expect(map[pin], `${id}.${pin} on ${choice.name}`).toBeDefined();
      }
    }
  });

  it('an ATmega328P profile maps VCC to VCC and AVCC, GND to both GND pins', () => {
    const c = single(() => new Mcu({ profile: 'atmega328p', firmware: { setup: async () => {}, loop: async () => {} } }));
    expect(defaultFootprint(c, 'smd').name).toBe('DIP-28');
    const { map } = pinMap(c, getFootprint('DIP-28')!);
    expect(map.VCC).toEqual(['7', '20']);
    expect(map.GND).toEqual(['8', '22']);
  });
});

describe('normalization', () => {
  it('lengths accept units and default to mm', () => {
    expect(parseLength(1.6, 'x')).toBe(1.6);
    expect(parseLength('0.1in', 'x')).toBe(2.54);
    expect(parseLength('100mil', 'x')).toBe(2.54);
    expect(parseLength('2cm', 'x')).toBe(20);
    expect(() => parseLength('3ft', 'x')).toThrow(/length/);
  });

  it('board defaults are filled and normalization is idempotent', () => {
    const b = normalizeBoard({ width: '50mm', height: 30, cornerRadius: 2 });
    expect(b).toEqual({ width: 50, height: 30, cornerRadius: 2, layers: 2, thickness: 1.6, tech: 'tht', rules: { trace: 0.25, clearance: 0.2, via: { drill: 0.3, diameter: 0.6 }, edgeClearance: 0.5 }, holes: [] });
    expect(normalizeBoard(b)).toEqual(b);
    expect(normalizeBoard({ preset: 'uno-shield' }).outline).toHaveLength(9);
  });

  it('rejects typos and impossible values with the fix in the message', () => {
    expect(() => normalizeBoard({ width: 10, height: 10, layer: 2 } as never)).toThrow(/unknown option 'layer'/);
    expect(() => normalizeBoard({ width: 10 } as never)).toThrow(/width, height/);
    expect(() => normalizeBoard({ width: 10, height: 10, rules: { via: { drill: 0.6, diameter: 0.5 } } })).toThrow(/larger than drill/);
    expect(() => normalizePlacement('R1', { x: 1 }, {})).toThrow(/both x and y/);
    expect(() => normalizePlacement('R1', { x: 1, y: 1, footprint: 'R9999' }, {})).toThrow(/unknown footprint 'R9999'.*catalog footprints/);
    expect(normalizePlacement('R1', { x: 1, y: 2, rot: -90, footprint: '0805' }, {})).toEqual({ x: 1, y: 2, rot: 270, footprint: '0805' });
  });

  it('tb.place needs a board and a registered component', () => {
    const noBoard = bench('x', tb => {
      tb.add('R1', new Resistor('1k'));
      tb.place('R1', { x: 1, y: 1 });
    });
    expect(() => elaborate(noBoard)).toThrow(/no board/);
    const unknown = bench('x', tb => {
      tb.add('R1', new Resistor('1k'));
      tb.board({ width: 10, height: 10 });
      tb.place('R9', { x: 1, y: 1 });
    });
    expect(() => elaborate(unknown)).toThrow(/no component with that id/);
  });
});

describe('pcb stage', () => {
  it('a valid board passes and reports the ratsnest (an MST: pads − 1 airwires per net)', () => {
    const r = runLadder(board());
    expect(r.exitCode).toBe(0);
    const pcb = r.stages.pcb!.pcb!;
    expect(pcb.placed.map(p => `${p.id}:${p.footprint}`)).toEqual(['D1:LED-5MM', 'R1:AXIAL-0.4', 'V1:HDR-1x2']);
    expect(pcb.ratsnest.map(a => a.net).sort()).toEqual(['gnd', 'led', 'n1']);
    expect(pcb.stats.airwires).toBe(3);
    expect(r.netlist.hash).toBe(runLadder(board(tb => tb.place('R1', { x: 15, y: 10 }))).netlist.hash); // layout is not netlist identity
  });

  it('the stage runs only with a board, and alone with --stage pcb', () => {
    const noBoard = bench('nb', tb => {
      const v = tb.add('V1', new VoltageSource(1));
      const r = tb.add('R1', new Resistor(1));
      v.pin('+').connect(r.pin('1'));
      r.pin('2').connect(tb.gnd);
      v.pin('-').connect(tb.gnd);
    });
    expect(runLadder(noBoard).stages.pcb).toBeUndefined();
    const r = runLadder(board(), { stages: ['pcb'] });
    expect(Object.keys(r.stages)).toEqual(['lint', 'pcb']);
  });

  it('P801: outside the outline, and copper too close to the edge', () => {
    const out = runLadder(board(tb => {
      tb.place('V1', { x: 5, y: 12, rot: 90 });
      tb.place('R1', { x: 15, y: 10 });
      tb.place('D1', { x: 29, y: 8 });
    }));
    expect(out.exitCode).toBe(2);
    expect(codes(out.diagnostics)).toEqual(['P801']);
    expect(out.diagnostics[0].subject?.components).toEqual(['D1']);
    expect(out.diagnostics[0].at).toMatch(/pcb\.test\.ts:\d+$/);
    const edge = runLadder(board(undefined, { width: 30, height: 20, rules: { edgeClearance: 4.5 } }));
    expect(codes(edge.diagnostics)).toContain('P801');
  });

  it('P802: overlapping courtyards, THT pads under a bottom part, mounting holes', () => {
    const overlap = runLadder(board(tb => {
      tb.place('V1', { x: 5, y: 12, rot: 90 });
      tb.place('R1', { x: 15, y: 10 });
      tb.place('D1', { x: 18, y: 10 });
    }));
    expect(codes(overlap.diagnostics)).toEqual(['P802']);
    expect(overlap.diagnostics[0].subject?.components).toEqual(['D1', 'R1']);
    // An SMD part on the bottom under R1's body is fine; under its drilled pad it is not.
    const smd = (x: number) => runLadder(board(tb => {
      tb.place('V1', { x: 5, y: 12, rot: 90 });
      tb.place('R1', { x: 15, y: 10 });
      tb.place('D1', { x, y: 10, side: 'bottom', footprint: 'LED-0805' });
    }));
    expect(codes(smd(15).diagnostics)).toEqual([]);
    expect(codes(smd(20.08).diagnostics)).toEqual(['P802']);
    const hole = runLadder(board(undefined, { width: 30, height: 20, holes: [{ x: 15, y: 10, d: 3 }] }));
    expect(codes(hole.diagnostics)).toEqual(['P802']);
  });

  it('P803 / P804 / P807: no footprint, pin without pad, bad pad map', () => {
    const abstract = bench('abs', tb => {
      const clk = tb.add('CLK', new Clock({ freq: '1k' }));
      const r = tb.add('R1', new Resistor('1k'));
      clk.pin('y').connect(r.pin('1'));
      r.pin('2').connect(tb.gnd);
      tb.board({ width: 20, height: 20 });
      tb.place('R1', { x: 10, y: 10 });
    });
    const a = runLadder(abstract, { stages: ['pcb'] });
    expect(codes(a.diagnostics)).toEqual(['P803']);
    expect(a.diagnostics.find(d => d.code === 'P803')!.fixes.some(f => f.patch === "tb.place('CLK', { offBoard: true });")).toBe(true);

    const noPad = runLadder(board(tb => {
      tb.place('V1', { x: 5, y: 12, rot: 90 });
      tb.place('R1', { x: 15, y: 10, footprint: 'HDR-1x1' });
      tb.place('D1', { x: 25, y: 8, rot: 90 });
    }));
    expect(codes(noPad.diagnostics)).toEqual(['P804']);
    expect(noPad.diagnostics[0].message).toMatch(/R1: pin 2 is connected but has no pad/);

    const shorted = runLadder(board(tb => {
      tb.place('V1', { x: 5, y: 12, rot: 90 });
      tb.place('R1', { x: 15, y: 10, pads: { '2': '1' } });
      tb.place('D1', { x: 25, y: 8, rot: 90, pads: { anode: 'X' } });
    }));
    expect(codes(shorted.diagnostics).sort()).toEqual(['P807', 'P807']);
  });

  it('P805: the mechanical fix places the part on a free spot that passes', () => {
    const unplaced = runLadder(board(tb => {
      tb.place('V1', { x: 5, y: 12, rot: 90 });
      tb.place('R1', { x: 15, y: 10 });
    }));
    const d = unplaced.diagnostics.find(x => x.code === 'P805')!;
    expect(d.fixes[0].confidence).toBe('mechanical');
    const s = unplaced.stages.pcb!.pcb!.unplaced[0].suggested!;
    expect(d.fixes[0].patch).toBe(`tb.place('D1', { x: ${s.x}, y: ${s.y}${s.rot ? `, rot: ${s.rot}` : ''} });`);
    const fixed = runLadder(board(tb => {
      tb.place('V1', { x: 5, y: 12, rot: 90 });
      tb.place('R1', { x: 15, y: 10 });
      tb.place('D1', s);
    }));
    expect(fixed.exitCode).toBe(0);
  });

  it('P806: an off-board source with no connector on its nets is a warning', () => {
    const r = runLadder(board(tb => {
      tb.place('V1', { offBoard: true });
      tb.place('R1', { x: 15, y: 10 });
      tb.place('D1', { x: 25, y: 8, rot: 90 });
    }));
    expect(r.exitCode).toBe(0);
    const d = r.diagnostics.find(x => x.code === 'P806')!;
    expect(d.severity).toBe('warning');
    expect(d.evidence).toEqual({ nets: ['gnd', 'n1'] });
  });

  it('rotation and the bottom side transform pads (bottom mirrors x)', () => {
    const components = elaborate(board()).netlist.components;
    const spec = (pl: PcbSpec['placements']): PcbSpec => ({ board: normalizeBoard({ width: 40, height: 40 }), placements: pl });
    const pads = (pl: PcbSpec['placements']) => Object.fromEntries(layoutBoard(spec(pl), components).parts.find(p => p.id === 'R1')!.pads.map(p => [p.name, [p.x, p.y]]));
    expect(pads({ R1: { x: 20, y: 20 } })).toEqual({ 1: [14.92, 20], 2: [25.08, 20] });
    expect(pads({ R1: { x: 20, y: 20, rot: 90 } })).toEqual({ 1: [20, 14.92], 2: [20, 25.08] });
    expect(pads({ R1: { x: 20, y: 20, side: 'bottom' } })).toEqual({ 1: [25.08, 20], 2: [14.92, 20] });
  });

  it('custom footprints work as data', () => {
    const fp: FootprintDef = {
      name: 'MY-2PIN',
      description: 'custom',
      tech: 'smd',
      pads: [
        { name: 'a', x: -1, y: 0, shape: 'rect', w: 1, h: 1 },
        { name: 'b', x: 1, y: 0, shape: 'rect', w: 1, h: 1 },
      ],
      courtyard: [{ x: 0, y: 0, w: 3.5, h: 1.5 }],
    };
    const r = runLadder(board(tb => {
      tb.place('V1', { x: 5, y: 12, rot: 90 });
      tb.place('R1', { x: 15, y: 10, footprint: fp, pads: { '1': 'a', '2': 'b' } });
      tb.place('D1', { x: 25, y: 8, rot: 90 });
    }));
    expect(r.exitCode).toBe(0);
    expect(r.stages.pcb!.pcb!.placed.find(p => p.id === 'R1')!.footprint).toBe('MY-2PIN');
  });
});

describe('circuit document', () => {
  const desc = board(tb => {
    tb.place('V1', { x: 5, y: 12, rot: 90 });
    tb.place('R1', { x: 15, y: 10, footprint: { name: 'MY-R', pads: [{ name: '1', x: -2, y: 0, w: 1.2, drill: 0.6 }, { name: '2', x: 2, y: 0, w: 1.2, drill: 0.6 }] } });
    tb.place('D1', { x: 29, y: 8 }); // P801: the diagnostic's location must survive the round trip
  });

  it('round-trips to an identical RunRecord, validates against the schema', () => {
    const doc = toCircuitDoc(desc);
    expect(doc.pcb!.footprints!['MY-R'].tech).toBe('tht');
    expect(doc.pcb!.placements.D1.at).toMatch(/pcb\.test\.ts:\d+$/);
    expect(validateJsonSchema(schema, doc)).toEqual([]);
    expect(validateJsonSchema(schema, stripLocations(doc))).toEqual([]);
    expect(stripLocations(doc).pcb!.placements.D1.at).toBeUndefined();
    expect(JSON.stringify(runLadder(benchFromDoc(doc)))).toBe(JSON.stringify(runLadder(desc)));
    expect(toCircuitDoc(benchFromDoc(doc))).toEqual(doc);
  });

  it('validateCircuitDoc rejects unit strings, unknown ids and bad boards', () => {
    const doc = toCircuitDoc(desc);
    const bad = (f: (d: any) => void) => {
      const d = JSON.parse(JSON.stringify(doc));
      f(d);
      const v = validateCircuitDoc(d);
      expect(v.ok).toBe(false);
      return v.ok ? [] : v.diagnostics.map(x => x.message).join(' | ');
    };
    expect(bad(d => (d.pcb.board.width = '30mm'))).toMatch(/numbers in mm/);
    expect(bad(d => (d.pcb.placements.R9 = { x: 1, y: 1 }))).toMatch(/unknown component 'R9'/);
    expect(bad(d => (d.pcb.board.layers = 4))).toMatch(/layers must be 1 or 2/);
    expect(bad(d => (d.pcb.placements.D1.footprint = 'NOPE'))).toMatch(/unknown footprint 'NOPE'/);
    expect(bad(d => (d.pcb.extra = 1))).toMatch(/extra/);
  });
});

describe('registry', () => {
  it('P801–P807 are documented (explain + docs/DIAGNOSTICS.md)', () => {
    const md = fs.readFileSync(path.join(repo, 'docs', 'DIAGNOSTICS.md'), 'utf8');
    for (const code of ['P801', 'P802', 'P803', 'P804', 'P805', 'P806', 'P807']) {
      const doc = findDiagnosticDoc(code)!;
      expect(doc, code).toBeDefined();
      expect(md).toContain(`| \`${code}\` | ${doc.slug} |`);
    }
  });
});
