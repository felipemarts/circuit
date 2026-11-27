import { bench, VoltageSource, Resistor, LED } from 'circuitsvibe';

/**
 * LED driver on a 30 × 20 mm board: a 2-pin power header, the series
 * resistor and a 5 mm LED. The pcb stage checks the placement and reports
 * the ratsnest the router will turn into copper.
 */
export default bench('led-driver-board', (tb) => {
  const v1 = tb.add('V1', new VoltageSource(5));
  const r1 = tb.add('R1', new Resistor('330'));
  const d1 = tb.add('D1', new LED());

  v1.pin('+').connect(r1.pin('1'));
  r1.pin('2').connect(d1.pin('anode'));
  d1.pin('cathode').connect(tb.gnd);
  v1.pin('-').connect(tb.gnd);
  tb.name('vin', v1.pin('+'));
  tb.name('led', d1.pin('anode'));

  tb.expect.op('D1.i').toBeWithin('5m', '15m');

  tb.board({ width: 30, height: 20, holes: [{ x: 3, y: 3, d: 3.2 }, { x: 27, y: 17, d: 3.2 }] });
  tb.place('V1', { x: 5, y: 12, rot: 90 });       // power header on the left edge
  tb.place('R1', { x: 15, y: 10 });               // 0.4" axial resistor
  tb.place('D1', { x: 25, y: 8, rot: 90 });       // 5 mm LED
});
