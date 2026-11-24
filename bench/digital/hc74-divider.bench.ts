import { bench, Part, VoltageSource } from 'circuitsvibe';

/**
 * 74HC74 D flip-flop as a toggle (D = ~Q): it divides a 1 MHz clock by 2.
 * ~PRE/~CLR are tied high (inactive); the unused second flip-flop has its
 * inputs tied to rails.
 */
export default bench('hc74-divider', (tb) => {
  const vcc = tb.add('VCC', new VoltageSource(5));
  const clk = tb.add('VCLK', new VoltageSource({ pulse: { v1: 0, v2: 5, td: '0.5u', tr: '5n', tf: '5n', pw: '0.5u', per: '1u' } }));
  const u1 = tb.add('U1', Part('74HC74'));

  vcc.pin('-').connect(tb.gnd);
  clk.pin('-').connect(tb.gnd);
  u1.pin('VCC').connect(vcc.pin('+'));
  u1.pin('GND').connect(tb.gnd);
  clk.pin('+').connect(u1.pin('1CLK'));
  u1.pin('1D').connect(u1.pin('~1Q'));
  u1.pin('~1PRE').connect(vcc.pin('+'));
  u1.pin('~1CLR').connect(vcc.pin('+'));
  u1.pin('~2PRE').connect(vcc.pin('+'));
  u1.pin('~2CLR').connect(vcc.pin('+'));
  u1.pin('2D').connect(tb.gnd);
  u1.pin('2CLK').connect(tb.gnd);

  tb.name('q', u1.pin('1Q'));

  const q = tb.expect.logic('q', { tstop: '20u' });
  q.toHaveFrequency('500k', 0.001, { from: '1u' });
  q.toHaveDutyCycle(0.5, 0.01, { from: '1u' });
  tb.expect.logic('U1.1CLK').toToggle({ edge: 'rising', count: 20 });
});
