/**
 * Real op-amp and comparator parts: macro-model parameters derived from the
 * datasheet data in src/parts/data/amplifiers.ts.
 *
 *   Part('LM358')   → one amplifier of the dual package, pins inp/inn/out/v+/v-
 *   Part('LM393')   → one comparator of the dual package
 *
 * Every parameter is computed here from a cited catalog value; where the data
 * has no number, the model uses a stated assumption (listed in `notes`, shown
 * by `circuitsvibe catalog`). Dual parts are single-channel devices: add one
 * Part() per channel you use (each draws its own per-channel quiescent current).
 */
import type { Component } from '../core/Component';
import { findPart } from '../parts';
import type { ComparatorPart, OpAmpPart, Spec } from '../parts/types';
import { OpAmp, OPAMP_DEFAULTS, type OpAmpParams } from './OpAmp';
import { Comparator, type ComparatorParams } from './Comparator';

export const OPAMP_PART_IDS = ['LM358', 'LM741', 'TL072', 'MCP6002', 'NE5532'] as const;
export const COMPARATOR_PART_IDS = ['LM393', 'LM311'] as const;
export const AMPLIFIER_PART_IDS = [...OPAMP_PART_IDS, ...COMPARATOR_PART_IDS] as const;

/** Model pin → package pin number of channel 1/A (see the catalog entry's `pins`). */
export const PACKAGE_PINS: Record<string, Record<string, number>> = {
  LM358: { out: 1, inn: 2, inp: 3, 'v-': 4, 'v+': 8 },
  LM741: { inn: 2, inp: 3, 'v-': 4, out: 6, 'v+': 7 },
  TL072: { out: 1, inn: 2, inp: 3, 'v-': 4, 'v+': 8 },
  MCP6002: { out: 1, inn: 2, inp: 3, 'v-': 4, 'v+': 8 },
  NE5532: { out: 1, inn: 2, inp: 3, 'v-': 4, 'v+': 8 },
  LM393: { out: 1, inn: 2, inp: 3, 'v-': 4, 'v+': 8 },
  LM311: { emit: 1, inp: 2, inn: 3, 'v-': 4, out: 7, 'v+': 8 },
};

/** Per-part choices the generic derivation cannot make from the data alone. */
interface OpAmpMapping {
  /** Sign of the input bias current (data stores magnitudes): −1 = flows out of the inputs (PNP). */
  ibSign: 1 | -1;
  /** Set when the sign is an assumption (the data gives a magnitude only). */
  ibAssumed?: boolean;
  /** Where the datasheet's output-swing load resistor returns: mid-supply or V−. */
  loadRef: 'mid' | 'v-';
  /** Indices into outputShortCircuitCurrent for [source, sink]; null = not in the data. */
  isc: [number, number] | null;
  /** Divide the printed supply current by this (whole-package figures). */
  iqDivide: number;
  /** Phase margin (deg) when the data has none in `phaseMargin` but implies one. */
  pmEstimate?: { deg: number; note: string };
  /** Swing assumption when the data has no output-swing spec. */
  swingAssumption?: { high: number; low: number; note: string };
}

const OPAMP_MAPPINGS: Record<(typeof OPAMP_PART_IDS)[number], OpAmpMapping> = {
  LM358: { ibSign: -1, loadRef: 'v-', isc: [1, 2], iqDivide: 1 },
  LM741: {
    ibSign: 1,
    loadRef: 'mid',
    isc: [0, 0],
    iqDivide: 1,
    pmEstimate: {
      deg: phaseMarginFromOvershoot(0.05),
      note: 'phase margin estimated from the printed 5 % unity-gain overshoot (second-order fit, ζ = 0.69)',
    },
  },
  TL072: { ibSign: 1, ibAssumed: true, loadRef: 'mid', isc: null, iqDivide: 1 },
  MCP6002: { ibSign: 1, ibAssumed: true, loadRef: 'mid', isc: [1, 1], iqDivide: 1 },
  NE5532: {
    ibSign: 1,
    loadRef: 'mid',
    isc: [0, 0],
    iqDivide: 2,
    swingAssumption: { high: -1, low: 1, note: 'output swing not in SLOS075K: the model ASSUMES 1 V headroom to each rail (no data)' },
  },
};

/** Default output resistance when the data has no two-load swing pair to fit it. */
const DEFAULT_ROUT = 50;

