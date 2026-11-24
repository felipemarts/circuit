import { describe, it, expect } from 'vitest';
import { bench, runLadder, renderHuman, VoltageSource, Resistor, Part, NPN } from '../../src/forge';
import type { RatingResult, TB } from '../../src/forge';

function ledBench(r: string, extra?: (tb: TB) => void) {
  return bench('led', (tb) => {
    const v1 = tb.add('V1', new VoltageSource(5));
    const r1 = tb.add('R1', new Resistor(r));
    const d1 = tb.add('D1', Part('LED-RED-5MM'));
    v1.pin('+').connect(r1.pin('1'));
    r1.pin('2').connect(d1.pin('anode'));
    d1.pin('cathode').connect(tb.gnd);
    v1.pin('-').connect(tb.gnd);
    tb.expect.op('D1.i').toBeAbove('1m');
    extra?.(tb);
  });
}

const fails = (rs: RatingResult[] | undefined) => (rs ?? []).filter(r => r.verdict === 'fail');

describe('ratings — op stage', () => {
  it('LED overcurrent: R402 against IF = 30 mA, exit 1, citation and location; assertions untouched', () => {
    const rec = runLadder(ledBench('47'), { hints: false });
    expect(rec.exitCode).toBe(1);
    expect(rec.verdict).toBe('fail');
    expect(rec.firstFailure).toBe('R402');
    expect(rec.stages.op!.assertions!.every(a => a.verdict === 'pass')).toBe(true); // spec ≠ rating
    const f = fails(rec.stages.op!.ratings);
    const if_ = f.find(r => r.rating === 'IF')!;
    expect(if_).toMatchObject({ code: 'R402', component: 'D1', part: 'LED-RED-5MM', measure: 'value', limit: 0.03, unit: 'A', confidence: 'verified', modelEstimated: true });
    expect(if_.value).toBeCloseTo(rec.stages.op!.probes!['D1.i'] ?? if_.value, 6);
    expect(if_.utilization).toBeGreaterThan(2);
    expect(if_.margin).toBeLessThan(0);
    expect(if_.source).toMatch(/Kingbright/);
    expect(if_.at).toMatch(/ratings\.test\.ts:\d+/);
    expect(f.some(r => r.code === 'R404' && r.rating === 'Pd')).toBe(true);
    expect(rec.diagnostics).toEqual([]); // ratings live in stages.<stage>.ratings, not diagnostics
    const human = renderHuman(rec);
    expect(human).toMatch(/R402 ratings: D1 \(LED-RED-5MM\) continuous forward current is .* exceeds the absolute maximum IF = 30mA/);
    expect(human).toMatch(/ratings \(datasheet absolute max, simulated\): 3 checked on 1 part, 2 exceeded/);
  });

  it('a compliant LED passes with utilization reported; derate tightens; ignore and disable work', () => {
    const ok = runLadder(ledBench('150'), { hints: false });
    expect(ok.exitCode).toBe(0);
    const if_ = ok.stages.op!.ratings!.find(r => r.rating === 'IF')!;
    expect(if_.verdict).toBe('pass');
    expect(if_.utilization).toBeGreaterThan(0.6); // ~21 mA of 30 mA
    const derated = runLadder(ledBench('150', tb => tb.ratings({ derate: 0.5 })), { hints: false });
    expect(derated.exitCode).toBe(1);
    expect(fails(derated.stages.op!.ratings).find(r => r.rating === 'IF')).toMatchObject({ derate: 0.5, allowed: 0.015 });
    expect(runLadder(ledBench('47', tb => tb.ratings(false)), { hints: false }).exitCode).toBe(0);
    expect(runLadder(ledBench('47', tb => tb.ratings({ ignore: ['D1'] })), { hints: false }).stages.op!.ratings).toBeUndefined();
    expect(runLadder(ledBench('47', tb => tb.ratings({ derate: 1.5 })), { hints: false }).diagnostics[0].code).toBe('T001');
  });

  it('a verified hint keeps the part inside its ratings', () => {
    const rec = runLadder(ledBench('47', tb => tb.param('R1', { min: '47', max: '4.7k', scale: 'log' })));
    const r = fails(rec.stages.op!.ratings).find(x => x.rating === 'IF')!;
    expect(r.hint?.kind).toBe('verified-param-range');
    expect(r.fixes![0].confidence).toBe('verified');
    const again = runLadder(ledBench('47'), { overrides: { R1: r.hint!.suggestedValue }, hints: false });
    expect(again.exitCode).toBe(0);
  });

  it('transistor over Vceo: 2N3904 off across 60 V → R401 Vceo (value 60, limit 40)', () => {
    const b = bench('vceo', (tb) => {
      const v = tb.add('V1', new VoltageSource(60));
      const rc = tb.add('RC', new Resistor('10k'));
      const rb = tb.add('RB', new Resistor('10k'));
      const q = tb.add('Q1', Part('2N3904'));
      v.pin('+').connect(rc.pin('1'));
      rc.pin('2').connect(q.pin('c'));
      rb.pin('1').connect(q.pin('b'));
      rb.pin('2').connect(tb.gnd);
      q.pin('e').connect(tb.gnd);
      v.pin('-').connect(tb.gnd);
    });
    const rec = runLadder(b, { hints: false });
    expect(rec.exitCode).toBe(1);
    const vceo = fails(rec.stages.op!.ratings).find(r => r.rating === 'Vceo')!;
    expect(vceo.code).toBe('R401');
    expect(vceo.value).toBeCloseTo(60, 3);
    expect(vceo.limit).toBe(40);
    expect(vceo.quantity).toBe('Q1.vce');
    const vcbo = rec.stages.op!.ratings!.find(r => r.rating === 'Vcbo')!;
    expect(vcbo.verdict).toBe('pass'); // Vcb just below 60 V = Vcbo: at the limit, not over it
    expect(vcbo.utilization).toBeGreaterThan(0.99);
  });

  it('MOSFET over Vgs: 2N7000 gate at 24 V → R401 Vgs (limit ±20 V)', () => {
    const b = bench('vgs', (tb) => {
      const vg = tb.add('VG', new VoltageSource(24));
      const vd = tb.add('VD', new VoltageSource(5));
      const rd = tb.add('RD', new Resistor('100'));
      const m = tb.add('M1', Part('2N7000'));
      vg.pin('+').connect(m.pin('g'));
      vd.pin('+').connect(rd.pin('1'));
      rd.pin('2').connect(m.pin('d'));
      m.pin('s').connect(tb.gnd);
      vg.pin('-').connect(tb.gnd);
      vd.pin('-').connect(tb.gnd);
    });
    const rec = runLadder(b, { hints: false });
    const f = fails(rec.stages.op!.ratings);
    expect(f.map(r => r.rating)).toEqual(['Vgs']);
    expect(f[0]).toMatchObject({ code: 'R401', value: 24, limit: 20, unit: 'V' });
    expect(f[0].message).toMatch(/M1 \(2N7000\) gate-source voltage \(±\) is 24V/);
  });

  it('dc stage: the peak over the sweep and its sweep value', () => {
    const b = bench('led-sweep', (tb) => {
      const v1 = tb.add('V1', new VoltageSource(3));
      const r1 = tb.add('R1', new Resistor('100'));
      const d1 = tb.add('D1', Part('LED-RED-5MM'));
      v1.pin('+').connect(r1.pin('1'));
      r1.pin('2').connect(d1.pin('anode'));
      d1.pin('cathode').connect(tb.gnd);
      v1.pin('-').connect(tb.gnd);
      tb.expect.dc({ source: 'V1', from: 0, to: 9, points: 10 }).probe('D1.i').toBeMonotonic('increasing');
    });
    const rec = runLadder(b, { hints: false });
    expect(rec.stages.op!.verdict).toBe('pass');
    const f = fails(rec.stages.dc!.ratings).find(r => r.rating === 'IF')!;
    expect(f).toMatchObject({ code: 'R402', measure: 'peak', x: 9 });
    expect(f.config).toMatch(/V1: 0 → 9/);
    expect(rec.exitCode).toBe(1);
  });
});

