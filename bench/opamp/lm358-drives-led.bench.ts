import { bench, Part, VoltageSource, Resistor } from 'circuitsvibe';

/**
 * Op-amp + real semiconductors: one LM358 channel used open-loop as a
 * comparator (sensor voltage on 'inp', a 1 V divider reference on 'inn')
 * drives a 2N3904 base through 4.7 kΩ; the transistor sinks a red LED from
 * 5 V through 150 Ω. Every Part() is checked against its datasheet:
 * U1 at the operating point (R420–R425), Q1 and D1 after op and over the dc
 * sweep (R401–R404) — all in stages.<stage>.ratings, next to the assertions.
 */
export default bench('lm358-drives-led', (tb) => {
  const vcc = tb.add('VCC', new VoltageSource(5));
  const vin = tb.add('VIN', new VoltageSource(2));
  const rt = tb.add('RT', new Resistor('40k'));
  const rbot = tb.add('RBOT', new Resistor('10k'));
  const u1 = tb.add('U1', Part('LM358'));
  const rb = tb.add('RB', new Resistor('4.7k'));
  const rled = tb.add('RLED', new Resistor('150'));
  const q1 = tb.add('Q1', Part('2N3904'));
  const d1 = tb.add('D1', Part('LED-RED-5MM'));

  vcc.pin('-').connect(tb.gnd);
  vin.pin('-').connect(tb.gnd);
  u1.pin('v+').connect(vcc.pin('+'));
  u1.pin('v-').connect(tb.gnd);
  vin.pin('+').connect(u1.pin('inp'));
  vcc.pin('+').connect(rt.pin('1')); // reference: 5 V · 10k / 50k = 1 V
  rt.pin('2').connect(rbot.pin('1'));
  rbot.pin('2').connect(tb.gnd);
  rt.pin('2').connect(u1.pin('inn'));
  u1.pin('out').connect(rb.pin('1'));
  rb.pin('2').connect(q1.pin('b'));
  vcc.pin('+').connect(rled.pin('1'));
  rled.pin('2').connect(d1.pin('anode'));
  d1.pin('cathode').connect(q1.pin('c'));
  q1.pin('e').connect(tb.gnd);

  tb.name('ref', u1.pin('inn'));

  // Sensor at 2 V > 1 V reference: output high (LM358 swings to ~VCC − 1.5 V), LED on.
  tb.expect.op('ref').toBeCloseTo(1, 0.01);
  tb.expect.op('U1.v').toBeWithin(3, 4.2);
  tb.expect.op('D1.i').toBeWithin('15m', '25m');
  tb.expect.op('Q1.vce').toBeBelow(0.3);
  // Sweeping the sensor: the LED switches on as it crosses the reference.
  const sweep = tb.expect.dc({ source: 'VIN', from: 0, to: 3, points: 61 });
  sweep.probe('D1.i').toCross('10m').between(0.9, 1.1);
  sweep.probe('D1.i').at(0.5).toBeBelow('1u');
});
