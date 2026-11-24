import { bench, Part, VoltageSource, Resistor } from 'circuitsvibe';

/**
 * Mixed-signal + real semiconductors: a 74HC04 inverter output drives a
 * 2N3904 base through 4.7 kΩ; the transistor switches a red LED from 5 V
 * through 150 Ω. The inverter is co-simulated (logic capture in
 * stages.tran.logic), while Q1 and D1 are catalog parts whose datasheet
 * ratings are checked after op and tran (stages.<stage>.ratings), here with
 * a 20 % derating margin.
 */
export default bench('hc04-drives-npn', (tb) => {
  const vcc = tb.add('VCC', new VoltageSource(5));
  const vin = tb.add('VIN', new VoltageSource({ pulse: { v1: 0, v2: 5, td: '0.5m', tr: '10n', tf: '10n', pw: '0.5m', per: '1m' } }));
  const u1 = tb.add('U1', Part('74HC04'));
  const rb = tb.add('RB', new Resistor('4.7k'));
  const rled = tb.add('RLED', new Resistor('150'));
  const q1 = tb.add('Q1', Part('2N3904'));
  const d1 = tb.add('D1', Part('LED-RED-5MM'));

  vcc.pin('-').connect(tb.gnd);
  vin.pin('-').connect(tb.gnd);
  u1.pin('VCC').connect(vcc.pin('+'));
  u1.pin('GND').connect(tb.gnd);
  vin.pin('+').connect(u1.pin('1A'));
  u1.pin('1Y').connect(rb.pin('1'));
  rb.pin('2').connect(q1.pin('b'));
  vcc.pin('+').connect(rled.pin('1'));
  rled.pin('2').connect(d1.pin('anode'));
  d1.pin('cathode').connect(q1.pin('c'));
  q1.pin('e').connect(tb.gnd);
  for (const p of ['2A', '3A', '4A', '5A', '6A']) u1.pin(p).connect(tb.gnd); // unused inputs tied low

  tb.name('in', u1.pin('1A'));
  tb.name('drive', u1.pin('1Y'));
  tb.ratings({ derate: 0.8 });

  // t = 0: input low → 1Y high → Q1 saturated → LED on.
  tb.expect.op('D1.i').toBeWithin('15m', '24m');
  tb.expect.op('Q1.vce').toBeBelow(0.3);
  tb.expect.op('Q1.ib').toBeAbove('500u');

  const run = tb.expect.tran({ tstop: '2.5m', maxStep: '20u' });
  run.probe('Q1.ic').toNeverExceed('25m');
  run.logic('drive').toHaveFrequency('1k', 0.001, { from: '0.2m' });
  run.logic('drive').toBe(0).at('0.75m'); // input high → LED off
  run.logic('drive').toBe(1).at('1.25m'); // input low  → LED on
});
