import { bench, VoltageSource, Part } from 'circuitsvibe';

/**
 * SEEDED BROKEN: an LM358 follower on 5 V asked to buffer 4.2 V — above its
 * input common-mode range (0 … V+ − 1.5 V). The macro model would happily
 * follow; a real LM358 does not, so the result is not trustworthy.
 * Expected: R423 opamp-input-common-mode in stages.op.ratings, exit 1.
 */
export default bench('opamp-common-mode', (tb) => {
  const u1 = tb.add('U1', Part('LM358'));
  const vin = tb.add('VIN', new VoltageSource(4.2));
  const vcc = tb.add('VCC', new VoltageSource(5));
  vcc.pin('+').connect(u1.pin('v+'));
  vcc.pin('-').connect(tb.gnd);
  u1.pin('v-').connect(tb.gnd);
  vin.pin('+').connect(u1.pin('inp'));
  vin.pin('-').connect(tb.gnd);
  u1.pin('inn').connect(u1.pin('out'));
  tb.name('out', u1.pin('out'));

  tb.expect.op('out').toBeWithin(3.4, 3.6);
});
