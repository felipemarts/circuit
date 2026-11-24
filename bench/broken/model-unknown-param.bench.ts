import { bench, VoltageSource, Resistor, Diode } from 'circuitsvibe';

/**
 * SEEDED BROKEN (warning only): the .model card misspells RS as RSS. The
 * unknown parameter is ignored and reported, the run continues and the
 * spec passes. Expected: T005 (warning at lint), exit 0.
 */
export default bench('model-unknown-param', (tb) => {
  const v1 = tb.add('V1', new VoltageSource(5));
  const r1 = tb.add('R1', new Resistor('1k'));
  const d1 = tb.add('D1', Diode.fromModel('.model D1N4148 D(IS=2.52n RSS=0.568 N=1.752 CJO=4p M=0.4 TT=20n BV=100 IBV=100u)'));

  v1.pin('+').connect(r1.pin('1'));
  r1.pin('2').connect(d1.pin('anode'));
  d1.pin('cathode').connect(tb.gnd);
  v1.pin('-').connect(tb.gnd);

  tb.expect.op('D1.i').toBeWithin('4m', '5m');
});
