import { bench, ArduinoUno, VoltageSource, Resistor, LED } from 'circuitsvibe';

/**
 * Uno blink as a shield: the board has the Arduino Uno R3 outline, U1 is the
 * Uno's four header strips (footprint UNO-SHIELD, origin = centre of the Uno),
 * and the 5 V supply is the Uno itself (off this board, reached through the
 * 5V / GND header pins). The LED and its resistor sit between the headers.
 */
export default bench('uno-shield-blink', (tb) => {
  const v5 = tb.add('V5', new VoltageSource(5));
  const u1 = tb.add('U1', new ArduinoUno({ firmware: '../mcu/blink.fw.ts' }));
  const r1 = tb.add('R1', new Resistor('330'));
  const d1 = tb.add('D1', new LED());

  v5.pin('-').connect(tb.gnd);
  u1.pin('5V').connect(v5.pin('+'));
  u1.pin('GND').connect(tb.gnd);
  u1.pin('D13').connect(r1.pin('1'));
  r1.pin('2').connect(d1.pin('anode'));
  d1.pin('cathode').connect(tb.gnd);

  const run = tb.expect.tran({ tstop: '1.2', maxStep: '10m' });
  run.logic('U1.D13').toBe(1).at('0.25');
  run.probe('D1.i').toNeverExceed('10m');

  tb.board({ preset: 'uno-shield' });
  tb.place('U1', { x: 34.29, y: 26.67 });   // the Uno headers, lined up with the outline
  tb.place('V5', { offBoard: true });       // the Uno's own 5 V regulator
  tb.place('R1', { x: 30, y: 40 });
  tb.place('D1', { x: 42, y: 40, rot: 90 });
});
