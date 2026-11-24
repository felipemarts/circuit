import { bench, VoltageSource, Resistor, Capacitor, NMOS } from 'circuitsvibe';

/**
 * SEEDED BROKEN: the MOSFET gate is driven only through a coupling
 * capacitor — no DC path sets its voltage (singular matrix; a real gate
 * floats half-on). Expected: F108 at lint, exit 2. Fix: a gate-source
 * pull-down resistor.
 */
export default bench('mosfet-gate-floating', (tb) => {
  const vdd = tb.add('VDD', new VoltageSource(12));
  const vin = tb.add('VIN', new VoltageSource({ pwm: { low: 0, high: 5, freq: '1k', duty: 0.5 } }));
  const cg = tb.add('CG', new Capacitor('100n'));
  const rl = tb.add('RL', new Resistor('100'));
  const m1 = tb.add('M1', new NMOS({ vto: 2, kp: '50m' }));

  vdd.pin('-').connect(tb.gnd);
  vin.pin('-').connect(tb.gnd);
  vin.pin('+').connect(cg.pin('1'));
  cg.pin('2').connect(m1.pin('g'));
  vdd.pin('+').connect(rl.pin('1'));
  rl.pin('2').connect(m1.pin('d'));
  m1.pin('s').connect(tb.gnd);

  tb.expect.op('M1.id').toBeBelow('1m');
});
