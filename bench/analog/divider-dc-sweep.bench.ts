import { bench, VoltageSource, Resistor } from 'circuitsvibe';

/**
 * Resistive divider swept from 0 to 10 V: the output is exactly V1/2, a
 * straight line through the origin with slope 0.5.
 *
 *   circuitsvibe sweep bench/analog/divider-dc-sweep.bench.ts --source V1 --from 0 --to 10 --points 11 --probe out
 */
export default bench('divider-dc-sweep', (tb) => {
  const v1 = tb.add('V1', new VoltageSource(5));
  const r1 = tb.add('R1', new Resistor('10k'));
  const r2 = tb.add('R2', new Resistor('10k'));

  v1.pin('+').connect(r1.pin('1'));
  r1.pin('2').connect(r2.pin('1'));
  r2.pin('2').connect(tb.gnd);
  v1.pin('-').connect(tb.gnd);
  tb.name('out', r2.pin('1'));

  tb.expect.op('out').toBeCloseTo(2.5, '1m');

  tb.expect
    .dc({ source: 'V1', from: 0, to: 10, points: 21 })
    .probe('out')
    .toBeMonotonic('increasing')
    .at('2.5').toBeCloseTo('1.25', '1m')
    .slopeAt(5).toBeWithin(0.499, 0.501)
    .toCross('3').between(5.9, 6.1);
});