/** Phase margin of a second-order loop whose closed-loop step overshoots by `os` (fraction). */
export function phaseMarginFromOvershoot(os: number): number {
  const l = Math.log(os);
  const zeta = -l / Math.sqrt(Math.PI * Math.PI + l * l);
  const z2 = zeta * zeta;
  return (Math.atan((2 * zeta) / Math.sqrt(Math.sqrt(1 + 4 * z2 * z2) - 2 * z2)) * 180) / Math.PI;
}

const typ = (s: Spec | undefined): number | undefined => s?.typ ?? undefined;
const r6 = (v: number) => Number(v.toPrecision(6));

/** Numeric supply of a spec's conditions: total V+ − V− (or undefined). */
function supplyOf(c: Spec['conditions']): number | undefined {
  if (!c) return undefined;
  for (const key of ['VS', 'VDD', 'VCC']) {
    const v = c[key];
    if (typeof v === 'number') return v;
    if (typeof v === 'string') {
      const m = v.match(/^±\s*([\d.]+)\s*V$/);
      if (m) return 2 * Number(m[1]);
    }
  }
  return undefined;
}

const at25 = (s: Spec) => s.conditions?.TA === undefined || s.conditions.TA === 25;

/**
 * Output window offset (at zero load current) and output resistance from the
 * datasheet swing points. Two 25 °C points at one supply with different loads
 * fit both; a single point is reproduced exactly with the default rout.
 */
function fitSwing(
  specs: Spec[] | undefined,
  side: 'high' | 'low',
  loadRef: 'mid' | 'v-',
): { offset: number; rout?: number; note: string } | null {
  if (!specs || specs.length === 0) return null;
  const points = specs
    .filter(s => at25(s) && typeof s.conditions?.RL === 'number' && supplyOf(s.conditions) !== undefined)
    .map(s => {
      const value = s.typ ?? (side === 'high' ? s.min : s.max)!;
      const vs = supplyOf(s.conditions)!;
      const rl = s.conditions!.RL as number;
      // Output voltage relative to the load's return.
      const vOut = side === 'high' ? vs + value : value; // relative to V−
      const ref = loadRef === 'mid' ? vs / 2 : 0;
      const current = Math.abs(vOut - ref) / rl;
      return { value, vs, rl, current, which: s.typ !== undefined ? 'typ' : side === 'high' ? 'min' : 'max' };
    });
  if (points.length === 0) return null;
  const vs = points[0].vs;
  const same = points.filter(p => p.vs === vs);
  const sign = side === 'high' ? 1 : -1; // headroom grows with current: high side goes down, low side up
  if (same.length >= 2 && same[0].rl !== same[1].rl) {
    const [a, b] = same;
    const rout = Math.abs((b.value - a.value) / (b.current - a.current));
    const offset = a.value + sign * rout * a.current;
    return {
      offset,
      rout,
      note: `swing ${side}: fitted to ${a.which} ${a.value} V (RL ${a.rl} Ω) and ${b.which} ${b.value} V (RL ${b.rl} Ω) at ${vs} V → ${r6(offset)} V at no load, rout ${r6(rout)} Ω`,
    };
  }
  const p = points[0];
  const offset = p.value + sign * DEFAULT_ROUT * p.current;
  return {
    offset,
    note: `swing ${side}: ${p.which} ${p.value} V at RL ${p.rl} Ω, VS ${p.vs} V, reproduced with rout ${DEFAULT_ROUT} Ω (assumed) → ${r6(offset)} V at no load`,
  };
}

