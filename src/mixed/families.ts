/**
 * Electrical models of logic families, derived from the real-parts catalog
 * (src/parts). Every number here is read from a part's datasheet record —
 * thresholds, output resistance, propagation delay and supply limits are
 * interpolated piecewise-linearly over the supply voltages the datasheet
 * prints (linear extrapolation outside them, clamped to sane bounds).
 *
 * The only modeling constants that are NOT datasheet values are named and
 * documented here (output ramp fraction, unpowered threshold, NE555 latch
 * delay), and the catalog command prints them as model assumptions.
 */
import { findPart } from '../parts';
import type { LogicLevelPoint, LogicPart, Spec, TimerPart } from '../parts/types';

/** 'typ' uses typical datasheet values; 'worst' uses max delays and max output resistance. */
export type Corner = 'typ' | 'worst';

export type FamilyName = 'HC' | 'HCT' | 'CD4000';

/** Supply below this fraction of the recommended minimum: the IC is unpowered (outputs high-Z). */
export const UNPOWERED_FRACTION = 0.5;

/** Output conductance ramp = this fraction of the part's typical tpd at the supply (model choice). */
export const RAMP_FRACTION = 0.2;

/** Datasheet test load the tpd values are specified at (CL = 50 pF for every part used here). */
export const TPD_TEST_LOAD = 50e-12;

type Pt = [number, number];

/** Piecewise-linear interpolation over sorted points; linear extrapolation on the end segments. */
export function interp(points: Pt[], v: number): number {
  if (points.length === 0) return NaN;
  if (points.length === 1) return points[0][1];
  let i = 1;
  while (i < points.length - 1 && v > points[i][0]) i++;
  const [x0, y0] = points[i - 1];
  const [x1, y1] = points[i];
  return y0 + ((y1 - y0) * (v - x0)) / (x1 - x0);
}

function pts(levels: LogicLevelPoint[], pick: (l: LogicLevelPoint) => number | undefined): Pt[] {
  const out: Pt[] = [];
  for (const l of levels) {
    const v = pick(l);
    if (v !== undefined && Number.isFinite(v)) out.push([l.vcc, v]);
  }
  return out.sort((a, b) => a[0] - b[0]);
}

const condNum = (s: Spec, key: string): number | undefined => {
  const v = s.conditions?.[key];
  return typeof v === 'number' ? v : undefined;
};

export interface LogicFamilyModel {
  partId: string;
  family: FamilyName;
  /** Recommended operating supply range (V). */
  vccMin: number;
  vccMax: number;
  /** Absolute maximum supply (V). */
  vccAbsMax: number;
  /** Absolute minimum supply (V, usually −0.5). */
  vccAbsMin: number;
  vih(vs: number): number;
  vil(vs: number): number;
  /** Schmitt thresholds (74HC14), when the datasheet gives them. */
  vtPlus?: (vs: number) => number;
  vtMinus?: (vs: number) => number;
  rOutHigh(vs: number, corner: Corner): number;
  rOutLow(vs: number, corner: Corner): number;
  /** Propagation delay of a datasheet path (substring of the tpd `path` condition), CL = 50 pF. */
  tpd(path: string, vs: number, corner: Corner): number;
  /** Max input rise/fall time at vs, when the datasheet states one for ordinary inputs. */
  maxInputTransition(vs: number): number | undefined;
  /** |IO| abs max per output pin (A). */
  outputCurrentMax?: number;
  /** Max power per output transistor (W), when given instead of a current (CD4000B). */
  outputPowerMax?: number;
  /** |IIK| abs max input clamp current (A). */
  inputClampCurrentMax?: number;
  /** Citation (first datasheet) for messages. */
  source: string;
}

const cache = new Map<string, LogicFamilyModel>();

/** Electrical model of a logic part from the catalog (74HC00, CD4017, …). */
export function logicFamilyModel(partId: string): LogicFamilyModel {
  const hit = cache.get(partId);
  if (hit) return hit;
  const p = findPart(partId);
  if (!p || p.category !== 'logic') throw new Error(`no logic part '${partId}' in the catalog`);
  const m = buildLogicModel(p);
  cache.set(partId, m);
  return m;
}

