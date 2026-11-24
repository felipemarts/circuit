import { bench, Part, VoltageSource, Resistor, Capacitor } from 'circuitsvibe';

/**
 * SEEDED BROKEN (warning): an op assertion on a Schmitt RC oscillator. At DC
 * the capacitor is open and the inverter output keeps flipping its own input:
 * there is no static logic state to report.
 * Expected: D514 no-static-logic-state (warning). Exit 0.
 */
export default bench('oscillator-op-only', (tb) => {
  const vcc = tb.add('VCC', new VoltageSource(5));
  const u1 = tb.add('U1', Part('74HC14'));
  const r1 = tb.add('R1', new Resistor('10k'));
  const c1 = tb.add('C1', new Capacitor('10n'));
  vcc.pin('-').connect(tb.gnd);
  u1.pin('VCC').connect(vcc.pin('+'));
  u1.pin('GND').connect(tb.gnd);
  u1.pin('1Y').connect(r1.pin('1'));
  r1.pin('2').connect(u1.pin('1A'));
  c1.pin('1').connect(u1.pin('1A'));
  c1.pin('2').connect(tb.gnd);
  for (const p of ['2A', '3A', '4A', '5A', '6A']) u1.pin(p).connect(tb.gnd);
  tb.expect.op('VCC.i').toBeBelow(1);
});
