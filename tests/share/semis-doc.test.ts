import { describe, it, expect } from 'vitest';
import {
  bench,
  runLadder,
  renderHuman,
  toCircuitDoc,
  benchFromDoc,
  validateCircuitDoc,
  describeComponent,
  buildComponent,
  Part,
  PART_RESOLVERS,
  VoltageSource,
  Resistor,
  Diode,
  type BenchDescriptor,
} from '../../src/forge';
import { load } from './helpers';

// Integration of the semiconductor branch with the circuit document and the
// mixed-signal runtime: one Part() over every family, tb.ratings(...) and
// .model cards carried by the document, device-quantity probes validated,
// datasheet ratings and logic captures reported side by side.

/** 5 V → R → (catalog or fromModel) diode, with an op assertion on the diode current. */
function diodeBench(name: string, opts: { ratings?: Parameters<import('../../src/forge').TB['ratings']>[0]; card?: string; r?: string } = {}): BenchDescriptor {
  return bench(name, tb => {
    const v1 = tb.add('V1', new VoltageSource(5));
    const r1 = tb.add('R1', new Resistor(opts.r ?? '1k'));
    const d1 = tb.add('D1', opts.card ? Diode.fromModel(opts.card) : Part('1N4148'));
    v1.pin('+').connect(r1.pin('1'));
    r1.pin('2').connect(d1.pin('anode'));
    d1.pin('cathode').connect(tb.gnd);
    v1.pin('-').connect(tb.gnd);
    if (opts.ratings !== undefined) tb.ratings(opts.ratings);
    tb.expect.op('D1.i').toBeWithin('1m', '10m');
    tb.expect.op('D1.p').toBeBelow('10m');
  });
}

const roundTrip = (desc: BenchDescriptor) => {
  const doc = toCircuitDoc(desc);
  const back = benchFromDoc(JSON.parse(JSON.stringify(doc)));
  return { doc, original: JSON.stringify(runLadder(desc)), replayed: JSON.stringify(runLadder(back)), again: toCircuitDoc(back) };
};

describe('unified Part()', () => {
  it('dispatches to the IC family and the semiconductor family', () => {
    expect((Part('74HC04') as { kind?: string }).kind).toBe('IC');
    expect((Part('sn74hc04n') as { kind?: string }).kind).toBe('IC'); // catalog alias
    expect((Part('2N3904') as { kind?: string }).kind).toBe('NPN');
    expect((Part('IRLZ44N') as { kind?: string }).kind).toBe('NMOS');
    expect((Part('LED-RED-5MM') as { kind?: string }).kind).toBe('LED');
    expect(PART_RESOLVERS.map(r => r.family)).toEqual(['logic ICs / timers', 'op-amps / comparators', 'semiconductors', 'microcontroller boards']);
    expect((Part('LM358') as { kind?: string }).kind).toBe('OpAmp');
    expect((Part('LM393') as { kind?: string }).kind).toBe('Comparator');
  });

  it('lists every family in the unknown-part error and refuses IC options on semiconductors', () => {
    expect(() => Part('NOPE123')).toThrow(/unknown part \(no such part in the catalog\)\. Simulatable catalog parts: logic ICs \/ timers: .*74HC04.*; op-amps \/ comparators: .*LM358.*; semiconductors: .*2N3904/);
    expect(() => Part('2N3904', { corner: 'worst' })).toThrow(/apply to logic ICs only/);
    expect(() => Part('')).toThrow(/expected a catalog part id/);
  });

  it('both buildComponent round trips survive: ICs by catalog-id type, semiconductors by part param', () => {
    for (const c of [Part('74HC04'), Part('NE555'), Part('2N3906'), Part('1N4733A')]) {
      const info = describeComponent(c);
      expect(describeComponent(buildComponent(info.type, JSON.parse(JSON.stringify(info.params))))).toEqual(info);
    }
    expect(describeComponent(Part('2N3904')).params.part).toBe('2N3904');
    expect(describeComponent(Part('74HC04')).type).toBe('74HC04');
  });
});

