import { bench, VoltageSource, Resistor, Part } from 'circuitsvibe';

/**
 * Logic-level IRLZ44N switching a 12 Ω load from 12 V with a 5 V gate
 * drive. After turn-on the drain sits at Id·Rds(on) (~31 mΩ at 5 V with the
 * estimated card); every datasheet rating stays within limits.
 */
export default bench('mosfet-low-side-switch', (tb) => {
  const vdd = tb.add('VDD', new VoltageSource(12));
  const vg = tb.add('VG', new VoltageSource({ pulse: { v1: 0, v2: 5, td: '100u', tr: '1u', tf: '1u', pw: '1' } }));
  const rg = tb.add('RG', new Resistor('100'));
  const rgs = tb.add('RGS', new Resistor('100k'));
  const rl = tb.add('RL', new Resistor('12'));
  const m1 = tb.add('M1', Part('IRLZ44N'));

  vdd.pin('-').connect(tb.gnd);
  vg.pin('-').connect(tb.gnd);
  vg.pin('+').connect(rg.pin('1'));
  rg.pin('2').connect(m1.pin('g'));
  rgs.pin('1').connect(m1.pin('g'));
  rgs.pin('2').connect(tb.gnd);
  vdd.pin('+').connect(rl.pin('1'));
  rl.pin('2').connect(m1.pin('d'));
  m1.pin('s').connect(tb.gnd);
  tb.name('drain', m1.pin('d'));

  tb.expect.op('drain').toBeAbove(11.9);           // gate low at the operating point: off
  tb.expect.tran({ tstop: '1m', maxStep: '10u' })
    .probe('drain').toStayBelow(0.1, { from: '200u' })
    .probe('M1.id').toEndCloseTo(1, 0.01);         // ≈ 12 V / 12 Ω
});
