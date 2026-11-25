import { bench, VhdlBlock, VoltageSource, Resistor, LED } from 'circuitsvibe';
import counter from './counter.vhd';

/**
 * A 4-bit VHDL counter (counter.vhd, generic N = 4) clocked by a 1 kHz PULSE
 * source drives four LEDs through 470 Ω. The block's pins are its port bits
 * (clk, rst, q[0]…q[3]; `en` is left open and takes its VHDL default '1'),
 * bridged with 74HC levels at an ideal 5 V: q[0] toggles on every rising
 * clock edge (500 Hz), q[3] runs at 1 kHz / 16 = 62.5 Hz.
 */
export default bench('vhdl-counter-leds', (tb) => {
  const clk = tb.add('CLK', new VoltageSource({ pulse: { v1: 0, v2: 5, td: '0.5m', tr: '100n', tf: '100n', pw: '0.5m', per: '1m' } }));
  const u2 = tb.add('U2', new VhdlBlock({ source: counter, entity: 'counter', generics: { N: 4 }, family: 'HC', vcc: 5 }));
  clk.pin('-').connect(tb.gnd);
  clk.pin('+').connect(u2.pin('clk'));
  u2.pin('rst').connect(tb.gnd);
  for (let i = 0; i < 4; i++) {
    const r = tb.add(`R${i}`, new Resistor('470'));
    const d = tb.add(`D${i}`, new LED());
    u2.pin(`q[${i}]`).connect(r.pin('1'));
    r.pin('2').connect(d.pin('anode'));
    d.pin('cathode').connect(tb.gnd);
  }

  const run = tb.expect.tran({ tstop: '40m', maxStep: '50u' });
  run.logic('U2.q[0]').toHaveFrequency(500, 1e-6, { from: '1m' });
  run.logic('U2.q[3]').toHaveFrequency(62.5, 1e-6, { from: '1m' });
  run.logic('U2.q[1]').toBe(1).at('2.7m'); // 2 rising edges (0.5 m, 1.5 m, 2.5 m → count 3 = 0b0011)
  run.logic('U2.q[2]').toBe(0).at('2.7m');
  run.probe('D0.i').toNeverExceed('8m');
});
