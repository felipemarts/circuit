import { bench, VoltageSource, Resistor, Inductor, Capacitor } from 'circuitsvibe';

/**
 * SEEDED BROKEN: a parasitic LC tank (1 nH, 1 nF: rings at ~5 MHz, 200 ns
 * period, barely damped) under a bench that forbids steps below 1 us. The
 * truncation-error control cannot follow the ringing with such a step floor.
 * Expected: S203 timestep-too-small naming L1 or C1 and the time, exit 2.
 */
export default bench('lc-ringing-min-step', (tb) => {
  const v1 = tb.add('V1', new VoltageSource(5));
  const r1 = tb.add('R1', new Resistor('10m'));
  const l1 = tb.add('L1', new Inductor('1n'));
  const c1 = tb.add('C1', new Capacitor('1n'));

  v1.pin('+').connect(r1.pin('1'));
  r1.pin('2').connect(l1.pin('1'));
  l1.pin('2').connect(c1.pin('1'));
  c1.pin('2').connect(tb.gnd);
  v1.pin('-').connect(tb.gnd);

  tb.expect.tran({ tstop: '1m', dt: '10u', minStep: '1u' }).probe('C1.v').toEndCloseTo(5, 0.1);
});
