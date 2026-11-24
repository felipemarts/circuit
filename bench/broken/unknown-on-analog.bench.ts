import { bench, Not, Const, Resistor } from 'circuitsvibe';

/**
 * SEEDED BROKEN (warning): a logic inverter fed an unknown value drives a
 * resistive load — the analog net sees an undefined, mid-rail level.
 * Expected: D512 unknown-output (warning; the bench still passes). Exit 0.
 */
export default bench('unknown-on-analog', (tb) => {
  const x = tb.add('SX', new Const('X'));
  const g = tb.add('G1', new Not());
  const r1 = tb.add('R1', new Resistor('10k'));
  x.pin('y').connect(g.pin('a'));
  g.pin('y').connect(r1.pin('1'));
  r1.pin('2').connect(tb.gnd);
  tb.name('load', r1.pin('1'));
  tb.expect.op('load').toBeAbove(0);
});
