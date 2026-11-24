import { bench, Part, VoltageSource, Resistor } from 'circuitsvibe';

/**
 * SEEDED BROKEN: a 74HC04 powered through a 4.7 kΩ "current limiter" in its VCC
 * lead. When the output goes high into a 100 Ω load, the IC's own supply
 * collapses below 1 V (half the 2 V minimum): brown-out.
 * Expected: D510 ic-unpowered (error, tran, with time). Exit 2.
 */
export default bench('ic-brownout', (tb) => {
  const v1 = tb.add('V1', new VoltageSource(5));
  const rs = tb.add('RS', new Resistor('4.7k'));
  const vin = tb.add('VIN', new VoltageSource({ pulse: { v1: 5, v2: 0, td: '1u', tr: '10n', tf: '10n', pw: '10u' } }));
  const u1 = tb.add('U1', Part('74HC04'));
  const rl = tb.add('RL', new Resistor('100'));
  v1.pin('-').connect(tb.gnd);
  vin.pin('-').connect(tb.gnd);
  v1.pin('+').connect(rs.pin('1'));
  rs.pin('2').connect(u1.pin('VCC'));
  u1.pin('GND').connect(tb.gnd);
  vin.pin('+').connect(u1.pin('1A'));
  u1.pin('1Y').connect(rl.pin('1'));
  rl.pin('2').connect(tb.gnd);
  for (const p of ['2A', '3A', '4A', '5A', '6A']) u1.pin(p).connect(tb.gnd);
  tb.name('vcc_ic', u1.pin('VCC'));
  tb.expect.tran({ tstop: '5u' }).probe('vcc_ic').toStayAbove(4, { from: '2u' });
});
