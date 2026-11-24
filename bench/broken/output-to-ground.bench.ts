import { bench, Part, VoltageSource } from 'circuitsvibe';

/**
 * SEEDED BROKEN: an unused 74HC04 section "tied off" by grounding its OUTPUT
 * instead of its input — with the input low the output drives high into GND.
 * Expected: F138 output-on-rail naming U1.6Y. Exit 2.
 */
export default bench('output-to-ground', (tb) => {
  const vcc = tb.add('VCC', new VoltageSource(5));
  const u1 = tb.add('U1', Part('74HC04'));
  vcc.pin('-').connect(tb.gnd);
  u1.pin('VCC').connect(vcc.pin('+'));
  u1.pin('GND').connect(tb.gnd);
  for (const p of ['1A', '2A', '3A', '4A', '5A', '6A']) u1.pin(p).connect(tb.gnd);
  u1.pin('6Y').connect(tb.gnd);
  tb.expect.op('U1.1Y').toBeAbove(4.9);
});
