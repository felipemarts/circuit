import { bench, VoltageSource, Resistor, LED } from 'circuit-forge';

/**
 * SEEDED BROKEN: series resistor too small — the LED runs at ~27 mA against a
 * 8–12 mA spec. Expected: A301 with a VERIFIED hint (the platform sweeps R1
 * and returns a passing range), exit 1. Applying the hint turns this green:
 *
 *   forge verify bench/broken/led-overcurrent.bench.ts --set R1=<suggested>
 */
export default bench('led-overcurrent', (tb) => {
  const v1 = tb.add('V1', new VoltageSource(5));
  const r1 = tb.add('R1', new Resistor('100'));
  const d1 = tb.add('D1', new LED());

  v1.pin('+').connect(r1.pin('1'));
  r1.pin('2').connect(d1.pin('anode'));
  d1.pin('cathode').connect(tb.gnd);
  v1.pin('-').connect(tb.gnd);

  tb.param('R1', { min: '100', max: '10k', scale: 'log' });

  tb.expect.op('D1.i').toBeWithin('8m', '12m');
});
