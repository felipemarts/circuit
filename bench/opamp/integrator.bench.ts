import { bench, VoltageSource, Resistor, Capacitor, Part } from 'circuitsvibe';

/**
 * Inverting integrator with an LM741 on ±15 V: a 0.5 V step into R = 10 kΩ,
 * C = 100 nF ramps the output at −Vin/(R·C) = −500 V/s, i.e. −1 V after 2 ms.
 * The 1 MΩ across C bleeds the DC offset (it sets a DC gain of −100) so the
 * operating point is defined; over 2 ms (τ = 100 ms) it bends the ramp by ~1 %.
 */
export default bench('integrator', (tb) => {
  const u1 = tb.add('U1', Part('LM741'));
  const vin = tb.add('VIN', new VoltageSource({ pulse: { v1: 0, v2: 0.5, td: '0.5m', tr: '1u', tf: '1u', pw: '10m' } }));
  const vcc = tb.add('VCC', new VoltageSource(15));
  const vee = tb.add('VEE', new VoltageSource(-15));
  const r1 = tb.add('R1', new Resistor('10k'));
  const c1 = tb.add('C1', new Capacitor('100n'));
  const rb = tb.add('RB', new Resistor('1M'));

  vcc.pin('+').connect(u1.pin('v+'));
  vee.pin('+').connect(u1.pin('v-'));
  vcc.pin('-').connect(tb.gnd);
  vee.pin('-').connect(tb.gnd);

  vin.pin('+').connect(r1.pin('1'));
  vin.pin('-').connect(tb.gnd);
  r1.pin('2').connect(u1.pin('inn'));
  c1.pin('1').connect(u1.pin('inn'));
  c1.pin('2').connect(u1.pin('out'));
  rb.pin('1').connect(u1.pin('inn'));
  rb.pin('2').connect(u1.pin('out'));
  u1.pin('inp').connect(tb.gnd);
  tb.name('out', u1.pin('out'));

  // Starts from the operating point. DC offset at the output:
  // Vos·(1 + RB/R1) + Ib(inn)·RB = 2 mV·101 + 70 nA·1 MΩ ≈ 0.27 V (LM741 typ).
  tb.expect
    .tran({ tstop: '2.5m', dt: '10u', ic: 'op' })
    .probe('out')
    .toStayAbove(-1.0, { from: '0' })
    .toEndCloseTo(0.272 - 0.995, 0.02);                  // offset + ramp of −500 V/s over 2 ms (−1 % bleed)
});
