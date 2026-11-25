import { bench, VoltageSource, Resistor, Part } from 'circuitsvibe';

/**
 * Non-inverting Schmitt trigger with an LM393 on 5 V: the input reaches 'inp'
 * through R1 (10 kΩ), the open-collector output is pulled up by RP (10 kΩ)
 * and fed back to 'inp' through RF (100 kΩ); a 10k/10k divider puts the
 * 2.5 V reference on 'inn'. The hysteresis is set by the resistors alone:
 *   output high (5 V): V(inp) = (10·Vin + 5)/11 → falls below 2.5 V at Vin ≈ 2.25 V
 *   output low (≈ 0 V): V(inp) = 10·Vin/11      → rises above 2.5 V at Vin ≈ 2.75 V
 * Two DC sweeps of the 0–3.3 V input (up, then down) find both thresholds.
 */
export default bench('lm393-schmitt-trigger', (tb) => {
  const u1 = tb.add('U1', Part('LM393'));
  const vcc = tb.add('VCC', new VoltageSource(5));
  const vin = tb.add('VIN', new VoltageSource(0));
  const r1 = tb.add('R1', new Resistor('10k'));
  const rf = tb.add('RF', new Resistor('100k'));
  const rp = tb.add('RP', new Resistor('10k'));
  const ra = tb.add('RA', new Resistor('10k'));
  const rb = tb.add('RB', new Resistor('10k'));

  vcc.pin('-').connect(tb.gnd);
  vin.pin('-').connect(tb.gnd);
  vcc.pin('+').connect(u1.pin('v+'));                  // single supply: v- on gnd
  u1.pin('v-').connect(tb.gnd);

  vin.pin('+').connect(r1.pin('1'));                   // input → R1 → inp
  r1.pin('2').connect(u1.pin('inp'));
  rf.pin('1').connect(u1.pin('out'));                  // positive feedback: out → RF → inp
  rf.pin('2').connect(u1.pin('inp'));
  rp.pin('1').connect(vcc.pin('+'));                   // open collector needs the pull-up
  rp.pin('2').connect(u1.pin('out'));
  ra.pin('1').connect(vcc.pin('+'));                   // 2.5 V reference on inn
  ra.pin('2').connect(u1.pin('inn'));
  rb.pin('1').connect(u1.pin('inn'));
  rb.pin('2').connect(tb.gnd);
  tb.name('out', u1.pin('out'));

  tb.expect.op('out').toBeBelow(0.1);                  // Vin = 0 → output low
  tb.expect.dc({ source: 'VIN', from: 0, to: 3.3, points: 331 })
    .probe('out')
    .toCross(2.5).between(2.7, 2.8)                    // rising threshold ≈ 2.75 V
    .at(2.5).toBeBelow(0.1);                           // still low at the plain-comparator point
  tb.expect.dc({ source: 'VIN', from: 3.3, to: 0, points: 331 })
    .probe('out')
    .toCross(2.5).between(2.2, 2.3)                    // falling threshold ≈ 2.25 V
    .at(2.5).toBeAbove(4.5);                           // still high on the way down (≈ 4.8 V: RP loaded by RF + R1)
});
