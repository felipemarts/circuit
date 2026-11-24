import { bench, VoltageSource, Capacitor, Part } from 'circuitsvibe';

/**
 * SEEDED BROKEN: AC-coupled follower — the input capacitor blocks DC and there
 * is no bias resistor, so the non-inverting input floats.
 * Expected: F121 opamp-input-no-dc-path (instead of the generic F101), with a
 * bias resistor from the input to gnd as the fix. Exit 2.
 */
export default bench('opamp-ac-coupled-no-bias', (tb) => {
  const u1 = tb.add('U1', Part('TL072'));
  const vin = tb.add('VIN', new VoltageSource({ dc: 0, ac: 1 }));
  const vcc = tb.add('VCC', new VoltageSource(15));
  const vee = tb.add('VEE', new VoltageSource(-15));
  const c1 = tb.add('C1', new Capacitor('1u'));
  vcc.pin('+').connect(u1.pin('v+'));
  vee.pin('+').connect(u1.pin('v-'));
  vcc.pin('-').connect(tb.gnd);
  vee.pin('-').connect(tb.gnd);
  vin.pin('+').connect(c1.pin('1'));
  vin.pin('-').connect(tb.gnd);
  c1.pin('2').connect(u1.pin('inp'));
  u1.pin('inn').connect(u1.pin('out'));
  tb.name('out', u1.pin('out'));

  tb.expect.ac({ from: '10', to: '100k' }).probe('out').gainAt('1k').toBeWithin(-0.1, 0.1);
});
