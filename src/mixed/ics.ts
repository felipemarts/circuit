/**
 * Real logic ICs and the NE555 as mixed-signal devices: pin roles (supply,
 * logic input/output, analog), the bridge at each pin, and the internal
 * behavior as a small digital netlist built from src/digital primitives.
 *
 * Pin names and numbers come from the catalog record (src/parts), i.e. the
 * datasheet pinout. Delays come from the catalog's tpd rows at the IC's
 * actual supply (see families.ts).
 */
import { findPart } from '../parts';
import type { LogicPart, PinDef, TimerPart } from '../parts/types';
import type { PartParams } from '../digital/parts';
import { logicFamilyModel, ne555Model, RAMP_FRACTION, TPD_TEST_LOAD, type Corner, type FamilyName } from './families';

export type IcPinRole = 'vcc' | 'gnd' | 'in' | 'out' | 'analog';

/** How a pin is bridged between the analog nodes and the digital nets. */
export type BridgeKind =
  | 'logic' // threshold detector VIL/VIH (non-Schmitt)
  | 'schmitt' // VT+/VT− hysteresis
  | 'pushpull' // Thevenin output stage, VOH/VOL from the supply pins
  | 'tristate' // push-pull with high-Z
  | 'thres555' // comparator: 1 while V(THRES) > V(CONT)
  | 'trig555' // comparator: 1 while V(TRIG) < V(CONT)/2
  | 'reset555' // 1 while V(RESET) < V(GND) + reset threshold
  | 'out555' // Darlington high side + sink low side
  | 'disch555' // open-collector discharge transistor
  | 'none';

export interface IcPin {
  number: number;
  name: string;
  role: IcPinRole;
  bridge: BridgeKind;
  /** Gate/section index (1-based) for "unused section" lint; 0 = shared pin. */
  section: number;
}

/** A component of the internal digital netlist. Pin targets: 'pin:<NAME>' (an IC pin's net) or 'int:<name>'. */
export interface InternalComponent {
  local: string;
  type: string;
  params: PartParams;
  pins: Record<string, string>;
}

export interface IcBuildContext {
  /** Supply voltage the IC is powered at (V). */
  vs: number;
  corner: Corner;
}

export interface IcDef {
  id: string;
  kind: 'logic' | 'timer';
  family: FamilyName | 'NE555';
  summary: string;
  pins: IcPin[];
  /** Internal digital behavior at a supply voltage. */
  build(ctx: IcBuildContext): InternalComponent[];
  /** Output conductance ramp duration (s) at vs. */
  ramp(vs: number): number;
}

const pin = (name: string): string => `pin:${name}`;
const int = (name: string): string => `int:${name}`;

/**
 * Intrinsic delay: the datasheet tpd is measured with CL = 50 pF on the output, which the
 * analog side charges through Rout. Subtract that RC (ln 2 · Rout · CL, to the 50 % point)
 * and half the output ramp so that a 50 pF bench load reproduces the datasheet tpd.
 */
function intrinsic(tpd: number, rOut: number, ramp: number): number {
  return Math.max(tpd - Math.LN2 * rOut * TPD_TEST_LOAD - ramp / 2, 0.25 * tpd);
}

function roles(part: LogicPart | TimerPart, assign: (p: PinDef) => Omit<IcPin, 'number' | 'name'>): IcPin[] {
  return part.pins.map(p => ({ number: p.number, name: p.name, ...assign(p) }));
}

const SUPPLY_NAMES: Record<string, IcPinRole> = { VCC: 'vcc', VDD: 'vcc', GND: 'gnd', VSS: 'gnd' };

function logicPart(id: string): LogicPart {
  const p = findPart(id);
  if (!p || p.category !== 'logic') throw new Error(`catalog has no logic part ${id}`);
  return p;
}

