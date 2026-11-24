import { bench, ArduinoUno, VoltageSource, LED } from 'circuitsvibe';

/**
 * Seeded broken: an LED straight on D13 with no series resistor. Only the
 * pin's output resistance (≈ 40 Ω, ATmega328P VOH row) limits the current:
 * about 70 mA while D13 is high — above the 40 mA absolute maximum per pin.
 *
 * Expected: R410 mcu-pin-current-exceeded, exit 1.
 */
export default bench('mcu-led-no-resistor', (tb) => {
  const v5 = tb.add('V5', new VoltageSource(5));
  const u1 = tb.add('U1', new ArduinoUno({ firmware: '../mcu/blink.fw.ts' }));
  const d1 = tb.add('D1', new LED());
  v5.pin('-').connect(tb.gnd);
  u1.pin('5V').connect(v5.pin('+'));
  u1.pin('GND').connect(tb.gnd);
  u1.pin('D13').connect(d1.pin('anode'));
  d1.pin('cathode').connect(tb.gnd);
  tb.expect.logic('U1.D13', { tstop: '1.2', maxStep: '10m' }).toToggle({ count: 2, within: ['0.1', '1.1'] });
});