/** Macro-model parameters of a catalog op-amp, with a note per derived value. */
export function deriveOpAmp(part: OpAmpPart): { params: OpAmpParams; notes: string[] } {
  const map = OPAMP_MAPPINGS[part.id as keyof typeof OPAMP_MAPPINGS];
  if (!map) throw new Error(`no op-amp model mapping for ${part.id}`);
  const c = part.characteristics;
  const notes: string[] = [];
  const aolDb = typ(c.openLoopGain) ?? c.openLoopGain?.min;
  const params: OpAmpParams = { part: part.id };
  if (aolDb !== undefined) params.aol = r6(Math.pow(10, aolDb / 20));
  if (c.gbw?.typ !== undefined) params.gbw = c.gbw.typ;
  const sr = c.slewRate?.typ ?? c.slewRate?.min;
  if (sr !== undefined) params.sr = sr;
  const pm = c.phaseMargin?.typ ?? map.pmEstimate?.deg;
  const gbw = c.gbw?.typ;
  if (pm !== undefined && pm < 89 && gbw) {
    const r = Math.tan(((90 - pm) * Math.PI) / 180);
    const fu = gbw / Math.sqrt(1 + r * r);
    params.fp2 = r6(fu / r);
    notes.push(
      `fp2: second pole placed for ${r6(pm)}° phase margin (${c.phaseMargin?.typ !== undefined ? 'datasheet' : map.pmEstimate!.note}); open-loop unity gain at ${r6(fu)} Hz`,
    );
  } else {
    params.fp2 = 0;
    notes.push(
      pm !== undefined ? `single-pole model (datasheet phase margin ${pm}°)` : 'single-pole model: the data has no phase margin (phase margin ≈ 90°, optimistic)',
    );
  }
  params.vos = typ(c.inputOffsetVoltage) ?? 0;
  if (typ(c.inputOffsetVoltage) === undefined) notes.push('vos: no typical value printed (only ± limits) — model uses 0; set { vos } to test the limit');
  const ib = typ(c.inputBiasCurrent);
  if (ib !== undefined) params.ib = map.ibSign * ib;
  if (map.ibSign < 0) notes.push('ib: negative — the bias current flows out of the (PNP) inputs');
  if (map.ibAssumed) notes.push('ib: the data gives a magnitude only — current into the inputs assumed');
  const ios = typ(c.inputOffsetCurrent);
  if (ios !== undefined) params.ios = ios;

  const hi = fitSwing(c.outputSwingHigh, 'high', map.loadRef);
  const lo = fitSwing(c.outputSwingLow, 'low', map.loadRef);
  if (hi) {
    params.swingHigh = r6(Math.min(0, hi.offset));
    notes.push(hi.note);
  }
  if (lo) {
    params.swingLow = r6(Math.max(0, lo.offset));
    notes.push(lo.note);
  }
  if (!hi && !lo && map.swingAssumption) {
    params.swingHigh = map.swingAssumption.high;
    params.swingLow = map.swingAssumption.low;
    notes.push(map.swingAssumption.note);
  }
  params.rout = r6(hi?.rout ?? lo?.rout ?? DEFAULT_ROUT);
  if (!(hi?.rout ?? lo?.rout)) notes.push(`rout: ${DEFAULT_ROUT} Ω assumed (no load-dependent swing pair in the data)`);

  const isc = c.outputShortCircuitCurrent;
  if (map.isc && isc) {
    params.iscSource = typ(isc[map.isc[0]]) ?? isc[map.isc[0]].min!;
    params.iscSink = typ(isc[map.isc[1]]) ?? isc[map.isc[1]].min!;
  } else {
    params.iscSource = OPAMP_DEFAULTS.iscSource;
    params.iscSink = OPAMP_DEFAULTS.iscSink;
    notes.push(`output short-circuit current not in the data — model ASSUMES ±${OPAMP_DEFAULTS.iscSource * 1e3} mA`);
  }
  const iq = c.supplyCurrent?.[0];
  if (iq) {
    params.iq = r6((iq.typ ?? iq.max!) / map.iqDivide);
    if (map.iqDivide !== 1) notes.push(`iq: package supply current / ${map.iqDivide} (one channel)`);
  }
  return { params, notes };
}

interface ComparatorMapping {
  ibSign: 1 | -1;
  ibAssumed?: boolean;
  emitterPin: boolean;
  /** responseTime indices [5 mV overdrive (HL), 5 mV overdrive (LH)] and optional large-overdrive index. */
  response: { hl: number; lh: number; fast?: number };
  /** saturationVoltage index used for vol/iol. */
  sat: number;
  /** Maximum sink when outputSinkCurrent is missing. */
  isinkAssumption?: { value: number; note: string };
  iqDivide: number;
  /** supplyCurrent index used for iq. */
  iq: number;
  /** Output-swing ΔVO of the avd test (V) — informational. */
}

const COMPARATOR_MAPPINGS: Record<(typeof COMPARATOR_PART_IDS)[number], ComparatorMapping> = {
  LM393: { ibSign: -1, emitterPin: false, response: { hl: 0, lh: 0, fast: 1 }, sat: 0, iqDivide: 2, iq: 0 },
  LM311: {
    ibSign: 1,
    ibAssumed: true,
    emitterPin: true,
    response: { hl: 1, lh: 0 },
    sat: 0,
    isinkAssumption: { value: 0.1, note: 'isink: maximum sink current not in the tables — model ASSUMES 100 mA (abs-max output current is 50 mA)' },
    iqDivide: 1,
    iq: 1,
  },
};

