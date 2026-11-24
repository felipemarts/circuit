import { bench, VoltageSource, Resistor, Part } from 'circuitsvibe';

/**
 * SEEDED BROKEN: an NE5532 follower driving a 10 Ω load directly: the output
 * current hits the short-circuit limit (38 mA typ), so the output sits near
 * 0.38 V instead of following the 2 V input.
 * Expected: R422 opamp-output-current-limit in stages.op.ratings (and the
 * output assertion fails), exit 1.
 */
export default bench('opamp-output-short', (tb) => {
  const u1 = tb.add('U1', Part('NE5532'));
  const vin = tb.add('VIN', new VoltageSource(2));
  const vcc = tb.add('VCC', new VoltageSource(15));
  const vee = tb.add('VEE', new VoltageSource(-15));
  const rl = tb.add('RL', new Resistor('10'));
  vcc.pin('+').connect(u1.pin('v+'));
  vee.pin('+').connect(u1.pin('v-'));
  vcc.pin('-').connect(tb.gnd);
  vee.pin('-').connect(tb.gnd);
  vin.pin('+').connect(u1.pin('inp'));
  vin.pin('-').connect(tb.gnd);
  u1.pin('inn').connect(u1.pin('out'));
  rl.pin('1').connect(u1.pin('out'));
  rl.pin('2').connect(tb.gnd);
  tb.name('out', u1.pin('out'));

  tb.expect.op('out').toBeCloseTo(2, 0.01);
});
