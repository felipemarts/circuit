import { describe, it, expect } from 'vitest';
import { partDetail, partSummaries, renderPartDetail, renderPartList, SEMI_PARAMS } from '../../src/cli/partsCatalog';
import { COMPONENT_CATALOG, GRAMMAR_NOTES } from '../../src/cli/catalog';
import { findDiagnosticDoc } from '../../src/forge';

describe('circuitsvibe catalog — semiconductors and real parts', () => {
  it('lists the generic types with their parameter tables', () => {
    for (const t of ['Diode', 'NPN', 'PNP', 'NMOS', 'PMOS', 'Part']) expect(COMPONENT_CATALOG.map(e => e.type)).toContain(t);
    expect(SEMI_PARAMS.NPN.find(p => p.name === 'Vaf')).toEqual({ name: 'Vaf', default: null, unit: 'V', description: 'forward Early voltage (0 = infinite)' });
    expect(GRAMMAR_NOTES).toMatch(/RATINGS/);
    expect(GRAMMAR_NOTES).toMatch(/Q1|\.ic/);
  });

  it('every real part is listed; simulatable ones say whether the model is estimated', () => {
    const list = partSummaries();
    expect(list.find(p => p.id === '2N3904')).toMatchObject({ construct: "Part('2N3904')", device: 'NPN', modelEstimated: false });
    expect(list.find(p => p.id === '2N7000')).toMatchObject({ device: 'NMOS', modelEstimated: true });
    expect(list.find(p => p.id === 'LM358')).toMatchObject({ construct: "Part('LM358')", device: 'OpAmp' });
    expect(list.find(p => p.id === 'ATmega328P')).toMatchObject({ construct: null });
    expect(renderPartList(list)).toMatch(/2N7000\s+mosfet\s+Part\('2N7000'\)\s+NMOS, model ESTIMATED/);
  });

  it('a part detail has pins, model card (estimated flags, ignored params), ratings with units and citations', () => {
    const d = partDetail('2n7000')!;
    expect(d.pinout.map(p => p.name)).toEqual(expect.arrayContaining(['D', 'G', 'S']));
    expect(d.pins).toBe("'d', 'g', 's'");
    expect(d.model).toMatchObject({ device: 'NMOS', estimated: true, params: { Vto: 1.78, Kp: 0.143 } });
    expect(d.model!.bodyDiode).toMatchObject({ Is: 4.4e-13, n: 1.14 });
    expect(d.ratings.find(r => r.name === 'Vgs')).toMatchObject({ max: 20, unit: 'V' });
    expect(d.ratings[0].source).toMatch(/onsemi/);
    const text = renderPartDetail(partDetail('2N3904')!);
    expect(text).toMatch(/Vceo\s+40V/);
    expect(text).toMatch(/not modeled \(ignored\): Irb, Rbm, Xtf, Vtf, Itf, Xcjc/);
    expect(text).toMatch(/hFE\s+min 100 max 300 @ IC=10m/);
    expect(renderPartDetail(partDetail('2N7000')!)).toMatch(/model:\s+ESTIMATED/);
  });

  it('every new code is documented for circuitsvibe explain', () => {
    for (const c of ['F107', 'F108', 'F109', 'F110', 'R401', 'R402', 'R403', 'R404', 'T005', 'T006', 'T007', 'T008']) {
      expect(findDiagnosticDoc(c)?.explanation.length ?? 0).toBeGreaterThan(100);
    }
  });
});