describe('ratings — transient Pd over limit in a pulse', () => {
  // 2N7000 (Pd 0.4 W) biased into its linear region by a 6 ms gate pulse in a 10 ms window.
  const pulsed = (vgOn: number, extra?: (tb: TB) => void, dcGate?: number) =>
    bench('pd-pulse', (tb) => {
      const vdd = tb.add('VDD', new VoltageSource(10));
      const vg = tb.add(
        'VG',
        new VoltageSource(dcGate !== undefined ? dcGate : { pulse: { v1: 0, v2: vgOn, td: '1m', tr: '1u', tf: '1u', pw: '6m' } }),
      );
      const rl = tb.add('RL', new Resistor('10'));
      const m = tb.add('M1', Part('2N7000'));
      vdd.pin('+').connect(rl.pin('1'));
      rl.pin('2').connect(m.pin('d'));
      vg.pin('+').connect(m.pin('g'));
      m.pin('s').connect(tb.gnd);
      vdd.pin('-').connect(tb.gnd);
      vg.pin('-').connect(tb.gnd);
      if (dcGate === undefined) tb.expect.tran({ tstop: '10m', maxStep: '100u' }).probe('M1.id').toNeverExceed(1);
      extra?.(tb);
    });

  it('average over the window (default) → R404 with the window; instantaneous peak with pd: "peak" → time and value', () => {
    const dcOn = runLadder(pulsed(3.2, undefined, 3.2), { hints: false });
    const pOn = dcOn.stages.op!.ratings!.find(r => r.rating === 'Pd')!.value;
    expect(pOn).toBeGreaterThan(0.8); // the steady on-state dissipation, also an op-stage violation
    const rec = runLadder(pulsed(3.2), { hints: false });
    expect(rec.stages.op!.verdict).toBe('pass'); // gate low at the operating point
    const avg = fails(rec.stages.tran!.ratings).find(r => r.rating === 'Pd')!;
    expect(avg).toMatchObject({ code: 'R404', measure: 'average', window: [0, 0.01] });
    expect(avg.value / pOn).toBeGreaterThan(0.59);
    expect(avg.value / pOn).toBeLessThan(0.61); // on for 6 of the 10 ms
    expect(rec.exitCode).toBe(1);
    expect(rec.stages.tran!.assertions![0].verdict).toBe('pass');

    const peak = runLadder(pulsed(3.2, tb => tb.ratings({ pd: 'peak' })), { hints: false });
    const pk = fails(peak.stages.tran!.ratings).find(r => r.rating === 'Pd')!;
    expect(pk.measure).toBe('peak');
    expect(Math.abs(pk.value / pOn - 1)).toBeLessThan(1e-3);
    expect(pk.time!).toBeGreaterThan(1e-3);
    expect(pk.time!).toBeLessThan(7e-3);
    expect(pk.tFirstViolation!).toBeGreaterThan(1e-3);
    expect(pk.tFirstViolation!).toBeLessThan(1.01e-3); // crosses 0.4 W on the 1 µs rising edge
    // Id25 has a pulsed companion (IdPulsed 0.5 A): average vs Id25, peak vs IdPulsed — both pass.
    const id = rec.stages.tran!.ratings!.filter(r => r.quantity === 'M1.id');
    expect(id.map(r => `${r.rating}:${r.measure}:${r.verdict}`)).toEqual(['Id25:average:pass', 'IdPulsed:peak:pass']);
  });
});

describe('ratings — generic devices are not rated', () => {
  it('new NPN() has no ratings; only Part() devices are checked', () => {
    const b = bench('generic', (tb) => {
      const v = tb.add('V1', new VoltageSource(500));
      const rc = tb.add('RC', new Resistor('10k'));
      const q = tb.add('Q1', new NPN({ bf: 100 }));
      v.pin('+').connect(rc.pin('1'));
      rc.pin('2').connect(q.pin('c'));
      q.pin('b').connect(tb.gnd);
      q.pin('e').connect(tb.gnd);
      v.pin('-').connect(tb.gnd);
    });
    const rec = runLadder(b, { hints: false });
    expect(rec.exitCode).toBe(0);
    expect(rec.stages.op!.ratings).toBeUndefined();
  });
});
