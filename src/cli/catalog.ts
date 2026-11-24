/**
 * `circuitsvibe catalog` — the agent's datasheet: every component type, its pins,
 * value semantics and DC behavior, plus the probe and assertion grammars.
 */

export interface CatalogEntry {
  type: string;
  example: string;
  pins: string;
  value: string;
  dc: string;
}

export const COMPONENT_CATALOG: CatalogEntry[] = [
  {
    type: 'Resistor',
    example: `tb.add('R1', new Resistor('4.7k'))`,
    pins: `'1', '2'`,
    value: 'resistance in ohms (finite, > 0); accepts units string',
    dc: 'conducts; sweepable via tb.param',
  },
  {
    type: 'Capacitor',
    example: `tb.add('C1', new Capacitor('10u'))`,
    pins: `'1', '2'`,
    value: 'capacitance in farads (finite, > 0)',
    dc: 'OPEN at DC — nets isolated behind it need a DC path (see F101); sweepable',
  },
  {
    type: 'Inductor',
    example: `tb.add('L1', new Inductor('10m'))`,
    pins: `'1', '2'`,
    value: 'inductance in henries (finite, > 0)',
    dc: '0 V short at DC — across an ideal source it triggers F104; sweepable',
  },
  {
    type: 'VoltageSource',
    example: `tb.add('V1', new VoltageSource(5))  |  new VoltageSource({ pulse: { v1: 0, v2: 5, tr: '1u', tf: '1u', pw: '1m', per: '2m' } })`,
    pins: `'+', '-'`,
    value: 'DC volts, or { dc?, ac?, sin | pulse | pwl | pwm } (see SOURCES below); dc defaults to the waveform at t=0',
    dc: 'ideal source — parallel sources trigger F104; sweepable (DC value) and dc-sweepable via tb.expect.dc({ source })',
  },
  {
    type: 'CurrentSource',
    example: `tb.add('I1', new CurrentSource('1m'))  |  new CurrentSource({ dc: '1m', ac: 1 })`,
    pins: `'+', '-'`,
    value: 'amperes, or the same options object as VoltageSource; pushes its current out of + into the circuit',
    dc: 'does not fix node voltages — a node fed only by it floats (F101); sweepable',
  },
  {
    type: 'Diode',
    example: `tb.add('D1', new Diode({ Is: 1e-14, n: 1 }))`,
    pins: `'anode', 'cathode'`,
    value: 'Shockley params {Is, n, Vt}; nonlinear (Newton-Raphson with pn-junction limiting)',
    dc: 'needs series resistance or NR may not converge (S201); AC model: junction conductance at the operating point',
  },
  {
    type: 'LED',
    example: `tb.add('D1', new LED())`,
    pins: `'anode', 'cathode'`,
    value: 'Diode with LED-ish defaults (~2 V forward drop at mA currents)',
    dc: 'ALWAYS use a series resistor; probe D1.i for the operating current',
  },
  {
    type: 'Switch',
    example: `tb.add('SW1', new Switch(false))`,
    pins: `'com', 'a', 'b'`,
    value: 'SPDT: closed=false routes com→a, closed=true routes com→b; .toggle()',
    dc: 'conducts (1 mΩ closed / 1 TΩ open channel)',
  },
  {
    type: 'Button',
    example: `tb.add('BT1', new Button(false))`,
    pins: `'1', '2'`,
    value: 'momentary: conducts while .pressed === true',
    dc: 'conducts (1 mΩ pressed / 1 TΩ released)',
  },
];

export const GRAMMAR_NOTES = `PROBES (every stage)
  '<id>.i'   current through component <id>          e.g. 'D1.i'
  '<id>.v'   voltage across component <id>           e.g. 'R1.v'
  '<net>'    voltage of a net named via tb.name(...)  e.g. 'out'

VALUES  numbers or unit strings: '4.7k' '10m' '2u' '1M' '1e-6' (m=milli, M=mega)

SOURCES  new VoltageSource(...) / new CurrentSource(...) take a value or ONE waveform:
  { dc: 2.5, ac: 1 }                                   DC bias + AC stimulus (ac: mag or { mag, phase })
  { sin:   { offset, amplitude, freq, delay?, damping?, phase? } }     phase in degrees
  { pulse: { v1, v2, td?, tr?, tf?, pw, per? } }       SPICE PULSE; tr/tf 0 = ideal edge
  { pwl:   { points: [[t, v], ...], repeat? } }        times strictly increasing
  { pwm:   { low?, high, freq, duty, rise?, fall?, delay? } }   duty 0..1 or '25%'
  dc defaults to the waveform value at t=0; ac combines with any waveform

STAGES  lint -> op -> dc -> ac -> tran (fail-fast; dc/ac/tran run only when asserted)

SCALAR MATCHERS    .toBeWithin(min,max) .toBeCloseTo(v,tol) .toBeAbove(v) .toBeBelow(v)
OP ASSERTIONS      tb.expect.op(probe).<scalar>
DC SWEEP           tb.expect.dc({source:'V1', from:0, to:5, points:51}).probe(p)   ({param:'R1'} or step: also)
                     .at(x).<scalar>  .slopeAt(x).<scalar>  .toBeMonotonic('increasing'|'decreasing')
                     .toCross(level).between(a,b)       x in sweep units; at() interpolates linearly
AC                 tb.expect.ac({from:'10', to:'1M', pointsPerDecade:20}).probe(p, {ref?})
                     .gainAt(f).<scalar> dB   .phaseAt(f).<scalar> deg   .bandwidth3dB().<scalar> Hz
                     .unityGainFrequency().<scalar> Hz   .phaseMargin().<scalar> deg
                     H = probe / stimulus phasor (the one source with ac), or probe / ref
TRAN ASSERTIONS    tb.expect.tran({tstop:'5m', dt?:'1u', maxStep?, method?:'trap'|'be', ic?:'zero'|'op'}).probe(p)
                     .toSettleWithin({target,tol,by}) .toNeverExceed(v) .toStayAbove(v,{from})
                     .toStayBelow(v,{from}) .toRippleBelow(amp,{from}) .toEndCloseTo(v,tol)
                     adaptive steps: dt = initial step and ceiling (maxStep overrides the ceiling)
SIZING DELEGATION  tb.param('R1', {min:'100', max:'10k', scale:'log'})
                   -> on op-assertion failure the platform sweeps the range and
                     returns a VERIFIED passing range instead of making you guess
NET NAMES          tb.name('out', r1.pin('2'))  -> probe 'out' in any stage`;
