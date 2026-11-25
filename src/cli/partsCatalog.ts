/**
 * `circuitsvibe catalog` for semiconductors: the generic device types with
 * their model parameters, and the real-part catalog (src/parts) with pins,
 * model card (estimated flags, ignored parameters), absolute maximum
 * ratings with units and citations — human text and JSON.
 */
import { PARTS, findPart } from '../parts';
import type { Citation, PartEntry, Spec } from '../parts/types';
import { mcuProfileId, partModelInfo, partUnsupportedReason } from '../components/Part';
import { BJT_PARAMS, DIODE_PARAMS, MOSFET_PARAMS, type ParamDef } from '../components/semi/params';
import { formatEng } from '../elab/units';
import { icPart } from '../mixed/part';
import { opampPart } from '../opamps/parts';

export interface ParamDoc {
  name: string;
  default: number | null;
  unit: string;
  description: string;
}

export function paramDocs(defs: ParamDef[]): ParamDoc[] {
  return defs.map(d => ({ name: d.name, default: Number.isFinite(d.default) ? d.default : null, unit: d.unit, description: d.description }));
}

export const SEMI_PARAMS: Record<string, ParamDoc[]> = {
  Diode: paramDocs(DIODE_PARAMS),
  LED: paramDocs(DIODE_PARAMS),
  NPN: paramDocs(BJT_PARAMS),
  PNP: paramDocs(BJT_PARAMS),
  NMOS: paramDocs(MOSFET_PARAMS),
  PMOS: paramDocs(MOSFET_PARAMS),
};

const SIM_PINS: Record<string, string> = {
  Diode: `'anode', 'cathode'`,
  LED: `'anode', 'cathode'`,
  NPN: `'c', 'b', 'e'`,
  PNP: `'c', 'b', 'e'`,
  NMOS: `'d', 'g', 's'`,
  PMOS: `'d', 'g', 's'`,
};

function cite(entry: PartEntry, sourceId?: string): string {
  const c: Citation | undefined = (sourceId ? entry.sources.find(s => s.id === sourceId) : undefined) ?? entry.sources[0];
  return c ? [c.publisher, c.document ?? c.title, c.revision].filter(Boolean).join(', ') : entry.manufacturer;
}

export interface PartSummary {
  id: string;
  category: string;
  description: string;
  /** How to instantiate it, or null when it cannot be simulated. */
  construct: string | null;
  /** Simulated device type (Diode/LED/NPN/PNP/NMOS/PMOS, OpAmp/Comparator), 'IC' for a logic IC / NE555 (mixed-signal), 'Mcu' for a microcontroller, null when data only. */
  device: string | null;
  modelEstimated: boolean | null;
  reason?: string;
}

export function partSummaries(): PartSummary[] {
  return PARTS.map(p => {
    // Logic ICs / NE555 are simulated by the mixed-signal family of Part() (src/mixed).
    if (icPart(p.id)) return { id: p.id, category: p.category, description: p.description, construct: `Part('${p.id}')`, device: 'IC', modelEstimated: null };
    // Op-amps / comparators: behavioural macro model fitted to the datasheet (src/opamps).
    const amp = opampPart(p.id) as { kind?: string } | undefined;
    if (amp) return { id: p.id, category: p.category, description: p.description, construct: `Part('${p.id}')`, device: amp.kind ?? 'OpAmp', modelEstimated: true };
    // Microcontrollers run TypeScript firmware in the transient (src/mcu); constructed with new Mcu, not Part().
    if (p.category === 'mcu') return { id: p.id, category: p.category, description: p.description, construct: `new Mcu({ profile: '${mcuProfileId(p.id)}', firmware })`, device: 'Mcu', modelEstimated: null };
    const reason = partUnsupportedReason(p);
    if (reason) return { id: p.id, category: p.category, description: p.description, construct: null, device: null, modelEstimated: null, reason };
    const info = partModelInfo(p);
    return { id: p.id, category: p.category, description: p.description, construct: `Part('${p.id}')`, device: info.device, modelEstimated: info.estimated };
  });
}

export interface RatingDoc {
  name: string;
  max: number;
  unit: string;
  conditions?: Record<string, number | string>;
  note?: string;
  estimated?: boolean;
  source: string;
}

