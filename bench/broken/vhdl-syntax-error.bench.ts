import { bench, VhdlBlock, VoltageSource, Resistor, LED } from 'circuitsvibe';
import counter from './counter-typo.vhd';

/**
 * Seeded broken: counter-typo.vhd misses a ';' after `count <= count + 1`
 * (line 15). The VHDL error comes out of the lint stage with its .vhd
 * file:line:col; nothing is simulated.
 *
 * Expected: V701 vhdl-syntax-error, exit 2.
 */
export default bench('vhdl-syntax-error', (tb) => {
  const clk = tb.add('CLK', new VoltageSource({ pulse: { v1: 0, v2: 5, td: '0.5m', tr: '100n', tf: '100n', pw: '0.5m', per: '1m' } }));
  const u2 = tb.add('U2', new VhdlBlock({ source: counter }));
  const r1 = tb.add('R1', new Resistor('470'));
  const d1 = tb.add('D1', new LED());
  clk.pin('-').connect(tb.gnd);
  clk.pin('+').connect(u2.pin('clk'));
  u2.pin('q[0]').connect(r1.pin('1'));
  r1.pin('2').connect(d1.pin('anode'));
  d1.pin('cathode').connect(tb.gnd);
  tb.expect.logic('U2.q[0]', { tstop: '5m' }).toHaveFrequency(500, 1e-6);
});
