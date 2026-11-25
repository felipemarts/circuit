/**
 * Real catalog parts: `Part('2N3904')` returns the right device class
 * configured from the catalog's model card (src/parts), tagged with the part
 * id so the netlist records it, `buildComponent` rebuilds it and the ladder
 * checks it against the datasheet absolute maximum ratings.
 *
 * Generic devices (`new NPN({ bf: 100 })`) are simulated parts with free
 * parameters and no ratings; Part() devices are real parts.
 */
import { findPart, PARTS } from '../parts';
import type { BjtPart, DiodePart, MosfetPart, PartEntry } from '../parts/types';
import { Diode, type DiodeParams } from './Diode';
import { LED } from './LED';
import { NPN, PNP } from './BJT';
import { NMOS, PMOS, type MosfetParams } from './MOSFET';
import { BJT_PARAMS, DIODE_PARAMS, MOSFET_PARAMS, findParamDef, type ParamDef } from './semi/params';
import { unmodeledParams } from './semi/spiceModel';

export type PartDevice = Diode | LED | NPN | PNP | NMOS | PMOS;

/** How a catalog entry maps onto a simulated device. */
export interface PartModelInfo {
  /** Device type in the netlist: Diode, LED, NPN, PNP, NMOS, PMOS. */
  device: 'Diode' | 'LED' | 'NPN' | 'PNP' | 'NMOS' | 'PMOS';
  /** Constructor parameters (canonical names) taken from the card. */
  params: Record<string, number>;
  /** Body-diode parameters (MOSFETs), canonical diode names. */
  bodyDiode?: Record<string, number>;
  /** Card parameters this simulator does not model (ignored). */
  ignored: string[];
  /** Whole model card estimated (fitted from datasheet curves). */
  estimated: boolean;
  /** Individually estimated parameters (name → derivation note). */
  estimatedParams: Record<string, string>;
  /** Card derivation note. */
  note?: string;
  /** Citation id of the card. */
  source?: string;
}

/** The `new Mcu({ profile })` id of an MCU catalog entry ('ESP32-WROOM-32' → 'esp32'). */
export function mcuProfileId(id: string): string {
  return id.toLowerCase().replace(/-.*$/, '');
}

/** Why a catalog entry cannot be simulated with Part() (undefined when it can). */
export function partUnsupportedReason(entry: PartEntry): string | undefined {
  switch (entry.category) {
    case 'diode':
      return entry.model ? undefined : `${entry.id} has no model card in the catalog`;
    case 'bjt':
      if (entry.darlington) {
        return `${entry.id} is a Darlington: the catalog keeps only the driver transistor of the vendor's .SUBCKT, and a single transistor with those parameters would misrepresent the part — build it from two transistors (new NPN/PNP) and shunt resistors`;
      }
      return entry.model ? undefined : `${entry.id} has no published SPICE model in the catalog — use new ${entry.polarity}({ ... }) with your own parameters`;
    case 'mosfet':
      return entry.model ? undefined : `${entry.id} has no model card in the catalog`;
    case 'mcu':
      return `${entry.id} is a microcontroller: it runs firmware, so build it with new Mcu({ profile: '${mcuProfileId(entry.id)}', firmware: './app.fw.ts' })${entry.id === 'ATmega328P' ? ` or new ArduinoUno({ firmware })` : ''}`;
    default:
      return `${entry.id} (${entry.category}) is catalog data only — no device model is simulated yet`;
  }
}

function mapParams(defs: ParamDef[], card: Record<string, number | undefined>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(card)) {
    if (value === undefined) continue;
    const def = findParamDef(defs, key);
    if (def) out[def.name] = def.zeroIsInfinite && value === 0 ? Infinity : value;
  }
  // Infinity is the constructor default for 'not set'; drop it to keep params plain JSON.
  for (const k of Object.keys(out)) if (!Number.isFinite(out[k])) delete out[k];
  return out;
}

