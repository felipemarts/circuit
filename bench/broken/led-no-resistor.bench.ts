import { bench, VoltageSource, LED } from 'circuitsvibe';

/**
 * SEEDED BROKEN: LED wired straight across the supply — the classic beginner
 * (and LLM) mistake. Expected: F105 source-clamped-diode from lint, before
 * any solver runs (otherwise Newton-Raphson would diverge), naming D1 with
 * the series-resistance fix suggested. Exit 2.
 */
export default bench('led-no-resistor', (tb) => {
  const v1 = tb.add('V1', new VoltageSource(5));
  const d1 = tb.add('D1', new LED());

  v1.pin('+').connect(d1.pin('anode'));
  d1.pin('cathode').connect(tb.gnd);
  v1.pin('-').connect(tb.gnd);

  tb.expect.op('D1.i').toBeWithin('5m', '15m');
});
