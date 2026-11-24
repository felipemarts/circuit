import { bench, VoltageSource, Resistor, Capacitor } from 'circuitsvibe';

/**
 * SEEDED BROKEN: AC assertions on an RC low-pass whose source has only a DC
 * value. A DC value sets the operating point; it does not drive the AC
 * analysis, so every small-signal quantity would be 0 (-inf dB).
 * Expected: T003 no-ac-stimulus, exit 3. Fix: new VoltageSource({ dc: 0, ac: 1 }).
 */
export default bench('ac-no-stimulus', (tb) => {
  const v1 = tb.add('V1', new VoltageSource(1));
  const r1 = tb.add('R1', new Resistor('1k'));
  const c1 = tb.add('C1', new Capacitor('159n'));

  v1.pin('+').connect(r1.pin('1'));
  r1.pin('2').connect(c1.pin('1'));
  c1.pin('2').connect(tb.gnd);
  v1.pin('-').connect(tb.gnd);
  tb.name('out', c1.pin('1'));

  tb.expect.ac({ from: '10', to: '100k' }).probe('out').bandwidth3dB().toBeWithin('900', '1.1k');
});
