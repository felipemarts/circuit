import { describe, it, expect } from 'vitest';
import { bench, runLadder, VoltageSource, Resistor, Capacitor, Inductor, Diode, LED } from '../../src/forge';
import type { TB, RunRecord } from '../../src/forge';

/** Drop the fields that legitimately differ between two sources of the same netlist. */
function withoutLocations(record: RunRecord): unknown {
  return JSON.parse(JSON.stringify(record), (key, value) => (key === 'at' ? undefined : value));
}

function asserts(tb: TB): void {
  tb.expect.op('D1.i').toBeAbove(0);
  tb.expect.op('mid').toBeAbove(0);
  tb.expect.dc({ source: 'V1', from: 0, to: 6, points: 13 }).probe('mid').toBeMonotonic('increasing');
  tb.expect.ac({ from: '10', to: '100k', pointsPerDecade: 10 }).probe('mid').gainAt('1k').toBeBelow(0);
  tb.expect.tran({ tstop: '2m', dt: '5u', maxStep: '50u' }).probe('C1.v').toNeverExceed(10).probe('L1.i').toNeverExceed(1);
}

// V1 → R1 → mid; mid → D1 → gnd; mid → L1 → R2 → C1 → gnd; mid → R3 → LED D2 → gnd.
const forward = bench('ordering', (tb: TB) => {
  const v1 = tb.add('V1', new VoltageSource({ dc: 5, ac: 1, pulse: { v1: 0, v2: 5, tr: '10u', tf: '10u', pw: '1m', per: '2m' } }));
  const r1 = tb.add('R1', new Resistor('470'));
  const d1 = tb.add('D1', new Diode());
  const l1 = tb.add('L1', new Inductor('1m'));
  const r2 = tb.add('R2', new Resistor('100'));
  const c1 = tb.add('C1', new Capacitor('1u'));
  const r3 = tb.add('R3', new Resistor('330'));
  const d2 = tb.add('D2', new LED());
  v1.pin('+').connect(r1.pin('1'));
  r1.pin('2').connect(d1.pin('anode'));
  d1.pin('cathode').connect(tb.gnd);
  r1.pin('2').connect(l1.pin('1'));
  l1.pin('2').connect(r2.pin('1'));
  r2.pin('2').connect(c1.pin('1'));
  c1.pin('2').connect(tb.gnd);
  r1.pin('2').connect(r3.pin('1'));
  r3.pin('2').connect(d2.pin('anode'));
  d2.pin('cathode').connect(tb.gnd);
  v1.pin('-').connect(tb.gnd);
  tb.name('mid', r1.pin('2'));
  asserts(tb);
});

// The same netlist, declared and wired in a different order.
const shuffled = bench('ordering', (tb: TB) => {
  const d2 = tb.add('D2', new LED());
  const c1 = tb.add('C1', new Capacitor('1u'));
  const r3 = tb.add('R3', new Resistor('330'));
  const l1 = tb.add('L1', new Inductor('1m'));
  const v1 = tb.add('V1', new VoltageSource({ dc: 5, ac: 1, pulse: { v1: 0, v2: 5, tr: '10u', tf: '10u', pw: '1m', per: '2m' } }));
  const r2 = tb.add('R2', new Resistor('100'));
  const d1 = tb.add('D1', new Diode());
  const r1 = tb.add('R1', new Resistor('470'));
  d2.pin('cathode').connect(tb.gnd);
  c1.pin('2').connect(tb.gnd);
  v1.pin('-').connect(tb.gnd);
  d1.pin('cathode').connect(tb.gnd);
  r3.pin('2').connect(d2.pin('anode'));
  r2.pin('2').connect(c1.pin('1'));
  l1.pin('2').connect(r2.pin('1'));
  d1.pin('anode').connect(l1.pin('1'));
  r3.pin('1').connect(d1.pin('anode'));
  r1.pin('2').connect(r3.pin('1'));
  r1.pin('1').connect(v1.pin('+'));
  tb.name('mid', l1.pin('1'));
  asserts(tb);
});

describe('deterministic ordering of matrix unknowns', () => {
  it('the same netlist declared in a different order gives a byte-identical RunRecord (except `at`)', () => {
    const a = runLadder(forward);
    const b = runLadder(shuffled);
    expect(a.exitCode).toBe(0);
    expect(a.netlist.hash).toBe(b.netlist.hash);
    expect(JSON.stringify(withoutLocations(a))).toBe(JSON.stringify(withoutLocations(b)));
    // Every stage ran, so the equality covers op, dc, ac and tran numbers.
    expect(Object.keys(a.stages)).toEqual(['lint', 'op', 'dc', 'ac', 'tran']);
  });

  it('repeated runs are byte-identical', () => {
    expect(JSON.stringify(runLadder(forward))).toBe(JSON.stringify(runLadder(forward)));
  });
});
