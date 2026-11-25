import { bench, ArduinoUno, VoltageSource, Resistor, LED } from 'circuitsvibe';

/**
 * Arduino Uno blink: D13 → 330 Ω → LED. The firmware (blink.fw.ts) toggles
 * D13 every 500 ms of simulation time. While D13 is high the LED current is
 * (VOH − Vf) / (R + Rout): Rout ≈ 40 Ω from the ATmega328P VOH row
 * (4.2 V at 20 mA, VCC 5 V), so about (5 − 1.95) / 370 ≈ 8 mA.
 */
export default bench('uno-blink', (tb) => {
  const v5 = tb.add('V5', new VoltageSource(5));
  const u1 = tb.add('U1', new ArduinoUno({ firmware: './blink.fw.ts' }));
  const r1 = tb.add('R1', new Resistor('330'));
  const d1 = tb.add('D1', new LED());

  v5.pin('-').connect(tb.gnd);
  u1.pin('5V').connect(v5.pin('+'));
  u1.pin('GND').connect(tb.gnd);
  u1.pin('D13').connect(r1.pin('1'));
  r1.pin('2').connect(d1.pin('anode'));
  d1.pin('cathode').connect(tb.gnd);

  const run = tb.expect.tran({ tstop: '2.2', maxStep: '10m' });
  run.logic('U1.D13').toHaveFrequency(1, 1e-9, { from: '0.1' }); // exactly 1 Hz
  run.logic('U1.D13').toToggle({ count: 4, within: [0.1, 2.1] }); // 0.5, 1, 1.5, 2 s
  run.logic('U1.D13').toBe(1).at('0.25');
  run.logic('U1.D13').toBe(0).at('0.75');
  run.probe('D1.i').toNeverExceed('10m');
  tb.expect.serial('U1').toContain('blink ready', { by: '1m' });
});
