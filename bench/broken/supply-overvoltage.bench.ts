import { bench, Part, VoltageSource, Resistor } from 'circuitsvibe';

/**
 * SEEDED BROKEN: a 74HC14 on the 9 V rail. 74HC is rated 2–6 V (7 V absolute
 * maximum): the part would be destroyed.
 * Expected: D509 supply-out-of-range (error, beyond the absolute maximum). Exit 2.
 */
export default bench('supply-overvoltage', (tb) => {
  const vcc = tb.add('VCC', new VoltageSource(9));
  const u1 = tb.add('U1', Part('74HC14'));
  const r1 = tb.add('R1', new Resistor('10k'));
  vcc.pin('-').connect(tb.gnd);
  u1.pin('VCC').connect(vcc.pin('+'));
  u1.pin('GND').connect(tb.gnd);
  for (const p of ['1A', '2A', '3A', '4A', '5A', '6A']) u1.pin(p).connect(tb.gnd);
  u1.pin('1Y').connect(r1.pin('1'));
  r1.pin('2').connect(tb.gnd);
  tb.expect.op('R1.i').toBeAbove(0);
});