/** Gate-array ICs: N identical sections '<k>A'… → '<k>Y'. */
function gateArray(
  id: string,
  summary: string,
  type: 'Nand' | 'Not',
  path: string,
  schmitt: boolean,
  sections: { inputs: string[]; output: string }[],
): IcDef {
  const part = logicPart(id);
  const fam = logicFamilyModel(id);
  const sectionOf = new Map<string, number>();
  sections.forEach((s, i) => {
    for (const n of [...s.inputs, s.output]) sectionOf.set(n, i + 1);
  });
  const outputs = new Set(sections.map(s => s.output));
  const ramp = (vs: number) => RAMP(fam.tpd(path, vs, 'typ'));
  return {
    id,
    kind: 'logic',
    family: fam.family,
    summary,
    pins: roles(part, p => {
      const supply = SUPPLY_NAMES[p.name];
      if (supply) return { role: supply, bridge: 'none', section: 0 };
      const out = outputs.has(p.name);
      return { role: out ? 'out' : 'in', bridge: out ? 'pushpull' : schmitt ? 'schmitt' : 'logic', section: sectionOf.get(p.name) ?? 0 };
    }),
    build({ vs, corner }) {
      const delay = intrinsic(fam.tpd(path, vs, corner), fam.rOutHigh(vs, corner), ramp(vs));
      return sections.map((s, i): InternalComponent => ({
        local: `g${i + 1}`,
        type,
        params: type === 'Not' ? { delay } : { inputs: s.inputs.length, delay },
        pins: Object.fromEntries([
          ...s.inputs.map((n, k) => [String.fromCharCode(97 + k), pin(n)]),
          ['y', pin(s.output)],
        ]),
      }));
    },
    ramp,
  };
}

const RAMP = (tpdTyp: number): number => RAMP_FRACTION * tpdTyp;

const quad2 = (k: number) => ({ inputs: [`${k}A`, `${k}B`], output: `${k}Y` });
const hex1 = (k: number) => ({ inputs: [`${k}A`], output: `${k}Y` });

function hc74(): IcDef {
  const id = '74HC74';
  const part = logicPart(id);
  const fam = logicFamilyModel(id);
  const path = 'CLK->Q/~Q';
  const ramp = (vs: number) => RAMP(fam.tpd(path, vs, 'typ'));
  return {
    id,
    kind: 'logic',
    family: 'HC',
    summary: 'dual D flip-flop, rising edge, async active-low preset/clear',
    pins: roles(part, p => {
      const supply = SUPPLY_NAMES[p.name];
      if (supply) return { role: supply, bridge: 'none', section: 0 };
      const section = Number(p.name.replace('~', '')[0]);
      const out = /^~?\dQ$/.test(p.name);
      return { role: out ? 'out' : 'in', bridge: out ? 'pushpull' : 'logic', section };
    }),
    build({ vs, corner }) {
      const delay = intrinsic(fam.tpd(path, vs, corner), fam.rOutHigh(vs, corner), ramp(vs));
      const out: InternalComponent[] = [];
      for (const k of [1, 2]) {
        out.push(
          { local: `pre${k}`, type: 'Not', params: { delay: 0 }, pins: { a: pin(`~${k}PRE`), y: int(`set${k}`) } },
          { local: `clr${k}`, type: 'Not', params: { delay: 0 }, pins: { a: pin(`~${k}CLR`), y: int(`rst${k}`) } },
          {
            local: `ff${k}`,
            type: 'DFF',
            // tsu(D) ≥ 20 ns, th = 0 at 4.5 V (SCLS094 timing requirements, catalog notes).
            params: { delay, set: true, reset: true, setup: 20e-9, hold: 0 },
            pins: { d: pin(`${k}D`), clk: pin(`${k}CLK`), set: int(`set${k}`), reset: int(`rst${k}`), q: pin(`${k}Q`), qn: pin(`~${k}Q`) },
          },
        );
      }
      return out;
    },
    ramp,
  };
}

const QS = ['QA', 'QB', 'QC', 'QD', 'QE', 'QF', 'QG', 'QH'];

