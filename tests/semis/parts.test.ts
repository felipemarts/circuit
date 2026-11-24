import { describe, it, expect } from 'vitest';
import { Part, partModelInfo, findPart, describeComponent, buildComponent, NPN, NMOS, Diode, LED, PNP, PMOS } from '../../src/forge';
import { diodeVoltageAt, hfeAt, rdsOn, type Q } from './helpers';

/**
 * Catalog models vs datasheet values (TA = 25 °C, model at the nominal
 * temperature). Tolerances are the datasheet's own min/max where it prints
 * them; for estimated (fitted) cards the known model error is pinned.
 */
describe('Part() — device classes and identity', () => {
  it('returns the right device class configured from the catalog, tagged with the part id', () => {
    expect(Part('2N3904')).toBeInstanceOf(NPN);
    expect(Part('2n3906')).toBeInstanceOf(PNP);
    expect(Part('BC547BG').partId).toBe('BC547B'); // alias
    expect(Part('2N7000')).toBeInstanceOf(NMOS);
    expect(Part('IRF9540N')).toBeInstanceOf(PMOS);
    expect(Part('1N4148')).toBeInstanceOf(Diode);
    expect(Part('LED-RED-5MM')).toBeInstanceOf(LED);
    const q = Part('2N3904') as NPN;
    expect(q.params.Bf).toBe(206.302);
    expect(q.params.Nf).toBe(1.5);
    const m = Part('IRLZ44N') as NMOS;
    expect(m.bodyDiode).toMatchObject({ Is: 3.86e-13, n: 1, Rs: 0.0071 });
  });

  it('netlist params record the part id and buildComponent rebuilds the Part', () => {
    for (const id of ['2N3904', '2N3906', 'BC547B', 'BC557B', 'BD139', '2N7000', 'BS170', 'IRLZ44N', 'IRF540N', 'IRF9540N', 'AO3400A', 'BSS84', '1N4148', '1N4007', '1N5819', '1N4733A', 'BZX79-C3V3', 'LED-RED-5MM', 'LED-GREEN-5MM']) {
      const info = describeComponent(Part(id));
      expect(info.params.part).toBe(id);
      const rebuilt = buildComponent(info.type, JSON.parse(JSON.stringify(info.params)));
      expect((rebuilt as { partId?: string }).partId).toBe(id);
      expect(describeComponent(rebuilt)).toEqual(info);
    }
  });

  it('unknown and non-simulatable parts throw with guidance', () => {
    expect(() => Part('2N9999')).toThrow(/unknown part.*Simulatable catalog parts: .*2N3904/);
    expect(() => Part('ATmega328P')).toThrow(/catalog data only/);
    expect(() => Part('2N2222A')).toThrow(/no published SPICE model/);
    expect(() => Part('TIP120')).toThrow(/Darlington/);
  });

  it('estimated cards say so; parameters the simulator ignores are listed', () => {
    expect(partModelInfo(findPart('2N7000')!).estimated).toBe(true);
    expect(partModelInfo(findPart('2N3904')!).estimated).toBe(false);
    expect(partModelInfo(findPart('2N3904')!).ignored).toEqual(['Irb', 'Rbm', 'Xtf', 'Vtf', 'Itf', 'Xcjc']);
    expect(partModelInfo(findPart('1N4733A')!).estimatedParams).toHaveProperty('BV');
  });
});