function buildLogicModel(p: LogicPart): LogicFamilyModel {
  const L = p.levels;
  const vihPts = pts(L, l => l.VIH?.min);
  const vilPts = pts(L, l => l.VIL?.max);
  const vtpPts = pts(L, l => l.VTplus?.typ);
  const vtmPts = pts(L, l => l.VTminus?.typ);
  // Output resistance: interpolate the CONDUCTANCE (a MOSFET on-resistance falls ~ with overdrive).
  const gPts = (pick: (l: LogicLevelPoint) => Spec | undefined, corner: Corner): Pt[] =>
    pts(L, l => {
      const s = pick(l);
      const r = corner === 'worst' ? (s?.max ?? s?.typ) : (s?.typ ?? s?.max);
      return r ? 1 / r : undefined;
    });
  const gHigh = { typ: gPts(l => l.rOutHigh, 'typ'), worst: gPts(l => l.rOutHigh, 'worst') };
  const gLow = { typ: gPts(l => l.rOutLow, 'typ'), worst: gPts(l => l.rOutLow, 'worst') };
  // Parts that only print one side (74HCT04 at 4.5 V high / 5.5 V low): use the other side.
  if (gHigh.typ.length === 0) Object.assign(gHigh, gLow);
  if (gLow.typ.length === 0) Object.assign(gLow, gHigh);
  if (vihPts.length === 0 && vtpPts.length > 0) {
    // Schmitt parts print no VIH/VIL: VT+ max / VT− min bound the input levels.
    vihPts.push(...pts(L, l => l.VTplus?.max));
    vilPts.push(...pts(L, l => l.VTminus?.min));
  }
  const tpdCache = new Map<string, Pt[]>();
  const tpdPts = (path: string, corner: Corner): Pt[] => {
    const key = `${path}|${corner}`;
    let r = tpdCache.get(key);
    if (!r) {
      r = pts(L, l => {
        const s = (l.tpd ?? []).find(t => String(t.conditions?.path ?? '').includes(path) && (condNum(t, 'CL') ?? TPD_TEST_LOAD) === TPD_TEST_LOAD);
        return s ? (corner === 'worst' ? (s.max ?? s.typ) : (s.typ ?? s.max)) : undefined;
      });
      if (r.length === 0) throw new Error(`${p.id}: no tpd for path '${path}' in the catalog`);
      tpdCache.set(key, r);
    }
    return r;
  };
  const transition: Pt[] = [];
  let transitionConst: number | undefined;
  for (const s of p.recommended.inputTransitionTime ?? []) {
    if (s.max === undefined) continue;
    const vcc = s.conditions?.VCC;
    if (typeof vcc === 'number') transition.push([vcc, s.max]);
    else if (typeof vcc === 'string' && !s.conditions?.input) transitionConst = s.max;
  }
  transition.sort((a, b) => a[0] - b[0]);
  const rec = p.recommended.vcc;
  const positive = (v: number, floor: number) => (Number.isFinite(v) && v > floor ? v : floor);
  const family = p.family as FamilyName;
  return {
    partId: p.id,
    family,
    vccMin: rec.min ?? 2,
    vccMax: rec.max ?? 6,
    vccAbsMax: p.ratings.vccMax.max ?? 7,
    vccAbsMin: p.ratings.vccMin?.min ?? -0.5,
    vih: vs => Math.min(Math.max(interp(vihPts, vs), 0.05 * vs), 0.95 * vs),
    vil: vs => Math.min(Math.max(interp(vilPts, vs), 0.02 * vs), 0.9 * vs),
    ...(vtpPts.length > 0
      ? {
          vtPlus: (vs: number) => Math.min(Math.max(interp(vtpPts, vs), 0.05 * vs), 0.95 * vs),
          vtMinus: (vs: number) => Math.min(Math.max(interp(vtmPts, vs), 0.02 * vs), 0.9 * vs),
        }
      : {}),
    rOutHigh: (vs, corner) => 1 / positive(interp(gHigh[corner], vs), 1e-4),
    rOutLow: (vs, corner) => 1 / positive(interp(gLow[corner], vs), 1e-4),
    tpd: (path, vs, corner) => positive(interp(tpdPts(path, corner), vs), 1e-12),
    maxInputTransition: vs => (transition.length > 0 ? positive(interp(transition, vs), 1e-9) : transitionConst),
    ...(p.ratings.outputCurrentPerPin?.max !== undefined ? { outputCurrentMax: p.ratings.outputCurrentPerPin.max } : {}),
    ...(family === 'CD4000' ? { outputPowerMax: 0.1 } : {}),
    ...(p.ratings.inputClampCurrent?.max !== undefined ? { inputClampCurrentMax: p.ratings.inputClampCurrent.max } : {}),
    source: citation(p.sources[0]),
  };
}

function citation(c: { publisher: string; document?: string; title: string }): string {
  return `${c.publisher} ${c.document ?? c.title}`;
}

/** Part whose levels stand for a family when a generic primitive is bridged ({ family: 'HC' }). */
export const FAMILY_REFERENCE_PART: Record<FamilyName, string> = {
  HC: '74HC04',
  HCT: '74HCT04',
  CD4000: 'CD4011',
};

