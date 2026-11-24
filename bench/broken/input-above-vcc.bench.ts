import { bench, Part, VoltageSource, Resistor } from 'circuitsvibe';

/**
 * SEEDED BROKEN: a 5 V signal into a 74HC04 powered at 3.3 V through only
 * 47 Ω — the input clamp diode to VCC conducts tens of mA.
 * Expected: D513 input-clamp-overcurrent (U1.1A, above the 20 mA |IIK| max). Exit 2.
 */
export default bench('input-above-vcc', (tb) => {
  const vcc = tb.add('VCC', new VoltageSource(3.3));
  const v5 = tb.add('V5', new VoltageSource(5));
  const u1 = tb.add('U1', Part('74HC04'));
  const r1 = tb.add('R1', new Resistor('47'));
  vcc.pin('-').connect(tb.gnd);
  v5.pin('-').connect(tb.gnd);
  u1.pin('VCC').connect(vcc.pin('+'));
  u1.pin('GND').connect(tb.gnd);
  v5.pin('+').connect(r1.pin('1'));
  r1.pin('2').connect(u1.pin('1A'));
  for (const p of ['2A', '3A', '4A', '5A', '6A']) u1.pin(p).connect(tb.gnd);
  tb.expect.op('U1.1Y').toBeBelow(0.1);
});
