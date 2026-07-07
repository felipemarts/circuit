import { bench, VoltageSource, Resistor, Capacitor } from 'circuit-forge';

/**
 * SEEDED BROKEN: a cap-coupled stage with no DC return path.
 * Expected: F101 floating-net (island n?, grouped), exit 2, op/tran skipped.
 */
export default bench('floating-island', (tb) => {
  const v1 = tb.add('V1', new VoltageSource(5));
  const r1 = tb.add('R1', new Resistor('1k'));
  const c2 = tb.add('C2', new Capacitor('100n'));
  const r3 = tb.add('R3', new Resistor('10k'));

  // Valid half: V1 → R1 → gnd
  v1.pin('+').connect(r1.pin('1'));
  r1.pin('2').connect(tb.gnd);
  v1.pin('-').connect(tb.gnd);

  // Broken half: coupled through C2, no DC path anywhere
  v1.pin('+').connect(c2.pin('1'));
  c2.pin('2').connect(r3.pin('1'));

  tb.expect.op('R1.i').toBeCloseTo('5m', '1m');
});
