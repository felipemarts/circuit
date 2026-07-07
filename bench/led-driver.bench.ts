import { bench, VoltageSource, Resistor, LED } from 'circuit-forge';

/**
 * LED driver: 5 V supply, series resistor, LED to ground.
 * The canonical "hello world" of the verification ladder — passes as written.
 */
export default bench('led-driver', (tb) => {
  const v1 = tb.add('V1', new VoltageSource(5));
  const r1 = tb.add('R1', new Resistor('330'));
  const d1 = tb.add('D1', new LED());

  v1.pin('+').connect(r1.pin('1'));
  r1.pin('2').connect(d1.pin('anode'));
  d1.pin('cathode').connect(tb.gnd);
  v1.pin('-').connect(tb.gnd);

  tb.name('led', d1.pin('anode'));

  // The platform explores this range for verified sizing hints if needed.
  tb.param('R1', { min: '100', max: '10k', scale: 'log' });

  tb.expect.op('D1.i').toBeWithin('5m', '15m'); // LED bright but safe
  tb.expect.op('led').toBeWithin(1.8, 2.6);     // sane forward voltage
});
