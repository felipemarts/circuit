/**
 * Datasheet checks of real op-amps and comparators (Part('LM358')…) at the DC
 * operating point. Results go to `stages.op.ratings` like the other catalog
 * parts' ratings: a violation fails the op stage (exit 1 — the circuit is
 * valid, the real part would be over-stressed or outside the conditions its
 * model is valid for).
 *
 *   R420 opamp-supply-over-max          V(v+) − V(v-) above the absolute maximum supply
 *   R421 opamp-differential-input-over-max  |V(inp) − V(inn)| above the absolute maximum
 *   R422 opamp-output-current-limit     output at ≥ 90 % of its short-circuit current
 *   R423 opamp-input-common-mode        an input outside the input common-mode range
 *   R424 opamp-input-over-max           an input beyond the absolute maximum input voltage
 *   R425 opamp-supply-below-min         supply below the recommended operating minimum
 */
import type { Elaboration } from '../elab/bench';
import { formatEng } from '../elab/units';
import { findPart } from '../parts';
import type { ComparatorPart, OpAmpPart, Spec } from '../parts/types';
import type { Fix, RatingResult } from '../schema/types';
import type { AmpOperatingPoint } from './OpAmp';

interface AmpDevice {
  kind: string;
  partId?: string;
  _op: AmpOperatingPoint | null;
  params: { iscSource?: number; iscSink?: number };
}

/** Fraction of the short-circuit current at which R422 reports the output as current-limited. */
export const CURRENT_LIMIT_FRACTION = 0.9;

interface Check {
  code: string;
  slug: string;
  rating: string;
  description: string;
  quantity: string;
  limit: number;
  value: number;
  unit: string;
  spec?: Spec;
  advice: string;
  /** Wording of the limit in the message ("absolute maximum", "range", …). */
  kindWord: string;
}

function citation(entry: OpAmpPart | ComparatorPart, spec?: Spec): { source: string; url?: string } {
  const c = entry.sources.find(s => s.id === spec?.source) ?? entry.sources[0];
  return { source: [c.publisher, c.document, c.revision].filter(Boolean).join(' '), url: c.url };
}