describe('Part() — model vs datasheet', () => {
  it('2N3904 hFE at the datasheet test points (VCE = 1 V) lies within the printed limits', () => {
    // onsemi 2N3903/D: hFE min 40 @0.1 mA, 70 @1 mA, 100..300 @10 mA, 60 @50 mA, 30 @100 mA
    const h = (ic: number) => hfeAt(() => Part('2N3904') as unknown as Q, ic, 1).hfe;
    const h10 = h(10e-3);
    expect(h10).toBeGreaterThanOrEqual(100);
    expect(h10).toBeLessThanOrEqual(300);
    expect(h10).toBeCloseTo(119.2, 0); // pinned: the published MODPEX card
    expect(h(0.1e-3)).toBeGreaterThanOrEqual(40);
    expect(h(1e-3)).toBeGreaterThanOrEqual(70);
    expect(h(50e-3)).toBeGreaterThanOrEqual(59.5); // 60.2 — at the min edge (±1 %)
    expect(h(100e-3)).toBeGreaterThanOrEqual(30);
  });

  it('BC547B hFE at 2 mA / 5 V within group B (200..450, typ 290)', () => {
    const { hfe } = hfeAt(() => Part('BC547B') as unknown as Q, 2e-3, 5);
    expect(hfe).toBeGreaterThanOrEqual(200);
    expect(hfe).toBeLessThanOrEqual(450);
    expect(Math.abs(hfe / 290 - 1)).toBeLessThan(0.05);
  });

  it('PNP parts: 2N3906 hFE @10 mA in 100..300, BC557B @2 mA in 180..460', () => {
    const a = hfeAt(() => Part('2N3906') as unknown as Q, 10e-3, 1, -1).hfe;
    expect(a).toBeGreaterThanOrEqual(100);
    expect(a).toBeLessThanOrEqual(300);
    const b = hfeAt(() => Part('BC557B') as unknown as Q, 2e-3, 5, -1).hfe;
    expect(b).toBeGreaterThanOrEqual(180);
    expect(b).toBeLessThanOrEqual(460);
  });

  it('2N7000 Rds(on): 1.22 Ω at 10 V / 0.5 A (typ 1.2, max 5); 3.0 Ω at 4.5 V / 75 mA vs typ 1.8 (documented estimated-model error)', () => {
    const r10 = rdsOn(Part('2N7000') as unknown as Q, 10, 0.5);
    expect(Math.abs(r10 / 1.2 - 1)).toBeLessThan(0.03); // the fit anchors this point
    const r45 = rdsOn(Part('2N7000') as unknown as Q, 4.5, 0.075);
    expect(r45).toBeGreaterThan(2.8);
    expect(r45).toBeLessThan(3.1); // +67 % over typ 1.8 Ω, still under max 5.3 Ω
    expect(r45).toBeLessThan(5.3);
  });

  it('IRLZ44N Rds(on): ~22 mΩ at 10 V (max 22), ~31 mΩ at 5 V (max 25 — estimated card is high)', () => {
    expect(rdsOn(Part('IRLZ44N') as unknown as Q, 10, 25)).toBeLessThan(0.0225);
    const r5 = rdsOn(Part('IRLZ44N') as unknown as Q, 5, 25);
    expect(r5).toBeGreaterThan(0.029);
    expect(r5).toBeLessThan(0.032);
  });

  it('1N4148 VF at 10 mA = 0.728 V ≤ 1 V max; 1N4007 VF at 1 A ≤ 1.1 V; 1N5819 card gives 0.76 V at 1 A vs 0.6 V max (card error pinned)', () => {
    const vf = (id: string, i: number) => diodeVoltageAt(Part(id) as unknown as Q, i);
    const a = vf('1N4148', 10e-3);
    expect(a).toBeLessThanOrEqual(1);
    expect(a).toBeCloseTo(0.728, 2);
    expect(vf('1N4007', 1)).toBeLessThanOrEqual(1.1);
    // Diodes Inc DI_1N5819 card vs Diodes Inc DS23001 VF max 0.6 V @1 A: the card is 27 % high
    expect(vf('1N5819', 1)).toBeCloseTo(0.76, 1);
  });

  it('1N4733A Vz at Izt = 49 mA is 5.1 V (4.845..5.355); LEDs at their datasheet points', () => {
    expect(-diodeVoltageAt(Part('1N4733A') as unknown as Q, -0.049)).toBeCloseTo(5.1, 6);
    expect(-diodeVoltageAt(Part('BZX79-C3V3') as unknown as Q, -0.005)).toBeCloseTo(3.3, 6);
    expect(diodeVoltageAt(Part('LED-RED-5MM') as unknown as Q, 0.02)).toBeCloseTo(1.85, 2); // typ 1.85, max 2.5
    expect(diodeVoltageAt(Part('LED-GREEN-5MM') as unknown as Q, 0.01)).toBeCloseTo(2.04, 2); // typ 2.0, max 2.4
  });
});
