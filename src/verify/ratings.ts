/**
 * Datasheet absolute-maximum-rating checks of catalog parts (Part('…')).
 *
 * After the op, dc and tran stages every Part() device is checked against
 * its catalog ratings. The results live in `stages.<stage>.ratings`, apart
 * from the bench's assertions: assertions are the simulated spec the author
 * wrote, ratings are the real part's datasheet limits.
 *
 * What is compared (all values are magnitudes in the rated sense):
 *   op    the operating-point value;
 *   dc    the largest value over the sweep (and the sweep value where it occurs);
 *   tran  voltages: the instantaneous peak over the window;
 *         continuous currents (IcMax, Id25, IF/IFAV): the instantaneous peak —
 *           or, when the datasheet also prints a pulsed/surge rating
 *           (IcPeak, IdPulsed, IFP/IFSM), the time average over the window,
 *           with the peak checked against the pulsed rating (R403);
 *         Pd: the time average over the window (Pd is a steady-state
 *           thermal rating), or the instantaneous peak with
 *           tb.ratings({ pd: 'peak' }).
 * Codes: R401 voltage, R402 continuous current, R403 pulsed/surge current,
 * R404 power dissipation. A violation fails the stage (exit 1: the circuit
 * is valid but the real part would be over-stressed).
 */
import type { Elaboration } from '../elab/bench';
import { kindOf } from '../elab/describe';
import { asQuantityDevice } from '../elab/quantity';
import { formatEng } from '../elab/units';
import { findPart } from '../parts';
import type { Citation, PartEntry, Spec } from '../parts/types';
import type { Fix, RatingResult, VerifiedParamHint } from '../schema/types';
import type { Waveform } from './measure';

export interface RatingOptions {
  /** Check ratings at all (default true). */
  enabled: boolean;
  /** Multiply every limit by this factor (0 < derate ≤ 1, default 1). */
  derate: number;
  /** How Pd is compared in the transient stage (default 'average'). */
  pd: 'average' | 'peak';
  /** Component ids excluded from the checks. */
  ignore: string[];
}

export const DEFAULT_RATING_OPTIONS: RatingOptions = { enabled: true, derate: 1, pd: 'average', ignore: [] };

type Stage = 'op' | 'dc' | 'tran';
type Kind = 'voltage' | 'current' | 'pulsed' | 'power';

const CODE: Record<Kind, { code: string; slug: string }> = {
  voltage: { code: 'R401', slug: 'voltage-rating-exceeded' },
  current: { code: 'R402', slug: 'current-rating-exceeded' },
  pulsed: { code: 'R403', slug: 'pulsed-current-rating-exceeded' },
  power: { code: 'R404', slug: 'power-rating-exceeded' },
};

/** One rated quantity of one component. */
export interface RatingCheck {
  component: string;
  entry: PartEntry;
  rating: string;
  description: string;
  kind: Kind;
  spec: Spec;
  /** Probe expression the value is computed from. */
  probe: string;
  /** Raw probe value → rated magnitude. */
  transform: (raw: number) => number;
  /** Stages this check applies to. */
  stages: Stage[];
  /** tran reduction. */
  tranMeasure: 'peak' | 'average';
  /** Fix advice when exceeded. */
  advice: string;
}

const pos = (x: number) => Math.max(0, x);

