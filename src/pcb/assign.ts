/**
 * Footprint assignment: which land pattern a netlist component gets by
 * default, and which pad(s) each of its pins lands on.
 *
 *  - Real catalog parts keep their datasheet package and pin numbers
 *    (Part('2N3904') → TO-92 with E/B/C on pads 1/2/3; Part('74HC04') → DIP-14).
 *    ICs, op-amps and timers follow the board technology (DIP-n ↔ SOIC-n share
 *    the numbering); discrete transistors keep their package because the SMD
 *    versions of a part use another pinout.
 *  - Generic parts (new Resistor, new NPN…) get the board's technology default
 *    and a conventional pinout (documented in docs/PCB.md).
 *  - Abstract parts (logic primitives, VHDL blocks, defineComponent parts)
 *    have no physical form: P803 unless a footprint and pad map are given.
 */
import { findPart } from '../parts';
import type { PartEntry } from '../parts/types';
import { getMcuProfile } from '../mcu/profiles';
import type { NetlistComponent } from '../schema/types';
import type { FootprintDef, PcbTech } from './types';

const norm = (s: string): string => s.toUpperCase().replace(/[\s_]/g, '');

/** Library footprint for a catalog package name. */
export function packageFootprint(pkg: string): string | undefined {
  if (/^DIP-\d+$/.test(pkg)) return pkg;
  return ({ 'DO-35': 'DO-35', 'DO-41': 'DO-41', 'T-1 3/4 (5 mm)': 'LED-5MM', 'TO-92': 'TO-92', 'TO-220AB': 'TO-220', 'TO-225': 'TO-126', 'SOT-23': 'SOT-23' } as Record<string, string>)[pkg];
}

const SEMIS = ['Diode', 'LED', 'NPN', 'PNP', 'NMOS', 'PMOS'];
const AMPS = ['OpAmp', 'Comparator', 'IdealOpAmp'];

function partOf(c: NetlistComponent): PartEntry | undefined {
  if (typeof c.params.part === 'string') return findPart(c.params.part);
  if (c.type === 'Mcu' && typeof c.params.profile === 'string') {
    try {
      return findPart(getMcuProfile(c.params.profile).part);
    } catch {
      return undefined;
    }
  }
  if (c.type === 'ArduinoUno') return undefined;
  const p = findPart(c.type);
  return p && (p.category === 'logic' || p.category === 'timer') ? p : undefined;
}

/** Same pin numbering in the other technology (DIP-8 ↔ SOIC-8). */
function icFootprint(pkg: string, tech: PcbTech): string | undefined {
  const m = pkg.match(/^DIP-(\d+)$/);
  if (!m) return packageFootprint(pkg);
  return tech === 'smd' && Number(m[1]) <= 16 ? `SOIC-${m[1]}` : pkg; // narrow SOIC stops at 16 pins
}

export interface FootprintChoice {
  /** Library footprint name, or undefined when the part has no physical form here. */
  name?: string;
  /** Why (for P803 and documentation). */
  reason: string;
}

