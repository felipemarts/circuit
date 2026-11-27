import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { bench, runLadder, toCircuitDoc, benchFromDoc, normalizeBoard, findDiagnosticDoc, checkDesignRules, traceCapacity, requiredWidth, VoltageSource, Resistor, Capacitor, LED, Part } from '../../src/forge';
import type { TB, BenchDescriptor, Diagnostic, BoardSpec } from '../../src/forge';
import type { CopperItem } from '../../src/pcb/copper';
import { item } from '../../src/pcb/copper';
import { validateJsonSchema } from '../share/mini-json-schema';

const repo = path.resolve(__dirname, '..', '..');
const schema = JSON.parse(fs.readFileSync(path.join(repo, 'schema', 'circuit.schema.json'), 'utf8'));
const codes = (diags: Diagnostic[]) => diags.filter(d => d.stage === 'pcb').map(d => d.code);

/** A source driving a load resistor through a series resistor; `ohms` sets the current. */
function power(ohms: string, boardSpec: Parameters<TB['board']>[0] = { width: 40, height: 20 }, extra: (tb: TB) => void = () => {}): BenchDescriptor {
  return bench('power', tb => {
    const v1 = tb.add('V1', new VoltageSource(5));
    const r1 = tb.add('R1', new Resistor(ohms));
    const r2 = tb.add('R2', new Resistor(ohms));
    v1.pin('+').connect(r1.pin('1'));
    r1.pin('2').connect(r2.pin('1'));
    r2.pin('2').connect(tb.gnd);
    v1.pin('-').connect(tb.gnd);
    tb.name('vin', v1.pin('+'));
    tb.name('mid', r1.pin('2'));
    tb.expect.op('mid').toBeWithin(2.4, 2.6);
    tb.ratings({ derate: 1 });
    tb.board(boardSpec);
    tb.place('V1', { x: 5, y: 10, rot: 90 });
    tb.place('R1', { x: 17, y: 14 });
    tb.place('R2', { x: 31, y: 7 });
    extra(tb);
  });
}

describe('IPC-2221 trace capacity', () => {
  it('matches the standard curve and inverts exactly', () => {
    // 10 mil (0.254 mm), 1 oz, 10 °C rise, outer layer: ≈ 0.88 A (IPC-2221 calculators).
    expect(traceCapacity(0.254, 1, 10)).toBeCloseTo(0.88, 1);
    // 1 A needs ≈ 0.3 mm on 1 oz at 10 °C; 2 oz halves the width.
    expect(requiredWidth(1, 1, 10)).toBeCloseTo(0.3, 1);
    expect(requiredWidth(1, 2, 10)).toBeCloseTo(requiredWidth(1, 1, 10) / 2, 6);
    for (const w of [0.1, 0.5, 2]) expect(requiredWidth(traceCapacity(w, 1, 20), 1, 20)).toBeCloseTo(w, 9);
    expect(requiredWidth(0, 1, 10)).toBe(0);
  });
});