function checksFor(id: string, kind: string, entry: PartEntry, opts: RatingOptions): RatingCheck[] {
  const out: RatingCheck[] = [];
  const add = (
    rating: string,
    spec: Spec | undefined,
    k: Kind,
    description: string,
    probe: string,
    transform: (x: number) => number,
    advice: string,
    stages: Stage[] = ['op', 'dc', 'tran'],
    tranMeasure: 'peak' | 'average' = 'peak',
  ) => {
    if (!spec || spec.max === undefined || !(spec.max > 0)) return;
    out.push({ component: id, entry, rating, description, kind: k, spec, probe, transform, stages, tranMeasure, advice });
  };
  const pdMeasure = opts.pd === 'peak' ? 'peak' : 'average';
  if (entry.category === 'diode') {
    const r = entry.ratings;
    const reverseOp = r.VR ?? r.VRRM;
    const reverseTran = r.VRRM ?? r.VR;
    const reverseName = (s: Spec | undefined) => (s === r.VR ? 'VR' : 'VRRM');
    const advice = `lower the reverse voltage across ${id} or choose a diode with a higher reverse rating`;
    if (reverseOp) add(reverseName(reverseOp), reverseOp, 'voltage', 'reverse voltage', `${id}.v`, x => pos(-x), advice, ['op', 'dc']);
    if (reverseTran) add(reverseName(reverseTran), reverseTran, 'voltage', 'peak reverse voltage', `${id}.v`, x => pos(-x), advice, ['tran']);
    const cont = r.IF ?? r.IFAV;
    const contName = r.IF ? 'IF' : 'IFAV';
    const contTran = r.IFAV ?? r.IF;
    const contTranName = r.IFAV ? 'IFAV' : 'IF';
    const pulsed = r.IFP ?? r.IFSM;
    const pulsedName = r.IFP ? 'IFP' : 'IFSM';
    const iAdvice = `increase the series resistance that sets ${id}'s current, or choose a part with a higher current rating`;
    add(contName, cont, 'current', 'continuous forward current', `${id}.i`, pos, iAdvice, ['op', 'dc']);
    add(contTranName, contTran, 'current', pulsed ? 'average forward current' : 'forward current', `${id}.i`, pos, iAdvice, ['tran'], pulsed ? 'average' : 'peak');
    add(pulsedName, pulsed, 'pulsed', pulsedName === 'IFSM' ? 'surge (non-repetitive peak) forward current' : 'peak pulsed forward current', `${id}.i`, pos, iAdvice, ['tran']);
    add('Pd', r.Pd, 'power', 'power dissipation', `${id}.p`, pos, `reduce ${id}'s current (or the voltage across it), or choose a part with a higher Pd`, ['op', 'dc', 'tran'], pdMeasure);
  } else if (entry.category === 'bjt') {
    const r = entry.ratings;
    const s = kind === 'PNP' ? -1 : 1;
    const vAdvice = (what: string) => `lower the ${what} of ${id} (supply or swing), or choose a transistor with a higher rating`;
    add('Vceo', r.Vceo, 'voltage', 'collector-emitter voltage (base open)', `${id}.vce`, x => pos(s * x), vAdvice('collector-emitter voltage'));
    add('Vcbo', r.Vcbo, 'voltage', 'collector-base voltage', `${id}.vcb`, x => pos(s * x), vAdvice('collector-base voltage'));
    add('Vebo', r.Vebo, 'voltage', 'reverse emitter-base voltage', `${id}.veb`, x => pos(s * x), `limit the reverse base-emitter voltage of ${id} (e.g. a diode or a divider on the base)`);
    const iAdvice = `limit ${id}'s collector current (larger collector/load resistance, or less base drive), or choose a transistor with a higher Ic rating`;
    add('IcMax', r.IcMax, 'current', 'continuous collector current', `${id}.ic`, Math.abs, iAdvice, ['op', 'dc']);
    add('IcMax', r.IcMax, 'current', r.IcPeak ? 'average collector current' : 'collector current', `${id}.ic`, Math.abs, iAdvice, ['tran'], r.IcPeak ? 'average' : 'peak');
    add('IcPeak', r.IcPeak, 'pulsed', 'peak collector current', `${id}.ic`, Math.abs, iAdvice, ['tran']);
    add('IbMax', r.IbMax, 'current', 'base current', `${id}.ib`, Math.abs, `add or increase the base resistor of ${id}`, ['op', 'dc', 'tran']);
    add('Pd', r.Pd, 'power', 'total power dissipation', `${id}.p`, pos, `reduce ${id}'s dissipation (Vce·Ic): saturate it fully when switching, or choose a larger package`, ['op', 'dc', 'tran'], pdMeasure);
  } else if (entry.category === 'mosfet') {
    const r = entry.ratings;
    const s = kind === 'PMOS' ? -1 : 1;
    add('Vds', r.Vds, 'voltage', 'drain-source voltage', `${id}.vds`, x => pos(s * x), `lower the drain-source voltage of ${id} (add a clamp/snubber for inductive loads), or choose a MOSFET with a higher Vds rating`);
    add('Vgs', r.Vgs, 'voltage', 'gate-source voltage (±)', `${id}.vgs`, Math.abs, `limit ${id}'s gate drive (divider or Zener clamp on the gate) to within ±Vgs`);
    const iAdvice = `limit ${id}'s drain current (larger load resistance), or choose a MOSFET with a higher Id rating`;
    add('Id25', r.Id25, 'current', 'continuous drain current', `${id}.id`, Math.abs, iAdvice, ['op', 'dc']);
    add('Id25', r.Id25, 'current', r.IdPulsed ? 'average drain current' : 'drain current', `${id}.id`, Math.abs, iAdvice, ['tran'], r.IdPulsed ? 'average' : 'peak');
    add('IdPulsed', r.IdPulsed, 'pulsed', 'pulsed drain current', `${id}.id`, Math.abs, iAdvice, ['tran']);
    add('Pd', r.Pd, 'power', 'total power dissipation', `${id}.p`, pos, `reduce ${id}'s dissipation (enhance it fully: more gate drive for a lower Rds(on)), or add a heatsink / choose a larger part`, ['op', 'dc', 'tran'], pdMeasure);
  }
  return out;
}

