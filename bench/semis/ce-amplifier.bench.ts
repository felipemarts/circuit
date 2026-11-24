import { bench, VoltageSource, Resistor, Capacitor, Part } from 'circuitsvibe';

/**
 * Common-emitter amplifier with a 2N3904 (published onsemi card, junction
 * and transit-time charges included): divider bias, bypassed emitter,
 * AC-coupled 10 kΩ load. Mid-band gain ≈ gm·(RC ‖ RL) with gm = Ic/(Nf·Vt) —
 * this card has Nf = 1.5, so ~41 dB rather than the ideal-transistor 44.6 dB.
 */
export default bench('ce-amplifier', (tb) => {
  const vcc = tb.add('VCC', new VoltageSource(12));
  const vin = tb.add('VIN', new VoltageSource({ dc: 0, ac: 1 }));
  const cin = tb.add('CIN', new Capacitor('10u'));
  const r1 = tb.add('R1', new Resistor('47k'));
  const r2 = tb.add('R2', new Resistor('10k'));
  const rc = tb.add('RC', new Resistor('4.7k'));
  const re = tb.add('RE', new Resistor('1k'));
  const ce = tb.add('CE', new Capacitor('100u'));
  const cout = tb.add('COUT', new Capacitor('10u'));
  const rl = tb.add('RL', new Resistor('10k'));
  const q1 = tb.add('Q1', Part('2N3904'));

  vcc.pin('-').connect(tb.gnd);
  vin.pin('-').connect(tb.gnd);
  vin.pin('+').connect(cin.pin('1'));
  cin.pin('2').connect(q1.pin('b'));
  r1.pin('1').connect(vcc.pin('+'));
  r1.pin('2').connect(q1.pin('b'));
  r2.pin('1').connect(q1.pin('b'));
  r2.pin('2').connect(tb.gnd);
  rc.pin('1').connect(vcc.pin('+'));
  rc.pin('2').connect(q1.pin('c'));
  re.pin('1').connect(q1.pin('e'));
  re.pin('2').connect(tb.gnd);
  ce.pin('1').connect(q1.pin('e'));
  ce.pin('2').connect(tb.gnd);
  cout.pin('1').connect(q1.pin('c'));
  cout.pin('2').connect(rl.pin('1'));
  rl.pin('2').connect(tb.gnd);
  tb.name('out', rl.pin('1'));

  tb.expect.op('Q1.ic').toBeWithin('1.2m', '1.6m');  // hand calc ≈ 1.4 mA
  tb.expect.op('Q1.vce').toBeWithin(3, 6);           // headroom both ways
  const ac = tb.expect.ac({ from: '1', to: '100M', pointsPerDecade: 20 }).probe('out');
  ac.gainAt('10k').toBeWithin(39, 43);               // simulated 40.5 dB
  ac.bandwidth3dB().toBeAbove('10M');                // band-pass f_high − f_low (simulated 19 MHz)
});
