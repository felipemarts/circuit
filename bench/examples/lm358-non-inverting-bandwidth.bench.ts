import { bench, VoltageSource, Resistor, Part } from 'circuitsvibe';

/**
 * LM358 non-inverting amplifier on a single 12 V supply, gain 1 + R2/R1 = 10
 * (20 dB). The input sits at 0.5 V DC so the output rests at 5 V — well
 * inside the LM358 swing — and a 1 V AC stimulus rides on it for the Bode
 * sweep. The datasheet GBW (0.7 MHz typ) gives a closed-loop −3 dB bandwidth
 * near 70 kHz, far below the generic 1 MHz macro-model of
 * bench/opamp/non-inverting-ac-bandwidth.bench.ts.
 */
export default bench('lm358-non-inverting-bandwidth', (tb) => {
  const u1 = tb.add('U1', Part('LM358'));                 // one channel of the dual
  const vin = tb.add('VIN', new VoltageSource({ dc: 0.5, ac: 1 }));
  const vcc = tb.add('VCC', new VoltageSource(12));
  const r1 = tb.add('R1', new Resistor('1k'));
  const r2 = tb.add('R2', new Resistor('9k'));

  vcc.pin('+').connect(u1.pin('v+'));
  vcc.pin('-').connect(tb.gnd);
  u1.pin('v-').connect(tb.gnd);                            // single supply: v- on gnd

  vin.pin('+').connect(u1.pin('inp'));
  vin.pin('-').connect(tb.gnd);
  r1.pin('1').connect(u1.pin('inn'));
  r1.pin('2').connect(tb.gnd);
  r2.pin('1').connect(u1.pin('inn'));
  r2.pin('2').connect(u1.pin('out'));
  tb.name('out', u1.pin('out'));

  tb.expect.op('out').toBeWithin(4.9, 5.1);                // 10 × 0.5 V (+ Vos·10)
  tb.expect
    .ac({ from: '10', to: '10M', pointsPerDecade: 20 })
    .probe('out')
    .gainAt('100').toBeWithin(19.9, 20.1)
    .bandwidth3dB().toBeWithin('60k', '80k')              // ≈ GBW / 10
    .phaseAt('70k').toBeWithin(-50, -40);                 // single pole: −45° near the corner
});
