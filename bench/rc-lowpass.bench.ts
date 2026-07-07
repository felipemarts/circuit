import { bench, VoltageSource, Resistor, Capacitor } from 'circuit-forge';

/**
 * RC step response: 5 V into R(1k) + C(1u), τ = 1 ms.
 * Demonstrates transient assertions — passes as written.
 */
export default bench('rc-lowpass', (tb) => {
  const v1 = tb.add('V1', new VoltageSource(5));
  const r1 = tb.add('R1', new Resistor('1k'));
  const c1 = tb.add('C1', new Capacitor('1u'));

  v1.pin('+').connect(r1.pin('1'));
  r1.pin('2').connect(c1.pin('1'));
  c1.pin('2').connect(tb.gnd);
  v1.pin('-').connect(tb.gnd);

  tb.name('out', c1.pin('1'));

  tb.expect.op('out').toBeCloseTo(5, 0.01); // fully charged at DC

  tb.expect
    .tran({ tstop: '6m', dt: '10u' })
    .probe('C1.v')
    .toSettleWithin({ target: 5, tol: 0.05, by: '4m' })
    .toNeverExceed(5.5)
    .toEndCloseTo(5, 0.1)
    .probe('R1.i')
    .toStayBelow('6m'); // inrush current bounded by V/R
});