/** The footprint a component gets when tb.place does not name one. */
export function defaultFootprint(c: NetlistComponent, tech: PcbTech): FootprintChoice {
  const part = partOf(c);
  const smd = tech === 'smd';
  if (part) {
    if (SEMIS.includes(c.type)) {
      const name = packageFootprint(part.package.name);
      return name ? { name, reason: `${part.id} catalog package ${part.package.name}` } : { reason: `${part.id}'s package ${part.package.name} has no library footprint` };
    }
    const name = icFootprint(part.package.name, tech);
    return name ? { name, reason: `${part.id} catalog package ${part.package.name}${name !== part.package.name ? ` (as ${name}: board tech '${tech}')` : ''}` } : { reason: `${part.id}'s package ${part.package.name} has no library footprint yet` };
  }
  const v = (k: string) => (typeof c.params[k] === 'number' ? (c.params[k] as number) : 0);
  switch (c.type) {
    case 'Resistor':
      return { name: smd ? '0805' : 'AXIAL-0.4', reason: `generic resistor, board tech '${tech}'` };
    case 'Capacitor':
      return smd
        ? { name: v('c') > 10e-6 ? '1206' : '0805', reason: `generic capacitor, board tech '${tech}'` }
        : { name: v('c') >= 1e-6 ? 'RADIAL-5MM' : 'DISC-5MM', reason: `generic capacitor (${v('c') >= 1e-6 ? 'electrolytic, ≥ 1 µF' : 'ceramic, < 1 µF'}), board tech '${tech}'` };
    case 'Inductor':
      return { name: smd ? '1210' : 'AXIAL-0.4', reason: `generic inductor, board tech '${tech}'` };
    case 'Diode':
      return { name: smd ? 'SOD-123' : 'DO-35', reason: `generic diode, board tech '${tech}'` };
    case 'LED':
      return { name: smd ? 'LED-0805' : 'LED-5MM', reason: `generic LED, board tech '${tech}'` };
    case 'NPN':
    case 'PNP':
    case 'NMOS':
    case 'PMOS':
      return { name: smd ? 'SOT-23' : 'TO-92', reason: `generic transistor, board tech '${tech}'` };
    case 'OpAmp':
    case 'IdealOpAmp':
    case 'Comparator':
      return { name: smd ? 'SOIC-8' : 'DIP-8', reason: `generic ${c.type === 'Comparator' ? 'comparator' : 'op-amp'}, board tech '${tech}'` };
    case 'VoltageSource':
    case 'CurrentSource':
      return { name: 'HDR-1x2', reason: 'a source enters the board through a 2-pin connector (pad 1 = +)' };
    case 'Switch':
      return { name: 'SW-SPDT', reason: 'SPDT switch' };
    case 'Button':
      return { name: 'TACT-6MM', reason: 'push button' };
    case 'ArduinoUno':
      return { name: 'UNO-SHIELD', reason: 'the board is an Arduino Uno shield: U1 is the Uno headers' };
    case 'Mcu':
      return { reason: `the ${String(c.params.profile ?? 'atmega328p')} profile has no library footprint yet` };
    case 'VhdlBlock':
      return { reason: 'a VHDL block is logic, not a physical part: implement it with a real IC, or give it a footprint and a pad map' };
    default:
      return { reason: `${c.type} is an abstract part (logic primitive or defineComponent part) with no physical package: use a catalog Part() or give it a footprint and a pad map` };
  }
}

// Conventional pinouts of generic parts, per footprint.
const BJT_PINOUT: Record<string, Record<string, string>> = {
  'TO-92': { e: '1', b: '2', c: '3' }, // 2N3904 / 2N3906 style (EBC)
  'SOT-23': { b: '1', e: '2', c: '3' }, // MMBT3904 style
  'TO-220': { b: '1', c: '2', e: '3' }, // TIP120 style
  'TO-126': { e: '1', c: '2', b: '3' }, // BD139 style
};
const MOS_PINOUT: Record<string, Record<string, string>> = {
  'TO-92': { s: '1', g: '2', d: '3' }, // 2N7000 style
  'SOT-23': { g: '1', s: '2', d: '3' }, // AO3400 / BSS84 style
  'TO-220': { g: '1', d: '2', s: '3' }, // IRLZ44N style
};
/** Industry-standard single op-amp (LM741 / NE5534 / OPA… DIP-8, SOIC-8). */
const OPAMP_SINGLE = { inn: '2', inp: '3', 'v-': '4', out: '6', 'v+': '7' };
/** Dual comparator, channel 1 (LM393 / LM2903). */
const COMPARATOR_DUAL = { out: '1', inn: '2', inp: '3', 'v-': '4', 'v+': '8' };
/** Single comparator with an emitter pin (LM311). */
const COMPARATOR_311 = { emit: '1', inp: '2', inn: '3', 'v-': '4', out: '7', 'v+': '8' };

/** Channel-1 role of a catalog op-amp / comparator pin name. */
function amplifierRole(name: string): string | undefined {
  const n = norm(name);
  if (/^(OUT|OUTPUT|OUT1|1OUT|VOUTA|COLOUT)$/.test(n)) return 'out';
  if (n === 'EMITOUT') return 'emit';
  if (/^(IN-|IN1-|1IN-|VINA-)$/.test(n)) return 'inn';
  if (/^(IN\+|IN1\+|1IN\+|VINA\+)$/.test(n)) return 'inp';
  if (/^(V-|VCC-|VSS|GND|VEE)$/.test(n)) return 'v-';
  if (/^(V\+|VCC\+|VDD|VCC)$/.test(n)) return 'v+';
  return undefined;
}

const one = (m: Record<string, string>): Record<string, string[]> => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, [v]]));

/** Catalog pin numbers of every catalog pin whose (normalized) name is one of `names`. */
function numbersOf(part: PartEntry, names: string[]): string[] {
  const want = new Set(names.map(norm));
  return part.pins.filter(p => want.has(norm(p.name))).map(p => String(p.number));
}

