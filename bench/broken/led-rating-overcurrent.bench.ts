import { bench, VoltageSource, Resistor, Part } from 'circuitsvibe';

/**
 * SEEDED BROKEN: a real red LED (Part('LED-RED-5MM'), IF max 30 mA) behind a
 * 47 Ω resistor at 5 V runs at ~64 mA. The bench's own assertion passes (the
 * LED does light), but the datasheet absolute maximum is exceeded.
 * Expected: R402 (datasheet rating, in stages.op.ratings) with a VERIFIED
 * fix from the R1 range, exit 1.
 */
export default bench('led-rating-overcurrent', (tb) => {
  const v1 = tb.add('V1', new VoltageSource(5));
  const r1 = tb.add('R1', new Resistor('47'));
  const d1 = tb.add('D1', Part('LED-RED-5MM'));

  v1.pin('+').connect(r1.pin('1'));
  r1.pin('2').connect(d1.pin('anode'));
  d1.pin('cathode').connect(tb.gnd);
  v1.pin('-').connect(tb.gnd);

  tb.param('R1', { min: '47', max: '4.7k', scale: 'log' });
  tb.expect.op('D1.i').toBeAbove('5m'); // lit
});
