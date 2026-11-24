import { elaborate, type BenchDescriptor } from '../elab/bench';
import { normalizeDcSweep } from '../elab/expect';
import { kindOf, isOverridable } from '../elab/describe';
import { runLint } from '../verify/lint';
import { runSweep } from '../verify/dc';
import { ENGINE } from '../schema/version';
import type { DcSweepConfig, Diagnostic } from '../schema/types';

export const SWEEP_SCHEMA = 'circuitsvibe-sweep/0.1';

export interface SweepRecord {
  schema: typeof SWEEP_SCHEMA;
  bench: string;
  engine: string;
  netlist: string;
  overrides?: Record<string, number>;
  sweep: DcSweepConfig;
  /** Swept values, in sweep order. */
  x: number[];
  /** probe → value at every swept point. */
  probes: Record<string, number[]>;
  solver?: { method: 'linear' | 'newton-raphson'; iterations: number; aidedPoints?: number };
  diagnostics: Diagnostic[];
  exitCode: 0 | 2 | 3;
}

import { COMPONENT_PROBE_RE, probeQuantitiesOf } from '../elab/quantity';

/**
 * `circuitsvibe sweep`: lint, then a DC sweep of one source (or component
 * value), returning every probe's curve. Deterministic: same bench + flags ⇒
 * byte-identical JSON.
 */
export function sweepBench(
  desc: BenchDescriptor,
  opts: {
    source?: string;
    param?: string;
    from: string;
    to: string;
    points?: number;
    step?: string;
    probes: string[];
    overrides?: Record<string, number>;
  },
): SweepRecord {
  const overrides = opts.overrides ?? {};
  const elab = elaborate(desc, overrides);
  const sweep = normalizeDcSweep({
    source: opts.source,
    param: opts.param,
    from: opts.from,
    to: opts.to,
    points: opts.points,
    step: opts.step,
  });
  const id = sweep.source ?? sweep.param!;
  const comp = elab.components.get(id);
  if (!comp) throw new Error(`no component with id '${id}'. Known ids: ${[...elab.components.keys()].join(', ')}`);
  if (sweep.source !== undefined && !['VoltageSource', 'CurrentSource'].includes(kindOf(comp))) {
    throw new Error(`--source ${id} is a ${kindOf(comp)}; use --param ${id} to sweep a component value`);
  }
  if (sweep.param !== undefined && !isOverridable(comp)) throw new Error(`--param ${id}: ${kindOf(comp)} has no sweepable value`);

  const named = [...elab.netNode.keys()].filter(n => n !== 'gnd' && !/^n\d+$/.test(n)).sort();
  const probes = opts.probes.length > 0 ? opts.probes : named;
  if (probes.length === 0) throw new Error(`no probes: pass --probe out,R1.i (or name a net in the bench with tb.name)`);
  for (const p of probes) {
    const m = p.match(COMPONENT_PROBE_RE);
    if (m) {
      const c = elab.components.get(m[1]);
      if (!c || !probeQuantitiesOf(c).includes(m[2])) {
        throw new Error(`probe '${p}': no component '${m[1]}' exposing '${m[2]}'${c ? ` (available: ${probeQuantitiesOf(c).join(', ')})` : ''}`);
      }
    } else if (!named.includes(p)) {
      throw new Error(`unknown probe '${p}': use '<id>.i' / '<id>.v' or a named net (${named.join(', ') || 'none'})`);
    }
  }

  const base: SweepRecord = {
    schema: SWEEP_SCHEMA,
    bench: desc.name,
    engine: ENGINE,
    netlist: elab.netlist.hash,
    ...(Object.keys(overrides).length > 0 ? { overrides } : {}),
    sweep,
    x: [],
    probes: {},
    diagnostics: [],
    exitCode: 0,
  };
  const lint = runLint(elab);
  base.diagnostics.push(...lint);
  if (lint.some(d => d.severity === 'error')) return { ...base, exitCode: 2 };

  const out = runSweep(elab, sweep, probes);
  if (!out.ok) {
    base.diagnostics.push(out.diagnostic);
    return { ...base, exitCode: out.diagnostic.code.startsWith('T') ? 3 : 2 };
  }
  return {
    ...base,
    x: out.curve.x,
    probes: out.curve.values,
    solver: {
      method: out.curve.linear ? 'linear' : 'newton-raphson',
      iterations: out.curve.iterations,
      ...(out.curve.aidedPoints > 0 ? { aidedPoints: out.curve.aidedPoints } : {}),
    },
  };
}

const cell = (v: number) => {
  const s = Number(v.toPrecision(6)).toString();
  return s.padStart(14);
};

/** Fixed-width table: one row per swept point. */
export function renderSweepTable(r: SweepRecord): string {
  const id = r.sweep.source ?? r.sweep.param!;
  const lines: string[] = [];
  lines.push(`bench ${r.bench}  netlist ${r.netlist.slice(0, 12)}  sweep ${id} ${r.sweep.from} → ${r.sweep.to} (${r.sweep.points} points)  (${r.engine})`);
  for (const d of r.diagnostics) {
    lines.push(`  ${d.code} ${d.severity === 'warning' ? 'warning ' : ''}${d.message}${d.at ? `  at ${d.at}` : ''}`);
  }
  if (r.x.length > 0) {
    const names = Object.keys(r.probes);
    lines.push([id, ...names].map(n => n.padStart(14)).join(''));
    for (let k = 0; k < r.x.length; k++) {
      lines.push([cell(r.x[k]), ...names.map(n => cell(r.probes[n][k]))].join(''));
    }
  }
  lines.push(`exit ${r.exitCode}`);
  return lines.join('\n');
}
