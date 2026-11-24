import { bench, ArduinoUno, VoltageSource, Resistor, Capacitor } from 'circuitsvibe';

/**
 * A potentiometer (6.8k over 3.3k) puts 5 · 3.3/10.1 = 1.634 V on A0. The
 * firmware reads it (10-bit, Vref = VCC: floor(1.634 · 1024 / 5) = 334), writes
 * 334 >> 2 = 83 to the PWM pin D9 (490 Hz phase-correct, duty 83/255) and
 * prints the code every 100 ms. A 47 kΩ / 1 µF RC averages the PWM:
 * 5 V · 83/255 ≈ 1.627 V (the 40–45 Ω output resistance is negligible against 47 kΩ).
 */
export default bench('uno-adc-pwm', (tb) => {
  const v5 = tb.add('V5', new VoltageSource(5));
  const u1 = tb.add('U1', new ArduinoUno({ firmware: './adc-pwm.fw.ts' }));
  const top = tb.add('RPOT1', new Resistor('6.8k')); // potentiometer: track above / below the wiper
  const bot = tb.add('RPOT2', new Resistor('3.3k'));
  const rf = tb.add('RF', new Resistor('47k'));
  const cf = tb.add('CF', new Capacitor('1u'));

  v5.pin('-').connect(tb.gnd);
  u1.pin('5V').connect(v5.pin('+'));
  u1.pin('GND').connect(tb.gnd);
  v5.pin('+').connect(top.pin('1'));
  top.pin('2').connect(bot.pin('1'));
  bot.pin('2').connect(tb.gnd);
  u1.pin('A0').connect(top.pin('2'));
  u1.pin('D9').connect(rf.pin('1'));
  rf.pin('2').connect(cf.pin('1'));
  cf.pin('2').connect(tb.gnd);
  tb.name('wiper', top.pin('2'));
  tb.name('avg', cf.pin('1'));

  const run = tb.expect.tran({ tstop: '0.5', maxStep: '1m' });
  run.serial('U1').toContain('334\r\n', { by: '1m' }).toHaveLines(6); // t = 0, 0.1 … 0.5 s
  run.logic('U1.D9').toHaveFrequency(490.196, 0.001, { from: '0.01' });
  run.logic('U1.D9').toHaveDutyCycle(83 / 255, 0.002, { from: '0.01' });
  run.probe('avg').toSettleWithin({ target: (5 * 83) / 255, tol: 0.03, by: '0.35' });
});