function checksFor(id: string, entry: OpAmpPart | ComparatorPart, op: AmpOperatingPoint, dev: AmpDevice): Check[] {
  const out: Check[] = [];
  const vs = op.vpos - op.vneg;
  const r = entry.ratings;
  const c = entry.characteristics;
  const isComparator = entry.category === 'comparator';
  if (r.supplyMax?.max !== undefined) {
    out.push({
      code: 'R420',
      slug: 'opamp-supply-over-max',
      rating: 'supplyMax',
      description: 'supply voltage V(v+) − V(v-)',
      quantity: `${id}: V(v+) − V(v-)`,
      limit: r.supplyMax.max,
      value: vs,
      unit: 'V',
      spec: r.supplyMax,
      advice: `lower the supply of ${id} below ${formatEng(r.supplyMax.max, 'V')} total (V+ − V−), or choose a higher-voltage part`,
      kindWord: 'absolute maximum',
    });
  }
  if (r.differentialInputMax?.max !== undefined) {
    out.push({
      code: 'R421',
      slug: 'opamp-differential-input-over-max',
      rating: 'differentialInputMax',
      description: 'differential input |V(inp) − V(inn)|',
      quantity: `${id}: |V(inp) − V(inn)|`,
      limit: r.differentialInputMax.max,
      value: Math.abs(op.vinp - op.vinn),
      unit: 'V',
      spec: r.differentialInputMax,
      advice: `limit the voltage between the inputs of ${id} (series resistors plus clamp diodes), or choose a part with a larger differential input rating`,
      kindWord: 'absolute maximum',
    });
  }
  if (!isComparator) {
    const sourcing = op.iout >= 0;
    const isc = sourcing ? dev.params.iscSource : dev.params.iscSink;
    if (isc !== undefined) {
      out.push({
        code: 'R422',
        slug: 'opamp-output-current-limit',
        rating: 'outputShortCircuitCurrent',
        description: `output ${sourcing ? 'source' : 'sink'} current`,
        quantity: `${id}.i`,
        limit: CURRENT_LIMIT_FRACTION * isc,
        value: Math.abs(op.iout),
        unit: 'A',
        spec: (entry as OpAmpPart).characteristics.outputShortCircuitCurrent?.[0],
        advice: `the output of ${id} is current-limited (shorted or overloaded): raise the load resistance, or buffer the output; the simulated output voltage is set by the limit, not by the feedback`,
        kindWord: `${Math.round(CURRENT_LIMIT_FRACTION * 100)} % of the short-circuit current (${formatEng(isc, 'A')})`,
      });
    }
  }
  // Common-mode range: op-amps need both inputs inside; a comparator only one.
  const cmLow = c.inputCommonModeLow?.typ ?? c.inputCommonModeLow?.max;
  const cmHigh = c.inputCommonModeHigh?.typ ?? c.inputCommonModeHigh?.min;
  if (cmLow !== undefined && cmHigh !== undefined) {
    const lo = op.vneg + cmLow;
    const hi = op.vpos + cmHigh;
    const outside = (v: number) => (v > hi ? v - hi : v < lo ? lo - v : 0);
    const inputs: [string, number][] = [['inp', op.vinp], ['inn', op.vinn]];
    const worst = inputs.reduce((a, b) => (outside(b[1]) > outside(a[1]) ? b : a));
    const best = inputs.reduce((a, b) => (outside(b[1]) < outside(a[1]) ? b : a));
    const [pin, v] = isComparator ? best : worst;
    const high = v > (lo + hi) / 2;
    out.push({
      code: 'R423',
      slug: 'opamp-input-common-mode',
      rating: high ? 'inputCommonModeHigh' : 'inputCommonModeLow',
      description: high ? `input ${pin} above V(v-) (common-mode top at V+ ${cmHigh >= 0 ? '+' : '−'} ${formatEng(Math.abs(cmHigh), 'V')})` : `input ${pin} below V(v+) (common-mode bottom at V− ${cmLow >= 0 ? '+' : '−'} ${formatEng(Math.abs(cmLow), 'V')})`,
      quantity: `${id}: V(${pin}) ${high ? '− V(v-)' : 'from V(v+)'}`,
      limit: high ? hi - op.vneg : op.vpos - lo,
      value: high ? v - op.vneg : op.vpos - v,
      unit: 'V',
      spec: high ? c.inputCommonModeHigh : c.inputCommonModeLow,
      advice: isComparator
        ? `bring at least one input of ${id} inside its common-mode range [${formatEng(lo, 'V')}, ${formatEng(hi, 'V')}] (a divider on the input or a wider supply)`
        : `keep both inputs of ${id} inside [${formatEng(lo, 'V')}, ${formatEng(hi, 'V')}]: shift the input bias, widen the supply, or use a rail-to-rail-input part (e.g. MCP6002)`,
      kindWord: 'input common-mode range',
    });
  }
  // Absolute maximum input voltage (rail-relative ratings only).
  for (const [pin, v] of [['inp', op.vinp], ['inn', op.vinn]] as const) {
    const max = r.inputVoltageMax;
    if (max?.max !== undefined && max.relativeTo) {
      const ref = max.relativeTo === 'V+' ? op.vpos : op.vneg;
      out.push({
        code: 'R424',
        slug: 'opamp-input-over-max',
        rating: 'inputVoltageMax',
        description: `input ${pin} above ${max.relativeTo === 'V+' ? 'V(v+)' : 'V(v-)'}`,
        quantity: `${id}: V(${pin}) − V(${max.relativeTo === 'V+' ? 'v+' : 'v-'})`,
        limit: max.max,
        value: v - ref,
        unit: 'V',
        spec: max,
        advice: `clamp input ${pin} of ${id} (series resistor + diodes to the rails) so it stays within the absolute maximum input voltage`,
        kindWord: 'absolute maximum',
      });
    }
    const min = r.inputVoltageMin;
    if (min?.min !== undefined && min.relativeTo) {
      const ref = min.relativeTo === 'V+' ? op.vpos : op.vneg;
      out.push({
        code: 'R424',
        slug: 'opamp-input-over-max',
        rating: 'inputVoltageMin',
        description: `input ${pin} below ${min.relativeTo === 'V+' ? 'V(v+)' : 'V(v-)'} (magnitude)`,
        quantity: `${id}: V(${min.relativeTo === 'V+' ? 'v+' : 'v-'}) − V(${pin})`,
        limit: -min.min,
        value: ref - v,
        unit: 'V',
        spec: min,
        advice: `input ${pin} of ${id} is driven below its negative-input limit (the input ESD/substrate diode conducts): clamp it or shift the bias`,
        kindWord: 'absolute maximum',
      });
    }
  }
  const supplyMin = c.supply.single?.min;
  if (supplyMin !== undefined) {
    out.push({
      code: 'R425',
      slug: 'opamp-supply-below-min',
      rating: 'supply.single.min',
      description: 'minimum recommended supply (required ≤ actual V(v+) − V(v-))',
      quantity: `${id}: V(v+) − V(v-)`,
      limit: vs,
      value: supplyMin,
      unit: 'V',
      spec: c.supply.single,
      advice: `raise the supply of ${id} to at least ${formatEng(supplyMin, 'V')} total — below it the datasheet (and the model's data) does not apply`,
      kindWord: 'recommended operating supply',
    });
  }
  return out;
}

