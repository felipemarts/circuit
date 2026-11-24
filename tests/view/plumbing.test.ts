import { describe, it, expect } from 'vitest';
import { toCircuitDoc, runLadder, benchFromDoc, createShareLink, decodeShareUrl } from '../../src/forge';
import { simulateDoc } from '../../src/view/simulate';
import { assertionModels, bodeModel, dcModel, diagnosticModels, highlightModels, logicModel, ratingGroups, scopeModel, verdictModel, animationScales } from '../../src/view/models';
import { layoutCircuit } from '../../src/view/layout';
import { eng, checkLabel, valueLabel } from '../../src/view/format';
import { load } from '../share/helpers';

// decode → run → panel models: the viewer's data path, end to end, in Node.

async function docOf(rel: string) {
  const desc = await load(rel);
  const doc = toCircuitDoc(desc);
  const { url } = await createShareLink(doc, { baseUrl: 'http://localhost/app.html' });
  return { doc: await decodeShareUrl(url), url };
}

describe('viewer data plumbing', () => {
  it('runs the same ladder as the CLI and collects op + tran waveforms (hc04 drives npn)', async () => {
    const { doc } = await docOf('bench/semis/hc04-drives-npn.bench.ts');
    const sim = await simulateDoc(doc, undefined, { yield: false });
    const cli = runLadder(benchFromDoc(doc), { overrides: doc.overrides });
    expect(sim.record.verdict).toBe(cli.verdict);
    expect(sim.record.exitCode).toBe(cli.exitCode);
    expect(sim.record.netlist.hash).toBe(cli.netlist.hash);
    expect(sim.notes).toEqual([]);
    expect(sim.op).toBeDefined();
    expect(sim.op!.nets.drive).toBeGreaterThan(4);
    expect(sim.op!.pins['Q1.c']).toBeGreaterThan(0.01);
    expect(sim.op!.pins['D1.anode']).toBeCloseTo(sim.op!.pins['Q1.c'], 6);
    const tr = sim.tran!;
    expect(tr.t.length).toBeGreaterThan(50);
    expect(tr.nets.drive.length).toBe(tr.t.length);
    expect(tr.pins['RLED.1'].length).toBe(tr.t.length);
    expect(tr.probes['Q1.ic'].length).toBe(tr.t.length);
    expect(tr.logic).toBeDefined();
    expect(Object.keys(tr.logic!.signals)).toContain('drive');
    // panel models
    const vm = verdictModel(doc, sim.record);
    expect(vm.verdict).toBe('pass');
    expect(vm.meaningKey).toBe('exit0');
    const chips = assertionModels(doc, sim.record);
    expect(chips.length).toBe(7);
    expect(chips.find(c => c.probe === 'D1.i')!.anchor).toEqual({ kind: 'component', id: 'D1' });
    expect(chips.find(c => c.probe === 'drive')!.anchor).toEqual({ kind: 'net', id: 'drive' });
    const scope = scopeModel(doc, sim.record, sim)!;
    expect(scope.traces.map(t => t.probe)).toContain('Q1.ic');
    expect(scope.traces.find(t => t.probe === 'Q1.ic')!.bands[0].kind).toBe('line');
    const ratings = ratingGroups(doc, sim.record);
    expect(ratings.map(g => g.component)).toEqual(['D1', 'Q1']);
    expect(ratings[0].rows.every(r => r.verdict === 'pass')).toBe(true);
    const logic = logicModel(sim.record, tr.logic)!;
    expect(logic.signals.map(s => s.name)).toContain('drive');
    const scales = animationScales(sim);
    expect(scales.vmax).toBe(5);
    expect(scales.imax).toBeGreaterThan(0.01);
  });

  it('FAIL with a verified hint (led-overcurrent)', async () => {
    const { doc } = await docOf('bench/broken/led-overcurrent.bench.ts');
    const sim = await simulateDoc(doc, undefined, { yield: false });
    expect(sim.record.verdict).toBe('fail');
    expect(sim.record.exitCode).toBe(1);
    const a = assertionModels(doc, sim.record);
    expect(a[0].verdict).toBe('fail');
    expect(a[0].hintText).toMatch(/R1 in \[/);
    expect(a[0].margin).toMatch(/outside/);
    expect(sim.op).toBeDefined(); // still animates the operating point
  });

  it('rating violation highlights the part (bjt-over-vceo)', async () => {
    const { doc } = await docOf('bench/broken/bjt-over-vceo.bench.ts');
    const sim = await simulateDoc(doc, undefined, { yield: false });
    expect(sim.record.exitCode).toBe(1);
    const groups = ratingGroups(doc, sim.record);
    expect(groups.some(g => g.failed)).toBe(true);
    const hl = highlightModels(sim.record);
    expect(hl.some(h => h.kind === 'rating' && h.badge?.startsWith('R40'))).toBe(true);
  });

  it('lint error: no simulation, culprit highlighted (ic-no-supply)', async () => {
    const { doc } = await docOf('bench/broken/ic-no-supply.bench.ts');
    const sim = await simulateDoc(doc, undefined, { yield: false });
    expect(sim.record.verdict).toBe('error');
    expect(sim.record.exitCode).toBe(2);
    expect(sim.op).toBeUndefined();
    expect(sim.tran).toBeUndefined();
    const d = diagnosticModels(sim.record);
    expect(d.some(x => x.code === 'F135')).toBe(true);
    expect(highlightModels(sim.record).length).toBeGreaterThan(0);
    const vm = verdictModel(doc, sim.record);
    expect(vm.meaningKey).toBe('exit2');
  });

  it('AC bench gives Bode curves with markers (ce-amplifier)', async () => {
    const { doc } = await docOf('bench/semis/ce-amplifier.bench.ts');
    const sim = await simulateDoc(doc, undefined, { yield: false });
    expect(sim.ac.length).toBe(1);
    const bode = bodeModel(sim.record, sim);
    expect(bode.length).toBe(1);
    expect(bode[0].f.length).toBe(sim.ac[0].f.length);
    expect(bode[0].markers.map(m => m.kind).sort()).toEqual(['bandwidth3dB', 'bandwidth3dB', 'gainAt']);
    // the curve agrees with the ladder's own measurement at 10 kHz
    const k = bode[0].f.findIndex(f => Math.abs(f - 1e4) / 1e4 < 0.06);
    const gainAt = sim.record.stages.ac!.assertions!.find(a => a.check.op === 'gainAt')!.measured!;
    expect(Math.abs(bode[0].gain[k] - gainAt)).toBeLessThan(0.5);
  });

  it('DC sweep bench gives a curve with markers (divider-dc-sweep)', async () => {
    const { doc } = await docOf('bench/analog/divider-dc-sweep.bench.ts');
    const sim = await simulateDoc(doc, undefined, { yield: false });
    expect(sim.dc.length).toBeGreaterThan(0);
    const dc = dcModel(doc, sim.record, sim);
    expect(dc.length).toBeGreaterThan(0);
    expect(dc[0].x.length).toBe(dc[0].y.length);
    expect(dc[0].markers.length).toBeGreaterThan(0);
  });

  it('pure digital bench: logic capture only (counter-pure-digital)', async () => {
    const { doc } = await docOf('bench/digital/counter-pure-digital.bench.ts');
    const sim = await simulateDoc(doc, undefined, { yield: false });
    expect(sim.tran?.digitalOnly).toBe(true);
    expect(sim.tran?.logic).toBeDefined();
    const logic = logicModel(sim.record, sim.tran!.logic)!;
    expect(logic.signals.length).toBeGreaterThan(0);
    expect(layoutCircuit(doc).components.length).toBe(doc.components.length);
  });

  it('formats values the way a schematic reads', () => {
    expect(eng(330, 'Ω')).toBe('330 Ω');
    expect(eng(4700, 'Ω')).toBe('4.7 kΩ');
    expect(eng(1e-5, 'F')).toBe('10 µF');
    expect(eng(0.0199, 'A')).toBe('19.9 mA');
    expect(eng(0)).toBe('0');
    expect(valueLabel({ id: 'V1', type: 'VoltageSource', params: { v: 0, pulse: { v1: 0, v2: 5, td: 0, tr: 1e-8, tf: 1e-8, pw: 5e-4, per: 1e-3 } }, pins: {} })).toBe('PULSE 0→5 V 1 kHz');
    expect(valueLabel({ id: 'V1', type: 'VoltageSource', params: { v: 0, ac: { mag: 1, phase: 0 } }, pins: {} })).toBe('AC 1 V');
    expect(checkLabel({ op: 'within', min: 0.005, max: 0.015 }, 'A')).toBe('in [5 mA, 15 mA]');
    expect(checkLabel({ op: 'neverExceed', value: 0.025 }, 'A')).toBe('never exceeds 25 mA');
  });
});
