import { bench, Part, VoltageSource, Resistor, LED } from 'circuitsvibe';

/**
 * CD4017 decade counter as an LED chaser: a 1 kHz clock steps one decoded
 * output high at a time (Q0 → Q9); Q0 lights an LED through 1 kΩ (CD4000B
 * outputs are weak: ~400 Ω at 5 V). CARRY OUT runs at clock / 10.
 */
export default bench('cd4017-chaser', (tb) => {
  const vdd = tb.add('VDD', new VoltageSource(5));
  const clk = tb.add('VCLK', new VoltageSource({ pulse: { v1: 0, v2: 5, td: '0.5m', tr: '1u', tf: '1u', pw: '0.5m', per: '1m' } }));
  const u1 = tb.add('U1', Part('CD4017'));
  const r1 = tb.add('R1', new Resistor('1k'));
  const d1 = tb.add('D1', new LED());

  vdd.pin('-').connect(tb.gnd);
  clk.pin('-').connect(tb.gnd);
  u1.pin('VDD').connect(vdd.pin('+')); //   pin 16
  u1.pin('VSS').connect(tb.gnd); //          pin 8
  clk.pin('+').connect(u1.pin('CLOCK')); // pin 14 (Schmitt input)
  u1.pin('RESET').connect(tb.gnd); //        pin 15
  u1.pin('CLOCK INHIBIT').connect(tb.gnd); // pin 13
  u1.pin('Q0').connect(r1.pin('1'));
  r1.pin('2').connect(d1.pin('anode'));
  d1.pin('cathode').connect(tb.gnd);

  const run = tb.expect.tran({ tstop: '25m', maxStep: '50u' });
  run.logic('U1.Q0').toBe(1).at('0.2m');
  run.logic('U1.Q1').toBe(1).at('1.2m');
  run.logic('U1.Q5').toBe(1).at('5.2m');
  run.logic('U1.Q9').toBe(1).at('9.2m');
  run.logic('U1.Q0').toBe(1).at('10.2m'); // wrapped around
  run.logic('U1.Q3').toBeStable('4m', '12m', { value: 0 }); // high only for counts 3 and 13
  run.logic('U1.CARRY OUT').toHaveFrequency('100', 0.001, { from: '1m' });
  run.probe('D1.i').toNeverExceed('5m');
});
