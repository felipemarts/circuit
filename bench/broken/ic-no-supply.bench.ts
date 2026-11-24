import { bench, Part, VoltageSource, Resistor } from 'circuitsvibe';

/**
 * SEEDED BROKEN: a 74HC04 whose VCC pin (14) was never wired — only its
 * input is driven. Real ICs are powered through their supply pins.
 * Expected: F135 ic-supply-unconnected from lint, naming U1.VCC. Exit 2.
 */
export default bench('ic-no-supply', (tb) => {
  const v1 = tb.add('V1', new VoltageSource(5));
  const u1 = tb.add('U1', Part('74HC04'));
  const r1 = tb.add('R1', new Resistor('10k'));
  v1.pin('-').connect(tb.gnd);
  v1.pin('+').connect(u1.pin('1A'));
  u1.pin('GND').connect(tb.gnd);
  u1.pin('1Y').connect(r1.pin('1'));
  r1.pin('2').connect(tb.gnd);
  for (const p of ['2A', '3A', '4A', '5A', '6A']) u1.pin(p).connect(tb.gnd);
  tb.expect.op('U1.1Y').toBeBelow(0.1);
});
