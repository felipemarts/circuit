import { bench, Part, VoltageSource, Resistor, LED } from 'circuitsvibe';

/**
 * A 74HC04 inverter drives an LED through 330 Ω. The input is a 1 kHz logic
 * square wave; the LED current is set by VOH (= VCC − Rout·I, Rout from the
 * 74HC04 VOH rows) and the LED drop — about 9 mA while the output is high.
 */
export default bench('hc04-led-driver', (tb) => {
  const vcc = tb.add('VCC', new VoltageSource(5));
  const vin = tb.add('VIN', new VoltageSource({ pulse: { v1: 0, v2: 5, td: '0.5m', tr: '10n', tf: '10n', pw: '0.5m', per: '1m' } }));
  const u1 = tb.add('U1', Part('74HC04'));
  const r1 = tb.add('R1', new Resistor('330'));
  const d1 = tb.add('D1', new LED());

  vcc.pin('-').connect(tb.gnd);
  vin.pin('-').connect(tb.gnd);
  u1.pin('VCC').connect(vcc.pin('+')); // pin 14
  u1.pin('GND').connect(tb.gnd); //       pin 7
  vin.pin('+').connect(u1.pin('1A'));
  u1.pin('1Y').connect(r1.pin('1'));
  r1.pin('2').connect(d1.pin('anode'));
  d1.pin('cathode').connect(tb.gnd);
  for (const p of ['2A', '3A', '4A', '5A', '6A']) u1.pin(p).connect(tb.gnd); // unused inputs tied low

  tb.name('in', u1.pin('1A'));
  tb.name('drive', u1.pin('1Y'));

  tb.expect.op('D1.i').toBeWithin('7m', '12m'); // input low at t = 0 → LED on
  const run = tb.expect.tran({ tstop: '3m', maxStep: '20u' });
  run.probe('D1.i').toNeverExceed('15m');
  run.logic('drive').toHaveFrequency('1k', 0.001, { from: '0.2m' });
  run.logic('drive').toBe(0).at('0.75m');
  run.logic('drive').toBe(1).at('1.25m');
});
