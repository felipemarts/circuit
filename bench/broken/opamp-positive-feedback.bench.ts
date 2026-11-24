import { bench, VoltageSource, Resistor, OpAmp } from 'circuitsvibe';

/**
 * SEEDED BROKEN: "inverting amplifier" with the inputs swapped — the feedback
 * resistor goes to inp, so the loop gain is positive.
 * Expected: F122 opamp-positive-feedback (warning) from lint. The DC operating
 * point is the circuit's UNSTABLE equilibrium (out = −1 V, which is why the op
 * assertion passes and why the warning matters); the transient shows the
 * output running away to a rail, so the tran assertion fails (A301), exit 1.
 */
export default bench('opamp-positive-feedback', (tb) => {
  const u1 = tb.add('U1', new OpAmp());
  const vin = tb.add('VIN', new VoltageSource(0.1));
  const vcc = tb.add('VCC', new VoltageSource(15));
  const vee = tb.add('VEE', new VoltageSource(-15));
  const r1 = tb.add('R1', new Resistor('10k'));
  const r2 = tb.add('R2', new Resistor('100k'));
  vcc.pin('+').connect(u1.pin('v+'));
  vee.pin('+').connect(u1.pin('v-'));
  vcc.pin('-').connect(tb.gnd);
  vee.pin('-').connect(tb.gnd);
  vin.pin('+').connect(r1.pin('1'));
  vin.pin('-').connect(tb.gnd);
  r1.pin('2').connect(u1.pin('inp')); // should be inn
  r2.pin('1').connect(u1.pin('inp'));
  r2.pin('2').connect(u1.pin('out'));
  u1.pin('inn').connect(tb.gnd); // should be inp
  tb.name('out', u1.pin('out'));

  tb.expect.op('out').toBeCloseTo(-1, 0.01);
  tb.expect.tran({ tstop: '100u', dt: '0.1u' }).probe('out').toEndCloseTo(-1, 0.05);
});
