/**
 * `circuitsvibe catalog` entries of the amplifier family: the three model types
 * and every real op-amp / comparator part, with the parameters derived from
 * the datasheet data, the assumptions made, and the citation.
 */
import { findPart } from '../parts';
import type { ComparatorPart, OpAmpPart } from '../parts/types';
import { formatEng } from '../elab/units';
import { OPAMP_DEFAULTS } from './OpAmp';
import { COMPARATOR_DEFAULTS } from './Comparator';
import { AMPLIFIER_PART_IDS, PACKAGE_PINS, deriveComparator, deriveOpAmp } from './parts';

export interface AmplifierCatalogEntry {
  type: string;
  example: string;
  pins: string;
  value: string;
  dc: string;
  /** Model parameters (plain JSON) — real parts only. */
  params?: Record<string, number | string | boolean>;
  /** How each parameter was obtained from the data, and the assumptions. */
  notes?: string[];
  /** Primary datasheet citation. */
  source?: string;
}

const fmt = (o: object) =>
  Object.entries(o)
    .map(([k, v]) => `${k}: ${typeof v === 'number' ? Number(v.toPrecision(4)) : v}`)
    .join(', ');

const MODEL_ENTRIES: AmplifierCatalogEntry[] = [
  {
    type: 'IdealOpAmp',
    example: `tb.add('U1', new IdealOpAmp())  |  new IdealOpAmp({ gain: 1e5 })`,
    pins: `'inp' (+ input), 'inn' (− input), 'out', optional 'v+', 'v-'`,
    value: `{ gain } open-loop gain V/V (default 1e6): V(out) = gain·(V(inp) − V(inn)); with BOTH supply pins wired the output is smoothly clamped to [V(v-), V(v+)]`,
    dc: `output = ideal voltage source to ground (F123 if shorted/paralleled); inputs draw no current (each needs a DC path, F121); probes: U1.v = V(out), U1.i = output current (positive = sourcing); op/dc/ac/tran`,
  },
  {
    type: 'OpAmp',
    example: `tb.add('U1', new OpAmp({ aol: 1e5, gbw: '1M', sr: '1M' }))  |  tb.add('U1', Part('LM358'))`,
    pins: `'inp', 'inn', 'out', 'v+', 'v-' (supply pins REQUIRED, F120)`,
    value: `macro model { aol, gbw (Hz), sr (V/s), fp2 (Hz, 0 = none), vos, ib, ios, swingHigh (≤ 0, rel. V+), swingLow (≥ 0, rel. V−), rout, iscSource, iscSink, iq } — defaults ${fmt(OPAMP_DEFAULTS)}`,
    dc: `dominant pole gbw/aol, slew limit sr, output window [V− + swingLow, V+ + swingHigh] minus rout·Iout, smooth short-circuit current limit, quiescent iq from v+ to v-; AC: small signal around the op point (a saturated output has ~0 gain); probes U1.v = V(out), U1.i = output current (positive = sourcing)`,
  },
  {
    type: 'Comparator',
    example: `tb.add('U1', new Comparator())  |  tb.add('U1', Part('LM393'))  — add a pull-up resistor on 'out'`,
    pins: `'inp', 'inn', 'out' (open collector), 'v+', 'v-' (+ 'emit' with { emitterPin: true }, e.g. LM311)`,
    value: `{ avd, vos, ib, ios, tpdHL, tpdLH, overdrive, tpdFast, vol, iol, isink, gleak, iq, emitterPin } — defaults ${fmt(COMPARATOR_DEFAULTS)}`,
    dc: `output sinks current (low) when V(inp) < V(inn) + vos, otherwise off (pull-up sets the high level, F124 without one); delay tpd at 'overdrive', shorter with more overdrive when tpdFast is given; hysteresis only from external resistors; U1.i = current out of 'out' (negative while sinking)`,
  },
];

function partEntry(id: string): AmplifierCatalogEntry {
  const entry = findPart(id) as OpAmpPart | ComparatorPart;
  const derived = entry.category === 'opamp' ? deriveOpAmp(entry) : deriveComparator(entry);
  const notes = derived.notes;
  const params = derived.params as Record<string, number | string | boolean>;
  const pins = Object.entries(PACKAGE_PINS[id])
    .map(([name, n]) => `'${name}' (pin ${n})`)
    .join(', ');
  const ds = entry.sources[0];
  const r = entry.ratings;
  const ratings = [
    r.supplyMax?.max !== undefined ? `supply ≤ ${formatEng(r.supplyMax.max, 'V')}` : null,
    r.differentialInputMax?.max !== undefined ? `|vd| ≤ ${formatEng(r.differentialInputMax.max, 'V')}` : null,
  ]
    .filter(Boolean)
    .join(', ');
  const c = entry.characteristics;
  const key =
    entry.category === 'opamp'
      ? `GBW ${formatEng(params.gbw as number, 'Hz')}, SR ${formatEng(params.sr as number, 'V/s')}, Aol ${formatEng(params.aol as number)}, Vos ${formatEng(params.vos as number, 'V')}, swing V+${formatEng(params.swingHigh as number, 'V')} / V−+${formatEng(params.swingLow as number, 'V')}, Isc ${formatEng(params.iscSource as number, 'A')}`
      : `tpd ${formatEng(params.tpdHL as number, 's')} (HL) / ${formatEng(params.tpdLH as number, 's')} (LH) at ${formatEng(params.overdrive as number, 'V')} overdrive, VOL ${formatEng(params.vol as number, 'V')} at ${formatEng(params.iol as number, 'A')}`;
  return {
    type: id,
    example: `tb.add('U1', Part('${id}'))`,
    pins: `${pins} — ONE ${entry.category === 'opamp' ? 'amplifier' : 'comparator'}${entry.channels > 1 ? ` of the ${entry.channels}-channel ${entry.package.name}` : ` (${entry.package.name})`}; add one Part() per channel`,
    value: `${entry.category === 'opamp' ? 'OpAmp' : 'Comparator'} macro model of the ${entry.description}: ${key}`,
    dc: `supply ${c.supply.single?.min ?? '?'}–${c.supply.single?.max ?? '?'} V total; ratings checked at the op point (R420–R425): ${ratings || 'see catalog data'}`,
    params,
    notes,
    source: `${ds.publisher} ${ds.document ?? ''} ${ds.revision ?? ''} — ${ds.url}`.replace(/\s+/g, ' ').trim(),
  };
}

export const AMPLIFIER_CATALOG: AmplifierCatalogEntry[] = [...MODEL_ENTRIES, ...AMPLIFIER_PART_IDS.map(partEntry)];
