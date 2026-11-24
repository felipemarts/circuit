import { bench, VoltageSource, Resistor, Part } from 'circuitsvibe';

/**
 * SEEDED BROKEN: a 2N7000 (Pd 400 mW) driven by a 3.2 V gate pulse only
 * half-enhances: ~1.2 W in the linear region for 6 of 10 ms. Every
 * assertion passes, but the window-average dissipation exceeds Pd.
 * Expected: R404 (stages.tran.ratings, measure 'average'), exit 1.
 * Fix: drive the gate to 10 V (fully on) or use a logic-level part.
 */
export default bench('mosfet-pd-pulse', (tb) => {
  const vdd = tb.add('VDD', new VoltageSource(10));
  const vg = tb.add('VG', new VoltageSource({ pulse: { v1: 0, v2: 3.2, td: '1m', tr: '1u', tf: '1u', pw: '6m' } }));
  const rl = tb.add('RL', new Resistor('10'));
  const m1 = tb.add('M1', Part('2N7000'));

  vdd.pin('-').connect(tb.gnd);
  vg.pin('-').connect(tb.gnd);
  vdd.pin('+').connect(rl.pin('1'));
  rl.pin('2').connect(m1.pin('d'));
  vg.pin('+').connect(m1.pin('g'));
  m1.pin('s').connect(tb.gnd);

  tb.expect.tran({ tstop: '10m', maxStep: '100u' }).probe('M1.id').toNeverExceed('500m');
});
