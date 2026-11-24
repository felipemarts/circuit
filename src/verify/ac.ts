import type { Elaboration } from '../elab/bench';
import { SimulationSystem } from '../analysis/engine';
import type { Phasor } from '../analysis/context';
import { kindOf } from '../elab/describe';
import { checkMeasurement, type CheckOutcome } from './measure';
import { solverDiagnostic } from './solverDiag';
import type { StageOutcome } from './op';
import type { AcSweepConfig, AssertionResult, AssertionSpec, CheckSpec, Diagnostic } from '../schema/types';
import type { ComplexMNAMatrix } from '../solver/MNAMatrix';

const COMPONENT_PROBE_RE = /^([A-Za-z][A-Za-z0-9_]*)\.(i|v)$/;
/** 20·log10(1/√2): the half-power level. */
export const MINUS_3DB = 20 * Math.log10(Math.SQRT1_2);

/** Log-spaced sweep frequencies; both ends included exactly. */
export function acFrequencies(cfg: AcSweepConfig): number[] {
  const decades = Math.log10(cfg.to / cfg.from);
  const n = Math.max(1, Math.round(decades * cfg.pointsPerDecade));
  const fs: number[] = [];
  for (let k = 0; k <= n; k++) fs.push(k === n ? cfg.to : cfg.from * Math.pow(10, (decades * k) / n));
  return fs;
}

const cdiv = (a: Phasor, b: Phasor): Phasor => {
  const den = b[0] * b[0] + b[1] * b[1];
  return [(a[0] * b[0] + a[1] * b[1]) / den, (a[1] * b[0] - a[0] * b[1]) / den];
};
const gainDb = (h: Phasor) => 20 * Math.log10(Math.hypot(h[0], h[1]));
const phaseDeg = (h: Phasor) => (Math.atan2(h[1], h[0]) * 180) / Math.PI;

/** Unwrap `deg` to be within 180° of `near`. */
function unwrapNear(deg: number, near: number): number {
  return deg + 360 * Math.round((near - deg) / 360);
}

interface AcContext {
  elab: Elaboration;
  system: SimulationSystem;
  /** Stimulus phasor (unique AC source), or null when none/ambiguous. */
  stimulus: Phasor | null;
  solves: number;
}

function probePhasor(ctx: AcContext, expr: string, re: Float64Array, im: Float64Array, omega: number, matrix: ComplexMNAMatrix): Phasor {
  const m = expr.match(COMPONENT_PROBE_RE);
  if (m) {
    const comp = ctx.elab.components.get(m[1])!;
    const r = comp.acReadResults(re, im, omega, matrix);
    if (!r) return [NaN, NaN];
    if (m[2] === 'v') return r.voltage;
    return r.current ?? [NaN, NaN];
  }
  const node = ctx.elab.netNode.get(expr)!;
  return node.index > 0 ? [re[node.index - 1], im[node.index - 1]] : [0, 0];
}

/** H(f) = probe / reference at one frequency (one complex solve). */
function transfer(ctx: AcContext, probe: string, ref: string | undefined, f: number): Phasor {
  const { re, im, matrix } = ctx.system.acSolve(f);
  ctx.solves++;
  const omega = 2 * Math.PI * f;
  const p = probePhasor(ctx, probe, re, im, omega, matrix);
  const r = ref !== undefined ? probePhasor(ctx, ref, re, im, omega, matrix) : ctx.stimulus!;
  return cdiv(p, r);
}

/** Bisect (in log f) for the frequency where gain crosses `level` inside [fa, fb]. */
function refineCrossing(ctx: AcContext, probe: string, ref: string | undefined, fa: number, fb: number, level: number): number {
  let a = Math.log(fa);
  let b = Math.log(fb);
  const ga = gainDb(transfer(ctx, probe, ref, fa)) - level;
  for (let i = 0; i < 40; i++) {
    const mid = (a + b) / 2;
    const gm = gainDb(transfer(ctx, probe, ref, Math.exp(mid))) - level;
    if ((gm < 0) === (ga < 0)) a = mid;
    else b = mid;
    if (b - a < 1e-10) break;
  }
  return Math.exp((a + b) / 2);
}

