import { describe, it, expect } from 'vitest';
import {
  DigitalCircuit,
  And,
  Nand,
  Not,
  Buf,
  DFF,
  TriBuf,
  Const,
  Pull,
  Clock,
  Stimulus,
  valueAt,
  lintDigital,
} from '../../src/digital';

const codes = (c: DigitalCircuit) => c.lint().map(d => d.code);

describe('contention at runtime', () => {
  it('strong 0 vs strong 1 ⇒ X + D501 naming both drivers', () => {
    const c = new DigitalCircuit();
    c.add('K0', new Const(0), { y: 'BUS' });
    c.add('K1', new Const(1), { y: 'BUS' });
    c.add('G1', new Buf({ delay: 0 }), { a: 'BUS', y: 'OUT' });
    const sim = c.build();
    expect(sim.value('BUS')).toBe('X');
    expect(sim.value('OUT')).toBe('X');
    const [d] = sim.diagnostics();
    expect(d.code).toBe('D501');
    expect(d.time).toBe(0);
    expect(d.subject?.net).toBe('BUS');
    expect(d.evidence).toEqual({ drivingZero: ['K0.y'], drivingOne: ['K1.y'] });
    expect(codes(c)).toContain('F131');
  });

  it('tri-state bus: contention only while both drivers are enabled; pull-up when released', () => {
    const c = new DigitalCircuit();
    c.add('KA', new Const(0), { y: 'A' });
    c.add('KB', new Const(1), { y: 'B' });
    c.add('SEA', new Stimulus({ initial: 1, changes: [['100n', 0]] }), { y: 'ENA' });
    c.add('SEB', new Stimulus({ changes: [['50n', 1], ['150n', 0]] }), { y: 'ENB' });
    c.add('TA', new TriBuf({ delay: '1n' }), { a: 'A', en: 'ENA', y: 'BUS' });
    c.add('TB', new TriBuf({ delay: '1n' }), { a: 'B', en: 'ENB', y: 'BUS' });
    c.add('PU', new Pull(1), { y: 'BUS' });
    expect(c.lint()).toEqual([]); // tri-state + pull is a legal bus
    const sim = c.build().advanceTo('200n');
    const bus = sim.trace('BUS');
    expect(valueAt(bus, '20n')).toBe(0); // TA drives 0
    expect(valueAt(bus, '70n')).toBe('X'); // both enabled
    expect(valueAt(bus, '120n')).toBe(1); // only TB
    expect(valueAt(bus, '170n')).toBe(1); // released → weak pull-up
    const diags = sim.diagnostics();
    expect(diags.map(d => d.code)).toEqual(['D501']);
    expect(diags[0].time).toBeCloseTo(51e-9, 15);
    expect(diags[0].evidence).toEqual({ drivingZero: ['TA.y'], drivingOne: ['TB.y'] });
  });

  it('pull-up vs pull-down ⇒ X + D507 (warning)', () => {
    const c = new DigitalCircuit();
    c.add('PU', new Pull(1), { y: 'N' });
    c.add('PD', new Pull(0), { y: 'N' });
    const sim = c.build();
    expect(sim.value('N')).toBe('X');
    expect(sim.diagnostics().map(d => [d.code, d.severity])).toEqual([['D507', 'warning']]);
  });
});

