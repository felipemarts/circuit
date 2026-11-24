import { bench, VoltageSource, Resistor, Part } from 'circuitsvibe';

/**
 * SEEDED BROKEN: an LM358 on ±18 V — 36 V across a part rated 32 V absolute
 * maximum. The macro model keeps working (it has no breakdown), so the check
 * is the datasheet rating at the operating point.
 * Expected: R420 opamp-supply-over-max in stages.op.ratings, exit 1.
 */
export default bench('opamp-supply-over-max', (tb) => {
  const u1 = tb.add('U1', Part('LM358'));
  const vin = tb.add('VIN', new VoltageSource(0.5));
  const vcc = tb.add('VCC', new VoltageSource(18));
  const vee = tb.add('VEE', new VoltageSource(-18));
  const r1 = tb.add('R1', new Resistor('10k'));
  const r2 = tb.add('R2', new Resistor('100k'));
  vcc.pin('+').connect(u1.pin('v+'));
  vee.pin('+').connect(u1.pin('v-'));
  vcc.pin('-').connect(tb.gnd);
  vee.pin('-').connect(tb.gnd);
  vin.pin('+').connect(r1.pin('1'));
  vin.pin('-').connect(tb.gnd);
  r1.pin('2').connect(u1.pin('inn'));
  r2.pin('1').connect(u1.pin('inn'));
  r2.pin('2').connect(u1.pin('out'));
  u1.pin('inp').connect(tb.gnd);
  tb.name('out', u1.pin('out'));

  tb.expect.op('out').toBeWithin(-5.1, -4.9);
});
