import { bench, VoltageSource, Part } from 'circuitsvibe';

/**
 * SEEDED BROKEN: an LM358 wired as a follower with its supply pins left open
 * — a macro model has no output window without its rails.
 * Expected: F120 opamp-supply-unconnected from lint, naming U1.v+ and U1.v-, exit 2.
 */
export default bench('opamp-no-supply', (tb) => {
  const u1 = tb.add('U1', Part('LM358'));
  const vin = tb.add('VIN', new VoltageSource(1));
  vin.pin('+').connect(u1.pin('inp'));
  vin.pin('-').connect(tb.gnd);
  u1.pin('inn').connect(u1.pin('out'));
  tb.name('out', u1.pin('out'));

  tb.expect.op('out').toBeCloseTo(1, 0.01);
});
