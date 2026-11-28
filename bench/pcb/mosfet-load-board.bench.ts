import { bench, VoltageSource, Resistor, Part } from 'circuitsvibe';

/**
 * A 12 V, 3 A load switched by a logic-level IRLZ44N on a 50 × 30 mm board.
 * The load (modelled as RL, 4 Ω) and the 12 V supply connect through screw
 * terminals: RL's footprint is the TERM-2 the load is wired to. The pcb stage
 * takes each net's current from the simulation (≈ 3 A in steady state) and
 * widens the power traces per IPC-2221; the gate trace keeps
 * the 0.25 mm minimum.
 */
export default bench('mosfet-load-board', (tb) => {
  const vdd = tb.add('VDD', new VoltageSource(12));
  const vg = tb.add('VG', new VoltageSource({ pulse: { v1: 0, v2: 5, td: '100u', tr: '1u', tf: '1u', pw: '1' } }));
  const rg = tb.add('RG', new Resistor('100'));
  const rgs = tb.add('RGS', new Resistor('100k'));
  const rl = tb.add('RL', new Resistor('4'));
  const m1 = tb.add('M1', Part('IRLZ44N'));

  vdd.pin('-').connect(tb.gnd);
  vg.pin('-').connect(tb.gnd);
  vg.pin('+').connect(rg.pin('1'));
  rg.pin('2').connect(m1.pin('g'));
  rgs.pin('1').connect(m1.pin('g'));
  rgs.pin('2').connect(tb.gnd);
  vdd.pin('+').connect(rl.pin('1'));
  rl.pin('2').connect(m1.pin('d'));
  m1.pin('s').connect(tb.gnd);
  tb.name('vdd', vdd.pin('+'));
  tb.name('drain', m1.pin('d'));
  tb.name('gate', m1.pin('g'));

  tb.expect.tran({ tstop: '1m', maxStep: '10u' })
    .probe('drain').toStayBelow(0.15, { from: '200u' })
    .probe('M1.id').toEndCloseTo(3, 0.05);         // ≈ 12 V / 4 Ω

  tb.board({ width: 50, height: 30, holes: [{ x: 3.5, y: 3.5, d: 3.2 }, { x: 46.5, y: 26.5, d: 3.2 }] });
  tb.place('VDD', { x: 6, y: 20, rot: 90, footprint: 'TERM-2' });   // 12 V in
  tb.place('RL', { x: 44, y: 15, rot: 90, footprint: 'TERM-2' });   // the load's terminals
  tb.place('M1', { x: 30, y: 9 });                                  // TO-220, G D S
  tb.place('VG', { x: 6, y: 9, rot: 90 });                           // 5 V logic in (header)
  tb.place('RG', { x: 17, y: 7 });
  tb.place('RGS', { x: 17, y: 13 });
});
