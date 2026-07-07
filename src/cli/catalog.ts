/**
 * `forge catalog` — the agent's datasheet: every component type, its pins,
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
    example: `tb.add('V1', new VoltageSource(5))`,
    pins: `'+', '-'`,
    value: 'DC volts (finite); set .acAmplitude/.frequency for a sine in transient',
    dc: 'ideal source — parallel sources trigger F104; sweepable',
  },
  {
    type: 'CurrentSource',
    example: `tb.add('I1', new CurrentSource('1m'))`,
    pins: `'+', '-'`,
    value: 'amperes (finite); current flows into pin + externally',
    dc: 'does not fix node voltages — a node fed only by it floats (F101); sweepable',
  },
  {
    type: 'Diode',
    example: `tb.add('D1', new Diode({ Is: 1e-14, n: 1 }))`,
    pins: `'anode', 'cathode'`,
    value: 'Shockley params {Is, n, Vt}; nonlinear (Newton-Raphson)',
    dc: 'needs series resistance or NR may not converge (S201)',
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

export const GRAMMAR_NOTES = `PROBES
  '<id>.i'   current through component <id>          e.g. 'D1.i'
  '<id>.v'   voltage across component <id>           e.g. 'R1.v'
  '<net>'    voltage of a net named via tb.name(...)  (op stage only)

VALUES  numbers or unit strings: '4.7k' '10m' '2u' '1M' '1e-6' (m=milli, M=mega)

OP ASSERTIONS      tb.expect.op(probe).toBeWithin(min,max) .toBeCloseTo(v,tol) .toBeAbove(v) .toBeBelow(v)
TRAN ASSERTIONS    tb.expect.tran({tstop:'5m',dt:'1u'}).probe(p)
                     .toSettleWithin({target,tol,by}) .toNeverExceed(v) .toStayAbove(v,{from})
                     .toStayBelow(v,{from}) .toRippleBelow(amp,{from}) .toEndCloseTo(v,tol)
SIZING DELEGATION  tb.param('R1', {min:'100', max:'10k', scale:'log'})
                   → on op-assertion failure the platform sweeps the range and
                     returns a VERIFIED passing range instead of making you guess
NET NAMES          tb.name('out', r1.pin('2'))  → probe 'out' in op assertions`;
