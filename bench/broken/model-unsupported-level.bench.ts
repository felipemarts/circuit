import { bench, VoltageSource, Resistor, NMOS } from 'circuitsvibe';

/**
 * SEEDED BROKEN: a vendor LEVEL=3 MOSFET card. Only Level 1 is implemented,
 * so nothing is simulated. Expected: T006 at lint, exit 3 (tooling: use a
 * supported card or a catalog Part()).
 */
export default bench('model-unsupported-level', (tb) => {
  const vdd = tb.add('VDD', new VoltageSource(5));
  const vg = tb.add('VG', new VoltageSource(3));
  const rl = tb.add('RL', new Resistor('1k'));
  const m1 = tb.add('M1', NMOS.fromModel(`.model CMOSN NMOS (LEVEL=3 VTO=0.7 KP=110u GAMMA=0.4
+ PHI=0.7 THETA=0.06 ETA=0.1 KAPPA=0.2 TOX=9n)`));

  vdd.pin('-').connect(tb.gnd);
  vg.pin('-').connect(tb.gnd);
  vg.pin('+').connect(m1.pin('g'));
  vdd.pin('+').connect(rl.pin('1'));
  rl.pin('2').connect(m1.pin('d'));
  m1.pin('s').connect(tb.gnd);

  tb.expect.op('M1.id').toBeAbove('1m');
});
