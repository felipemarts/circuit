import { bench, Part, VoltageSource, Resistor, Capacitor } from 'circuitsvibe';

/**
 * Classic Schmitt-trigger RC oscillator: a 74HC14 inverter with R from its
 * output back to its input and C to ground. With the datasheet typical VT+/VT−
 * at 5 V (2.77 V / 1.73 V, interpolated between the 4.5 V and 6 V columns):
 *   T = R·C·[ln((VCC − VT−)/(VCC − VT+)) + ln(VT+/VT−)] ≈ 0.848·R·C → 11.8 kHz
 * for 10 kΩ / 10 nF. The slow RC ramp on the input becomes clean output edges.
 */
export default bench('hc14-schmitt-oscillator', (tb) => {
  const vcc = tb.add('VCC', new VoltageSource(5));
  const u1 = tb.add('U1', Part('74HC14'));
  const r1 = tb.add('R1', new Resistor('10k'));
  const c1 = tb.add('C1', new Capacitor('10n'));

  vcc.pin('-').connect(tb.gnd);
  u1.pin(14).connect(vcc.pin('+'));
  u1.pin(7).connect(tb.gnd);
  u1.pin('1Y').connect(r1.pin('1'));
  r1.pin('2').connect(u1.pin('1A'));
  c1.pin('1').connect(u1.pin('1A'));
  c1.pin('2').connect(tb.gnd);
  for (const p of ['2A', '3A', '4A', '5A', '6A']) u1.pin(p).connect(tb.gnd);

  tb.name('osc', u1.pin('1Y'));
  tb.name('ramp', u1.pin('1A'));

  const run = tb.expect.tran({ tstop: '2m', maxStep: '10u' });
  run.logic('osc').toHaveFrequency(1 / (0.848 * 10e3 * 10e-9), 0.03, { from: '0.3m' });
  run.probe('ramp').toStayAbove(1.6, { from: '0.3m' }); // never below VT− (1.73 V)
  run.probe('ramp').toStayBelow(2.9, { from: '0.3m' }); // never above VT+ (2.77 V)
});