function ratingDocs(entry: PartEntry): RatingDoc[] {
  const out: RatingDoc[] = [];
  for (const [name, spec] of Object.entries(entry.ratings as Record<string, Spec | undefined>)) {
    if (!spec || spec.max === undefined) continue;
    out.push({
      name,
      max: spec.max,
      unit: spec.unit,
      ...(spec.conditions ? { conditions: { ...spec.conditions } } : {}),
      ...(spec.note ? { note: spec.note } : {}),
      ...(spec.estimated ? { estimated: true } : {}),
      source: cite(entry, spec.source),
    });
  }
  return out;
}

/** Which datasheet ratings the ladder checks for this kind of part. */
function checkedRatings(entry: PartEntry): string {
  switch (entry.category) {
    case 'diode':
      return 'VR/VRRM (R401), IF/IFAV (R402), IFP/IFSM (R403, tran), Pd (R404)';
    case 'bjt':
      return 'Vceo, Vcbo, Vebo (R401), IcMax, IbMax (R402), IcPeak (R403, tran), Pd (R404)';
    case 'mosfet':
      return 'Vds, ±Vgs (R401), Id25 (R402), IdPulsed (R403, tran), Pd (R404)';
    default:
      return 'none (no device model)';
  }
}

export interface PartDetail {
  id: string;
  aliases: string[];
  category: string;
  description: string;
  manufacturer: string;
  package: string;
  /** Datasheet pinout (number → name). */
  pinout: { number: number; name: string; function?: string }[];
  construct: string | null;
  reason?: string;
  /** Simulator pin names. */
  pins: string | null;
  model: null | {
    device: string;
    params: Record<string, number>;
    bodyDiode?: Record<string, number>;
    estimated: boolean;
    estimatedParams: Record<string, string>;
    ignored: string[];
    note?: string;
    source: string;
  };
  ratings: RatingDoc[];
  ratingsChecked: string;
  characteristics: { name: string; min?: number; typ?: number; max?: number; unit: string; conditions?: Record<string, number | string>; estimated?: boolean }[];
  sources: { publisher: string; title: string; document?: string; revision?: string; url: string }[];
  notes: string[];
}

export function partDetail(id: string): PartDetail | undefined {
  const entry = findPart(id);
  if (!entry) return undefined;
  const reason = partUnsupportedReason(entry);
  const info = reason ? null : partModelInfo(entry);
  const characteristics: PartDetail['characteristics'] = [];
  const chars = (entry as { characteristics?: Record<string, Spec | Spec[] | undefined> }).characteristics ?? {};
  if (entry.category === 'diode' || entry.category === 'bjt' || entry.category === 'mosfet') {
    for (const [name, value] of Object.entries(chars)) {
      for (const s of value === undefined ? [] : Array.isArray(value) ? value : [value]) {
        if (typeof s !== 'object' || s === null || !('unit' in s)) continue;
        characteristics.push({
          name,
          ...(s.min !== undefined ? { min: s.min } : {}),
          ...(s.typ !== undefined ? { typ: s.typ } : {}),
          ...(s.max !== undefined ? { max: s.max } : {}),
          unit: s.unit,
          ...(s.conditions ? { conditions: { ...s.conditions } } : {}),
          ...(s.estimated ? { estimated: true } : {}),
        });
      }
    }
  }
  return {
    id: entry.id,
    aliases: entry.aliases ?? [],
    category: entry.category,
    description: entry.description,
    manufacturer: entry.manufacturer,
    package: entry.package.name,
    pinout: entry.pins.map(p => ({ number: p.number, name: p.name, ...(p.function ? { function: p.function } : {}) })),
    construct: reason ? null : `Part('${entry.id}')`,
    ...(reason ? { reason } : {}),
    pins: info ? SIM_PINS[info.device] : null,
    model: info
      ? {
          device: info.device,
          params: info.params,
          ...(info.bodyDiode ? { bodyDiode: info.bodyDiode } : {}),
          estimated: info.estimated,
          estimatedParams: info.estimatedParams,
          ignored: info.ignored,
          ...(info.note ? { note: info.note } : {}),
          source: cite(entry, info.source),
        }
      : null,
    ratings: ratingDocs(entry),
    ratingsChecked: checkedRatings(entry),
    characteristics,
    sources: entry.sources.map(s => ({ publisher: s.publisher, title: s.title, ...(s.document ? { document: s.document } : {}), ...(s.revision ? { revision: s.revision } : {}), url: s.url })),
    notes: entry.notes ?? [],
  };
}