/** The device mapping of a simulatable catalog entry. Throws with guidance otherwise. */
export function partModelInfo(entry: PartEntry): PartModelInfo {
  const reason = partUnsupportedReason(entry);
  if (reason) throw new Error(`Part('${entry.id}'): ${reason}`);
  const base = (model: { estimated?: boolean; estimatedParams?: Partial<Record<string, string>>; note?: string; source: string }) => ({
    estimated: model.estimated === true,
    estimatedParams: Object.fromEntries(Object.entries(model.estimatedParams ?? {}).filter(([, v]) => v !== undefined)) as Record<string, string>,
    ...(model.note ? { note: model.note } : {}),
    source: model.source,
  });
  if (entry.category === 'diode') {
    const d = entry as DiodePart;
    const m = d.model!;
    return {
      device: d.kind === 'led' ? 'LED' : 'Diode',
      params: mapParams(DIODE_PARAMS, m.params),
      ignored: unmodeledParams('D', m.params),
      ...base(m),
    };
  }
  if (entry.category === 'bjt') {
    const b = entry as BjtPart;
    const m = b.model!;
    return {
      device: b.polarity,
      params: mapParams(BJT_PARAMS, m.params),
      ignored: unmodeledParams(b.polarity, m.params),
      ...base(m),
    };
  }
  const f = entry as MosfetPart;
  const m = f.model!;
  const type = f.channel === 'N' ? 'NMOS' : 'PMOS';
  if (m.level !== undefined && m.level !== 1) throw new Error(`Part('${entry.id}'): model card LEVEL=${m.level} is not supported`);
  const info: PartModelInfo = {
    device: type,
    params: mapParams(MOSFET_PARAMS, m.params),
    ignored: unmodeledParams(type, m.params),
    ...base(m),
  };
  if (f.bodyDiode) {
    info.bodyDiode = mapParams(DIODE_PARAMS, f.bodyDiode.params);
    const ignored = unmodeledParams('D', f.bodyDiode.params);
    if (ignored.length > 0) info.ignored.push(...ignored.map(k => `bodyDiode.${k}`));
  }
  return info;
}

/** Catalog categories this resolver simulates. */
const SEMI_CATEGORIES = new Set<string>(['diode', 'bjt', 'mosfet']);

/**
 * Semiconductor resolver of the unified `Part()` (src/elab/part.ts): a real
 * catalog diode / LED / BJT / MOSFET as a simulated device — `Part('2N3904')`,
 * `Part('1N4148')`, `Part('IRLZ44N')`, `Part('LED-RED-5MM')`… (case-insensitive,
 * aliases work). Its netlist params carry `part: '<id>'`; the ladder checks it
 * against the datasheet absolute maximum ratings after op, dc and tran
 * (R401–R404).
 *
 * Returns undefined for ids that are not catalog semiconductors (so the next
 * resolver can try them); throws with guidance for a catalog semiconductor
 * that cannot be simulated (no model card, Darlington…).
 */
export function semiPart(id: string): PartDevice | undefined {
  if (typeof id !== 'string') return undefined;
  const entry = findPart(id);
  if (!entry || !SEMI_CATEGORIES.has(entry.category)) return undefined;
  const info = partModelInfo(entry);
  let dev: PartDevice;
  switch (info.device) {
    case 'Diode':
      dev = new Diode(info.params as DiodeParams);
      break;
    case 'LED':
      dev = new LED(info.params as DiodeParams);
      break;
    case 'NPN':
      dev = new NPN(info.params);
      break;
    case 'PNP':
      dev = new PNP(info.params);
      break;
    case 'NMOS':
    case 'PMOS': {
      const params: MosfetParams = { ...info.params, ...(info.bodyDiode ? { bodyDiode: info.bodyDiode as DiodeParams } : {}) };
      dev = info.device === 'NMOS' ? new NMOS(params) : new PMOS(params);
      break;
    }
  }
  dev.partId = entry.id;
  return dev;
}

/** Ids `semiPart` simulates (canonical catalog ids; aliases work too). */
export function semiPartIds(): string[] {
  return PARTS.filter(p => SEMI_CATEGORIES.has(p.category) && !partUnsupportedReason(p)).map(p => p.id);
}
