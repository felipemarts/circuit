import { bench, ArduinoUno, VoltageSource, Resistor, LED } from 'circuitsvibe';

/**
 * Seeded warning: a 68 Ω LED resistor on D13 draws about 26 mA — under the
 * 40 mA absolute maximum (no R410), but above the 20 mA at which the
 * ATmega328P datasheet guarantees VOH/VOL. The bench passes; the RunRecord
 * carries the warning.
 *
 * Expected: R411 mcu-pin-current-above-recommended (warning), exit 0.
 */
export default bench('mcu-pin-over-recommended', (tb) => {
  const v5 = tb.add('V5', new VoltageSource(5));
  const u1 = tb.add('U1', new ArduinoUno({ firmware: '../mcu/blink.fw.ts' }));
  const r1 = tb.add('R1', new Resistor('68'));
  const d1 = tb.add('D1', new LED());
  v5.pin('-').connect(tb.gnd);
  u1.pin('5V').connect(v5.pin('+'));
  u1.pin('GND').connect(tb.gnd);
  u1.pin('D13').connect(r1.pin('1'));
  r1.pin('2').connect(d1.pin('anode'));
  d1.pin('cathode').connect(tb.gnd);
  tb.expect.logic('U1.D13', { tstop: '1.2', maxStep: '10m' }).toToggle({ count: 2, within: ['0.1', '1.1'] });
});