const conds = (c?: Record<string, number | string>) =>
  c ? ` @ ${Object.entries(c).map(([k, v]) => `${k}=${typeof v === 'number' ? formatEng(v) : v}`).join(', ')}` : '';

const u = (unit: string) => (unit === '1' ? '' : unit);

export function renderPartDetail(d: PartDetail): string {
  const L: string[] = [];
  L.push(`${d.id}${d.aliases.length ? ` (aliases: ${d.aliases.join(', ')})` : ''} — ${d.description}`);
  L.push(`  category: ${d.category} · ${d.manufacturer} · package ${d.package}`);
  L.push(`  pinout:   ${d.pinout.map(p => `${p.number}=${p.name}`).join(' ')}`);
  if (d.construct) {
    L.push(`  use:      tb.add('X1', ${d.construct})   pins ${d.pins} (device type ${d.model!.device})`);
  } else {
    L.push(`  use:      not simulatable — ${d.reason}`);
  }
  if (d.model) {
    const m = d.model;
    L.push(`  model:    ${m.estimated ? 'ESTIMATED (fitted from datasheet curves)' : 'published card'} — ${m.source}`);
    L.push(`            ${Object.entries(m.params).map(([k, v]) => `${k}=${formatEng(v)}${m.estimatedParams[k] ? '*' : ''}`).join(' ')}`);
    if (m.bodyDiode) L.push(`  body diode: ${Object.entries(m.bodyDiode).map(([k, v]) => `${k}=${formatEng(v)}`).join(' ')}`);
    const est = Object.keys(m.estimatedParams);
    if (est.length > 0) L.push(`            * estimated: ${est.map(k => `${k} (${m.estimatedParams[k]})`).join('; ')}`);
    if (m.ignored.length > 0) L.push(`            not modeled (ignored): ${m.ignored.join(', ')}`);
    if (m.note) L.push(`            note: ${m.note}`);
  }
  L.push(`  absolute maximum ratings (checked: ${d.ratingsChecked}):`);
  for (const r of d.ratings) {
    L.push(`    ${r.name.padEnd(9)} ${formatEng(r.max, r.unit)}${conds(r.conditions)}${r.estimated ? ' (estimated)' : ''}${r.note ? ` — ${r.note}` : ''}  [${r.source}]`);
  }
  if (d.characteristics.length > 0) {
    L.push(`  characteristics (datasheet, for comparison):`);
    for (const c of d.characteristics) {
      const vals = [c.min !== undefined ? `min ${formatEng(c.min, u(c.unit))}` : '', c.typ !== undefined ? `typ ${formatEng(c.typ, u(c.unit))}` : '', c.max !== undefined ? `max ${formatEng(c.max, u(c.unit))}` : '']
        .filter(Boolean)
        .join(' ');
      L.push(`    ${c.name.padEnd(9)} ${vals}${conds(c.conditions)}${c.estimated ? ' (estimated)' : ''}`);
    }
  }
  L.push(`  sources:`);
  for (const s of d.sources) L.push(`    ${s.publisher}, ${s.document ?? s.title}${s.revision ? `, ${s.revision}` : ''} — ${s.url}`);
  for (const n of d.notes) L.push(`  note: ${n}`);
  return L.join('\n');
}

export function renderPartList(list: PartSummary[]): string {
  const L: string[] = ['REAL PARTS (src/parts catalog; one Part(id) for all — semiconductors and op-amps: datasheet ratings checked automatically; logic ICs: datasheet levels, drive and timing, co-simulated — circuitsvibe catalog <id> for details)'];
  for (const p of list) {
    const use = p.device === 'OpAmp' || p.device === 'Comparator' ? `${p.construct!.padEnd(22)} ${p.device}, macro model from the datasheet (ratings R420–R425 at op)` : p.device === 'IC' ? `${p.construct!.padEnd(22)} IC, mixed-signal (datasheet pins, levels, drive, timing)` : p.construct ? `${p.construct.padEnd(22)} ${p.device}${p.modelEstimated ? ', model ESTIMATED' : ', published model'}` : p.category === 'diode' || p.category === 'bjt' || p.category === 'mosfet' ? `(data only) ${p.reason?.split(':')[0].split(' — ')[0] ?? ''}` : '(data only — no device model yet)';
    L.push(`  ${p.id.padEnd(15)} ${p.category.padEnd(10)} ${use}`);
  }
  return L.join('\n');
}
