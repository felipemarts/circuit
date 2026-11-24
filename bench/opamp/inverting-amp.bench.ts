import { bench, VoltageSource, Resistor, Part } from 'circuitsvibe';

/**
 * Inverting amplifier with one channel of a TL072 on ±15 V: gain −R2/R1 = −10.
 * Vout = −10·Vin + Vos·(1 + R2/R1) = −2 V + 3 mV·11 (TL072 Vos 3 mV typ).
 * The DC sweep shows the linear range and the clipping at the data output
 * swing (±13.5 V typ at 10 kΩ).
 */
export default bench('inverting-amp', (tb) => {
  const u1 = tb.add('U1', Part('TL072'));
  const vin = tb.add('VIN', new VoltageSource(0.2));
  const vcc = tb.add('VCC', new VoltageSource(15));
  const vee = tb.add('VEE', new VoltageSource(-15));
  const r1 = tb.add('R1', new Resistor('10k'));
  const r2 = tb.add('R2', new Resistor('100k'));
  const rl = tb.add('RL', new Resistor('10k'));

  vcc.pin('+').connect(u1.pin('v+'));
  vee.pin('+').connect(u1.pin('v-'));
  vcc.pin('-').connect(tb.gnd);
  vee.pin('-').connect(tb.gnd);

  vin.pin('+').connect(r1.pin('1'));
  vin.pin('-').connect(tb.gnd);
  r1.pin('2').connect(u1.pin('inn'));
  r2.pin('1').connect(u1.pin('inn'));
  r2.pin('2').connect(u1.pin('out'));
  u1.pin('inp').connect(tb.gnd);
  rl.pin('1').connect(u1.pin('out'));
  rl.pin('2').connect(tb.gnd);
  tb.name('out', u1.pin('out'));
  tb.name('vminus', u1.pin('inn'));

  tb.expect.op('out').toBeCloseTo(-2 + 0.033, 0.005);
  tb.expect.op('vminus').toBeCloseTo(0.003, 0.001);       // virtual ground (offset by Vos)
  tb.expect
    .dc({ source: 'VIN', from: -2, to: 2, points: 81 })
    .probe('out')
    .slopeAt(0).toBeWithin(-10.01, -9.99)
    .at(2).toBeWithin(-13.6, -13.3)                         // clipped near V− + 1.5 V
    .at(-2).toBeWithin(13.3, 13.6)
    .toBeMonotonic('decreasing');
});
