import { bench, VoltageSource, Resistor, Capacitor, NPN } from 'circuitsvibe';

/**
 * SEEDED BROKEN: a common-emitter stage whose base is reached only through
 * the input coupling capacitor — no bias network, so the transistor sits in
 * cutoff and there is no small-signal gain. Expected: F107 (warning at lint)
 * and the gain assertion fails (A301), exit 1. Fix: a base divider from VCC.
 */
export default bench('bjt-base-floating', (tb) => {
  const vcc = tb.add('VCC', new VoltageSource(12));
  const vin = tb.add('VIN', new VoltageSource({ dc: 0, ac: 1 }));
  const cin = tb.add('CIN', new Capacitor('10u'));
  const rc = tb.add('RC', new Resistor('4.7k'));
  const q1 = tb.add('Q1', new NPN({ bf: 200, vaf: 100 }));

  vcc.pin('-').connect(tb.gnd);
  vin.pin('-').connect(tb.gnd);
  vin.pin('+').connect(cin.pin('1'));
  cin.pin('2').connect(q1.pin('b'));
  vcc.pin('+').connect(rc.pin('1'));
  rc.pin('2').connect(q1.pin('c'));
  q1.pin('e').connect(tb.gnd);
  tb.name('out', q1.pin('c'));

  tb.expect.ac({ from: '100', to: '10k', pointsPerDecade: 10 }).probe('out').gainAt('1k').toBeAbove(20);
});
