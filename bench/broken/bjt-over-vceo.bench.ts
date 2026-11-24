import { bench, VoltageSource, Resistor, Part } from 'circuitsvibe';

/**
 * SEEDED BROKEN: a 2N3904 (Vceo 40 V) switching a 48 V load. While it is
 * off the full rail sits across collector-emitter. The bench's spec passes;
 * the datasheet rating does not. Expected: R401 (Vceo, in
 * stages.op.ratings), exit 1. Fix: a transistor rated above 48 V (e.g. BD139,
 * Vceo 80 V) or a lower rail.
 */
export default bench('bjt-over-vceo', (tb) => {
  const vcc = tb.add('VCC', new VoltageSource(48));
  const vin = tb.add('VIN', new VoltageSource(0));
  const rb = tb.add('RB', new Resistor('10k'));
  const rl = tb.add('RL', new Resistor('2.2k'));
  const q1 = tb.add('Q1', Part('2N3904'));

  vcc.pin('-').connect(tb.gnd);
  vin.pin('-').connect(tb.gnd);
  vin.pin('+').connect(rb.pin('1'));
  rb.pin('2').connect(q1.pin('b'));
  vcc.pin('+').connect(rl.pin('1'));
  rl.pin('2').connect(q1.pin('c'));
  q1.pin('e').connect(tb.gnd);

  tb.expect.op('Q1.ic').toBeBelow('1u'); // off, as designed
});
