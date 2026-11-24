import { bench, Mcu, VoltageSource, Resistor, LED } from 'circuitsvibe';

/**
 * Seeded broken: an ATtiny85 lights four LEDs on PB0–PB3 through 100 Ω —
 * about 17 mA per pin (under the 40 mA per-pin maximum, above the 10 mA test
 * condition), but the ATtiny85 limits the sum of all source currents to 60 mA.
 *
 * Expected: R413 mcu-supply-current-exceeded, exit 1.
 */
export default bench('mcu-total-current', (tb) => {
  const v5 = tb.add('V5', new VoltageSource(5));
  const u1 = tb.add('U1', new Mcu({ profile: 'attiny85', firmware: './tiny-leds.fw.ts' }));
  v5.pin('-').connect(tb.gnd);
  u1.pin('VCC').connect(v5.pin('+'));
  u1.pin('GND').connect(tb.gnd);
  for (const n of [0, 1, 2, 3]) {
    const r = tb.add(`R${n}`, new Resistor('100'));
    const d = tb.add(`D${n}`, new LED());
    u1.pin(`PB${n}`).connect(r.pin('1'));
    r.pin('2').connect(d.pin('anode'));
    d.pin('cathode').connect(tb.gnd);
  }
  tb.expect.logic('U1.PB0', { tstop: '0.05', maxStep: '1m' }).toBe(1);
});
