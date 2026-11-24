import { bench, ArduinoUno, VoltageSource, Resistor, LED } from 'circuitsvibe';

/**
 * Seeded broken: the 5 V supply sags to 2 V at t = 0.7 s, below the Uno's
 * brown-out level (2.7 V). The MCU resets: firmware stopped, pins high-Z, and
 * it stays in reset for the rest of the run.
 *
 * Expected: M622 mcu-reset-unpowered, exit 2.
 */
export default bench('mcu-brownout', (tb) => {
  const vs = tb.add('VS', new VoltageSource({ pwl: { points: [[0, 5], ['0.7', 5], ['0.71', 2]] } }));
  const u1 = tb.add('U1', new ArduinoUno({ firmware: '../mcu/blink.fw.ts' }));
  const r1 = tb.add('R1', new Resistor('330'));
  const d1 = tb.add('D1', new LED());
  vs.pin('-').connect(tb.gnd);
  u1.pin('5V').connect(vs.pin('+'));
  u1.pin('GND').connect(tb.gnd);
  u1.pin('D13').connect(r1.pin('1'));
  r1.pin('2').connect(d1.pin('anode'));
  d1.pin('cathode').connect(tb.gnd);
  tb.expect.logic('U1.D13', { tstop: '2.2', maxStep: '10m' }).toHaveFrequency(1, 1e-6, { from: '0.1' });
});
