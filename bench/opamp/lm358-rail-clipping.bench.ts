import { bench, VoltageSource, Resistor, Part } from 'circuitsvibe';

/**
 * LM358 (one channel) on a single 5 V supply, non-inverting gain 2 around a
 * 2.5 V bias, driven by a 1 V-amplitude sine: the ideal output would swing
 * 0–5 V, but the LM358 output only reaches V+ − 1.5 V (data: VOH ≥ V+ − 1.5 V
 * at 2 kΩ) on top, while the bottom goes down to ~V− (VOL 5 mV typ). The
 * inputs stay inside the 0…3.5 V common-mode range.
 */
export default bench('lm358-rail-clipping', (tb) => {
  const u1 = tb.add('U1', Part('LM358'));
  const vcc = tb.add('VCC', new VoltageSource(5));
  const vin = tb.add('VIN', new VoltageSource({ sin: { offset: 1.25, amplitude: 1.2, freq: '1k' } }));
  const r1 = tb.add('R1', new Resistor('10k'));
  const r2 = tb.add('R2', new Resistor('10k'));
  const rl = tb.add('RL', new Resistor('2k'));

  vcc.pin('+').connect(u1.pin('v+'));
  vcc.pin('-').connect(tb.gnd);
  u1.pin('v-').connect(tb.gnd);
  vin.pin('+').connect(u1.pin('inp'));
  vin.pin('-').connect(tb.gnd);
  r1.pin('1').connect(u1.pin('inn'));
  r1.pin('2').connect(tb.gnd);
  r2.pin('1').connect(u1.pin('inn'));
  r2.pin('2').connect(u1.pin('out'));
  rl.pin('1').connect(u1.pin('out'));
  rl.pin('2').connect(tb.gnd);
  tb.name('out', u1.pin('out'));

  tb.expect.op('out').toBeCloseTo(2.5 + 0.006, 0.002);      // 2·1.25 V + Vos·2
  tb.expect
    .tran({ tstop: '3m', dt: '2u', ic: 'op' })
    .probe('out')
    .toNeverExceed(3.52)                                     // clipped at ≈ V+ − 1.5 V (2 kΩ load)
    .toStayAbove(0, { from: '0' })
    .toStayBelow(3.52, { from: '1m' });
});
