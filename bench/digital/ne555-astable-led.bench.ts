import { bench, Part, VoltageSource, Resistor, Capacitor, LED } from 'circuitsvibe';

/**
 * NE555 astable blinking an LED. R1 = 4.7 kΩ, R2 = 10 kΩ, C = 1 µF:
 *   f = 1/(ln2·(R1 + 2R2)·C) ≈ 1.44/((R1 + 2R2)·C) = 58.4 Hz, duty (R1+R2)/(R1+2R2) = 0.595.
 * The threshold/trigger comparators reference CONT (internal 5k/5k/5k divider),
 * so the capacitor swings between 1/3 and 2/3 VCC.
 */
export default bench('ne555-astable-led', (tb) => {
  const vcc = tb.add('VCC', new VoltageSource(9));
  const u1 = tb.add('U1', Part('NE555'));
  const r1 = tb.add('R1', new Resistor('4.7k'));
  const r2 = tb.add('R2', new Resistor('10k'));
  const c1 = tb.add('C1', new Capacitor('1u'));
  const rl = tb.add('RL', new Resistor('680'));
  const d1 = tb.add('D1', new LED());

  vcc.pin('-').connect(tb.gnd);
  u1.pin('VCC').connect(vcc.pin('+')); // pin 8
  u1.pin('GND').connect(tb.gnd); //       pin 1
  u1.pin('RESET').connect(vcc.pin('+')); // pin 4, inactive
  r1.pin('1').connect(vcc.pin('+'));
  r1.pin('2').connect(u1.pin('DISCH')); // pin 7
  r2.pin('1').connect(u1.pin('DISCH'));
  r2.pin('2').connect(u1.pin('THRES')); // pin 6
  u1.pin('TRIG').connect(u1.pin('THRES')); // pin 2
  c1.pin('1').connect(u1.pin('THRES'));
  c1.pin('2').connect(tb.gnd);
  u1.pin('OUT').connect(rl.pin('1')); // pin 3
  rl.pin('2').connect(d1.pin('anode'));
  d1.pin('cathode').connect(tb.gnd);

  tb.name('out', u1.pin('OUT'));
  tb.name('timing', u1.pin('THRES'));

  const run = tb.expect.tran({ tstop: '100m', maxStep: '100u' });
  run.logic('out').toHaveFrequency(1 / (Math.LN2 * 24.7e3 * 1e-6), 0.02, { from: '20m' });
  run.logic('out').toHaveDutyCycle(14.7 / 24.7, 0.02, { from: '20m' });
  run.probe('timing').toStayAbove(2.9, { from: '20m' }); // 1/3 · 9 V = 3 V
  run.probe('timing').toStayBelow(6.1, { from: '20m' }); // 2/3 · 9 V = 6 V
  run.probe('D1.i').toNeverExceed('15m');
});
