import { bench, VoltageSource, Resistor, Part } from 'circuitsvibe';

/**
 * SEEDED BROKEN: an LM741 run from ±5 V — the LM741C is specified from ±10 V
 * (20 V total); below that its datasheet values (and the model built from
 * them) do not apply.
 * Expected: R425 opamp-supply-below-min in stages.op.ratings, exit 1.
 */
export default bench('opamp-supply-below-min', (tb) => {
  const u1 = tb.add('U1', Part('LM741'));
  const vin = tb.add('VIN', new VoltageSource(0.1));
  const vcc = tb.add('VCC', new VoltageSource(5));
  const vee = tb.add('VEE', new VoltageSource(-5));
  const r1 = tb.add('R1', new Resistor('10k'));
  const r2 = tb.add('R2', new Resistor('20k'));
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

  tb.expect.op('out').toBeWithin(-0.21, -0.19);
});