/** Every rating check of the elaborated bench, in component-id order. */
export function ratingChecks(elab: Elaboration, stage?: Stage): RatingCheck[] {
  const opts = elab.ratingOptions ?? DEFAULT_RATING_OPTIONS;
  if (!opts.enabled) return [];
  const out: RatingCheck[] = [];
  for (const id of [...elab.components.keys()].sort()) {
    if (opts.ignore.includes(id)) continue;
    const comp = elab.components.get(id)!;
    const partId = (comp as { partId?: string }).partId;
    if (!partId) continue;
    const entry = findPart(partId);
    if (!entry || !asQuantityDevice(comp)) continue;
    for (const c of checksFor(id, kindOf(comp), entry, opts)) if (!stage || c.stages.includes(stage)) out.push(c);
  }
  return out;
}

/** Probes needed by the checks of a stage. */
export function ratingProbes(elab: Elaboration, stage: Stage): string[] {
  return [...new Set(ratingChecks(elab, stage).map(c => c.probe))].sort();
}

function citation(entry: PartEntry, spec: Spec): { source: string; url?: string } {
  const c: Citation | undefined = (spec.source ? entry.sources.find(s => s.id === spec.source) : undefined) ?? entry.sources[0];
  if (!c) return { source: entry.manufacturer };
  return { source: [c.publisher, c.document ?? c.title, c.revision].filter(Boolean).join(', '), url: c.url };
}

function modelEstimated(entry: PartEntry): boolean {
  if (entry.category === 'diode' || entry.category === 'bjt' || entry.category === 'mosfet') {
    return entry.model?.estimated === true;
  }
  return false;
}

interface Reduced {
  measure: 'value' | 'peak' | 'average';
  value: number;
  time?: number;
  tFirstViolation?: number;
  window?: [number, number];
  x?: number;
  config?: string;
}

