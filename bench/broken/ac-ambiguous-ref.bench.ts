import { bench, VoltageSource, Resistor } from 'circuitsvibe';

/**
 * SEEDED BROKEN: two sources carry an AC stimulus, so "gain relative to the
 * stimulus" has no single meaning.
 * Expected: T004 ambiguous-ac-reference, exit 3. Fix: probe('out', { ref: 'a' })
 * or keep `ac` on one source only.
 */
export default bench('ac-ambiguous-ref', (tb) => {
  const va = tb.add('VA', new VoltageSource({ dc: 0, ac: 1 }));
  const vb = tb.add('VB', new VoltageSource({ dc: 0, ac: 1 }));
  const ra = tb.add('RA', new Resistor('1k'));
  const rb = tb.add('RB', new Resistor('1k'));

  va.pin('+').connect(ra.pin('1'));
  vb.pin('+').connect(rb.pin('1'));
  ra.pin('2').connect(rb.pin('2'));
  va.pin('-').connect(tb.gnd);
  vb.pin('-').connect(tb.gnd);
  tb.name('a', va.pin('+'));
  tb.name('out', ra.pin('2'));

  tb.expect.ac({ from: '10', to: '10k' }).probe('out').gainAt('1k').toBeWithin(-1, 1);
});
