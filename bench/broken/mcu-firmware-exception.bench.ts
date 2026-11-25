import { bench, ArduinoUno, VoltageSource } from 'circuitsvibe';

/**
 * Seeded broken: the firmware (crash.fw.ts) throws on its fifth loop() pass
 * (t = 1 s). The RunRecord carries M601 with the firmware line that threw
 * (`bench/broken/crash.fw.ts:13`) and the simulation time; the MCU halts.
 *
 * Expected: M601 firmware-exception, exit 2.
 */
export default bench('mcu-firmware-exception', (tb) => {
  const v5 = tb.add('V5', new VoltageSource(5));
  const u1 = tb.add('U1', new ArduinoUno({ firmware: './crash.fw.ts' }));
  v5.pin('-').connect(tb.gnd);
  u1.pin('5V').connect(v5.pin('+'));
  u1.pin('GND').connect(tb.gnd);
  u1.pin('A0').connect(v5.pin('+'));
  tb.expect.serial('U1', { tstop: '1.5', maxStep: '10m' }).toNotContain('ERROR');
});