function build(elab: Elaboration, check: RatingCheck, r: Reduced, stage: Stage): RatingResult {
  const opts = elab.ratingOptions ?? DEFAULT_RATING_OPTIONS;
  const limit = check.spec.max!;
  const allowed = limit * opts.derate;
  const value = r.value;
  const fail = value > allowed;
  const { code, slug } = CODE[check.kind];
  const cite = citation(check.entry, check.spec);
  const unit = check.spec.unit;
  const estimatedModel = modelEstimated(check.entry);
  const result: RatingResult = {
    code,
    slug,
    verdict: fail ? 'fail' : 'pass',
    component: check.component,
    part: check.entry.id,
    rating: check.rating,
    description: check.description,
    quantity: check.probe,
    measure: r.measure,
    limit,
    ...(opts.derate !== 1 ? { derate: opts.derate } : {}),
    allowed,
    unit,
    value: Number(value.toPrecision(8)),
    utilization: Number((value / allowed).toPrecision(4)),
    margin: Number((allowed - value).toPrecision(6)),
    ...(r.time !== undefined ? { time: r.time } : {}),
    ...(fail && r.tFirstViolation !== undefined ? { tFirstViolation: r.tFirstViolation } : {}),
    ...(r.window ? { window: r.window } : {}),
    ...(r.x !== undefined ? { x: r.x } : {}),
    ...(r.config ? { config: r.config } : {}),
    ...(check.spec.conditions ? { conditions: { ...check.spec.conditions } } : {}),
    source: cite.source,
    ...(cite.url ? { url: cite.url } : {}),
    ...(check.spec.estimated ? { estimated: true } : {}),
    ...(estimatedModel ? { modelEstimated: true } : {}),
    confidence: 'verified',
  };
  if (!fail) return result;
  const how =
    r.measure === 'average'
      ? `averages ${formatEng(value, unit)} over the window`
      : r.measure === 'peak'
        ? `peaks at ${formatEng(value, unit)}${r.time !== undefined ? ` (t=${formatEng(r.time, 's')})` : r.x !== undefined ? ` (sweep x=${formatEng(r.x)})` : ''}`
        : `is ${formatEng(value, unit)}`;
  const derated = opts.derate !== 1 ? ` derated ×${opts.derate} to ${formatEng(allowed, unit)}` : '';
  result.message = `${check.component} (${check.entry.id}) ${check.description} ${how} — exceeds the absolute maximum ${check.rating} = ${formatEng(limit, unit)}${derated} (${(value / allowed).toFixed(2)}×)`;
  const cond = check.spec.conditions
    ? ` Rated at ${Object.entries(check.spec.conditions)
        .map(([k, v]) => `${k} = ${typeof v === 'number' ? formatEng(v) : v}`)
        .join(', ')}.`
    : '';
  result.note =
    `absolute maximum ratings must never be exceeded; the value was simulated in the ${stage} stage with ${check.entry.id}'s model${
      estimatedModel ? ' (an ESTIMATED card fitted to datasheet curves — the real part can differ)' : ''
    }. Source: ${cite.source}.${cond}${check.spec.note ? ` Datasheet note: ${check.spec.note}.` : ''}`;
  result.fixes = [{ kind: 'check-values', confidence: 'suggested', detail: check.advice }];
  const at = elab.locOf.get(check.component);
  if (at) result.at = at;
  return result;
}

/** op: one value per check. `read` returns the published probe value. */
export function evaluateOpRatings(elab: Elaboration, read: (probe: string) => number): RatingResult[] {
  return ratingChecks(elab, 'op').map(c => build(elab, c, { measure: 'value', value: c.transform(read(c.probe)) }, 'op'));
}

/** dc: the peak over each sweep; worst over all sweeps. */
export function evaluateDcRatings(elab: Elaboration, sweeps: { label: string; x: number[]; values: Record<string, number[]> }[]): RatingResult[] {
  const out: RatingResult[] = [];
  for (const c of ratingChecks(elab, 'dc')) {
    let best: Reduced | null = null;
    for (const s of sweeps) {
      const ys = s.values[c.probe];
      if (!ys) continue;
      for (let i = 0; i < ys.length; i++) {
        const v = c.transform(ys[i]);
        if (!best || v > best.value) best = { measure: 'peak', value: v, x: s.x[i], config: s.label };
      }
    }
    if (best) out.push(build(elab, c, best, 'dc'));
  }
  return out;
}

