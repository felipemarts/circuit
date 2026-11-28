import { bench, VoltageSource, Resistor, Capacitor, LED } from 'circuitsvibe';
import LM7805 from './lm7805.part';

/**
 * A 9 V battery regulated to 5 V by an LM7805 (custom component, published
 * in the registry as its own module) feeding a 47 Ω load (~106 mA) on a
 * screw terminal, with the datasheet input / output capacitors and a power
 * LED. The DC sweep walks the input from 0 to 12 V through the dropout
 * region; the transient is the power-up step.
 */
export default bench('lm7805-supply', (tb) => {
  const vbat = tb.add('VBAT', new VoltageSource(9));
  const u1 = tb.add('U1', new LM7805());
  const cin = tb.add('CIN', new Capacitor('330n'));
  const cout = tb.add('COUT', new Capacitor('100n'));
  const rl = tb.add('RL', new Resistor('47'));
  const rled = tb.add('RLED', new Resistor('1k'));
  const d1 = tb.add('D1', new LED());

  vbat.pin('-').connect(tb.gnd);
  vbat.pin('+').connect(u1.pin('in'));
  u1.pin('gnd').connect(tb.gnd);
  cin.pin('1').connect(u1.pin('in'));
  cin.pin('2').connect(tb.gnd);
  cout.pin('1').connect(u1.pin('out'));
  cout.pin('2').connect(tb.gnd);
  rl.pin('1').connect(u1.pin('out'));
  rl.pin('2').connect(tb.gnd);
  rled.pin('1').connect(u1.pin('out'));
  rled.pin('2').connect(d1.pin('anode'));
  d1.pin('cathode').connect(tb.gnd);
  tb.name('vin', u1.pin('in'));
  tb.name('out', u1.pin('out'));

  tb.expect.op('out').toBeWithin(4.95, 5.05);
  tb.expect.op('RL.i').toBeWithin('100m', '110m');
  tb.expect.op('VBAT.i').toBeWithin('-120m', '-105m');   // load + LED + quiescent, leaving the battery

  tb.expect.dc({ source: 'VBAT', from: 0, to: 12, points: 121 })
    .probe('out')
    .toBeMonotonic('increasing')
    .toCross(4.75).between(6.5, 7.2)                      // dropout: regulation starts near 5 V + 2 V
    .at(5).toBeBelow(3.2)
    .at(12).toBeWithin(4.95, 5.05);

  tb.expect.tran({ tstop: '2m', maxStep: '20u' })
    .probe('out')
    .toSettleWithin({ target: 5, tol: 0.01, by: '200u' })
    .toNeverExceed(5.1);

  tb.board({ width: 40, height: 25, holes: [{ x: 3.5, y: 3.5, d: 3.2 }, { x: 36.5, y: 21.5, d: 3.2 }] });
  tb.place('VBAT', { x: 6, y: 13, rot: 90, footprint: 'TERM-2' });                       // 9 V in
  tb.place('U1', { x: 20, y: 16, footprint: 'TO-220', pads: { in: '1', gnd: '2', out: '3' } });
  tb.place('CIN', { x: 14, y: 7 });
  tb.place('COUT', { x: 26, y: 7 });
  tb.place('RL', { x: 35, y: 12, rot: 90, footprint: 'TERM-2' });                       // 5 V out to the load
  tb.place('RLED', { x: 19, y: 22.5 });
  tb.place('D1', { x: 30, y: 22 });
});
