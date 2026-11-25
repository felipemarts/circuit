import { bench, VhdlBlock, Clock, Const, Resistor, Capacitor } from 'circuitsvibe';
import pwm from './pwm.vhd';

/**
 * A VHDL PWM generator (pwm.vhd) with generics PERIOD = 10, DUTY = 3, clocked
 * by a 100 kHz logic Clock primitive wired straight to its clk port (a
 * pure-digital net: the event engine alone), reset held low by a Const. Its
 * pwm_out bit meets an analog RC filter (10 kΩ, 1 µF), bridged with 74HC
 * levels at an ideal 5 V: a 10 kHz square wave of duty 3/10 that the filter
 * averages to 0.3 · 5 V = 1.5 V.
 */
export default bench('vhdl-pwm-generic', (tb) => {
  const ck = tb.add('CK', new Clock({ freq: '100k' }));
  const rst = tb.add('RST', new Const(0));
  const u3 = tb.add('U3', new VhdlBlock({ source: pwm, generics: { PERIOD: 10, DUTY: 3 } }));
  const rf = tb.add('RF', new Resistor('10k'));
  const cf = tb.add('CF', new Capacitor('1u'));
  ck.pin('y').connect(u3.pin('clk'));
  rst.pin('y').connect(u3.pin('rst'));
  u3.pin('pwm_out').connect(rf.pin('1'));
  rf.pin('2').connect(cf.pin('1'));
  cf.pin('2').connect(tb.gnd);
  tb.name('avg', cf.pin('1'));

  const run = tb.expect.tran({ tstop: '60m', maxStep: '20u' });
  run.logic('U3.pwm_out').toHaveFrequency('10k', 1e-6, { from: '1m' });
  run.logic('U3.pwm_out').toHaveDutyCycle(0.3, 1e-6, { from: '1m' });
  run.probe('avg').toSettleWithin({ target: 1.5, tol: 0.02, by: '55m' });
});