/** Peak gain (dB) refined by golden-section search between the neighbours of sample `k`. */
function refinePeak(ctx: AcContext, probe: string, ref: string | undefined, curve: Curve, k: number): number {
  if (k === 0 || k === curve.f.length - 1) return curve.gain[k];
  let a = Math.log(curve.f[k - 1]);
  let b = Math.log(curve.f[k + 1]);
  const g = (lf: number) => gainDb(transfer(ctx, probe, ref, Math.exp(lf)));
  const r = (Math.sqrt(5) - 1) / 2;
  let c = b - r * (b - a);
  let d = a + r * (b - a);
  let gc = g(c);
  let gd = g(d);
  for (let i = 0; i < 60 && b - a > 1e-12; i++) {
    if (gc > gd) {
      b = d;
      d = c;
      gd = gc;
      c = b - r * (b - a);
      gc = g(c);
    } else {
      a = c;
      c = d;
      gc = gd;
      d = a + r * (b - a);
      gd = g(d);
    }
  }
  return Math.max(curve.gain[k], gc, gd);
}

interface Curve {
  f: number[];
  gain: number[];
  phase: number[];
}

function curveFor(ctx: AcContext, probe: string, ref: string | undefined, fs: number[]): Curve {
  const gain: number[] = [];
  const phase: number[] = [];
  for (const f of fs) {
    const h = transfer(ctx, probe, ref, f);
    gain.push(gainDb(h));
    const p = phaseDeg(h);
    phase.push(phase.length === 0 ? p : unwrapNear(p, phase[phase.length - 1]));
  }
  return { f: fs, gain, phase };
}

/** Unwrapped phase at an arbitrary frequency, consistent with the sweep curve. */
function phaseAtFreq(ctx: AcContext, probe: string, ref: string | undefined, curve: Curve, f: number): number {
  let nearest = 0;
  for (let k = 1; k < curve.f.length; k++) {
    if (Math.abs(Math.log(curve.f[k] / f)) < Math.abs(Math.log(curve.f[nearest] / f))) nearest = k;
  }
  return unwrapNear(phaseDeg(transfer(ctx, probe, ref, f)), curve.phase[nearest]);
}

function unityGain(ctx: AcContext, probe: string, ref: string | undefined, c: Curve): number | undefined {
  for (let k = 1; k < c.f.length; k++) {
    if (c.gain[k - 1] >= 0 && c.gain[k] < 0) return refineCrossing(ctx, probe, ref, c.f[k - 1], c.f[k], 0);
  }
  return undefined;
}

function measureAc(ctx: AcContext, spec: AssertionSpec, curve: Curve): CheckOutcome {
  const check = spec.check;
  const probe = spec.probe;
  const ref = spec.ref;
  switch (check.op) {
    case 'gainAt':
      return checkMeasurement(check.check, gainDb(transfer(ctx, probe, ref, check.f)));
    case 'phaseAt':
      return checkMeasurement(check.check, phaseAtFreq(ctx, probe, ref, curve, check.f));
    case 'bandwidth3dB': {
      let peak = 0;
      for (let k = 1; k < curve.gain.length; k++) if (curve.gain[k] > curve.gain[peak]) peak = k;
      const level = refinePeak(ctx, probe, ref, curve, peak) + MINUS_3DB;
      let fHigh: number | undefined;
      for (let k = peak + 1; k < curve.f.length; k++) {
        if (curve.gain[k] < level) {
          fHigh = refineCrossing(ctx, probe, ref, curve.f[k - 1], curve.f[k], level);
          break;
        }
      }
      let fLow: number | undefined;
      for (let k = peak - 1; k >= 0; k--) {
        if (curve.gain[k] < level) {
          fLow = refineCrossing(ctx, probe, ref, curve.f[k], curve.f[k + 1], level);
          break;
        }
      }
      if (fHigh === undefined) {
        return checkMeasurement(
          check.check,
          undefined,
          `no upper -3 dB crossing within the sweep (peak ${curve.gain[peak].toFixed(3)} dB at ${curve.f[peak].toPrecision(4)} Hz); extend 'to'`,
        );
      }
      if (fLow === undefined) {
        return checkMeasurement(check.check, fHigh, `low-pass: upper -3 dB frequency (relative to the ${curve.gain[peak].toFixed(3)} dB peak)`);
      }
      return checkMeasurement(
        check.check,
        fHigh - fLow,
        `band-pass: f_high - f_low = ${fHigh.toPrecision(6)} - ${fLow.toPrecision(6)} Hz around the ${curve.gain[peak].toFixed(3)} dB peak at ${curve.f[peak].toPrecision(4)} Hz`,
      );
    }
    case 'unityGainFrequency': {
      const fu = unityGain(ctx, probe, ref, curve);
      return checkMeasurement(check.check, fu, fu === undefined ? 'the gain never falls through 0 dB within the sweep' : undefined);
    }
    case 'phaseMargin': {
      const fu = unityGain(ctx, probe, ref, curve);
      if (fu === undefined) return checkMeasurement(check.check, undefined, 'no unity-gain crossing within the sweep, so the phase margin is undefined');
      return checkMeasurement(check.check, 180 + phaseAtFreq(ctx, probe, ref, curve, fu), `at the unity-gain frequency ${fu.toPrecision(6)} Hz`);
    }
    default:
      throw new Error(`check '${(check as CheckSpec).op}' is not an AC check`);
  }
}