/** Model parameters of a catalog comparator, with a note per derived value. */
export function deriveComparator(part: ComparatorPart): { params: ComparatorParams; notes: string[] } {
  const map = COMPARATOR_MAPPINGS[part.id as keyof typeof COMPARATOR_MAPPINGS];
  if (!map) throw new Error(`no comparator model mapping for ${part.id}`);
  const c = part.characteristics;
  const notes: string[] = [];
  const params: ComparatorParams = { part: part.id, emitterPin: map.emitterPin };
  const gain = typ(c.voltageGain) ?? c.voltageGain?.min;
  if (gain !== undefined) params.avd = r6(Math.pow(10, gain / 20));
  params.vos = typ(c.inputOffsetVoltage) ?? 0;
  const ib = typ(c.inputBiasCurrent);
  if (ib !== undefined) params.ib = map.ibSign * ib;
  if (map.ibSign < 0) notes.push('ib: negative — the bias current flows out of the (PNP) inputs');
  if (map.ibAssumed) notes.push('ib: the data gives a magnitude only — current into the inputs assumed');
  const ios = typ(c.inputOffsetCurrent);
  if (ios !== undefined) params.ios = ios;
  const rt = c.responseTime ?? [];
  params.tpdHL = rt[map.response.hl].typ!;
  params.tpdLH = rt[map.response.lh].typ!;
  const od = rt[map.response.hl].conditions?.overdrive;
  if (typeof od === 'number') params.overdrive = od;
  if (map.response.fast !== undefined) {
    params.tpdFast = rt[map.response.fast].typ!;
    notes.push(`response: ${params.tpdHL} s at ${params.overdrive} V overdrive, ${params.tpdFast} s with a TTL-level step (the delay shrinks with overdrive)`);
  } else {
    notes.push(`response: tpdHL ${params.tpdHL} s, tpdLH ${params.tpdLH} s at ${params.overdrive} V overdrive; larger overdrive is NOT faster in the model (no data)`);
  }
  const sat = c.saturationVoltage?.[map.sat];
  if (sat) {
    params.vol = sat.typ ?? sat.max!;
    params.iol = sat.conditions!.IOL as number;
  }
  const sink = c.outputSinkCurrent?.[0];
  if (sink) {
    params.isink = sink.typ ?? sink.min!;
    if (sink.typ === undefined) notes.push(`isink: ${params.isink} A is the datasheet MINIMUM sink current (the only value printed)`);
  } else if (map.isinkAssumption) {
    params.isink = map.isinkAssumption.value;
    notes.push(map.isinkAssumption.note);
  }
  const leak = c.outputLeakageCurrent?.[0];
  if (leak && typeof leak.conditions?.VOH === 'number') params.gleak = r6((leak.typ ?? leak.max!) / leak.conditions.VOH);
  const iq = c.supplyCurrent?.[map.iq];
  if (iq) {
    params.iq = r6((iq.typ ?? iq.max!) / map.iqDivide);
    if (map.iqDivide !== 1) notes.push(`iq: package supply current / ${map.iqDivide} (one channel)`);
    else notes.push(`iq: ${iq.conditions?.rail ?? 'supply current'} typ`);
  }
  return { params, notes };
}

/** Op-amp model parameters of a catalog part (throws for unknown ids). */
export function opampPartParams(id: string): OpAmpParams {
  const entry = findPart(id);
  if (!entry || entry.category !== 'opamp') throw new Error(`'${id}' is not an op-amp in the parts catalog (op-amps: ${OPAMP_PART_IDS.join(', ')})`);
  return deriveOpAmp(entry).params;
}

/** Comparator model parameters of a catalog part (throws for unknown ids). */
export function comparatorPartParams(id: string): ComparatorParams {
  const entry = findPart(id);
  if (!entry || entry.category !== 'comparator') throw new Error(`'${id}' is not a comparator in the parts catalog (comparators: ${COMPARATOR_PART_IDS.join(', ')})`);
  return deriveComparator(entry).params;
}

/**
 * Part() resolver for op-amps and comparators: a single-channel device built
 * from the catalog data, or undefined when `id` is not an amplifier part.
 */
export function opampPart(id: string): Component | undefined {
  const entry = findPart(id);
  if (!entry) return undefined;
  if (entry.category === 'opamp') return new OpAmp(deriveOpAmp(entry).params);
  if (entry.category === 'comparator') return new Comparator(deriveComparator(entry).params);
  return undefined;
}
