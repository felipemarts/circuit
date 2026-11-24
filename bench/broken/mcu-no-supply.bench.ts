import { bench, ArduinoUno, VoltageSource, Resistor, LED } from 'circuitsvibe';

/**
 * Seeded broken: the Uno's 5V pin is left unconnected — the MCU has no
 * supply, so the firmware could never run (the 5 V source only feeds R2).
 *
 * Expected: F139 mcu-supply-unconnected, exit 2.
 */
export default bench('mcu-no-supply', (tb) => {
  const v5 = tb.add('V5', new VoltageSource(5));
  const u1 = tb.add('U1', new ArduinoUno({ firmware: '../mcu/blink.fw.ts' }));
  const r1 = tb.add('R1', new Resistor('330'));
  const r2 = tb.add('R2', new Resistor('1k'));
  const d1 = tb.add('D1', new LED());
  v5.pin('-').connect(tb.gnd);
  v5.pin('+').connect(r2.pin('1'));
  r2.pin('2').connect(tb.gnd);
  u1.pin('GND').connect(tb.gnd);
  u1.pin('D13').connect(r1.pin('1'));
  r1.pin('2').connect(d1.pin('anode'));
  d1.pin('cathode').connect(tb.gnd);
  tb.expect.logic('U1.D13', { tstop: '1.2', maxStep: '10m' }).toHaveFrequency(1, 1e-6);
});
