import { bench, Clock, Counter, DFF, Not } from 'circuitsvibe';

/**
 * A bench with no analog parts at all: the digital engine runs alone over
 * tstop. A 1 MHz clock feeds a toggle flip-flop (÷2) and a 4-bit counter (÷16).
 */
export default bench('counter-pure-digital', (tb) => {
  const clk = tb.add('CLK', new Clock({ freq: '1M' }));
  const ff = tb.add('FF1', new DFF({ delay: '2n' }));
  const inv = tb.add('N1', new Not({ delay: '1n' }));
  const cnt = tb.add('C1', new Counter({ bits: 4, delay: '3n' }));

  clk.pin('y').connect(ff.pin('clk'));
  clk.pin('y').connect(cnt.pin('clk'));
  ff.pin('q').connect(inv.pin('a'));
  inv.pin('y').connect(ff.pin('d'));
  tb.name('half', ff.pin('q'));
  tb.name('msb', cnt.pin('q3'));

  const run = tb.expect.logic('half', { tstop: '100u' });
  run.toHaveFrequency('500k', 1e-6);
  run.logic('msb').toHaveFrequency('62.5k', 1e-6);
  run.logic('msb').toHaveDutyCycle(0.5, 1e-6);
  run.logic('C1.q0').toToggle({ edge: 'rising', count: 50 });
});
