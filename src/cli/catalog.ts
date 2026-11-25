/**
 * `circuitsvibe catalog` — the agent's datasheet: every component type, its pins,
 * value semantics and DC behavior, plus the probe and assertion grammars.
 */

import { mixedCatalog, MIXED_GRAMMAR_NOTES } from '../mixed/catalog';
import { AMPLIFIER_CATALOG } from '../opamps/catalog';
import { mcuCatalog, MCU_GRAMMAR_NOTES } from '../mixed/mcu-catalog';

export interface CatalogEntry {
  type: string;
  example: string;
  pins: string;
  value: string;
  dc: string;
  /** Extra datasheet-derived lines (logic ICs: levels per VCC, drive, tpd, citations). */
  details?: string[];
  /** Real parts: model parameters, how they were derived, and the datasheet. */
  params?: Record<string, number | string | boolean>;
  notes?: string[];
  source?: string;
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
    example: `tb.add('D1', new Diode({ Is: '2.5n', n: 1.75, Rs: 0.5, Cjo: '4p', Tt: '20n', BV: 100 }))  |  Diode.fromModel('.model D1N4148 D(IS=2.52n RS=0.568 N=1.752 CJO=4p M=0.4 TT=20n BV=100 IBV=100u)')  |  Part('1N4148')`,
    pins: `'anode', 'cathode'`,
    value: 'SPICE level-1 diode (generic, free params, case-insensitive): Is, n, Rs (internal node), Cjo/Vj/M/Fc (depletion), Tt (diffusion), BV/IBV/Nbv (breakdown: Zener at Vz=BV, Iz=IBV); pn-junction limiting incl. breakdown',
    dc: 'needs series resistance or NR may not converge (S201); AC: gd + jω(Cj + Tt·gd); probes D1.i, D1.v, D1.p',
  },
  {
    type: 'LED',
    example: `tb.add('D1', new LED())`,
    pins: `'anode', 'cathode'`,
    value: "Diode with LED-ish defaults (Is=1e-20, n=2: ~2 V at mA currents); accepts Diode params; real LEDs: Part('LED-RED-5MM'), Part('LED-GREEN-5MM')",
    dc: 'ALWAYS use a series resistor; probe D1.i for the operating current',
  },
  {
    type: 'NPN',
    example: `tb.add('Q1', new NPN({ bf: 100, is: '1e-14', vaf: 100 }))  |  NPN.fromModel('.model Q2N3904 NPN(IS=6.734f BF=416.4 VAF=74.03 ...)')  |  Part('2N3904')`,
    pins: `'c', 'b', 'e' (aliases 'collector', 'base', 'emitter')`,
    value: 'Gummel-Poon subset, case-insensitive params: Is Bf Nf Vaf Ikf Ise Ne Br Nr Var Ikr Isc Nc Rb Re Rc Cje Vje Mje Cjc Vjc Mjc Tf Tr Fc (Ebers-Moll when only Is/Bf/Br are set; Vaf/Var/Ikf/Ikr 0 = infinite)',
    dc: 'drive the base through a resistor (F109 otherwise); pnjlim on both junctions; probes Q1.ic Q1.ib Q1.ie (into the pins) Q1.vbe Q1.vce Q1.vbc Q1.p; Q1.i = ic, Q1.v = vce',
  },
  {
    type: 'PNP',
    example: `tb.add('Q2', new PNP({ bf: 100 }))  |  Part('2N3906')`,
    pins: `'c', 'b', 'e'`,
    value: 'same parameters as NPN; every voltage and current mirrored (emitter at the positive side, ic < 0 when on)',
    dc: 'emitter to the most positive rail (F110 flags one tied to the lowest potential)',
  },
  {
    type: 'NMOS',
    example: `tb.add('M1', new NMOS({ vto: 2, kp: '50m', lambda: 0.01 }))  |  NMOS.fromModel('.model M1 NMOS(LEVEL=1 VTO=1 KP=2m)', { W: '10u', L: '1u' })  |  Part('2N7000')`,
    pins: `'d', 'g', 's' (aliases 'drain', 'gate', 'source'); with bulkPin: true also 'b'`,
    value: 'Level 1 (Shichman-Hodges): Vto Kp Lambda Gamma Phi Rd Rs W L Ld Cgso Cgdo Cgbo Cbd Cbs Is Pb Mj Fc; lumped W = L = 1 (Kp = beta); bodyDiode: { Is, n, Rs, ... } for power parts',
    dc: 'gate is insulated: give it a DC path (F108 otherwise); fetlim/limvds/pnjlim; probes M1.id M1.ig M1.is M1.vgs M1.vds M1.vbs M1.p; M1.i = id, M1.v = vds',
  },
  {
    type: 'PMOS',
    example: `tb.add('M2', new PMOS({ vto: -2, kp: '20m' }))  |  Part('IRF9540N')`,
    pins: `'d', 'g', 's'`,
    value: 'same parameters as NMOS; enhancement PMOS has Vto < 0; source to the most positive rail',
    dc: 'conducts when Vgs < Vto (gate below the source)',
  },
  {
    type: 'Part',
    example: `tb.add('Q1', Part('2N3904'))  |  Part('IRLZ44N')  |  Part('1N4733A')  |  Part('LED-RED-5MM')  |  Part('74HC04')`,
    pins: 'those of the device it returns (Diode/LED/NPN/PNP/NMOS/PMOS); logic ICs / NE555: datasheet pin names or numbers (see their entries)',
    value: 'one factory for every REAL catalog part (logic ICs / NE555 are listed below with their own entries). A semiconductor part: model card from the catalog (published or ESTIMATED — see circuitsvibe catalog <id>) plus datasheet absolute maximum ratings; netlist params carry part: <id>',
    dc: 'ratings are checked after op, dc and tran (R401 voltage, R402 current, R403 pulsed current, R404 power → exit 1); tb.ratings({ derate: 0.8 }) / tb.ratings(false)',
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
  // Logic ICs, NE555 and generic logic primitives (src/mixed).
  ...mixedCatalog(),
  // Op-amps and comparators (IdealOpAmp, OpAmp, Comparator) and the real parts behind Part('LM358')…
  ...AMPLIFIER_CATALOG,
  ...mcuCatalog(),
];

