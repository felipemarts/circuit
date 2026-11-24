import { bench, VoltageSource, Resistor, IdealOpAmp } from 'circuitsvibe';

/**
 * SEEDED BROKEN: an IdealOpAmp output wired straight to gnd. The ideal output
 * is a voltage source to ground, so the node is over-constrained.
 * Expected: F123 ideal-opamp-output-forced from lint (not a singular-matrix
 * S101 from the solver), exit 2.
 */
export default bench('ideal-opamp-output-shorted', (tb) => {
  const u1 = tb.add('U1', new IdealOpAmp());
  const vin = tb.add('VIN', new VoltageSource(1));
  const rf = tb.add('RF', new Resistor('10k'));
  vin.pin('+').connect(u1.pin('inp'));
  vin.pin('-').connect(tb.gnd);
  rf.pin('1').connect(u1.pin('inn'));
  rf.pin('2').connect(u1.pin('out'));
  u1.pin('out').connect(tb.gnd);

  tb.expect.op('U1.i').toBeBelow(0.1);
});