describe('circuit document: tb.ratings(...) settings', () => {
  it('writes only non-default keys and replays them byte-identically', () => {
    const plain = roundTrip(diodeBench('ratings-default'));
    expect(plain.doc.ratings).toBeUndefined();
    expect(plain.replayed).toBe(plain.original);

    const custom = roundTrip(diodeBench('ratings-custom', { ratings: { derate: 0.5, pd: 'peak', ignore: ['D1'] } }));
    expect(custom.doc.ratings).toEqual({ derate: 0.5, pd: 'peak', ignore: ['D1'] });
    expect(custom.replayed).toBe(custom.original);
    expect(custom.again).toEqual(custom.doc);

    const off = roundTrip(diodeBench('ratings-off', { ratings: false }));
    expect(off.doc.ratings).toEqual({ enabled: false });
    expect(JSON.parse(off.original).stages.op.ratings).toBeUndefined();
    expect(off.replayed).toBe(off.original);
  });

  it('a derated rating that fails in the bench fails identically from the document', () => {
    // 5 V / 47 Ω ≈ 90 mA through a 1N4148 (IF 300 mA): passes at derate 1, fails at 0.2.
    const desc = diodeBench('ratings-derated', { r: '47', ratings: { derate: 0.2 } });
    const { doc, original, replayed } = roundTrip(desc);
    expect(doc.ratings).toEqual({ derate: 0.2 });
    const record = JSON.parse(original);
    expect(record.exitCode).toBe(1);
    expect(record.stages.op.ratings.some((r: { code: string; verdict: string }) => r.code === 'R402' && r.verdict === 'fail')).toBe(true);
    expect(replayed).toBe(original);
  });

  it('rejects malformed ratings settings (T010)', () => {
    const doc = toCircuitDoc(diodeBench('ratings-bad'));
    const codes = (ratings: unknown) => {
      const r = validateCircuitDoc({ ...doc, ratings });
      return r.ok ? [] : r.diagnostics.map(d => `${d.code} ${d.evidence?.path}`);
    };
    expect(codes({ derate: 0.8 })).toEqual([]);
    expect(codes({ derate: 2 })).toEqual(['T010 /ratings/derate']);
    expect(codes({ pd: 'max' })).toEqual(['T010 /ratings/pd']);
    expect(codes({ ignore: ['Q9'] })).toEqual(['T010 /ratings/ignore/0']);
    expect(codes({ ignore: ['D1', 'D1'] })).toEqual(['T010 /ratings/ignore/1']);
    expect(codes({ margin: 1 })).toEqual(['T010 /ratings/margin']);
    expect(codes(false)).toEqual(['T010 /ratings']);
  });
});

describe('circuit document: .model cards', () => {
  const card = '.model D1N4148 D(IS=2.52n RSS=0.568 N=1.752 CJO=4p M=0.4 TT=20n BV=100 IBV=100u)';

  it('carries the card and replays its lint diagnostics (T005) byte-identically', () => {
    const { doc, original, replayed, again } = roundTrip(diodeBench('model-card', { card }));
    const d1 = doc.components.find(c => c.id === 'D1')!;
    expect(d1.modelCard).toBe(card);
    expect(d1.params.model).toBe('D1N4148');
    expect(JSON.parse(original).diagnostics.map((d: { code: string }) => d.code)).toEqual(['T005']);
    expect(replayed).toBe(original);
    expect(again).toEqual(doc);
  });

  it('refuses a card on a non-semiconductor or naming another model', () => {
    const doc = toCircuitDoc(diodeBench('model-card-bad', { card }));
    const edit = (f: (d: any) => void) => {
      const d = JSON.parse(JSON.stringify(doc));
      f(d);
      const r = validateCircuitDoc(d);
      return r.ok ? [] : r.diagnostics.map(x => x.code);
    };
    expect(edit(d => (d.components.find((c: { id: string }) => c.id === 'R1').modelCard = card))).toEqual(['T010']);
    expect(edit(d => (d.components.find((c: { id: string }) => c.id === 'D1').params.model = 'OTHER'))).toEqual(['T014']);
    expect(edit(d => (d.components.find((c: { id: string }) => c.id === 'D1').modelCard = 42))).toEqual(['T010']);
  });
});