export const GRAMMAR_NOTES = `PROBES (every stage)
  '<id>.i'   current through component <id>          e.g. 'D1.i'
  '<id>.v'   voltage across component <id>           e.g. 'R1.v'
  '<net>'    voltage of a net named via tb.name(...)  e.g. 'out'
  device quantities: Diode/LED .i .v .p · NPN/PNP .ic .ib .ie (into the pins) .vbe .vbc .vce .vcb .veb .p
                     (.i = ic, .v = vce) · NMOS/PMOS .id .ig .is .vgs .vds .vgd .vbs .p (.i = id, .v = vds)

RATINGS  Part('<id>') semiconductors are checked against their datasheet absolute maximum ratings
  after op, dc and tran (mixed-signal transients too): stages.<stage>.ratings[] (separate from assertions), codes
  R401 voltage · R402 continuous current · R403 pulsed/surge current · R404 power; exit 1.
  op = value, dc = peak over the sweep, tran = peak (voltages, currents) or window average
  (continuous currents that have a pulsed rating; Pd). tb.ratings({ derate: 0.8, pd: 'peak',
  ignore: ['Q1'] }) or tb.ratings(false). Logic ICs check their own drive limits instead (D511).

MODELS   Diode/LED/NPN/PNP/NMOS/PMOS.fromModel('.model <name> <type>(<p>=<v> ...)'): SPICE suffixes
  case-insensitive (M = milli, MEG = mega, MIL), '+' continuation lines, parentheses optional;
  T005 unknown param (warning) · T006 unsupported type/LEVEL · T007 malformed · T008 not modeled (warning)

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
NET NAMES          tb.name('out', r1.pin('2'))  -> probe 'out' in any stage

${MIXED_GRAMMAR_NOTES}
OP-AMPS            pins 'inp' (+), 'inn' (-), 'out', 'v+', 'v-' (supply REQUIRED on OpAmp, Comparator, Part())
                   tb.add('U1', Part('LM358'))  one channel; also LM741 TL072 MCP6002 NE5532
                   new OpAmp({ aol, gbw, sr, ... })  |  new IdealOpAmp()  (v+/v- optional: both = rail clamp)
                   probes: U1.v = V(out), U1.i = output current (+ = sourcing)
COMPARATORS        Part('LM393') | Part('LM311') (wire 'emit') | new Comparator(): open collector,
                   output low when V(inp) < V(inn); needs a pull-up; hysteresis = external resistors
OP-AMP RATINGS     Part() amplifiers: R420-R425 at the op point in stages.op.ratings (fail = exit 1)

${MCU_GRAMMAR_NOTES}`;
