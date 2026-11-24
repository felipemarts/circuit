import { bench, VoltageSource, Resistor, Part } from 'circuitsvibe';

/**
 * SEEDED BROKEN: a single-supply TL072 (0/12 V) with its input driven to
 * −1 V — beyond the absolute maximum input voltage V− − 0.5 V.
 * Expected: R424 opamp-input-over-max in stages.op.ratings, exit 1.
 */
export default bench('opamp-input-below-rail', (tb) => {
  const u1 = tb.add('U1', Part('TL072'));
  const vin = tb.add('VIN', new VoltageSource(-1));
  const vcc = tb.add('VCC', new VoltageSource(12));
  const rl = tb.add('RL', new Resistor('10k'));
  vcc.pin('+').connect(u1.pin('v+'));
  vcc.pin('-').connect(tb.gnd);
  u1.pin('v-').connect(tb.gnd);
  vin.pin('+').connect(u1.pin('inp'));
  vin.pin('-').connect(tb.gnd);
  u1.pin('inn').connect(u1.pin('out'));
  rl.pin('1').connect(u1.pin('out'));
  rl.pin('2').connect(tb.gnd);
  tb.name('out', u1.pin('out'));

  tb.expect.op('out').toBeBelow(4);
});
