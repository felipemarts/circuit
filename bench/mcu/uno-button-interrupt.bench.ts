import { bench, ArduinoUno, Part, VoltageSource, Resistor } from 'circuitsvibe';

/**
 * A push button on D2 (INPUT_PULLUP, ~35 kΩ internal pull-up) modelled as a
 * 2N7000 pulling the pin to ground while its gate pulse is high: five presses
 * of 20 ms every 60 ms. The firmware counts FALLING-edge interrupts and prints
 * the count. The PULSE edges are clean (1 µs), so there is no contact bounce
 * and the firmware needs no debounce: the count equals the number of presses.
 */
export default bench('uno-button-interrupt', (tb) => {
  const v5 = tb.add('V5', new VoltageSource(5));
  const u1 = tb.add('U1', new ArduinoUno({ firmware: './button-counter.fw.ts' }));
  const press = tb.add('VBTN', new VoltageSource({ pulse: { v1: 0, v2: 5, td: '20m', tr: '1u', tf: '1u', pw: '20m', per: '60m' } }));
  const rg = tb.add('RG', new Resistor('100'));
  const m1 = tb.add('M1', Part('2N7000'));

  v5.pin('-').connect(tb.gnd);
  press.pin('-').connect(tb.gnd);
  u1.pin('5V').connect(v5.pin('+'));
  u1.pin('GND').connect(tb.gnd);
  press.pin('+').connect(rg.pin('1'));
  rg.pin('2').connect(m1.pin('g'));
  m1.pin('s').connect(tb.gnd);
  m1.pin('d').connect(u1.pin('D2'));
  tb.name('button', u1.pin('D2'));

  const run = tb.expect.tran({ tstop: '0.31', maxStep: '1m' });
  run.logic('U1.D2').toToggle({ edge: 'falling', count: 5 });
  run.serial('U1').toContain('presses=5\r\n').toHaveLines(5).toNotContain('presses=6');
  run.logic('U1.D13').toBe(1).at('0.3'); // odd count
  run.probe('button').toStayAbove(4.9, { from: '0.3' }); // released: pulled up to 5 V
});