describe('circuit document: device-quantity probes', () => {
  it("accepts 'Q1.ic' / 'D1.p' and refuses quantities the device does not expose", async () => {
    const doc = toCircuitDoc(await load('bench/semis/led-transistor-switch.bench.ts'));
    expect(validateCircuitDoc(doc).ok).toBe(true);
    const probe = (p: string) => {
      const d = JSON.parse(JSON.stringify(doc));
      d.assertions[0].probe = p;
      const r = validateCircuitDoc(d);
      return r.ok ? [] : r.diagnostics.map(x => `${x.code} ${x.message}`);
    };
    expect(probe('Q1.ic')).toEqual([]);
    expect(probe('Q1.vbe')).toEqual([]);
    expect(probe('D1.p')).toEqual([]);
    expect(probe('Q1.vgs')[0]).toMatch(/^T010 .*NPN 'Q1' has no quantity 'vgs' \(available: .*'Q1\.ic'/);
    expect(probe('Q9.ic')[0]).toMatch(/^T010 /);
  });
});

describe('mixed-signal + real semiconductors', () => {
  it('a 74HC04 driving a 2N3904 reports logic captures and ratings in the same run', async () => {
    const record = runLadder(await load('bench/semis/hc04-drives-npn.bench.ts'));
    expect(record.exitCode).toBe(0);
    expect(record.stages.op?.ratings?.length).toBeGreaterThan(0);
    expect(record.stages.tran?.ratings?.length).toBeGreaterThan(0);
    expect(record.stages.tran?.logic?.[0].signals.drive.length).toBeGreaterThan(2);
    const human = renderHuman(record);
    expect(human).toMatch(/logic \[tstop=.*drive \d+ changes/);
    expect(human).toMatch(/ratings \(datasheet absolute max, simulated\): \d+ checked on 2 parts, 0 exceeded/);
  });

  it('ratings run after a mixed-signal transient: an over-driven LED behind the transistor is R402, not an IC diagnostic', () => {
    // Input high at t = 0 (LED off: op passes), low from 0.1 ms on: the LED is over-driven in tran.
    const desc = bench('hc04-npn-led-overcurrent', tb => {
      const vcc = tb.add('VCC', new VoltageSource(5));
      const vin = tb.add('VIN', new VoltageSource({ pulse: { v1: 5, v2: 0, td: '0.1m', tr: '10n', tf: '10n', pw: '10m', per: '20m' } }));
      const u1 = tb.add('U1', Part('74HC04'));
      const rb = tb.add('RB', new Resistor('4.7k'));
      const rled = tb.add('RLED', new Resistor('33'));
      const q1 = tb.add('Q1', Part('2N3904'));
      const d1 = tb.add('D1', Part('LED-RED-5MM'));
      vcc.pin('-').connect(tb.gnd);
      u1.pin('VCC').connect(vcc.pin('+'));
      u1.pin('GND').connect(tb.gnd);
      vin.pin('-').connect(tb.gnd);
      vin.pin('+').connect(u1.pin('1A'));
      for (const p of ['2A', '3A', '4A', '5A', '6A']) u1.pin(p).connect(tb.gnd);
      tb.name('drive', u1.pin('1Y'));
      u1.pin('1Y').connect(rb.pin('1'));
      rb.pin('2').connect(q1.pin('b'));
      vcc.pin('+').connect(rled.pin('1'));
      rled.pin('2').connect(d1.pin('anode'));
      d1.pin('cathode').connect(q1.pin('c'));
      q1.pin('e').connect(tb.gnd);
      const run = tb.expect.tran({ tstop: '1m', maxStep: '50u' });
      run.probe('Q1.ic').toNeverExceed('1');
      run.logic('drive').toBe(1).at('0.5m');
    });
    const record = runLadder(desc);
    expect(record.exitCode).toBe(1);
    const failed = (s: 'op' | 'tran') => (record.stages[s]?.ratings ?? []).filter(r => r.verdict === 'fail').map(r => `${r.component} ${r.code}`);
    expect(failed('op')).toEqual([]);
    expect(failed('tran')).toContain('D1 R402');
    expect(record.stages.tran?.assertions?.every(a => a.verdict === 'pass')).toBe(true);
    expect(record.stages.tran?.logic?.length).toBe(1);
    expect(record.diagnostics.map(d => d.code)).not.toContain('D511');
    expect(JSON.stringify(runLadder(benchFromDoc(toCircuitDoc(desc))))).toBe(JSON.stringify(record));
  });
});