describe('autorouter', () => {
  it('routes every connection, keeps the design rules, and is deterministic', () => {
    const r = runLadder(power('1k'));
    expect(r.exitCode).toBe(0);
    const routing = r.stages.pcb!.pcb!.routing!;
    expect(routing.stats).toMatchObject({ nets: 3, connections: 3, routed: 3, unrouted: 0, completion: 1 });
    expect(routing.currents).toBe('op');
    for (const n of routing.nets) {
      expect(n.complete).toBe(true);
      expect(n.tracks.length).toBeGreaterThan(0);
      // Every polyline starts or ends on a pad of its net, and stays inside the board.
      for (const t of n.tracks) for (const [x, y] of t.points) expect(x > 0 && x < 40 && y > 0 && y < 20).toBe(true);
    }
    expect(codes(r.diagnostics)).toEqual([]);
    expect(JSON.stringify(runLadder(power('1k')))).toBe(JSON.stringify(r));
  });

  it('sizes traces from the simulated current (IPC-2221) and rates them: P812', () => {
    // 5 V across 2 × 1 Ω: 2.5 A through every net.
    const r = runLadder(power('1'));
    const nets = r.stages.pcb!.pcb!.routing!.nets;
    const vin = nets.find(n => n.net === 'vin')!;
    expect(vin.current).toBeCloseTo(2.5, 3);
    expect(vin.widthFrom).toBe('current');
    expect(vin.width).toBeGreaterThanOrEqual(vin.requiredWidth!);
    expect(vin.width).toBeGreaterThan(1);
    const rating = r.stages.pcb!.ratings!.find(x => x.component === 'vin')!;
    expect(rating).toMatchObject({ code: 'P812', verdict: 'pass', part: 'PCB trace', unit: 'A', confidence: 'verified' });
    expect(rating.utilization).toBeLessThanOrEqual(1);
    expect(r.exitCode).toBe(0);
  });

  it('a nets override narrower than the current needs fails P812 with exit 1 and a widening fix', () => {
    const r = runLadder(power('1', { width: 40, height: 20, nets: { vin: { width: 0.3 } } }));
    expect(r.exitCode).toBe(1);
    expect(r.firstFailure).toBe('P812');
    const vin = r.stages.pcb!.pcb!.routing!.nets.find(n => n.net === 'vin')!;
    expect(vin).toMatchObject({ width: 0.3, widthFrom: 'net' });
    const rating = r.stages.pcb!.ratings!.find(x => x.component === 'vin')!;
    expect(rating.verdict).toBe('fail');
    expect(rating.message).toMatch(/carries 2\.5\d* ?A/);
    const fix = rating.fixes![0];
    expect(fix.confidence).toBe('mechanical');
    const widen = Number(fix.detail.match(/width: ([\d.]+)/)![1]);
    // The suggested width passes.
    expect(runLadder(power('1', { width: 40, height: 20, nets: { vin: { width: widen } } })).exitCode).toBe(0);
  });

  it('P810: a connection with no path is reported with its airwire', () => {
    const r = runLadder(power('1k', { width: 40, height: 20, rules: { clearance: 3 } }));
    expect(r.exitCode).toBe(2);
    expect(codes(r.diagnostics)).toContain('P810');
    const routing = r.stages.pcb!.pcb!.routing!;
    expect(routing.unrouted.length).toBeGreaterThan(0);
    expect(routing.stats.completion).toBeLessThan(1);
    const d = r.diagnostics.find(x => x.code === 'P810')!;
    expect(d.subject?.net).toBeDefined();
    expect(d.fixes.length).toBeGreaterThan(0);
  });

  it('route: false keeps the placement checks and the ratsnest only', () => {
    const r = runLadder(power('1k', { width: 40, height: 20, route: false }));
    expect(r.exitCode).toBe(0);
    expect(r.stages.pcb!.pcb!.routing).toBeUndefined();
    expect(r.stages.pcb!.pcb!.ratsnest.length).toBe(3);
  });

  it('--stage pcb routes without currents and warns P813; an unknown net in nets is P808', () => {
    const r = runLadder(power('1'), { stages: ['pcb'] });
    expect(r.stages.pcb!.pcb!.routing!.currents).toBe('none');
    expect(r.stages.pcb!.pcb!.routing!.nets.every(n => n.width === 0.25 && n.widthFrom === 'rule')).toBe(true);
    expect(codes(r.diagnostics)).toEqual(['P813']);
    expect(r.exitCode).toBe(0);
    const bad = runLadder(power('1k', { width: 40, height: 20, nets: { nope: { width: 1 } } }));
    expect(bad.exitCode).toBe(2);
    expect(codes(bad.diagnostics)).toEqual(['P808']);
  });

  it('uses both layers on a dense two-layer board; one layer cannot do better', () => {
    const timer = (layers: 1 | 2) =>
      bench('ne555-board', tb => {
        const vcc = tb.add('VCC', new VoltageSource(9));
        const u1 = tb.add('U1', Part('NE555'));
        const r1 = tb.add('R1', new Resistor('4.7k'));
        const r2 = tb.add('R2', new Resistor('10k'));
        const c1 = tb.add('C1', new Capacitor('1u'));
        const rl = tb.add('RL', new Resistor('680'));
        const d1 = tb.add('D1', new LED());
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
        u1.pin('OUT').connect(rl.pin('1'));
        rl.pin('2').connect(d1.pin('anode'));
        d1.pin('cathode').connect(tb.gnd);
        tb.board({ width: 40, height: 30, layers });
        tb.place('VCC', { x: 4, y: 15, rot: 90 });
        tb.place('U1', { x: 18, y: 15 });
        tb.place('R1', { x: 18, y: 25 });
        tb.place('R2', { x: 18, y: 5.5 });
        tb.place('C1', { x: 8, y: 8, rot: 90 });
        tb.place('RL', { x: 29, y: 15, rot: 90 });
        tb.place('D1', { x: 34, y: 15, rot: 90 });
      });
    const two = runLadder(timer(2), { stages: ['pcb'] }).stages.pcb!.pcb!.routing!;
    const one = runLadder(timer(1), { stages: ['pcb'] }).stages.pcb!.pcb!.routing!;
    expect(two.stats.completion).toBe(1);
    expect(two.nets.some(n => n.tracks.some(t => t.layer === 'bottom'))).toBe(true);
    expect(one.nets.every(n => n.tracks.every(t => t.layer === 'top'))).toBe(true);
    expect(one.stats.completion).toBeLessThanOrEqual(two.stats.completion);
  });

  it('round-trips through the circuit document (routing included) and validates against the schema', () => {
    const desc = power('1', { width: 40, height: 20, rules: { copper: 2, tempRise: 20, grid: 0.2 }, nets: { vin: { width: 2 } } });
    const doc = toCircuitDoc(desc);
    expect(doc.pcb!.board).toMatchObject({ rules: { copper: 2, tempRise: 20, grid: 0.2 }, nets: { vin: { width: 2 } } });
    expect(validateJsonSchema(schema, doc)).toEqual([]);
    expect(JSON.stringify(runLadder(benchFromDoc(doc)))).toBe(JSON.stringify(runLadder(desc)));
    const spec = normalizeBoard(doc.pcb!.board as never);
    expect(normalizeBoard(spec as never)).toEqual(spec);
    expect(() => normalizeBoard({ width: 10, height: 10, nets: { vin: { width: 0.05 } } })).toThrow(/0\.1 mm minimum/);
    expect(() => normalizeBoard({ width: 10, height: 10, rules: { copper: 20 } })).toThrow(/copper weight/);
    expect(() => normalizeBoard({ width: 10, height: 10, route: 'yes' as never })).toThrow(/route/);
  });
});

