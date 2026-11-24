import { bench, Part, VoltageSource } from 'circuitsvibe';

/**
 * SEEDED BROKEN: two 74HC04 outputs wired together to "share" a signal;
 * their inputs differ, so one drives high while the other drives low.
 * Expected: F136 outputs-tied from lint (U1.1Y, U1.2Y). Exit 2.
 */
export default bench('outputs-tied', (tb) => {
  const vcc = tb.add('VCC', new VoltageSource(5));
  const u1 = tb.add('U1', Part('74HC04'));
  vcc.pin('-').connect(tb.gnd);
  u1.pin('VCC').connect(vcc.pin('+'));
  u1.pin('GND').connect(tb.gnd);
  u1.pin('1A').connect(tb.gnd);
  u1.pin('2A').connect(vcc.pin('+'));
  u1.pin('1Y').connect(u1.pin('2Y'));
  for (const p of ['3A', '4A', '5A', '6A']) u1.pin(p).connect(tb.gnd);
  tb.name('bus', u1.pin('1Y'));
  tb.expect.op('bus').toBeAbove(4);
});
