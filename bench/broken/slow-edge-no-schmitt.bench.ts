import { bench, Part, VoltageSource, Resistor, Capacitor } from 'circuitsvibe';

/**
 * SEEDED BROKEN: a slow RC edge (tau = 100 µs) straight into a plain 74HC04
 * input: it crawls through the VIL–VIH band for ~100 µs, far beyond the
 * 500 ns maximum input transition time — use a Schmitt input (74HC14).
 * Expected: D508 input-forbidden-zone in the tran stage, with time and dwell. Exit 2.
 */
export default bench('slow-edge-no-schmitt', (tb) => {
  const vcc = tb.add('VCC', new VoltageSource(5));
  const vs = tb.add('VS', new VoltageSource({ pulse: { v1: 0, v2: 5, td: '10u', tr: '1u', tf: '1u', pw: '1m' } }));
  const u1 = tb.add('U1', Part('74HC04'));
  const r1 = tb.add('R1', new Resistor('10k'));
  const c1 = tb.add('C1', new Capacitor('10n'));
  vcc.pin('-').connect(tb.gnd);
  vs.pin('-').connect(tb.gnd);
  u1.pin('VCC').connect(vcc.pin('+'));
  u1.pin('GND').connect(tb.gnd);
  vs.pin('+').connect(r1.pin('1'));
  r1.pin('2').connect(u1.pin('1A'));
  c1.pin('1').connect(u1.pin('1A'));
  c1.pin('2').connect(tb.gnd);
  for (const p of ['2A', '3A', '4A', '5A', '6A']) u1.pin(p).connect(tb.gnd);
  tb.expect.logic('U1.1Y', { tstop: '0.5m' }).toToggle({ count: 1 });
});
