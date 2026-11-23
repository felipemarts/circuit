import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  PARTS,
  findPart,
  partsByCategory,
  type Citation,
  type PartEntry,
  type Spec,
  type SpiceModel,
  type Unit,
} from '../../src/parts/index';

const UNITS: ReadonlySet<Unit> = new Set<Unit>([
  'A', 'V', 'W', 'F', 's', 'Ω', '°C', '°C/W', 'Hz', 'V/s', 'dB', 'deg', 'C', 'S', 'A/V²',
  'V/√Hz', 'A/√Hz', '1', 'xVCC', 'bit', 'm', 'cd',
]);

const IC_CATEGORIES = new Set(['opamp', 'comparator', 'logic', 'timer', 'mcu']);

function isSpec(v: unknown): v is Spec {
  return (
    typeof v === 'object' &&
    v !== null &&
    'unit' in v &&
    ('min' in v || 'typ' in v || 'max' in v)
  );
}

/** Walk every Spec inside a value, with its dotted path. */
function collectSpecs(v: unknown, path: string, out: { path: string; spec: Spec }[] = []) {
  if (Array.isArray(v)) {
    v.forEach((x, i) => collectSpecs(x, `${path}[${i}]`, out));
  } else if (isSpec(v)) {
    out.push({ path, spec: v });
  } else if (typeof v === 'object' && v !== null) {
    for (const [k, x] of Object.entries(v)) {
      if (k === 'sources' || k === 'model' || k === 'bodyDiode') continue;
      collectSpecs(x, path ? `${path}.${k}` : k, out);
    }
  }
  return out;
}

function models(p: PartEntry): { path: string; model: SpiceModel<Record<string, number | undefined>> }[] {
  const out: { path: string; model: SpiceModel<Record<string, number | undefined>> }[] = [];
  if ('model' in p && p.model) out.push({ path: 'model', model: p.model });
  if (p.category === 'mosfet' && p.bodyDiode) out.push({ path: 'bodyDiode', model: p.bodyDiode });
  return out;
}

const specsOf = (p: PartEntry) => collectSpecs(p, '');

