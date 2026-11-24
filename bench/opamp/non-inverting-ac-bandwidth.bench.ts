import { bench, VoltageSource, Resistor, OpAmp } from 'circuitsvibe';

/**
 * Non-inverting stage, gain 1 + R2/R1 = 10 (20 dB), with a generic macro-model
 * op-amp of GBW = 1 MHz: the closed-loop −3 dB bandwidth is GBW/(1 + R2/R1)
 * = 100 kHz (dominant-pole model).
 */
export default bench('non-inverting-ac-bandwidth', (tb) => {
  const u1 = tb.add('U1', new OpAmp({ aol: 1e5, gbw: '1M', sr: '1M' }));
  const vin = tb.add('VIN', new VoltageSource({ dc: 0, ac: 1 }));
  const vcc = tb.add('VCC', new VoltageSource(12));
  const vee = tb.add('VEE', new VoltageSource(-12));
  const r1 = tb.add('R1', new Resistor('1k'));
  const r2 = tb.add('R2', new Resistor('9k'));

  vcc.pin('+').connect(u1.pin('v+'));
  vee.pin('+').connect(u1.pin('v-'));
  vcc.pin('-').connect(tb.gnd);
  vee.pin('-').connect(tb.gnd);

  vin.pin('+').connect(u1.pin('inp'));
  vin.pin('-').connect(tb.gnd);
  r1.pin('1').connect(u1.pin('inn'));
  r1.pin('2').connect(tb.gnd);
  r2.pin('1').connect(u1.pin('inn'));
  r2.pin('2').connect(u1.pin('out'));
  tb.name('out', u1.pin('out'));

  tb.expect
    .ac({ from: '10', to: '10M', pointsPerDecade: 20 })
    .probe('out')
    .gainAt('100').toBeWithin(19.99, 20.01)
    .bandwidth3dB().toBeWithin('98k', '102k')
    .phaseAt('100k').toBeWithin(-46, -44);              // single pole: −45° at the corner
});
