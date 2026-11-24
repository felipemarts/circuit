import { bench, VoltageSource, Resistor, Part } from 'circuitsvibe';

/**
 * SEEDED BROKEN: an LM311 on ±15 V comparing +20 V against −20 V — 40 V
 * between the inputs of a part rated 30 V absolute maximum.
 * Expected: R421 opamp-differential-input-over-max in stages.op.ratings, exit 1.
 */
export default bench('comparator-differential-input', (tb) => {
  const u1 = tb.add('U1', Part('LM311'));
  const vcc = tb.add('VCC', new VoltageSource(15));
  const vee = tb.add('VEE', new VoltageSource(-15));
  const va = tb.add('VA', new VoltageSource(20));
  const vb = tb.add('VB', new VoltageSource(-20));
  const rp = tb.add('RP', new Resistor('1k'));
  vcc.pin('+').connect(u1.pin('v+'));
  vee.pin('+').connect(u1.pin('v-'));
  vcc.pin('-').connect(tb.gnd);
  vee.pin('-').connect(tb.gnd);
  u1.pin('emit').connect(tb.gnd);
  va.pin('+').connect(u1.pin('inp'));
  va.pin('-').connect(tb.gnd);
  vb.pin('+').connect(u1.pin('inn'));
  vb.pin('-').connect(tb.gnd);
  rp.pin('1').connect(vcc.pin('+'));
  rp.pin('2').connect(u1.pin('out'));
  tb.name('out', u1.pin('out'));

  tb.expect.op('out').toBeAbove(14);
});
