import { bench, ArduinoUno, VoltageSource, Resistor, LED } from 'circuitsvibe';

/**
 * Seeded broken: the Uno's 5V pin is fed 7 V (e.g. VIN wired to the 5V
 * header) — above the ATmega328P absolute maximum of 6.0 V.
 *
 * Expected: M623 mcu-supply-out-of-range, exit 2.
 */
export default bench('mcu-supply-overvoltage', (tb) => {
  const v7 = tb.add('V7', new VoltageSource(7));
  const u1 = tb.add('U1', new ArduinoUno({ firmware: '../mcu/blink.fw.ts' }));
  const r1 = tb.add('R1', new Resistor('470'));
  const d1 = tb.add('D1', new LED());
  v7.pin('-').connect(tb.gnd);
  u1.pin('5V').connect(v7.pin('+'));
  u1.pin('GND').connect(tb.gnd);
  u1.pin('D13').connect(r1.pin('1'));
  r1.pin('2').connect(d1.pin('anode'));
  d1.pin('cathode').connect(tb.gnd);
  tb.expect.logic('U1.D13', { tstop: '1.2', maxStep: '10m' }).toHaveFrequency(1, 1e-6, { from: '0.1' });
});
