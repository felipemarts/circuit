import { bench, Part, VoltageSource } from 'circuitsvibe';

/**
 * SEEDED BROKEN: data changes 5 ns before the 74HC74 clock edge; the datasheet
 * setup time is 20 ns. The flip-flop's digital timing check fires through the
 * analog bridges and lands in the RunRecord with the IC's location.
 * Expected: D502 setup-violation (U1, with time). Exit 2.
 */
export default bench('hc74-setup-violation', (tb) => {
  const vcc = tb.add('VCC', new VoltageSource(5));
  const clk = tb.add('VCLK', new VoltageSource({ pulse: { v1: 0, v2: 5, td: '1u', tr: '5n', tf: '5n', pw: '1u', per: '2u' } }));
  const vd = tb.add('VD', new VoltageSource({ pulse: { v1: 0, v2: 5, td: '0.995u', tr: '1n', tf: '1n', pw: '2u', per: '4u' } }));
  const u1 = tb.add('U1', Part('74HC74'));
  for (const s of [vcc, clk, vd]) s.pin('-').connect(tb.gnd);
  u1.pin('VCC').connect(vcc.pin('+'));
  u1.pin('GND').connect(tb.gnd);
  clk.pin('+').connect(u1.pin('1CLK'));
  vd.pin('+').connect(u1.pin('1D'));
  for (const p of ['~1PRE', '~1CLR', '~2PRE', '~2CLR']) u1.pin(p).connect(vcc.pin('+'));
  for (const p of ['2D', '2CLK']) u1.pin(p).connect(tb.gnd);
  tb.expect.logic('U1.1Q', { tstop: '6u' }).toToggle({ min: 1 });
});
