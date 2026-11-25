import { bench, VoltageSource, Resistor, Capacitor } from 'circuitsvibe';

/**
 * First-order RC low-pass, R = 1 kΩ, C = 1 µF: fc = 1/(2π·RC) = 159.15 Hz.
 * The source carries a 1 V DC bias (the operating point) and the AC stimulus
 * (`ac: 1`) the Bode measurements are referenced to: −3 dB and −45° at fc,
 * −20 dB per decade above it.
 */
export default bench('rc-lowpass-bode', (tb) => {
  const vin = tb.add('VIN', new VoltageSource({ dc: 1, ac: 1 }));
  const r1 = tb.add('R1', new Resistor('1k'));
  const c1 = tb.add('C1', new Capacitor('1u'));

  vin.pin('+').connect(r1.pin('1'));
  r1.pin('2').connect(c1.pin('1'));
  c1.pin('2').connect(tb.gnd);
  vin.pin('-').connect(tb.gnd);
  tb.name('out', c1.pin('1'));

  tb.expect.op('out').toBeCloseTo(1, 1e-6);                 // the capacitor is open at DC

  const ac = tb.expect.ac({ from: '1', to: '100k', pointsPerDecade: 20 }).probe('out');
  ac.bandwidth3dB().toBeWithin('155', '163');               // fc = 159.15 Hz
  ac.gainAt('159.15').toBeWithin(-3.1, -2.9);               // −3.01 dB at fc
  ac.phaseAt('159.15').toBeWithin(-46, -44);                // −45° at fc
  ac.gainAt('1.5915k').toBeWithin(-20.5, -19.5);            // one decade up: −20 dB
  ac.gainAt('1').toBeWithin(-0.01, 0.01);                   // flat pass-band
});
