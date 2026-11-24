import { bench, VoltageSource, Resistor, Capacitor } from 'circuitsvibe';

/**
 * RC low-pass driven by a 0→5 V PULSE train (tau = R·C = 1 ms, period 20 ms).
 * The adaptive stepper lands on every pulse corner, restarts with Backward
 * Euler there, and takes large steps through the long flat stretches.
 */
export default bench('rc-pulse', (tb) => {
  const v1 = tb.add('V1', new VoltageSource({ pulse: { v1: 0, v2: 5, td: '1m', tr: '1u', tf: '1u', pw: '8m', per: '20m' } }));
  const r1 = tb.add('R1', new Resistor('1k'));
  const c1 = tb.add('C1', new Capacitor('1u'));

  v1.pin('+').connect(r1.pin('1'));
  r1.pin('2').connect(c1.pin('1'));
  c1.pin('2').connect(tb.gnd);
  v1.pin('-').connect(tb.gnd);
  tb.name('out', c1.pin('1'));

  tb.expect
    .tran({ tstop: '40m', dt: '1u', maxStep: '1m' })
    .probe('out')
    .toNeverExceed('5.01')                             // a first-order filter never overshoots
    .toStayAbove('-0.01')
    .probe('R1.i')
    .toNeverExceed('5.1m');                            // peak current V/R right after each edge
});