function hc595(): IcDef {
  const id = '74HC595';
  const part = logicPart(id);
  const fam = logicFamilyModel(id);
  const ramp = (vs: number) => RAMP(fam.tpd('RCLK->QA..QH', vs, 'typ'));
  return {
    id,
    kind: 'logic',
    family: 'HC',
    summary: "8-bit serial-in shift register (SER, SRCLK, ~SRCLR) + storage register (RCLK) with 3-state outputs QA–QH (~OE); QH' = serial out",
    pins: roles(part, p => {
      const supply = SUPPLY_NAMES[p.name];
      if (supply) return { role: supply, bridge: 'none', section: 0 };
      if (QS.includes(p.name)) return { role: 'out', bridge: 'tristate', section: 0 };
      if (p.name === "QH'") return { role: 'out', bridge: 'pushpull', section: 0 };
      return { role: 'in', bridge: 'logic', section: 0 };
    }),
    build({ vs, corner }) {
      const r = fam.rOutHigh(vs, corner);
      const shift = intrinsic(fam.tpd("SRCLK->QH'", vs, corner), r, ramp(vs));
      const store = intrinsic(fam.tpd('RCLK->QA..QH', vs, corner), r, ramp(vs));
      // OE→Q enable time: 15 ns typ at 4.5 V (catalog notes), scaled with the RCLK tpd over the supply.
      const ten = Math.min(15e-9 * (fam.tpd('RCLK->QA..QH', vs, corner) / fam.tpd('RCLK->QA..QH', 4.5, corner)), 0.75 * store);
      const out: InternalComponent[] = [
        { local: 'nclr', type: 'Not', params: { delay: 0 }, pins: { a: pin('~SRCLR'), y: int('clr') } },
        {
          local: 'sr',
          type: 'ShiftRegister',
          params: { bits: 8, mode: 'sipo', reset: true, delay: shift },
          pins: { si: pin('SER'), clk: pin('SRCLK'), reset: int('clr'), ...Object.fromEntries(QS.map((_, i) => [`q${i}`, int(`s${i}`)])), so: pin("QH'") },
        },
      ];
      QS.forEach((q, i) => {
        out.push(
          { local: `st${i}`, type: 'DFF', params: { delay: Math.max(store - ten, 1e-12) }, pins: { d: int(`s${i}`), clk: pin('RCLK'), q: int(`l${i}`) } },
          { local: `oe${i}`, type: 'TriBuf', params: { activeLow: true, delay: ten }, pins: { a: int(`l${i}`), en: pin('~OE'), y: pin(q) } },
        );
      });
      return out;
    },
    ramp,
  };
}

function cd4017(): IcDef {
  const id = 'CD4017';
  const part = logicPart(id);
  const fam = logicFamilyModel(id);
  const ramp = (vs: number) => RAMP(fam.tpd('CLOCK->decoded out', vs, 'typ'));
  // Johnson-counter decode: Qk = AND of two stage bits (s1..s5; 'n' = complement).
  const decode: [string, string][] = [
    ['q1n', 'q5n'],
    ['q1', 'q2n'],
    ['q2', 'q3n'],
    ['q3', 'q4n'],
    ['q4', 'q5n'],
    ['q5', 'q1'],
    ['q1n', 'q2'],
    ['q2n', 'q3'],
    ['q3n', 'q4'],
    ['q4n', 'q5'],
  ];
  return {
    id,
    kind: 'logic',
    family: 'CD4000',
    summary: 'decade counter (5-stage Johnson) with 10 decoded outputs Q0–Q9, CARRY OUT, CLOCK INHIBIT, RESET',
    pins: roles(part, p => {
      const supply = SUPPLY_NAMES[p.name];
      if (supply) return { role: supply, bridge: 'none', section: 0 };
      if (/^Q\d$/.test(p.name) || p.name === 'CARRY OUT') return { role: 'out', bridge: 'pushpull', section: 0 };
      return { role: 'in', bridge: p.name === 'CLOCK' ? 'schmitt' : 'logic', section: 0 };
    }),
    build({ vs, corner }) {
      const r = fam.rOutHigh(vs, corner);
      const dec = intrinsic(fam.tpd('CLOCK->decoded out', vs, corner), r, ramp(vs));
      const co = intrinsic(fam.tpd('CLOCK->CARRY OUT', vs, corner), r, ramp(vs));
      const ff = Math.min(dec, co) / 2;
      const out: InternalComponent[] = [
        { local: 'ninh', type: 'Not', params: { delay: 0 }, pins: { a: pin('CLOCK INHIBIT'), y: int('en') } },
        { local: 'gclk', type: 'And', params: { inputs: 2, delay: 0 }, pins: { a: pin('CLOCK'), b: int('en'), y: int('ck') } },
      ];
      for (let k = 1; k <= 5; k++) {
        out.push({
          local: `s${k}`,
          type: 'DFF',
          params: { delay: ff, reset: true },
          pins: { d: int(k === 1 ? 'q5n' : `q${k - 1}`), clk: int('ck'), reset: pin('RESET'), q: int(`q${k}`), qn: int(`q${k}n`) },
        });
      }
      decode.forEach(([a, b], k) => {
        out.push({ local: `d${k}`, type: 'And', params: { inputs: 2, delay: dec - ff }, pins: { a: int(a), b: int(b), y: pin(`Q${k}`) } });
      });
      out.push({ local: 'co', type: 'Buf', params: { delay: co - ff }, pins: { a: int('q5n'), y: pin('CARRY OUT') } });
      return out;
    },
    ramp,
  };
}

