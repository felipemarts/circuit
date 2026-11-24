import { bench, VoltageSource, Resistor, Inductor, Capacitor } from 'circuitsvibe';

/**
 * Series RLC band-pass, output across R: resonance f0 = 1/(2π·√(LC)) ≈ 5.03 kHz,
 * 0 dB at f0, -3 dB bandwidth R/(2π·L) ≈ 1.59 kHz (Q ≈ 3.2).
 */
export default bench('rlc-ac-bandpass', (tb) => {
  const v1 = tb.add('V1', new VoltageSource({ dc: 0, ac: 1 }));
  const l1 = tb.add('L1', new Inductor('10m'));
  const c1 = tb.add('C1', new Capacitor('100n'));
  const r1 = tb.add('R1', new Resistor('100'));

  v1.pin('+').connect(l1.pin('1'));
  l1.pin('2').connect(c1.pin('1'));
  c1.pin('2').connect(r1.pin('1'));
  r1.pin('2').connect(tb.gnd);
  v1.pin('-').connect(tb.gnd);
  tb.name('out', r1.pin('1'));

  tb.expect
    .ac({ from: '100', to: '1M', pointsPerDecade: 40 })
    .probe('out')
    .gainAt('5.0329k').toBeWithin(-0.01, 0.01)        // unity transfer at resonance
    .phaseAt('5.0329k').toBeWithin(-0.5, 0.5)
    .bandwidth3dB().toBeWithin('1.55k', '1.63k')
    .gainAt('100').toBeBelow(-30);
});
