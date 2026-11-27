import { bench, Part, VoltageSource, Resistor, Capacitor, LED } from 'circuitsvibe';

/**
 * NE555 astable LED blinker on a 40 × 30 mm two-layer board: the 9 V input on
 * a 2-pin header, the timer in DIP-8, timing resistors and capacitor around
 * it, the LED with its resistor on the right. The pcb stage sizes every trace
 * from the simulated currents, autoroutes the board and checks the copper.
 */
export default bench('ne555-blinker-board', (tb) => {
  const vcc = tb.add('VCC', new VoltageSource(9));
  const u1 = tb.add('U1', Part('NE555'));
  const r1 = tb.add('R1', new Resistor('4.7k'));
  const r2 = tb.add('R2', new Resistor('10k'));
  const c1 = tb.add('C1', new Capacitor('1u'));
  const rl = tb.add('RL', new Resistor('680'));
  const d1 = tb.add('D1', new LED());

  vcc.pin('-').connect(tb.gnd);
  u1.pin('VCC').connect(vcc.pin('+'));
  u1.pin('GND').connect(tb.gnd);
  u1.pin('RESET').connect(vcc.pin('+'));
  r1.pin('1').connect(vcc.pin('+'));
  r1.pin('2').connect(u1.pin('DISCH'));
  r2.pin('1').connect(u1.pin('DISCH'));
  r2.pin('2').connect(u1.pin('THRES'));
  u1.pin('TRIG').connect(u1.pin('THRES'));
  c1.pin('1').connect(u1.pin('THRES'));
  c1.pin('2').connect(tb.gnd);
  u1.pin('OUT').connect(rl.pin('1'));
  rl.pin('2').connect(d1.pin('anode'));
  d1.pin('cathode').connect(tb.gnd);

  tb.name('vcc', vcc.pin('+'));
  tb.name('out', u1.pin('OUT'));
  tb.name('timing', u1.pin('THRES'));

  const run = tb.expect.tran({ tstop: '100m', maxStep: '100u' });
  run.logic('out').toHaveFrequency(1 / (Math.LN2 * 24.7e3 * 1e-6), 0.02, { from: '20m' });
  run.probe('D1.i').toNeverExceed('15m');

  tb.board({ width: 40, height: 30, holes: [{ x: 3.5, y: 3.5, d: 3.2 }, { x: 36.5, y: 26.5, d: 3.2 }] });
  tb.place('VCC', { x: 4, y: 15, rot: 90 });   // 9 V in: pad 1 = +
  tb.place('U1', { x: 18, y: 15 });              // DIP-8, pin 1 lower-left
  tb.place('R1', { x: 18, y: 25 });
  tb.place('R2', { x: 18, y: 5.5 });
  tb.place('C1', { x: 8, y: 8, rot: 90 });
  tb.place('RL', { x: 29, y: 15, rot: 90 });
  tb.place('D1', { x: 34, y: 15, rot: 90 });
});