function ne555(): IcDef {
  const part = findPart('NE555') as TimerPart;
  const t = ne555Model();
  const bridges: Record<string, { role: IcPinRole; bridge: BridgeKind }> = {
    GND: { role: 'gnd', bridge: 'none' },
    VCC: { role: 'vcc', bridge: 'none' },
    TRIG: { role: 'in', bridge: 'trig555' },
    THRES: { role: 'in', bridge: 'thres555' },
    RESET: { role: 'in', bridge: 'reset555' },
    OUT: { role: 'out', bridge: 'out555' },
    DISCH: { role: 'out', bridge: 'disch555' },
    CONT: { role: 'analog', bridge: 'none' },
  };
  return {
    id: 'NE555',
    kind: 'timer',
    family: 'NE555',
    summary: 'timer: comparators at CONT (2/3 VCC) and CONT/2 (1/3 VCC), SR latch, discharge transistor, totem-pole output, active-low RESET',
    pins: roles(part, p => ({ ...bridges[p.name], section: 0 })),
    build(): InternalComponent[] {
      // Latch priority (function table): RESET low → output low; else TRIG < CONT/2 → high;
      // else THRES > CONT → low; else hold.
      return [
        { local: 'c0', type: 'Const', params: { value: 0 }, pins: { y: int('lo') } },
        { local: 'ntr', type: 'Not', params: { delay: 0 }, pins: { a: pin('TRIG'), y: int('ntrg') } },
        { local: 'nrs', type: 'Not', params: { delay: 0 }, pins: { a: pin('RESET'), y: int('nrst') } },
        { local: 'gset', type: 'And', params: { inputs: 2, delay: 0 }, pins: { a: pin('TRIG'), b: int('nrst'), y: int('set') } },
        { local: 'gthr', type: 'And', params: { inputs: 2, delay: 0 }, pins: { a: pin('THRES'), b: int('ntrg'), y: int('thr') } },
        { local: 'grst', type: 'Or', params: { inputs: 2, delay: 0 }, pins: { a: pin('RESET'), b: int('thr'), y: int('rst') } },
        {
          local: 'ff',
          type: 'DFF',
          params: { delay: t.delay, set: true, reset: true },
          pins: { d: int('lo'), clk: int('lo'), set: int('set'), reset: int('rst'), q: pin('OUT'), qn: pin('DISCH') },
        },
      ];
    },
    ramp: () => t.ramp,
  };
}

let DEFS: Map<string, IcDef> | undefined;

function defs(): Map<string, IcDef> {
  if (!DEFS) {
    DEFS = new Map(
      [
        gateArray('74HC00', 'quad 2-input NAND (nY = NOT(nA·nB))', 'Nand', 'A/B->Y', false, [1, 2, 3, 4].map(quad2)),
        gateArray('74HC04', 'hex inverter (nY = NOT nA)', 'Not', 'A->Y', false, [1, 2, 3, 4, 5, 6].map(hex1)),
        gateArray('74HC14', 'hex Schmitt-trigger inverter (VT+/VT− hysteresis)', 'Not', 'A->Y', true, [1, 2, 3, 4, 5, 6].map(hex1)),
        gateArray('74HCT04', 'hex inverter, TTL-level inputs (VIH 2.0 V, VIL 0.8 V)', 'Not', 'A->Y', false, [1, 2, 3, 4, 5, 6].map(hex1)),
        gateArray('CD4011', 'quad 2-input NAND, B-series CMOS (J = NOT(A·B), K, L, M)', 'Nand', 'input->output', false, [
          { inputs: ['A', 'B'], output: 'J' },
          { inputs: ['C', 'D'], output: 'K' },
          { inputs: ['E', 'F'], output: 'L' },
          { inputs: ['G', 'H'], output: 'M' },
        ]),
        hc74(),
        hc595(),
        cd4017(),
        ne555(),
      ].map(d => [d.id, d]),
    );
  }
  return DEFS;
}

/** Ids of the ICs that can be simulated (`Part(id)`). */
export function icIds(): string[] {
  return [...defs().keys()];
}

/** Definition of a simulatable IC by catalog id or alias (case-insensitive), or undefined. */
export function findIcDef(id: string): IcDef | undefined {
  const direct = defs().get(id);
  if (direct) return direct;
  const p = findPart(id);
  return p ? defs().get(p.id) : undefined;
}

/** Normalized pin key for lenient lookups: case-insensitive, ignoring spaces, '_' and '-'. */
export function pinKey(name: string): string {
  return name.toUpperCase().replace(/[\s_-]/g, '');
}
