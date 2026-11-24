import { bench, ArduinoUno, VoltageSource } from 'circuitsvibe';

/**
 * Seeded broken spec: the bench expects a line that is exactly "ready", but
 * blink.fw.ts prints "blink ready". The serial assertion fails with the output
 * it saw (the second one passes).
 *
 * Expected: A301 assertion-failed, exit 1.
 */
export default bench('mcu-serial-missing', (tb) => {
  const v5 = tb.add('V5', new VoltageSource(5));
  const u1 = tb.add('U1', new ArduinoUno({ firmware: '../mcu/blink.fw.ts' }));
  v5.pin('-').connect(tb.gnd);
  u1.pin('5V').connect(v5.pin('+'));
  u1.pin('GND').connect(tb.gnd);
  tb.expect.serial('U1', { tstop: '0.1' }).toMatch(/^ready\r$/m).toContain('blink ready', { by: '10m' });
});
