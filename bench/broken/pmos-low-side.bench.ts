import { bench, VoltageSource, Resistor, PMOS } from 'circuitsvibe';

/**
 * SEEDED BROKEN: a P-channel MOSFET wired as a low-side switch (source on
 * ground). Its gate can never go below its source, so it never conducts
 * forward — and with the drain above the source its body diode (and the
 * swapped channel) carry the load current whatever the gate does: "off"
 * (gate at 0 V) does not switch the load off. Expected: F110 (warning at
 * lint) and the off-state assertion fails (A301), exit 1. Fix: source to
 * +12 V (high-side switch), or an NMOS here.
 */
export default bench('pmos-low-side', (tb) => {
  const vdd = tb.add('VDD', new VoltageSource(12));
  const vg = tb.add('VG', new VoltageSource(0)); // 'off'
  const rl = tb.add('RL', new Resistor('100'));
  const m1 = tb.add('M1', new PMOS({ vto: -2, kp: '50m' }));

  vdd.pin('-').connect(tb.gnd);
  vg.pin('-').connect(tb.gnd);
  vg.pin('+').connect(m1.pin('g'));
  vdd.pin('+').connect(rl.pin('1'));
  rl.pin('2').connect(m1.pin('d'));
  m1.pin('s').connect(tb.gnd);

  tb.expect.op('RL.i').toBeBelow('1m'); // the load should be off
});
