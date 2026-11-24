import { bench, Part, VoltageSource, Clock, Stimulus } from 'circuitsvibe';

/**
 * 74HC595: shift the byte 1011 0010 (first bit first) in on SRCLK, latch it
 * on RCLK, read it on QA–QH. Logic primitives (Stimulus, Clock) drive the IC
 * pins through the analog bridges (74HC levels at an ideal 5 V).
 */
export default bench('hc595-shift-latch', (tb) => {
  const vcc = tb.add('VCC', new VoltageSource(5));
  const u1 = tb.add('U1', Part('74HC595'));
  const ser = tb.add('SER', new Stimulus({ pattern: '10110010', step: '1u' }));
  const sck = tb.add('SCK', new Clock({ period: '1u', start: '0.5u', stop: '7.9u' }));
  const rck = tb.add('RCK', new Stimulus({ changes: [['8.2u', 1], ['8.7u', 0]] }));

  vcc.pin('-').connect(tb.gnd);
  u1.pin('VCC').connect(vcc.pin('+'));
  u1.pin('GND').connect(tb.gnd);
  ser.pin('y').connect(u1.pin('SER'));
  sck.pin('y').connect(u1.pin('SRCLK'));
  rck.pin('y').connect(u1.pin('RCLK'));
  u1.pin('~SRCLR').connect(vcc.pin('+'));
  u1.pin('~OE').connect(tb.gnd);

  const run = tb.expect.logic('U1.QA', { tstop: '10u' });
  run.toBe(0).at('8u'); // shifted but not latched yet
  const byte = { QA: 0, QB: 1, QC: 0, QD: 0, QE: 1, QF: 1, QG: 0, QH: 1 } as const;
  for (const [q, v] of Object.entries(byte)) tb.expect.logic(`U1.${q}`).toBe(v).at('9.5u');
  tb.expect.logic("U1.QH'").toBe(1).at('9.5u');
});