describe('digital lint', () => {
  it('a clean circuit has no findings', () => {
    const c = new DigitalCircuit();
    c.add('CLK', new Clock({ freq: '1M' }), { y: 'clk' });
    c.add('FF1', new DFF(), { d: 'NQ', clk: 'clk', q: 'Q' });
    c.add('N1', new Not(), { a: 'Q', y: 'NQ' });
    expect(c.lint()).toEqual([]);
  });

  it('F130: undriven (floating) input', () => {
    const c = new DigitalCircuit();
    c.input('A', { initial: 0 });
    c.add('G1', new And(), { a: 'A', y: 'Y' }); // b left unconnected
    const diags = c.lint();
    expect(diags.map(d => d.code)).toEqual(['F130']);
    expect(diags[0].subject?.pins).toEqual(['G1.b']);
    expect(diags[0].fixes[1].patch).toContain(`c.get('G1').pin('b')`);
    expect(c.build().value('Y')).toBe(0); // A = 0 dominates the floating b
  });

  it('F130 lists every load of a named floating net', () => {
    const c = new DigitalCircuit();
    c.add('G1', new Not(), { a: 'EN' });
    c.add('G2', new Not(), { a: 'EN' });
    const [d] = c.lint();
    expect(d.code).toBe('F130');
    expect(d.subject).toMatchObject({ net: 'EN', pins: ['G1.a', 'G2.a'] });
    expect(d.fixes[1].patch).toBe(`c.add('K_EN', new Const(0), { y: 'EN' });`);
  });

  it('F131: two push-pull outputs on one net', () => {
    const c = new DigitalCircuit();
    c.input('A', { initial: 0 });
    c.add('G1', new Not(), { a: 'A', y: 'Y' });
    c.add('G2', new Buf(), { a: 'A', y: 'Y' });
    const [d] = c.lint();
    expect(d.code).toBe('F131');
    expect(d.subject).toMatchObject({ net: 'Y', components: ['G1', 'G2'], pins: ['G1.y', 'G2.y'] });
  });

  it('F131: push-pull output on an externally driven input net', () => {
    const c = new DigitalCircuit();
    c.input('A');
    c.add('K1', new Const(1), { y: 'A' });
    expect(codes(c)).toEqual(['F131']);
  });

  it('F132: q tied to qn', () => {
    const c = new DigitalCircuit();
    c.add('CLK', new Clock({ freq: '1M' }), { y: 'clk' });
    c.add('K0', new Const(0), { y: 'D' });
    c.add('FF1', new DFF(), { d: 'D', clk: 'clk', q: 'Q', qn: 'Q' });
    const diags = c.lint();
    expect(diags.map(d => d.code)).toEqual(['F132']);
    expect(diags[0].subject?.pins).toEqual(['FF1.q', 'FF1.qn']);
  });

  it('F133: zero-delay combinational loop (and a delayed loop is fine)', () => {
    const c = new DigitalCircuit();
    c.add('N1', new Not({ delay: 0 }), { a: 'L3', y: 'L1' });
    c.add('N2', new Not({ delay: 0 }), { a: 'L1', y: 'L2' });
    c.add('N3', new Not({ delay: 0 }), { a: 'L2', y: 'L3' });
    const diags = c.lint();
    expect(diags.map(d => d.code)).toEqual(['F133']);
    expect(diags[0].subject?.components).toEqual(['N1', 'N2', 'N3']);
    expect(diags[0].subject?.nets).toEqual(['L1', 'L2', 'L3']);
    expect(diags[0].message).toBe('zero-delay combinational loop through N1, N2, N3: L1 →(N2) L2 →(N3) L3 →(N1) L1');

    const ring = new DigitalCircuit();
    ring.add('N1', new Not({ delay: '1n' }), { a: 'L3', y: 'L1' });
    ring.add('N2', new Not({ delay: 0 }), { a: 'L1', y: 'L2' });
    ring.add('N3', new Not({ delay: 0 }), { a: 'L2', y: 'L3' });
    expect(ring.lint()).toEqual([]);
  });

  it('F133 self-loop, and the flip-flop path breaks loops', () => {
    const c = new DigitalCircuit();
    c.input('EN', { initial: 0 });
    c.add('G1', new Nand({ delay: 0 }), { a: 'EN', b: 'Y', y: 'Y' });
    expect(codes(c)).toEqual(['F133']);

    const ff = new DigitalCircuit();
    ff.add('CLK', new Clock({ freq: '1M' }), { y: 'clk' });
    ff.add('FF1', new DFF({ delay: 0 }), { d: 'NQ', clk: 'clk', q: 'Q' });
    ff.add('N1', new Not({ delay: 0 }), { a: 'Q', y: 'NQ' });
    expect(ff.lint()).toEqual([]);
  });

  it('F134: clock pin not driven', () => {
    const c = new DigitalCircuit();
    c.add('K1', new Const(1), { y: 'D' });
    c.add('FF1', new DFF(), { d: 'D', q: 'Q' });
    const diags = c.lint();
    expect(diags.map(d => d.code)).toEqual(['F134']);
    expect(diags[0].subject?.pins).toEqual(['FF1.clk']);
    expect(diags[0].fixes[0].patch).toBe(`c.add('CLK_FF1', new Clock({ freq: '1M' })).pin('y').connect(c.get('FF1').pin('clk'));`);
  });

  it('lint works on a plain JSON netlist', () => {
    const json = JSON.parse(JSON.stringify({ components: [{ id: 'G1', type: 'Not', params: {}, pins: { y: 'Y' } }] }));
    expect(lintDigital(json).map(d => d.code)).toEqual(['F130']);
  });
});

describe('zero-delay oscillation at runtime', () => {
  it('D504 when a zero-delay inverting loop is enabled; the kernel keeps going', () => {
    const c = new DigitalCircuit();
    c.add('SE', new Stimulus({ changes: [['10n', 1]] }), { y: 'EN' });
    c.add('G1', new Nand({ delay: 0 }), { a: 'EN', b: 'Y', y: 'Y' });
    const sim = c.build({ maxDeltaCycles: 100 });
    expect(sim.value('Y')).toBe(1); // EN = 0 → stable at power-on
    sim.advanceTo('50n');
    const [d] = sim.diagnostics();
    expect(d.code).toBe('D504');
    expect(d.time).toBeCloseTo(10e-9, 15);
    expect(d.subject?.components).toEqual(['G1']);
    expect(sim.now).toBeCloseTo(50e-9, 15);
    expect(sim.nextEventTime()).toBeUndefined();
  });

  it('the same loop with a real delay is a ring oscillator', () => {
    const c = new DigitalCircuit();
    c.add('SE', new Stimulus({ changes: [['10n', 1]] }), { y: 'EN' });
    c.add('G1', new Nand({ delay: '1n' }), { a: 'EN', b: 'Y', y: 'Y' });
    const sim = c.build().advanceTo('31n');
    expect(sim.diagnostics()).toEqual([]);
    expect(sim.trace('Y').t.length).toBe(22); // power-on + a toggle every 1 ns from 11n to 31n
  });
});
