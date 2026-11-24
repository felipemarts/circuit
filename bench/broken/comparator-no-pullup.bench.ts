import { bench, VoltageSource, Resistor, LED, Part } from 'circuitsvibe';

/**
 * SEEDED BROKEN: LM393 driving an LED to ground from its open-collector
 * output with no pull-up: the output can only sink, so the LED never lights.
 * Expected: F124 open-collector-no-pullup (warning); the LED current
 * assertion then fails (A301), exit 1.
 */
export default bench('comparator-no-pullup', (tb) => {
  const u1 = tb.add('U1', Part('LM393'));
  const vcc = tb.add('VCC', new VoltageSource(5));
  const vin = tb.add('VIN', new VoltageSource(3));
  const vref = tb.add('VREF', new VoltageSource(2));
  const r1 = tb.add('R1', new Resistor('330'));
  const d1 = tb.add('D1', new LED());
  vcc.pin('+').connect(u1.pin('v+'));
  vcc.pin('-').connect(tb.gnd);
  u1.pin('v-').connect(tb.gnd);
  vin.pin('+').connect(u1.pin('inp'));
  vin.pin('-').connect(tb.gnd);
  vref.pin('+').connect(u1.pin('inn'));
  vref.pin('-').connect(tb.gnd);
  r1.pin('1').connect(u1.pin('out'));
  r1.pin('2').connect(d1.pin('anode'));
  d1.pin('cathode').connect(tb.gnd);

  tb.expect.op('D1.i').toBeAbove('5m'); // inp > inn: "output high" was meant to light the LED
});