describe('parts catalog — registry', () => {
  it('is non-empty and covers every category', () => {
    const cats = new Set(PARTS.map((p) => p.category));
    for (const c of ['diode', 'bjt', 'mosfet', 'opamp', 'comparator', 'logic', 'timer', 'mcu']) {
      expect(cats.has(c as PartEntry['category']), c).toBe(true);
    }
  });

  it('has no duplicate ids, and aliases do not collide with other parts', () => {
    const seen = new Map<string, string>();
    for (const p of PARTS) {
      const k = p.id.toUpperCase();
      expect(seen.has(k), `duplicate id ${p.id}`).toBe(false);
      seen.set(k, p.id);
    }
    for (const p of PARTS) {
      for (const a of p.aliases ?? []) {
        const owner = seen.get(a.toUpperCase());
        expect(owner === undefined || owner === p.id, `alias ${a} of ${p.id} collides with ${owner}`).toBe(true);
      }
    }
    const aliases = PARTS.flatMap((p) => (p.aliases ?? []).map((a) => a.toUpperCase()));
    expect(new Set(aliases).size).toBe(aliases.length);
  });

  it('findPart resolves ids and aliases case-insensitively', () => {
    for (const p of PARTS) {
      expect(findPart(p.id)).toBe(p);
      expect(findPart(p.id.toLowerCase())).toBe(p);
      for (const a of p.aliases ?? []) expect(findPart(a)).toBe(p);
    }
    expect(findPart('LM555')?.id).toBe('NE555');
    expect(findPart('no-such-part')).toBeUndefined();
  });

  it('partsByCategory filters by category', () => {
    expect(partsByCategory('bjt').every((p) => p.category === 'bjt')).toBe(true);
    expect(partsByCategory('bjt').length).toBeGreaterThanOrEqual(6);
  });

  it('has the required parts', () => {
    const required = [
      '1N4148', '1N4007', '1N5819', '1N4733A', 'LED-RED-5MM', 'LED-GREEN-5MM',
      '2N3904', '2N3906', 'BC547B', 'BC557B', '2N2222A', 'TIP120',
      '2N7000', 'BS170', 'IRLZ44N', 'IRF540N', 'AO3400A', 'IRF9540N',
      'LM358', 'LM741', 'TL072', 'MCP6002', 'LM393',
      '74HC00', '74HC04', '74HC14', '74HC74', '74HC595', '74HCT04', 'CD4017', 'NE555',
      'ATmega328P', 'ATtiny85', 'ESP32-WROOM-32', 'RP2040',
    ];
    for (const id of required) expect(findPart(id), id).toBeDefined();
  });

  it('data modules are browser-safe (no Node APIs)', () => {
    const root = join(__dirname, '../../src/parts');
    const files = [
      ...readdirSync(root).filter((f) => f.endsWith('.ts')).map((f) => join(root, f)),
      ...readdirSync(join(root, 'data')).map((f) => join(root, 'data', f)),
    ];
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      expect(src, f).not.toMatch(/from\s+['"](node:|fs|path|os|child_process)/);
      expect(src, f).not.toMatch(/\b(require\(|process\.|__dirname|Buffer\.)/);
    }
  });
});

describe.each(PARTS.map((p) => [p.id, p] as const))('%s', (_id, p) => {
  it('cites at least one source with a URL, with unique citation ids', () => {
    expect(p.sources.length).toBeGreaterThanOrEqual(1);
    for (const c of p.sources) {
      expect(c.url, c.id).toMatch(/^https:\/\/\S+$/);
      expect(c.title.length, c.id).toBeGreaterThan(0);
      expect(c.publisher.length, c.id).toBeGreaterThan(0);
    }
    expect(p.sources.some((c) => c.kind === 'datasheet'), 'needs a datasheet citation').toBe(true);
    const ids = p.sources.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('has a description and manufacturer', () => {
    expect(p.description.length).toBeGreaterThan(0);
    expect(p.manufacturer.length).toBeGreaterThan(0);
  });

  it('every Spec is well-formed (finite, ordered, known unit, valid source)', () => {
    const sourceIds = new Set(p.sources.map((c: Citation) => c.id));
    const specs = specsOf(p);
    expect(specs.length).toBeGreaterThan(0);
    for (const { path, spec } of specs) {
      expect(UNITS.has(spec.unit), `${path}: unit ${spec.unit}`).toBe(true);
      const vals = [spec.min, spec.typ, spec.max].filter((x) => x !== undefined) as number[];
      expect(vals.length, path).toBeGreaterThan(0);
      for (const x of vals) expect(Number.isFinite(x), `${path}: ${x}`).toBe(true);
      if (spec.min !== undefined && spec.typ !== undefined) expect(spec.min, path).toBeLessThanOrEqual(spec.typ);
      if (spec.typ !== undefined && spec.max !== undefined) expect(spec.typ, path).toBeLessThanOrEqual(spec.max);
      if (spec.min !== undefined && spec.max !== undefined) expect(spec.min, path).toBeLessThanOrEqual(spec.max);
      if (spec.source !== undefined) expect(sourceIds.has(spec.source), `${path}: source ${spec.source}`).toBe(true);
      for (const [k, c] of Object.entries(spec.conditions ?? {})) {
        if (typeof c === 'number') expect(Number.isFinite(c), `${path}.conditions.${k}`).toBe(true);
      }
    }
  });

  it('every estimated value carries a note', () => {
    for (const { path, spec } of specsOf(p)) {
      if (spec.estimated) expect(spec.note?.trim().length ?? 0, `${path} is estimated without note`).toBeGreaterThan(10);
    }
    for (const { path, model } of models(p)) {
      if (model.estimated) expect(model.note?.trim().length ?? 0, `${path} estimated without note`).toBeGreaterThan(10);
      for (const [k, note] of Object.entries(model.estimatedParams ?? {})) {
        expect(note?.trim().length ?? 0, `${path}.estimatedParams.${k}`).toBeGreaterThan(5);
        expect(k in model.params, `${path}.estimatedParams.${k} names a param that is absent`).toBe(true);
      }
    }
  });

  it('model cards cite an existing source and have finite params', () => {
    const sourceIds = new Set(p.sources.map((c) => c.id));
    for (const { path, model } of models(p)) {
      expect(sourceIds.has(model.source), `${path}.source ${model.source}`).toBe(true);
      const entries = Object.entries(model.params);
      expect(entries.length, path).toBeGreaterThan(0);
      for (const [k, x] of entries) expect(Number.isFinite(x), `${path}.${k}`).toBe(true);
    }
  });

  it('absolute maximum ratings are positive', () => {
    const allowNonPositive = new Set(['vccMin', 'inputVoltageMin']);
    const ratings = (p as { ratings?: Record<string, Spec | undefined> }).ratings ?? {};
    for (const [k, spec] of Object.entries(ratings)) {
      if (!spec || allowNonPositive.has(k) || spec.relativeTo) continue;
      if (spec.max !== undefined) expect(spec.max, `ratings.${k}`).toBeGreaterThan(0);
    }
  });

  it('pinout is complete: numbered 1..N, unique, named, N = package pin count', () => {
    expect(p.pins.length).toBe(p.package.pinCount);
    const nums = p.pins.map((x) => x.number).sort((a, b) => a - b);
    expect(nums).toEqual(Array.from({ length: p.package.pinCount }, (_, i) => i + 1));
    for (const pin of p.pins) expect(pin.name.trim().length, `pin ${pin.number}`).toBeGreaterThan(0);
    if (IC_CATEGORIES.has(p.category)) {
      // Package name's pin count (DIP-14, QFN-56, Module-38) matches; an exposed pad may add one.
      const m = /-(\d+)$/.exec(p.package.name);
      expect(m, `package name ${p.package.name} should end in its pin count`).not.toBeNull();
      const n = Number(m![1]);
      const extra = p.package.pinCount - n;
      expect(extra === 0 || (extra === 1 && /GND|PAD/i.test(p.pins[p.pins.length - 1]!.name)), p.package.name).toBe(true);
    }
  });
});

describe('model plausibility', () => {
  it('diodes: Is within physical range for the diode kind, N/Rs/Cjo sane', () => {
    const isRange: Record<string, [number, number]> = {
      signal: [1e-20, 1e-6],
      rectifier: [1e-20, 1e-6],
      zener: [1e-20, 1e-6],
      schottky: [1e-12, 1e-4], // Schottky saturation currents are orders larger
      led: [1e-26, 1e-12], // wide-bandgap junctions: tiny Is
    };
    for (const d of partsByCategory('diode')) {
      if (!d.model) continue;
      expect(d.model.type).toBe('D');
      const { Is, N, Rs, Cjo, BV, IBV, M, Vj, Tt } = d.model.params;
      const [lo, hi] = isRange[d.kind]!;
      if (Is !== undefined) {
        expect(Is, d.id).toBeGreaterThanOrEqual(lo);
        expect(Is, d.id).toBeLessThanOrEqual(hi);
      }
      if (N !== undefined) expect(N, d.id).toBeGreaterThan(0.5), expect(N, d.id).toBeLessThan(5);
      if (Rs !== undefined) expect(Rs, d.id).toBeGreaterThanOrEqual(0), expect(Rs, d.id).toBeLessThan(100);
      if (Cjo !== undefined) expect(Cjo, d.id).toBeGreaterThanOrEqual(0), expect(Cjo, d.id).toBeLessThan(1e-8);
      if (BV !== undefined) expect(BV, d.id).toBeGreaterThan(0);
      if (IBV !== undefined) expect(IBV, d.id).toBeGreaterThan(0);
      if (M !== undefined) expect(M, d.id).toBeGreaterThan(0), expect(M, d.id).toBeLessThan(1);
      if (Vj !== undefined) expect(Vj, d.id).toBeGreaterThan(0.1), expect(Vj, d.id).toBeLessThan(3);
      if (Tt !== undefined) expect(Tt, d.id).toBeGreaterThanOrEqual(0), expect(Tt, d.id).toBeLessThan(1e-4);
    }
  });

  it('zener diodes have Vz/Izt and a breakdown model near Vz', () => {
    for (const d of partsByCategory('diode').filter((x) => x.kind === 'zener')) {
      const vz = d.characteristics?.Vz;
      expect(vz, d.id).toBeDefined();
      expect(d.characteristics?.Izt, d.id).toBeDefined();
      const nom = vz!.typ ?? ((vz!.min ?? 0) + (vz!.max ?? 0)) / 2;
      if (d.model?.params.BV !== undefined) expect(Math.abs(d.model.params.BV - nom) / nom, d.id).toBeLessThan(0.1);
    }
  });

  it('BJTs: model polarity matches, Bf > 0, Is in range, junction params sane', () => {
    for (const q of partsByCategory('bjt')) {
      expect(q.ratings.Vceo.max, q.id).toBeGreaterThan(0);
      expect(q.ratings.IcMax.max, q.id).toBeGreaterThan(0);
      if (!q.model) continue;
      expect(q.model.type, q.id).toBe(q.polarity);
      const { Is, Bf, Br, Vaf, Cje, Cjc, Tf, Nf } = q.model.params;
      expect(Is, q.id).toBeGreaterThanOrEqual(1e-20);
      expect(Is, q.id).toBeLessThanOrEqual(1e-6);
      expect(Bf, q.id).toBeGreaterThan(0);
      if (Br !== undefined) expect(Br, q.id).toBeGreaterThan(0);
      if (Vaf !== undefined) expect(Vaf, q.id).toBeGreaterThan(0);
      if (Nf !== undefined) expect(Nf, q.id).toBeGreaterThan(0.5), expect(Nf, q.id).toBeLessThan(3);
      if (Cje !== undefined) expect(Cje, q.id).toBeLessThan(1e-8);
      if (Cjc !== undefined) expect(Cjc, q.id).toBeLessThan(1e-8);
      if (Tf !== undefined) expect(Tf, q.id).toBeLessThan(1e-6);
    }
    expect(findPart('TIP120')).toMatchObject({ darlington: true });
  });

  it('BJTs: hFE entries state IC (and VCE for guaranteed minimums)', () => {
    for (const q of partsByCategory('bjt')) {
      for (const h of q.characteristics?.hFE ?? []) {
        expect(h.conditions?.IC, q.id).toBeDefined();
        if (h.min !== undefined) expect(h.conditions?.VCE, q.id).toBeDefined();
      }
    }
  });

  it('MOSFETs: Vto sign matches channel, Kp > 0, model type matches', () => {
    for (const m of partsByCategory('mosfet')) {
      expect(m.ratings.Vds.max, m.id).toBeGreaterThan(0);
      expect(m.ratings.Vgs.max, m.id).toBeGreaterThan(0);
      const th = m.characteristics?.VgsTh;
      if (!m.model) continue;
      expect(m.model.type, m.id).toBe(m.channel === 'N' ? 'NMOS' : 'PMOS');
      const { Vto, Kp } = m.model.params;
      expect(Vto, m.id).toBeDefined();
      if (m.channel === 'N') expect(Vto!, m.id).toBeGreaterThan(0);
      else expect(Vto!, m.id).toBeLessThan(0);
      expect(Kp!, m.id).toBeGreaterThan(0);
      // Fitted |Vto| should sit near the datasheet threshold window.
      if (th?.min !== undefined && th.max !== undefined) {
        expect(Math.abs(Vto!), m.id).toBeGreaterThan(th.min - 1);
        expect(Math.abs(Vto!), m.id).toBeLessThan(th.max + 0.5);
      }
      if (m.bodyDiode) {
        expect(m.bodyDiode.type).toBe('D');
        expect(m.bodyDiode.params.Is!, m.id).toBeGreaterThan(1e-20);
        expect(m.bodyDiode.params.Is!, m.id).toBeLessThan(1e-4);
      }
      expect(m.characteristics?.RdsOn?.length ?? 0, m.id).toBeGreaterThan(0);
      for (const r of m.characteristics?.RdsOn ?? []) expect(r.conditions?.VGS, m.id).toBeDefined();
    }
  });

  it('op-amps: GBW, slew rate and gain are plausible', () => {
    for (const a of partsByCategory('opamp')) {
      const c = a.characteristics;
      expect(c.supply.single ?? c.supply.dual, a.id).toBeDefined();
      for (const s of [c.gbw?.typ, c.gbw?.min].filter((x) => x !== undefined)) {
        expect(s!, a.id).toBeGreaterThan(1e4), expect(s!, a.id).toBeLessThan(1e9);
      }
      if (c.slewRate?.typ !== undefined) expect(c.slewRate.typ, a.id).toBeGreaterThan(1e3);
      if (c.openLoopGain?.typ !== undefined) {
        expect(c.openLoopGain.unit).toBe('dB');
        expect(c.openLoopGain.typ, a.id).toBeGreaterThan(60);
        expect(c.openLoopGain.typ, a.id).toBeLessThan(160);
      }
    }
  });

  it('comparators state output type and response time', () => {
    for (const c of partsByCategory('comparator')) {
      expect(c.output, c.id).toBe('open-collector');
      expect(c.characteristics.responseTime?.length ?? 0, c.id).toBeGreaterThan(0);
    }
  });

  it('NE555: threshold ≈ 2/3 VCC, trigger ≈ 1/3 VCC', () => {
    const t = partsByCategory('timer')[0]!;
    expect(t.characteristics.thresholdLevel.typ!).toBeCloseTo(2 / 3, 2);
    expect(t.characteristics.triggerLevel.typ!).toBeCloseTo(1 / 3, 2);
    expect(t.characteristics.thresholdLevel.unit).toBe('xVCC');
  });
});

describe('logic families', () => {
  const expectedVcc: Record<string, number[]> = { HC: [2, 4.5, 6], HCT: [4.5, 5.5], CD4000: [5, 10, 15] };

  it('tabulate the family supply points with VIL < VIH (or VT− < VT+)', () => {
    for (const p of partsByCategory('logic')) {
      const vccs = p.levels.map((l) => l.vcc);
      expect(vccs, p.id).toEqual(expectedVcc[p.family]);
      for (const l of p.levels) {
        if (l.VIH && l.VIL) expect(l.VIL.max!, `${p.id}@${l.vcc}`).toBeLessThan(l.VIH.min!);
        if (l.VTplus && l.VTminus) {
          const plus = l.VTplus.typ ?? l.VTplus.min!;
          const minus = l.VTminus.typ ?? l.VTminus.max!;
          expect(minus, `${p.id}@${l.vcc}`).toBeLessThan(plus);
        }
        expect(l.vcc, p.id).toBeLessThanOrEqual(p.ratings.vccMax.max!);
        for (const s of [l.VIH, l.VIL, l.VTplus, l.VTminus]) if (s?.max !== undefined) expect(s.max).toBeLessThanOrEqual(l.vcc);
        for (const r of [l.rOutHigh, l.rOutLow]) {
          if (!r) continue;
          expect(r.estimated, p.id).toBe(true);
          expect(r.unit).toBe('Ω');
          expect(r.typ ?? r.max!).toBeGreaterThan(1), expect(r.max ?? r.typ!).toBeLessThan(5000);
        }
      }
    }
  });

  it('74HC14 has Schmitt thresholds at every VCC', () => {
    const p = findPart('74HC14');
    expect(p?.category).toBe('logic');
    if (p?.category !== 'logic') return;
    for (const l of p.levels) {
      expect(l.VTplus, `${l.vcc}`).toBeDefined();
      expect(l.VTminus, `${l.vcc}`).toBeDefined();
    }
  });

  it('logic ICs expose VCC and GND pins', () => {
    for (const p of partsByCategory('logic')) {
      const names = p.pins.map((x) => x.name.toUpperCase());
      expect(names.some((n) => n === 'VCC' || n === 'VDD'), p.id).toBe(true);
      expect(names.some((n) => n === 'GND' || n === 'VSS'), p.id).toBe(true);
    }
  });
});

describe('microcontroller profiles', () => {
  it('ATmega328P maps Arduino Uno D0–D13 and A0–A5 to port pins', () => {
    const p = findPart('ATmega328P');
    expect(p?.category).toBe('mcu');
    if (p?.category !== 'mcu') return;
    const pins = p.boardMapping!.pins;
    const names = pins.map((x) => x.name);
    for (let i = 0; i <= 13; i++) expect(names, `D${i}`).toContain(`D${i}`);
    for (let i = 0; i <= 5; i++) expect(names, `A${i}`).toContain(`A${i}`);
    const byName = new Map(pins.map((x) => [x.name, x]));
    expect(byName.get('D13')!.port).toBe('PB5');
    expect(byName.get('D0')!.port).toBe('PD0');
    expect(byName.get('A0')!.port).toBe('PC0');
    const pwm = pins.filter((x) => x.pwm).map((x) => x.name).sort();
    expect(pwm).toEqual(['D10', 'D11', 'D3', 'D5', 'D6', 'D9']);
    const f = (n: string) => byName.get(n)!.pwm!.frequency!.typ!;
    expect(f('D5')).toBeCloseTo(976.5625, 3);
    expect(f('D6')).toBeCloseTo(976.5625, 3);
    for (const n of ['D3', 'D9', 'D10', 'D11']) expect(f(n)).toBeCloseTo(490.196, 2);
    // physical pins in the mapping exist in the package pinout
    const phys = new Map(p.pins.map((x) => [x.number, x.name]));
    for (const m of pins) if (m.physicalPin !== undefined) expect(phys.get(m.physicalPin), m.name).toContain(m.port);
  });

  it('every profile states supply, thresholds, pull-ups and ADC resolution', () => {
    for (const p of partsByCategory('mcu')) {
      expect(p.supply.unit).toBe('V');
      expect(p.nominalVcc, p.id).toBeGreaterThan(1);
      expect(p.nominalVcc, p.id).toBeLessThanOrEqual(p.ratings.vccMax.max!);
      expect(p.pullUp.unit).toBe('Ω');
      expect(p.adc.resolution.unit).toBe('bit');
      const vil = p.logic.VIL.max ?? p.logic.VIL.typ!;
      const vih = p.logic.VIH.min ?? p.logic.VIH.typ!;
      if (p.logic.VIL.unit === p.logic.VIH.unit) expect(vil, p.id).toBeLessThan(vih);
    }
  });
});
