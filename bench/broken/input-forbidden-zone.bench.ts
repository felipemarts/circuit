import { bench, Part, VoltageSource, Resistor } from 'circuitsvibe';

/**
 * SEEDED BROKEN: a 10k/10k divider meant as a "logic high" puts 2.5 V on a
 * 74HC04 input at VCC = 5 V — between VIL (1.5 V) and VIH (3.5 V).
 * Expected: D508 input-forbidden-zone at the operating point (U1.1A, with
 * vil/vih/supply evidence). Exit 2.
 */
export default bench('input-forbidden-zone', (tb) => {
  const vcc = tb.add('VCC', new VoltageSource(5));
  const u1 = tb.add('U1', Part('74HC04'));
  const ra = tb.add('RA', new Resistor('10k'));
  const rb = tb.add('RB', new Resistor('10k'));
  vcc.pin('-').connect(tb.gnd);
  u1.pin('VCC').connect(vcc.pin('+'));
  u1.pin('GND').connect(tb.gnd);
  ra.pin('1').connect(vcc.pin('+'));
  ra.pin('2').connect(u1.pin('1A'));
  rb.pin('1').connect(u1.pin('1A'));
  rb.pin('2').connect(tb.gnd);
  for (const p of ['2A', '3A', '4A', '5A', '6A']) u1.pin(p).connect(tb.gnd);
  tb.expect.op('U1.1Y').toBeBelow(0.5);
});
