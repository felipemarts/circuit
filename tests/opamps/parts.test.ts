import { describe, it, expect } from 'vitest';
import {
  IdealOpAmp,
  OpAmp,
  Comparator,
  Part,
  describeComponent,
  buildComponent,
  toCircuitDoc,
  benchFromDoc,
  runLadder,
  canonicalJson,
  opampPartParams,
  comparatorPartParams,
} from '../../src/forge';
import { findPart } from '../../src/parts';
import type { OpAmpPart } from '../../src/parts/types';
import { COMPONENT_CATALOG } from '../../src/cli/catalog';
import { phaseMarginFromOvershoot } from '../../src/opamps/parts';
import { inverting } from './helpers';

const PARTS = ['LM358', 'LM741', 'TL072', 'MCP6002', 'NE5532', 'LM393', 'LM311'];

describe('Part() for op-amps and comparators', () => {
  it('builds single-channel devices of the right type and pins, case-insensitive, aliases too', () => {
    for (const id of PARTS) {
      const c = Part(id.toLowerCase()) as unknown as { kind: string; partId: string; pinEntries(): [string][] };
      expect(c.kind).toBe(id.startsWith('LM3') && id !== 'LM358' ? 'Comparator' : 'OpAmp');
      expect(c.partId).toBe(id);
    }
    expect((Part('UA741') as unknown as { partId: string }).partId).toBe('LM741');
    const lm311 = Part('LM311');
    expect(lm311.pinEntries().map(([n]) => n)).toEqual(['inp', 'inn', 'out', 'v+', 'v-', 'emit']);
    expect(Part('LM393').pinEntries().map(([n]) => n)).toEqual(['inp', 'inn', 'out', 'v+', 'v-']);
  });

  it('unknown ids and data-only categories fail with a clear message', () => {
    expect(() => Part('NOPE123')).toThrow(/no such part/);
    expect(() => Part('ATmega328P')).toThrow(/catalog data only/); // NE555 is simulated by the IC family now
    expect((Part('NE555') as { kind?: string }).kind).toBe('IC');
  });

  it('model parameters come from the datasheet values (spot checks against the catalog)', () => {
    const lm358 = findPart('LM358') as OpAmpPart;
    const p = opampPartParams('LM358');
    expect(p.gbw).toBe(lm358.characteristics.gbw!.typ);
    expect(p.sr).toBe(lm358.characteristics.slewRate!.typ);
    expect(p.aol).toBeCloseTo(Math.pow(10, lm358.characteristics.openLoopGain!.typ! / 20), 0);
    expect(p.ib).toBe(-20e-9); // PNP inputs: the current flows out
    expect(p.iscSource).toBe(0.03);
    expect(p.iscSink).toBe(0.02);
    expect(p.iq).toBe(350e-6);
    expect(opampPartParams('LM741').rout).toBeCloseTo(196.078, 2); // fitted to ±14 V @10 kΩ, ±13 V @2 kΩ
    expect(opampPartParams('MCP6002').fp2).toBe(0); // PM 90° → single pole
    expect(opampPartParams('NE5532').iq).toBe(3e-3); // 6 mA package / 2 channels
    const c = comparatorPartParams('LM393');
    expect(c.vol).toBe(0.13);
    expect(c.iol).toBe(4e-3);
    expect(c.tpdFast).toBe(0.3e-6);
    expect(comparatorPartParams('LM311').emitterPin).toBe(true);
    expect(phaseMarginFromOvershoot(0.05)).toBeCloseTo(64.6, 1);
  });

  it('params are plain JSON and round-trip through buildComponent (every type and part)', () => {
    const comps = [new IdealOpAmp(), new IdealOpAmp({ gain: '1e5' }), new OpAmp(), new OpAmp({ gbw: '10M', fp2: 2e7 }), new Comparator(), new Comparator({ emitterPin: true }), ...PARTS.map(Part)];
    for (const c of comps) {
      const info = describeComponent(c);
      const json = JSON.parse(JSON.stringify(info));
      const rebuilt = buildComponent(json.type, json.params);
      expect(describeComponent(rebuilt)).toEqual(info);
      expect(rebuilt.pinEntries().map(([n]) => n)).toEqual(c.pinEntries().map(([n]) => n));
    }
    expect(() => buildComponent('OpAmp', { gbw: 'fast' })).toThrow(/gbw/);
    expect(() => buildComponent('OpAmp', { bogus: 1 })).toThrow(/unknown param 'bogus'/);
  });

  it('a Part() bench round-trips through the circuit document with an identical RunRecord', () => {
    const b = inverting(() => Part('TL072'), {
      vin: { dc: 0.1, ac: 1 },
      r1: 1e3,
      r2: 10e3,
      build: tb => {
        tb.expect.op('out').toBeWithin(-1.1, -0.9);
        tb.expect.ac({ from: '10', to: '10M', pointsPerDecade: 10 }).probe('out').bandwidth3dB().toBeWithin(1e5, 1e6);
      },
    });
    const original = runLadder(b);
    expect(original.exitCode).toBe(0);
    const doc = JSON.parse(canonicalJson(toCircuitDoc(b)));
    const U1 = doc.components.find((c: { id: string }) => c.id === 'U1');
    expect(U1.type).toBe('OpAmp');
    expect(U1.params.part).toBe('TL072');
    expect(JSON.stringify(runLadder(benchFromDoc(doc)))).toBe(JSON.stringify(original));
  });

  it('the catalog lists the three model types and every part with pins, specs, notes and the datasheet', () => {
    const types = COMPONENT_CATALOG.map(e => e.type);
    for (const t of ['IdealOpAmp', 'OpAmp', 'Comparator', ...PARTS]) expect(types).toContain(t);
    for (const id of PARTS) {
      const e = COMPONENT_CATALOG.find(x => x.type === id)!;
      expect(e.example).toBe(`tb.add('U1', Part('${id}'))`);
      expect(e.pins).toMatch(/'inp' \(pin \d\)/);
      expect(e.source).toMatch(/https:\/\//);
      expect(e.params!.part).toBe(id);
      expect(e.notes!.length).toBeGreaterThan(0);
    }
    expect(COMPONENT_CATALOG.find(x => x.type === 'TL072')!.notes!.join(' ')).toMatch(/ASSUMES ±25 mA/);
  });
});
