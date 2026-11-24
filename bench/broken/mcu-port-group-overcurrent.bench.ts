import { bench, ArduinoUno, VoltageSource, Resistor, LED } from 'circuitsvibe';

/**
 * Seeded broken: six LEDs on D8–D13 through 120 Ω, all on (leds6.fw.ts):
 * about 18 mA each — every pin is under its 40 mA absolute maximum, but the
 * port group B0–B5 + D5–D7 (Uno D5–D13) may source 100 mA in total.
 *
 * Expected: R412 mcu-port-current-exceeded, exit 1.
 */
export default bench('mcu-port-group-overcurrent', (tb) => {
  const v5 = tb.add('V5', new VoltageSource(5));
  const u1 = tb.add('U1', new ArduinoUno({ firmware: './leds6.fw.ts' }));
  v5.pin('-').connect(tb.gnd);
  u1.pin('5V').connect(v5.pin('+'));
  u1.pin('GND').connect(tb.gnd);
  for (const n of [8, 9, 10, 11, 12, 13]) {
    const r = tb.add(`R${n}`, new Resistor('120'));
    const d = tb.add(`D${n}`, new LED());
    u1.pin(`D${n}`).connect(r.pin('1'));
    r.pin('2').connect(d.pin('anode'));
    d.pin('cathode').connect(tb.gnd);
  }
  tb.expect.logic('U1.D13', { tstop: '0.05', maxStep: '1m' }).toBe(1);
});
