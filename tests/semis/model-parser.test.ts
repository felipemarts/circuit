import { describe, it, expect } from 'vitest';
import { parseSpiceModel, parseSpiceNumber, Diode, NPN, PNP, NMOS, LED, bench, runLadder, VoltageSource, Resistor } from '../../src/forge';

describe('.model parser — numbers', () => {
  it('SPICE suffixes are case-insensitive: M = milli, MEG = mega, MIL = 25.4 µm; trailing units ignored', () => {
    expect(parseSpiceNumber('1M')).toBe(1e-3);
    expect(parseSpiceNumber('1m')).toBe(1e-3);
    expect(parseSpiceNumber('1MEG')).toBe(1e6);
    expect(parseSpiceNumber('2.2Meg')).toBe(2.2e6);
    expect(parseSpiceNumber('10mil')).toBeCloseTo(254e-6, 18);
    expect(parseSpiceNumber('4pF')).toBe(4e-12);
    expect(parseSpiceNumber('2.52n')).toBe(2.52e-9);
    expect(parseSpiceNumber('1.5V')).toBe(1.5);
    expect(parseSpiceNumber('.3085')).toBe(0.3085);
    expect(parseSpiceNumber('1e-3k')).toBe(1);
    expect(parseSpiceNumber('10F')).toBe(10e-15); // F = femto in SPICE
    expect(parseSpiceNumber('3T')).toBe(3e12);
    expect(parseSpiceNumber('abc')).toBeUndefined();
  });
});

describe('.model parser — cards', () => {
  it('continuation lines, comments, optional parentheses and commas, spaces around =', () => {
    const card = `* 1N4148 from a vendor library
.MODEL D1N4148 D ( IS = 2.52n, RS=0.568 ; series resistance
+ N=1.752 CJO=4p M=0.4
+ TT=20n BV=100 IBV=100u )`;
    const m = parseSpiceModel(card);
    expect(m.diagnostics).toEqual([]);
    expect(m.name).toBe('D1N4148');
    expect(m.type).toBe('D');
    expect(m.params).toEqual({ Is: 2.52e-9, Rs: 0.568, n: 1.752, Cjo: 4e-12, M: 0.4, Tt: 2e-8, BV: 100, IBV: 1e-4 });
    const flat = parseSpiceModel('.model Q1 npn IS=1e-15 BF=200 VAF=0');
    expect(flat.params).toEqual({ Is: 1e-15, Bf: 200, Vaf: Infinity });
  });

  it('unknown parameter → T005 warning (device still built), not a crash', () => {
    const d = Diode.fromModel('.model DX D(IS=1n FOO=3 N=1.5)');
    expect(d.Is).toBe(1e-9);
    expect(d.n).toBe(1.5);
    expect(d.modelDiagnostics).toEqual([
      { code: 'T005', severity: 'warning', message: '.model DX: unknown parameter FOO ignored', params: ['FOO'] },
    ]);
  });

  it('known-but-unmodeled → T008; temperature/noise parameters are silent; vendor metadata is kept', () => {
    const q = PNP.fromModel('.model BC557B PNP(IS=3.83e-14 BF=344.4 XTB=0 EG=1.11 KF=0 IRB=1u RBM=1 Vceo=45 mfg=NXP)');
    expect(q.modelDiagnostics.map(d => [d.code, d.params])).toEqual([['T008', ['IRB', 'RBM']]]);
    expect(parseSpiceModel('.model BC557B PNP(IS=3.83e-14 mfg=NXP Vceo=45)').metadata).toEqual({ mfg: 'NXP', Vceo: '45' });
  });

  it('unsupported LEVEL / device type / mismatched fromModel → T006 error; malformed → T007', () => {
    expect(NMOS.fromModel('.model M1 NMOS(LEVEL=3 VTO=1)').modelDiagnostics.map(d => d.code)).toEqual(['T006']);
    expect(parseSpiceModel('.model J1 NJF(VTO=-2)').diagnostics[0]).toMatchObject({ code: 'T006', severity: 'error' });
    expect(NPN.fromModel('.model Q PNP(BF=100)').modelDiagnostics[0].message).toMatch(/use PNP\.fromModel/);
    expect(Diode.fromModel('.model D1 D(IS=abc)').modelDiagnostics[0]).toMatchObject({ code: 'T007', severity: 'error' });
    expect(Diode.fromModel('D(IS=1n)').modelDiagnostics[0].code).toBe('T007');
    expect(Diode.fromModel('.model D1 D(M=1.5)').modelDiagnostics[0].message).toMatch(/M=1.5 is out of range/);
    expect(LED.fromModel('.model L D(IS=1e-18 N=2 RS=5)').Rs).toBe(5);
  });

  it('MOSFET KP from UO/TOX when KP is absent', () => {
    const m = parseSpiceModel('.model MN NMOS(LEVEL=1 VTO=0.7 UO=600 TOX=20n)');
    expect(m.params.Kp).toBeCloseTo((600e-4 * 3.9 * 8.854187817e-12) / 20e-9, 12);
  });
});

describe('.model diagnostics in the ladder', () => {
  const withCard = (card: string) =>
    bench('card', (tb) => {
      const v = tb.add('V1', new VoltageSource(5));
      const r = tb.add('R1', new Resistor('1k'));
      const d = tb.add('D1', Diode.fromModel(card));
      v.pin('+').connect(r.pin('1'));
      r.pin('2').connect(d.pin('anode'));
      d.pin('cathode').connect(tb.gnd);
      v.pin('-').connect(tb.gnd);
      tb.expect.op('D1.i').toBeAbove('1m');
    });

  it('T005 is a lint warning with the component, location and fix; the run continues (exit 0)', () => {
    const rec = runLadder(withCard('.model DX D(IS=1n FOO=3)'));
    expect(rec.exitCode).toBe(0);
    expect(rec.diagnostics[0]).toMatchObject({ code: 'T005', slug: 'model-unknown-param', severity: 'warning', stage: 'lint', subject: { components: ['D1'] } });
    expect(rec.diagnostics[0].at).toMatch(/model-parser\.test\.ts:\d+/);
  });

  it('T006/T007 stop the run before anything is simulated (exit 3)', () => {
    const rec = runLadder(withCard('.model DX D(LEVEL=2 IS=1n)'));
    expect(rec.exitCode).toBe(3);
    expect(rec.firstFailure).toBe('T006');
    expect(rec.stages.op?.verdict).toBe('skipped');
  });
});
