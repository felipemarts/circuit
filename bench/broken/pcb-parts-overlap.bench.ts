import { bench, VoltageSource, Resistor, LED } from 'circuitsvibe';

/**
 * Two parts placed on top of each other: the resistor's 0.4" axial footprint
 * and the LED's 5 mm body share the same spot on a 25 × 15 mm board.
 * Expected: P802 (courtyard-overlap), exit 2 — move one part (or rotate it).
 */
export default bench('pcb-parts-overlap', (tb) => {
  const v1 = tb.add('V1', new VoltageSource(5));
  const r1 = tb.add('R1', new Resistor('330'));
  const d1 = tb.add('D1', new LED());
  v1.pin('+').connect(r1.pin('1'));
  r1.pin('2').connect(d1.pin('anode'));
  d1.pin('cathode').connect(tb.gnd);
  v1.pin('-').connect(tb.gnd);
  tb.expect.op('D1.i').toBeWithin('5m', '15m');

  tb.board({ width: 25, height: 15 });
  tb.place('V1', { x: 4, y: 7.5, rot: 90 });
  tb.place('R1', { x: 13, y: 7.5 });
  tb.place('D1', { x: 16, y: 7.5 });       // on top of R1's right half
});
