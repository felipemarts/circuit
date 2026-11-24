import { bench, Part, VoltageSource, LED } from 'circuitsvibe';

/**
 * SEEDED BROKEN: an LED straight on a 74HC04 output (no resistor). Only the
 * output resistance limits the current: ~60 mA, over the 25 mA absolute maximum.
 * Expected: D511 output-overcurrent at the operating point (U1.1Y). Exit 2.
 */
export default bench('led-on-logic-output', (tb) => {
  const vcc = tb.add('VCC', new VoltageSource(5));
  const u1 = tb.add('U1', Part('74HC04'));
  const d1 = tb.add('D1', new LED());
  vcc.pin('-').connect(tb.gnd);
  u1.pin('VCC').connect(vcc.pin('+'));
  u1.pin('GND').connect(tb.gnd);
  for (const p of ['1A', '2A', '3A', '4A', '5A', '6A']) u1.pin(p).connect(tb.gnd);
  u1.pin('1Y').connect(d1.pin('anode'));
  d1.pin('cathode').connect(tb.gnd);
  tb.expect.op('D1.i').toBeWithin('5m', '20m');
});