/** Time average of a piecewise-linear signal over its whole window. */
function average(t: number[], y: number[]): number {
  const T = t[t.length - 1] - t[0];
  if (!(T > 0)) return y[0];
  let area = 0;
  for (let i = 1; i < t.length; i++) area += ((y[i] + y[i - 1]) / 2) * (t[i] - t[i - 1]);
  return area / T;
}

/** tran: peaks or window averages per run; worst over runs. */
export function evaluateTranRatings(elab: Elaboration, runs: { label: string; waveforms: Map<string, Waveform> }[]): RatingResult[] {
  const opts = elab.ratingOptions ?? DEFAULT_RATING_OPTIONS;
  const out: RatingResult[] = [];
  for (const c of ratingChecks(elab, 'tran')) {
    let best: Reduced | null = null;
    const allowed = c.spec.max! * opts.derate;
    for (const run of runs) {
      const wf = run.waveforms.get(c.probe);
      if (!wf) continue;
      const y = wf.y.map(c.transform);
      let r: Reduced;
      if (c.tranMeasure === 'average') {
        r = { measure: 'average', value: average(wf.t, y), window: [wf.t[0], wf.t[wf.t.length - 1]], config: run.label };
      } else {
        let k = 0;
        for (let i = 1; i < y.length; i++) if (y[i] > y[k]) k = i;
        let tFirst: number | undefined;
        for (let i = 0; i < y.length; i++) {
          if (y[i] > allowed) {
            tFirst = i === 0 ? wf.t[0] : wf.t[i - 1] + ((allowed - y[i - 1]) / (y[i] - y[i - 1])) * (wf.t[i] - wf.t[i - 1]);
            break;
          }
        }
        r = { measure: 'peak', value: y[k], time: wf.t[k], ...(tFirst !== undefined ? { tFirstViolation: tFirst } : {}), config: run.label };
      }
      if (!best || r.value > best.value) best = r;
    }
    if (best) out.push(build(elab, c, best, 'tran'));
  }
  return out;
}

/** Attach a verified hint to failed ratings. */
export function attachRatingHint(ratings: RatingResult[], hint: VerifiedParamHint | undefined): void {
  if (!hint) return;
  for (const r of ratings) {
    if (r.verdict !== 'fail') continue;
    r.hint = hint;
    const fix: Fix = {
      kind: 'set-param',
      confidence: 'verified',
      detail: `${hint.param} in [${formatEng(hint.passingRange[0])}, ${formatEng(hint.passingRange[1])}] keeps every rating and op assertion within limits (simulated) — try --set ${hint.param}=${Number(hint.suggestedValue.toPrecision(6))}`,
    };
    r.fixes = [fix, ...(r.fixes ?? [])];
  }
}

/** Normalize tb.ratings(...) input. */
export function normalizeRatingOptions(input: Partial<RatingOptions> | false | undefined): RatingOptions {
  if (input === false) return { ...DEFAULT_RATING_OPTIONS, enabled: false };
  const o = { ...DEFAULT_RATING_OPTIONS, ...(input ?? {}) };
  if (typeof o.enabled !== 'boolean') throw new Error(`tb.ratings: enabled must be true or false`);
  if (!(typeof o.derate === 'number' && o.derate > 0 && o.derate <= 1)) {
    throw new Error(`tb.ratings: derate must be a number in (0, 1] (e.g. 0.8 = keep 20 % margin), got ${o.derate}`);
  }
  if (o.pd !== 'average' && o.pd !== 'peak') throw new Error(`tb.ratings: pd must be 'average' or 'peak', got '${o.pd}'`);
  if (!Array.isArray(o.ignore) || o.ignore.some(x => typeof x !== 'string')) throw new Error(`tb.ratings: ignore must be an array of component ids`);
  for (const k of Object.keys(input ?? {})) {
    if (!['enabled', 'derate', 'pd', 'ignore'].includes(k)) throw new Error(`tb.ratings: unknown option '${k}' (enabled, derate, pd, ignore)`);
  }
  return { enabled: o.enabled, derate: o.derate, pd: o.pd, ignore: [...o.ignore].sort() };
}