// ─── NE555 ───────────────────────────────────────────────────────────────────

/** NE555 latch/comparator propagation delay (s): NOT in the datasheet; set equal to the 100 ns typ output rise time. */
export const NE555_DELAY = 100e-9;

export interface TimerModel {
  partId: string;
  vccMin: number;
  vccMax: number;
  vccAbsMax: number;
  /** RESET threshold above GND (V), typ. */
  resetThreshold: number;
  /** Internal divider resistors VCC–CONT and CONT–GND (Ω): 5k + (5k + 5k). */
  rDivTop: number;
  rDivBottom: number;
  /** Discharge on-resistance (Ω) at vs, from the saturation voltage rows. */
  rDischarge(vs: number, corner: Corner): number;
  /** Output low-side resistance (Ω) at vs, from the VOL rows. */
  rOutLow(vs: number, corner: Corner): number;
  /** Output high side: VOH = VCC − vDropHigh − rOutHigh·I (Darlington), from the VOH rows. */
  vDropHigh: number;
  rOutHigh: number;
  outputCurrentMax: number;
  /** Output rise/fall time (s), typ. */
  ramp: number;
  delay: number;
  source: string;
}

let timerCache: TimerModel | undefined;

/** NE555 model from the catalog record (TI SLFS022K + LM555 SNAS548D). */
export function ne555Model(): TimerModel {
  if (timerCache) return timerCache;
  const p = findPart('NE555') as TimerPart;
  const c = p.characteristics;
  const at = (rows: Spec[] | undefined, vcc: number, io: string): Spec[] =>
    (rows ?? []).filter(r => condNum(r, 'VCC') === vcc).sort((a, b) => (condNum(a, io) ?? 0) - (condNum(b, io) ?? 0));
  // Discharge: R = Vsat / I at the 5 V (8 mA) and 15 V (15 mA) rows.
  const disc: Pt[] = [];
  const discW: Pt[] = [];
  for (const r of c.dischargeSaturation ?? []) {
    const vcc = condNum(r, 'VCC');
    const io = condNum(r, 'IO');
    if (vcc === undefined || !io || vcc === 4.5) continue;
    disc.push([vcc, io / (r.typ ?? r.max!)]);
    discW.push([vcc, io / (r.max ?? r.typ!)]);
  }
  disc.sort((a, b) => a[0] - b[0]);
  discW.sort((a, b) => a[0] - b[0]);
  // Output low: R = VOL / IOL at the highest-current row of 5 V (8 mA) and the 50 mA row of 15 V.
  const low5 = at(c.VOL, 5, 'IOL').pop()!;
  const low15 = at(c.VOL, 15, 'IOL').find(r => condNum(r, 'IOL') === 50e-3)!;
  const gLow: Pt[] = [
    [5, condNum(low5, 'IOL')! / low5.typ!],
    [15, condNum(low15, 'IOL')! / low15.typ!],
  ];
  const gLowW: Pt[] = [
    [5, condNum(low5, 'IOL')! / (low5.max ?? low5.typ!)],
    [15, condNum(low15, 'IOL')! / (low15.max ?? low15.typ!)],
  ];
  // Output high: two 15 V rows (100 mA, 200 mA) → drop = a + b·I.
  const high = at(c.VOH, 15, 'IOH');
  const r100 = high.find(r => condNum(r, 'IOH') === -100e-3)!;
  const r200 = high.find(r => condNum(r, 'IOH') === -200e-3)!;
  const d100 = 15 - r100.typ!;
  const d200 = 15 - r200.typ!;
  const rHigh = (d200 - d100) / 0.1;
  timerCache = {
    partId: p.id,
    vccMin: c.supply.min ?? 4.5,
    vccMax: c.supply.max ?? 16,
    vccAbsMax: p.ratings.supplyMax.max ?? 18,
    resetThreshold: c.resetVoltage?.typ ?? 0.7,
    rDivTop: 5e3,
    rDivBottom: 10e3,
    rDischarge: (vs, corner) => 1 / Math.max(interp(corner === 'worst' ? discW : disc, vs), 1e-4),
    rOutLow: (vs, corner) => 1 / Math.max(interp(corner === 'worst' ? gLowW : gLow, vs), 1e-4),
    vDropHigh: d100 - rHigh * 0.1,
    rOutHigh: rHigh,
    outputCurrentMax: c.outputCurrentMax?.max ?? 0.225,
    ramp: c.riseTime?.typ ?? 100e-9,
    delay: NE555_DELAY,
    source: citation(p.sources[0]),
  };
  return timerCache;
}
