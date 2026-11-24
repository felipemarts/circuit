import { bench, ArduinoUno, VoltageSource } from 'circuitsvibe';

/**
 * Seeded broken: the firmware (syntax.fw.ts) does not compile. Reported by the
 * lint stage with the firmware location, before anything is simulated.
 *
 * Expected: M608 firmware-load-error, exit 2.
 */
export default bench('mcu-firmware-syntax', (tb) => {
  const v5 = tb.add('V5', new VoltageSource(5));
  const u1 = tb.add('U1', new ArduinoUno({ firmware: './syntax.fw.ts' }));
  v5.pin('-').connect(tb.gnd);
  u1.pin('5V').connect(v5.pin('+'));
  u1.pin('GND').connect(tb.gnd);
  tb.expect.logic('U1.D13', { tstop: '0.1' }).toBe(1);
});
