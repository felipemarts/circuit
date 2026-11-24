import { bench, Part, VoltageSource, Resistor, LED } from 'circuitsvibe';

/**
 * SEEDED BROKEN: the 74HC00 gate driving the LED has its input B left open
 * (forgot the pull-up). A floating CMOS input has no defined level.
 * Expected: F137 floating-logic-input (error) naming U1.1B. Exit 2.
 */
export default bench('floating-cmos-input', (tb) => {
  const vcc = tb.add('VCC', new VoltageSource(5));
  const u1 = tb.add('U1', Part('74HC00'));
  const r1 = tb.add('R1', new Resistor('330'));
  const d1 = tb.add('D1', new LED());
  vcc.pin('-').connect(tb.gnd);
  u1.pin('VCC').connect(vcc.pin('+'));
  u1.pin('GND').connect(tb.gnd);
  u1.pin('1A').connect(vcc.pin('+'));
  u1.pin('1Y').connect(r1.pin('1'));
  r1.pin('2').connect(d1.pin('anode'));
  d1.pin('cathode').connect(tb.gnd);
  for (const p of ['2A', '2B', '3A', '3B', '4A', '4B']) u1.pin(p).connect(tb.gnd);
  tb.expect.op('D1.i').toBeWithin('5m', '15m');
});