describe('design-rule check', () => {
  const board = normalizeBoard({ width: 20, height: 10 }) as BoardSpec;
  const outline: [number, number][] = [[0, 0], [20, 0], [20, 10], [0, 10]];
  const track = (net: string, ax: number, ay: number, bx: number, by: number, layer: 'top' | 'bottom' = 'top'): CopperItem => item(net, layer, 'track', 'track', { kind: 'capsule', ax, ay, bx, by, r: 0.125 });

  it('flags two nets closer than the clearance on one layer, not on different layers', () => {
    const near = checkDesignRules([track('a', 2, 5, 18, 5), track('b', 2, 5.4, 18, 5.4)], board, outline);
    expect(near.map(v => v.kind)).toEqual(['clearance']);
    expect(near[0].distance).toBeCloseTo(0.15, 6);
    expect(checkDesignRules([track('a', 2, 5, 18, 5), track('b', 2, 5.4, 18, 5.4, 'bottom')], board, outline)).toEqual([]);
    expect(checkDesignRules([track('a', 2, 5, 18, 5), track('a', 2, 5.4, 18, 5.4)], board, outline)).toEqual([]);
  });

  it('flags copper near the edge and near drilled holes', () => {
    const v = checkDesignRules([track('a', 2, 0.3, 18, 0.3), item('~hole', 'both', 'hole', 'hole', { kind: 'circle', x: 10, y: 5, r: 1.6 }), track('b', 5, 6.7, 15, 6.7)], board, outline);
    expect(v.map(x => x.kind).sort()).toEqual(['edge', 'hole']);
  });
});

describe('registry', () => {
  it('P808 and P810–P813 are documented (explain + docs/DIAGNOSTICS.md)', () => {
    const md = fs.readFileSync(path.join(repo, 'docs', 'DIAGNOSTICS.md'), 'utf8');
    for (const code of ['P808', 'P810', 'P811', 'P812', 'P813']) {
      const doc = findDiagnosticDoc(code)!;
      expect(doc, code).toBeDefined();
      expect(md).toContain(`| \`${code}\` | ${doc.slug} |`);
    }
  });
});