function configKey(c: AcSweepConfig): string {
  return JSON.stringify([c.from, c.to, c.pointsPerDecade]);
}

/** Independent sources with a nonzero AC stimulus, sorted by id. */
function acSources(elab: Elaboration): { id: string; phasor: Phasor }[] {
  const out: { id: string; phasor: Phasor }[] = [];
  for (const id of [...elab.components.keys()].sort()) {
    const comp = elab.components.get(id)! as unknown as { acStimulus?: { mag: number; phase: number } | null };
    const kind = kindOf(elab.components.get(id)!);
    if (kind !== 'VoltageSource' && kind !== 'CurrentSource') continue;
    const ac = comp.acStimulus;
    if (ac && ac.mag !== 0) {
      const ph = (ac.phase * Math.PI) / 180;
      out.push({ id, phasor: [ac.mag * Math.cos(ph), ac.mag * Math.sin(ph)] });
    }
  }
  return out;
}

/** L2b — AC small-signal stage. */
export function runAc(elab: Elaboration): StageOutcome {
  const acAssertions = elab.assertions.filter(a => a.stage === 'ac');
  const sources = acSources(elab);
  const needStimulus = acAssertions.filter(a => a.ref === undefined);
  const diagnostics: Diagnostic[] = [];

  if (sources.length === 0) {
    const vs = [...elab.components.entries()].filter(([, c]) => kindOf(c) === 'VoltageSource').map(([id]) => id).sort();
    diagnostics.push({
      code: 'T003',
      slug: 'no-ac-stimulus',
      severity: 'error',
      stage: 'ac',
      message: 'AC assertions but no source has an AC stimulus — every small-signal quantity would be 0',
      note: 'AC analysis is driven only by sources given an `ac` magnitude; the DC values only set the operating point',
      fixes: [
        {
          kind: 'edit-source',
          confidence: 'suggested',
          detail: vs.length > 0
            ? `give the input source an AC stimulus, e.g. new VoltageSource({ dc: <bias>, ac: 1 }) for ${vs[0]}`
            : 'add an input source with an AC stimulus, e.g. new VoltageSource({ dc: 0, ac: 1 })',
        },
      ],
      at: vs.length > 0 ? elab.locOf.get(vs[0]) : acAssertions[0]?.at,
    });
  } else if (sources.length > 1 && needStimulus.length > 0) {
    diagnostics.push({
      code: 'T004',
      slug: 'ambiguous-ac-reference',
      severity: 'error',
      stage: 'ac',
      message: `${sources.length} sources have an AC stimulus (${sources.map(s => s.id).join(', ')}) — gain relative to "the stimulus" is ambiguous`,
      subject: { components: sources.map(s => s.id) },
      note: 'gainAt/phaseAt/... divide the probe by the stimulus phasor; with several stimuli, name the reference explicitly',
      fixes: [
        {
          kind: 'edit-assertion',
          confidence: 'suggested',
          detail: `name the reference probe: tb.expect.ac({...}).probe('out', { ref: 'in' }), or keep the ac stimulus on one source only`,
        },
      ],
      at: needStimulus[0].at,
    });
  }
  if (diagnostics.length > 0) return { stage: { verdict: 'error' }, diagnostics };

  let system: SimulationSystem;
  try {
    system = new SimulationSystem(elab.circuit);
  } catch (err) {
    return { stage: { verdict: 'error' }, diagnostics: [solverDiagnostic(elab, err, 'ac')] };
  }
  try {
    const missing = system.componentsWithoutAcModel();
    if (missing.length > 0) {
      const ids = missing.map(c => elab.idOf.get(c) ?? kindOf(c)).sort();
      return {
        stage: { verdict: 'error' },
        diagnostics: [
          {
            code: 'S204',
            slug: 'no-ac-model',
            severity: 'error',
            stage: 'ac',
            message: `${ids.join(', ')} ha${ids.length > 1 ? 've' : 's'} no small-signal model — the AC analysis cannot linearize ${ids.length > 1 ? 'them' : 'it'}`,
            subject: { components: ids },
            note: 'custom components need an `ac(ctx)` stamp in defineComponent (conductances, capacitances, transconductances around the operating point) to take part in AC analysis',
            fixes: [
              {
                kind: 'edit-component',
                confidence: 'suggested',
                detail: `add ac(ctx) { ctx.stampConductance(...); ctx.stampCapacitance(...); } to the defineComponent of ${missing.map(c => kindOf(c)).filter((k, i, a) => a.indexOf(k) === i).join(', ')}`,
              },
            ],
            at: elab.locOf.get(ids[0]),
          },
        ],
      };
    }

    let op;
    try {
      op = system.operatingPoint();
    } catch (err) {
      return { stage: { verdict: 'error' }, diagnostics: [solverDiagnostic(elab, err, 'ac')] };
    }
    system.publish(op.x);

    const ctx: AcContext = { elab, system, stimulus: sources.length === 1 ? sources[0].phasor : null, solves: 0 };
    const groups = new Map<string, { config: AcSweepConfig; assertions: AssertionSpec[] }>();
    for (const a of acAssertions) {
      const key = configKey(a.ac!);
      const group = groups.get(key) ?? { config: a.ac!, assertions: [] };
      group.assertions.push(a);
      groups.set(key, group);
    }

    const results: AssertionResult[] = [];
    let points = 0;
    try {
      for (const key of [...groups.keys()].sort()) {
        const { config, assertions } = groups.get(key)!;
        const fs = acFrequencies(config);
        points += fs.length;
        const curves = new Map<string, Curve>();
        for (const spec of assertions) {
          const ck = `${spec.probe}|${spec.ref ?? ''}`;
          let curve = curves.get(ck);
          if (!curve) {
            curve = curveFor(ctx, spec.probe, spec.ref, fs);
            curves.set(ck, curve);
          }
          const out = measureAc(ctx, spec, curve);
          const result: AssertionResult = {
            id: spec.id,
            stage: 'ac',
            probe: spec.probe,
            ...(spec.ref ? { ref: spec.ref } : {}),
            check: spec.check,
            verdict: out.pass ? 'pass' : 'fail',
            ...(out.measured !== undefined ? { measured: out.measured } : {}),
            ...(spec.at ? { at: spec.at } : {}),
          };
          if (!out.pass) {
            if (out.outsideBy !== undefined) {
              result.margin = { outsideBy: out.outsideBy, ...(out.ratio !== undefined ? { ratio: out.ratio } : {}) };
            }
            if (out.note) result.note = out.note;
          }
          results.push(result);
        }
      }
    } catch (err) {
      return { stage: { verdict: 'error' }, diagnostics: [solverDiagnostic(elab, err, 'ac')] };
    }
    results.sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)));
    const failed = results.some(r => r.verdict === 'fail');
    return {
      stage: {
        verdict: failed ? 'fail' : 'pass',
        solver: {
          method: 'complex-lu',
          iterations: op.telemetry.iterations,
          points,
          ...(op.telemetry.aids ? { aids: [...op.telemetry.aids] } : {}),
        },
        assertions: results,
      },
      diagnostics: [],
    };
  } finally {
    system.release();
  }
}
