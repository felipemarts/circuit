import { bench, VoltageSource, Resistor, Part } from 'circuitsvibe';

/**
 * 1N4733A (5.1 V, 1 W) shunt regulator: 12 V → 220 Ω → Zener ‖ 1 kΩ load.
 * The catalog card is ESTIMATED (only BV = Vz and IBV = Izt are known), so
 * the regulation slope reflects an ideal exponential knee, not the
 * datasheet's Zzt ≤ 7 Ω.
 */
export default bench('zener-regulator', (tb) => {
  const vin = tb.add('VIN', new VoltageSource(12));
  const rs = tb.add('RS', new Resistor('220'));
  const rl = tb.add('RL', new Resistor('1k'));
  const dz = tb.add('DZ', Part('1N4733A'));

  vin.pin('-').connect(tb.gnd);
  vin.pin('+').connect(rs.pin('1'));
  rs.pin('2').connect(dz.pin('cathode'));
  dz.pin('anode').connect(tb.gnd);
  rl.pin('1').connect(dz.pin('cathode'));
  rl.pin('2').connect(tb.gnd);
  tb.name('out', dz.pin('cathode'));

  tb.expect.op('out').toBeWithin(4.845, 5.355);    // datasheet Vz window
  tb.expect.dc({ source: 'VIN', from: 8, to: 15, points: 29 })
    .probe('out')
    .slopeAt(12).toBeBelow(0.01)                   // line regulation < 1 %
    .at(8).toBeAbove(4.8);
});
