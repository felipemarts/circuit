import { bench, VoltageSource, Resistor, NPN } from 'circuitsvibe';

/**
 * SEEDED BROKEN: the base is wired straight to a 5 V logic source — no base
 * resistor, so the base-emitter junction is clamped at 5 V. Expected: F109
 * at lint (before the solver would diverge), exit 2. Fix: a base resistor,
 * Rb = (5 − 0.7 V)/Ib.
 */
export default bench('bjt-base-clamped', (tb) => {
  const vcc = tb.add('VCC', new VoltageSource(12));
  const vin = tb.add('VIN', new VoltageSource(5));
  const rl = tb.add('RL', new Resistor('1k'));
  const q1 = tb.add('Q1', new NPN({ bf: 100 }));

  vcc.pin('-').connect(tb.gnd);
  vin.pin('-').connect(tb.gnd);
  vin.pin('+').connect(q1.pin('b'));
  vcc.pin('+').connect(rl.pin('1'));
  rl.pin('2').connect(q1.pin('c'));
  q1.pin('e').connect(tb.gnd);

  tb.expect.op('Q1.vce').toBeBelow(0.3);
});