/** Op-stage rating results of every Part() op-amp / comparator in the bench. */
export function evaluateAmplifierOpRatings(elab: Elaboration): RatingResult[] {
  const results: RatingResult[] = [];
  for (const id of [...elab.components.keys()].sort()) {
    const dev = elab.components.get(id) as unknown as AmpDevice;
    if ((dev.kind !== 'OpAmp' && dev.kind !== 'Comparator') || !dev.partId || !dev._op) continue;
    const entry = findPart(dev.partId);
    if (!entry || (entry.category !== 'opamp' && entry.category !== 'comparator')) continue;
    for (const check of checksFor(id, entry, dev._op, dev)) results.push(build(elab, id, entry, check));
  }
  return results;
}

function build(elab: Elaboration, id: string, entry: OpAmpPart | ComparatorPart, check: Check): RatingResult {
  const fail = check.value > check.limit;
  const cite = citation(entry, check.spec);
  const utilization = check.limit > 0 ? check.value / check.limit : check.value > 0 ? Infinity : 0;
  const result: RatingResult = {
    code: check.code,
    slug: check.slug,
    verdict: fail ? 'fail' : 'pass',
    component: id,
    part: entry.id,
    rating: check.rating,
    description: check.description,
    quantity: check.quantity,
    measure: 'value',
    limit: Number(check.limit.toPrecision(8)),
    allowed: Number(check.limit.toPrecision(8)),
    unit: check.unit,
    value: Number(check.value.toPrecision(8)),
    utilization: Number.isFinite(utilization) ? Number(utilization.toPrecision(4)) : 1e9,
    margin: Number((check.limit - check.value).toPrecision(6)),
    ...(check.spec?.conditions ? { conditions: { ...check.spec.conditions } } : {}),
    source: cite.source,
    ...(cite.url ? { url: cite.url } : {}),
    ...(check.spec?.estimated ? { estimated: true } : {}),
    // The op-amp/comparator model is a behavioural macro model fitted to the datasheet numbers.
    modelEstimated: true,
    confidence: 'verified',
  };
  if (!fail) return result;
  result.message =
    check.code === 'R425'
      ? `${id} (${entry.id}) supply is ${formatEng(check.limit, 'V')} — below the ${check.kindWord} minimum of ${formatEng(check.value, 'V')}`
      : `${id} (${entry.id}) ${check.description} is ${formatEng(check.value, check.unit)} — exceeds the ${check.kindWord} ${formatEng(check.limit, check.unit)}`;
  result.note = `checked at the DC operating point with ${entry.id}'s macro model (a behavioural model built from the datasheet values — see circuitsvibe catalog ${entry.id}). Source: ${cite.source}.${check.spec?.note ? ` Datasheet note: ${check.spec.note}` : ''}`;
  const fix: Fix = { kind: 'check-values', confidence: 'suggested', detail: check.advice };
  result.fixes = [fix];
  const at = elab.locOf.get(id);
  if (at) result.at = at;
  return result;
}

/** Attach a verified sizing hint to failed ratings (same contract as the assertion hints). */
export function attachAmplifierRatingHint(ratings: RatingResult[], hint: { param: string; passingRange: [number, number]; suggestedValue: number } | undefined): void {
  if (!hint) return;
  for (const r of ratings) {
    if (r.verdict !== 'fail') continue;
    r.hint = hint as RatingResult['hint'];
    const fix: Fix = {
      kind: 'set-param',
      confidence: 'verified',
      detail: `${hint.param} in [${formatEng(hint.passingRange[0])}, ${formatEng(hint.passingRange[1])}] keeps every rating and op assertion within limits (simulated) — try --set ${hint.param}=${Number(hint.suggestedValue.toPrecision(6))}`,
    };
    r.fixes = [fix, ...(r.fixes ?? [])];
  }
}
