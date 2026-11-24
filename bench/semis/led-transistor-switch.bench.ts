import { bench, VoltageSource, Resistor, Part } from 'circuitsvibe';

/**
 * A 3.3 V logic output switches a red LED from 5 V through a 2N3904
 * saturated switch. Real parts: the datasheet ratings of Q1 and D1 are
 * checked automatically (stages.op.ratings).
 */
export default bench('led-transistor-switch', (tb) => {
  const vcc = tb.add('VCC', new VoltageSource(5));
  const gpio = tb.add('GPIO', new VoltageSource(3.3));
  const rb = tb.add('RB', new Resistor('4.7k'));
  const rled = tb.add('RLED', new Resistor('150'));
  const q1 = tb.add('Q1', Part('2N3904'));
  const d1 = tb.add('D1', Part('LED-RED-5MM'));

  vcc.pin('-').connect(tb.gnd);
  gpio.pin('-').connect(tb.gnd);
  gpio.pin('+').connect(rb.pin('1'));
  rb.pin('2').connect(q1.pin('b'));
  vcc.pin('+').connect(rled.pin('1'));
  rled.pin('2').connect(d1.pin('anode'));
  d1.pin('cathode').connect(q1.pin('c'));
  q1.pin('e').connect(tb.gnd);

  tb.param('RLED', { min: '47', max: '1k', scale: 'log' });
  tb.expect.op('D1.i').toBeWithin('15m', '25m');   // bright but under IF max 30 mA
  tb.expect.op('Q1.vce').toBeBelow(0.3);            // saturated
  tb.expect.op('Q1.ib').toBeAbove('300u');          // forced beta ≈ 20+
});