/** Default pin → pads of a component on a footprint (before explicit overrides). */
function basePinMap(c: NetlistComponent, fp: FootprintDef): Record<string, string[]> {
  const pins = Object.keys(c.pins);
  const pads = new Set(fp.pads.map(p => p.name));
  const part = partOf(c);
  let map: Record<string, string[]> = {};
  switch (c.type) {
    case 'Diode':
    case 'LED':
      if (pads.has('A') && pads.has('K')) map = { anode: ['A'], cathode: ['K'] };
      else if (part) map = { anode: numbersOf(part, ['anode']), cathode: numbersOf(part, ['cathode']) };
      else map = { anode: ['2'], cathode: ['1'] }; // KiCad convention: pad 1 = cathode
      break;
    case 'NPN':
    case 'PNP':
    case 'NMOS':
    case 'PMOS': {
      const ownPackage = part ? packageFootprint(part.package.name) === fp.name : false;
      if (part && ownPackage) for (const p of pins) map[p] = numbersOf(part, [p]);
      else map = one((c.type === 'NPN' || c.type === 'PNP' ? BJT_PINOUT : MOS_PINOUT)[fp.name] ?? {});
      // A discrete MOSFET's body is tied to its source inside the package.
      if (pins.includes('b') && map.s) map.b = [...map.s];
      break;
    }
    case 'OpAmp':
    case 'IdealOpAmp':
    case 'Comparator':
      if (part) {
        for (const pin of part.pins) {
          const role = amplifierRole(pin.name);
          if (role && pins.includes(role) && !map[role]) map[role] = [String(pin.number)];
        }
      } else {
        map = one(c.type === 'Comparator' ? (pins.includes('emit') ? COMPARATOR_311 : COMPARATOR_DUAL) : OPAMP_SINGLE);
      }
      break;
    case 'Mcu':
      if (part && typeof c.params.profile === 'string') {
        const profile = getMcuProfile(c.params.profile);
        for (const p of pins) {
          const spec = profile.pins.find(s => s.name === p);
          const names = p === 'VCC' ? ['VCC', 'AVCC'] : spec?.port ? [spec.port] : [p];
          map[p] = numbersOf(part, names);
        }
      }
      break;
    case 'VoltageSource':
    case 'CurrentSource':
      map = { '+': ['1'], '-': ['2'] };
      break;
    case 'Switch':
      map = { a: ['1'], com: ['2'], b: ['3'] };
      break;
    default:
      if (part) for (const p of pins) map[p] = numbersOf(part, [p]);
  }
  // Anything still unmapped lands on the pad with its own name, if there is one.
  for (const p of pins) {
    if (map[p] && map[p].length > 0) continue;
    const same = fp.pads.find(x => norm(x.name) === norm(p));
    map[p] = same ? [same.name] : [];
  }
  const out: Record<string, string[]> = {};
  for (const p of pins) {
    const list = [...new Set((map[p] ?? []).filter(n => pads.has(n)))];
    if (list.length > 0) out[p] = list;
  }
  return out;
}

export interface PinMapResult {
  /** pin → pad names (pins without a pad are absent). */
  map: Record<string, string[]>;
  /** Problems with the explicit `pads` overrides. */
  errors: { pin?: string; pad?: string; message: string }[];
}

/** Pin → pads of a component on a footprint, with tb.place({ pads }) overrides applied. */
export function pinMap(c: NetlistComponent, fp: FootprintDef, explicit?: Record<string, string | string[]>): PinMapResult {
  const map = basePinMap(c, fp);
  const errors: PinMapResult['errors'] = [];
  const pads = new Set(fp.pads.map(p => p.name));
  for (const [pin, value] of Object.entries(explicit ?? {})) {
    if (!(pin in c.pins)) {
      errors.push({ pin, message: `pads maps pin '${pin}', which ${c.type} ${c.id} does not have (pins: ${Object.keys(c.pins).join(', ')})` });
      continue;
    }
    const list = Array.isArray(value) ? value : [value];
    const bad = list.filter(n => !pads.has(n));
    if (bad.length > 0) {
      errors.push({ pin, pad: bad[0], message: `pads maps ${c.id}.${pin} to pad${bad.length > 1 ? 's' : ''} ${bad.map(b => `'${b}'`).join(', ')}, which footprint ${fp.name} does not have (pads: ${[...pads].join(', ')})` });
      continue;
    }
    if (list.length === 0) delete map[pin];
    else map[pin] = [...new Set(list)];
  }
  return { map, errors };
}
