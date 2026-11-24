import { bench, VoltageSource, Resistor, Part } from 'circuitsvibe';

/**
 * LM393 on 5 V comparing a slow ramp against a 2.5 V reference set by a
 * divider; the open-collector output needs the 10 kΩ pull-up. The output is
 * high (pulled to 5 V) while the ramp on inp is above the reference, and low
 * (VOL ≈ 0.13 V at 4 mA; here ~0.5 mA → ~20 mV) below it. The switching point
 * is the reference minus Vos (2 mV typ).
 */
export default bench('comparator-threshold', (tb) => {
  const u1 = tb.add('U1', Part('LM393'));
  const vcc = tb.add('VCC', new VoltageSource(5));
  const vin = tb.add('VIN', new VoltageSource({ pwl: { points: [[0, 2], ['1m', 3]] } }));
  const ra = tb.add('RA', new Resistor('10k'));
  const rb = tb.add('RB', new Resistor('10k'));
  const rp = tb.add('RP', new Resistor('10k'));

  vcc.pin('+').connect(u1.pin('v+'));
  vcc.pin('-').connect(tb.gnd);
  u1.pin('v-').connect(tb.gnd);

  ra.pin('1').connect(vcc.pin('+'));                    // 2.5 V reference on inn
  ra.pin('2').connect(u1.pin('inn'));
  rb.pin('1').connect(u1.pin('inn'));
  rb.pin('2').connect(tb.gnd);
  vin.pin('+').connect(u1.pin('inp'));
  vin.pin('-').connect(tb.gnd);
  rp.pin('1').connect(vcc.pin('+'));                    // pull-up
  rp.pin('2').connect(u1.pin('out'));
  tb.name('out', u1.pin('out'));
  tb.name('ref', u1.pin('inn'));

  tb.expect.op('out').toBeBelow(0.05);                  // at t = 0 / DC: 2 V < 2.5 V → low
  tb.expect.op('ref').toBeCloseTo(2.5, 1e-3);           // the input bias current (−25 nA) shifts it by ~0.1 mV
  tb.expect
    .dc({ source: 'VIN', from: 2.4, to: 2.6, points: 201 })
    .probe('out')
    .toCross(2.5).between(2.497, 2.499)                  // 2.5 V − Vos
    .at(2.45).toBeBelow(0.05)
    .at(2.55).toBeAbove(4.99);
  tb.expect
    .tran({ tstop: '1m', dt: '1u' })
    .probe('out')
    .toEndCloseTo(5, 0.01);
});
