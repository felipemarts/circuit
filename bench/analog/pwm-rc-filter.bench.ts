import { bench, VoltageSource, Resistor, Capacitor } from 'circuitsvibe';

/**
 * 10 kHz, 25 % duty PWM (0/5 V) into an RC filter with tau = 10 ms: the
 * output settles to the average, 1.25 V, with a small ripple.
 */
export default bench('pwm-rc-filter', (tb) => {
  const v1 = tb.add('V1', new VoltageSource({ pwm: { low: 0, high: 5, freq: '10k', duty: '25%', rise: '100n', fall: '100n' } }));
  const r1 = tb.add('R1', new Resistor('10k'));
  const c1 = tb.add('C1', new Capacitor('1u'));

  v1.pin('+').connect(r1.pin('1'));
  r1.pin('2').connect(c1.pin('1'));
  c1.pin('2').connect(tb.gnd);
  v1.pin('-').connect(tb.gnd);
  tb.name('out', c1.pin('1'));

  tb.expect
    .tran({ tstop: '80m', maxStep: '10u' })
    .probe('out')
    .toSettleWithin({ target: 1.25, tol: 0.05, by: '60m' })
    .toRippleBelow('50m', { from: '60m' });
});
