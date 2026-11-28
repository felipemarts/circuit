import type { Elaboration } from '../elab/bench';
import { layoutBoard, type BoardLayout } from '../pcb/layout';
import { routeBoard, type NetPlan } from '../pcb/route';
import { checkDesignRules, type DrcViolation } from '../pcb/drc';
import { IPC2221_SOURCE, requiredWidth, traceCapacity } from '../pcb/ipc2221';
import { round } from '../pcb/geometry';
import type { PcbRouting } from '../pcb/types';
import type { Diagnostic, RatingResult } from '../schema/types';
import { formatEng } from '../elab/units';
import type { StageOutcome } from './op';

/** Currents below this do not get a P812 row (signal nets). */
const RATED_CURRENT = 1e-3;
/** Auto-sized widths are rounded up to this step (mm). */
const WIDTH_STEP = 0.05;
/** Widest trace the stage sizes by itself (mm); beyond it the trace is rated and fails P812. */
const MAX_AUTO_WIDTH = 5;
/** At most this many P811 diagnostics; the rest are counted in the last one. */
const MAX_DRC = 20;

/**
 * L4: pcb — the board of a bench that declares one (tb.board). Resolves
 * footprints and pin → pad maps, checks the placement (P801–P807), then —
 * when the placement is sound — sizes every net's traces from its simulated
 * current (IPC-2221), autoroutes the board, checks the copper against the
 * design rules (P810 unrouted, P811 clearance) and rates each trace's
 * current (P812, like a datasheet rating: exit 1). Structural problems are
 * exit 2: the board cannot be built as laid out.
 */
export function runPcb(elab: Elaboration): StageOutcome {
  const layout = layoutBoard(elab.pcb!, elab.netlist.components, elab.pcbLocs ?? {});
  const diagnostics = [...layout.diagnostics];
  const board = layout.board;
  if (diagnostics.some(d => d.severity === 'error') || board.route === false) {
    return { stage: { verdict: diagnostics.some(d => d.severity === 'error') ? 'error' : 'pass', pcb: layout.record }, diagnostics };
  }

  // ── trace widths from the simulated currents ──
  const netNames = new Set(elab.netlist.components.flatMap(c => Object.values(c.pins)));
  for (const name of Object.keys(board.nets ?? {})) {
    if (!netNames.has(name)) {
      diagnostics.push({
        code: 'P808',
        slug: 'unknown-net',
        severity: 'error',
        stage: 'pcb',
        message: `tb.board({ nets }) sets a width for net '${name}', which is not a net of this circuit`,
        note: 'per-net widths are keyed by net name: name the net first with tb.name(...)',
        evidence: { net: name, nets: [...netNames].filter(n => !/^n\d+$/.test(n)).sort() },
        fixes: [{ kind: 'name-net', confidence: 'suggested', detail: `tb.name('${name}', <a pin of that net>), or fix the key in tb.board({ nets })` }],
      });
    }
  }
  if (diagnostics.some(d => d.severity === 'error')) return { stage: { verdict: 'error', pcb: layout.record }, diagnostics };

  const { netCurrent, source } = netCurrents(elab);
  const copperOz = board.rules.copper ?? 1;
  const tempRise = board.rules.tempRise ?? 10;
  const plans: NetPlan[] = [...new Set(layout.ratsnest.map(a => a.net))].sort().map(net => {
    const current = netCurrent.get(net);
    const required = current !== undefined ? requiredWidth(current, copperOz, tempRise) : undefined;
    const override = board.nets?.[net]?.width;
    const auto = required !== undefined && required > board.rules.trace ? Math.min(MAX_AUTO_WIDTH, round(Math.ceil(required / WIDTH_STEP - 1e-9) * WIDTH_STEP)) : board.rules.trace;
    return {
      net,
      width: override ?? auto,
      widthFrom: override !== undefined ? 'net' : auto > board.rules.trace ? 'current' : 'rule',
      ...(current !== undefined ? { current: Number(current.toPrecision(4)) } : {}),
      ...(required !== undefined ? { requiredWidth: round(required) } : {}),
    };
  });

  // ── route + design-rule check ──
  const { routing, copper } = routeBoard(layout, plans, source);
  layout.record.routing = routing;
  diagnostics.push(...unroutedDiagnostics(routing, layout));
  diagnostics.push(...drcDiagnostics(checkDesignRules(copper, board, layout.outline)));
  if (source === 'none') {
    diagnostics.push({
      code: 'P813',
      slug: 'widths-not-current-checked',
      severity: 'warning',
      stage: 'pcb',
      message: 'trace widths were not checked against the circuit currents: this run simulated nothing (every trace uses rules.trace or tb.board({ nets }))',
      note: 'the pcb stage sizes each trace from the currents of the op and tran stages; --stage pcb alone skips them',
      fixes: [{ kind: 'run-simulation', confidence: 'mechanical', detail: 'verify with the simulation stages (default: every stage) to size and rate the traces' }],
    });
  }

  // ── P812: each trace's current against its IPC-2221 capacity ──
  const ratings: RatingResult[] = [];
  const derate = elab.ratingOptions.enabled ? elab.ratingOptions.derate : 1;
  for (const r of routing.nets) {
    if (r.current === undefined || r.current < RATED_CURRENT || !elab.ratingOptions.enabled) continue;
    const limit = traceCapacity(r.width, copperOz, tempRise);
    const allowed = limit * derate;
    const fail = r.current > allowed;
    const needed = requiredWidth(r.current / derate, copperOz, tempRise);
    const widen = round(Math.ceil(needed / WIDTH_STEP - 1e-9) * WIDTH_STEP);
    ratings.push({
      code: 'P812',
      slug: 'trace-current',
      verdict: fail ? 'fail' : 'pass',
      component: r.net,
      part: 'PCB trace',
      rating: 'Imax',
      description: `current a ${r.width} mm trace carries with a ${tempRise} °C rise (${copperOz} oz copper, outer layer)`,
      quantity: `${r.net}.i`,
      measure: 'rms',
      limit: round(limit),
      ...(derate !== 1 ? { derate } : {}),
      allowed: round(allowed),
      unit: 'A',
      value: r.current,
      utilization: round(r.current / allowed),
      margin: round(allowed - r.current),
      conditions: { width: r.width, copper: copperOz, tempRise },
      source: IPC2221_SOURCE,
      confidence: 'verified',
      ...(fail
        ? {
            message: `net ${r.net} carries ${formatEng(r.current, 'A')} but its ${r.width} mm trace is rated ${formatEng(allowed, 'A')} (${(r.current / allowed).toFixed(2)}×) — it heats more than ${tempRise} °C`,
            ...(r.widthFrom === 'net'
              ? {
                  note: `the width comes from tb.board({ nets: { ${r.net}: { width: ${r.width} } } }); the simulated current needs ≥ ${widen} mm`,
                  fixes: [{ kind: 'widen-trace', confidence: 'mechanical' as const, detail: `tb.board({ …, nets: { ${r.net}: { width: ${widen} } } }) — or drop the override and let the pcb stage size it from the current` }],
                }
              : {
                  note: `the current needs a ${widen} mm trace; the stage sizes traces up to ${MAX_AUTO_WIDTH} mm by itself`,
                  fixes: [
                    { kind: 'heavier-copper', confidence: 'suggested' as const, detail: `use heavier copper (tb.board({ rules: { copper: 2 } }) halves the width) or allow more heating (rules.tempRise), then set the width with tb.board({ nets: { ${r.net}: { width } } })` },
                    { kind: 'check-current', confidence: 'suggested' as const, detail: `check that ${formatEng(r.current, 'A')} is the real continuous current of net ${r.net} (stages op and tran)` },
                  ],
                }),
          }
        : {}),
    });
  }

  const errors = diagnostics.some(d => d.severity === 'error');
  return {
    stage: { verdict: errors ? 'error' : ratings.some(r => r.verdict === 'fail') ? 'fail' : 'pass', pcb: layout.record, ...(ratings.length > 0 ? { ratings } : {}) },
    diagnostics,
  };
}

/**
 * The current each net carries between its pads (the largest current any
 * copper segment of it carries, src/verify/currents.ts netBound): at the
 * operating point and as the transient RMS — the larger of the two.
 */
function netCurrents(elab: Elaboration): { netCurrent: Map<string, number>; source: PcbRouting['currents'] } {
  const { op, tran } = elab.pcbCurrents ?? {};
  const netCurrent = new Map<string, number>();
  for (const per of [op, tran]) {
    if (!per) continue;
    for (const [net, i] of Object.entries(per)) if (Number.isFinite(i)) netCurrent.set(net, Math.max(netCurrent.get(net) ?? 0, i));
  }
  return { netCurrent, source: tran ? 'op+tran' : op ? 'op' : 'none' };
}

function unroutedDiagnostics(routing: PcbRouting, layout: BoardLayout): Diagnostic[] {
  const byNet = new Map<string, PcbRouting['unrouted']>();
  for (const a of routing.unrouted) byNet.set(a.net, [...(byNet.get(a.net) ?? []), a]);
  const out: Diagnostic[] = [];
  const oneLayer = layout.board.layers === 1;
  for (const [net, wires] of byNet) {
    const route = routing.nets.find(n => n.net === net)!;
    const comps = [...new Set(wires.flatMap(w => [w.from, w.to]).map(ref => ref.slice(0, ref.indexOf('.'))))].sort();
    out.push({
      code: 'P810',
      slug: 'unrouted',
      severity: 'error',
      stage: 'pcb',
      message: `net ${net}: ${wires.length} connection${wires.length > 1 ? 's' : ''} could not be routed (${wires.map(w => `${w.from} → ${w.to}`).join(', ')})`,
      subject: { net, components: comps },
      note: `the autorouter found no path for a ${route.width} mm trace keeping ${layout.board.rules.clearance} mm from other copper${oneLayer ? ' on the single copper layer' : ''}; the airwires left are in stages.pcb.pcb.routing.unrouted`,
      evidence: { width: route.width, widthFrom: route.widthFrom, unrouted: wires },
      fixes: [
        { kind: 'move-part', confidence: 'suggested', detail: `give the router room: move ${comps.join(' / ')} so the airwire does not have to cross other nets' pads, or rotate them so their pads face each other` },
        ...(oneLayer ? [{ kind: 'two-layers', confidence: 'suggested' as const, detail: 'route on both sides: tb.board({ …, layers: 2 })' }] : []),
        ...(route.widthFrom === 'net' ? [{ kind: 'narrower-trace', confidence: 'suggested' as const, detail: `tb.board({ nets: { ${net}: { width } } }) sets ${route.width} mm: a narrower trace fits more gaps (P812 rates it against the current)` }] : []),
        { kind: 'enlarge-board', confidence: 'suggested', detail: 'or enlarge the board (tb.board({ width, height })) and spread the parts' },
      ],
    });
  }
  return out;
}

function drcDiagnostics(violations: DrcViolation[]): Diagnostic[] {
  const out: Diagnostic[] = [];
  const what = (it: DrcViolation['a']): string => (it.kind === 'pad' ? `pad ${it.ref}` : it.kind === 'hole' ? 'a drilled hole' : `a ${it.kind} of net ${it.net}`);
  for (const v of violations.slice(0, MAX_DRC)) {
    const other = v.kind === 'edge' ? 'the board edge' : what(v.b!);
    out.push({
      code: 'P811',
      slug: 'clearance',
      severity: 'error',
      stage: 'pcb',
      message: `${what(v.a)} is ${v.distance} mm from ${other} on the ${v.layer} layer (rule: ≥ ${v.required} mm) near (${v.x}, ${v.y}) mm`,
      subject: { net: v.a.net },
      note: 'copper of different nets closer than the clearance can short when the board is etched; copper too close to the edge or to a hole gets cut',
      evidence: { kind: v.kind, layer: v.layer, distance: v.distance, required: v.required, x: v.x, y: v.y, ...(v.b ? { other: v.b.kind === 'pad' ? v.b.ref : v.b.kind } : {}) },
      fixes: [{ kind: 'reroute', confidence: 'suggested', detail: 'move the parts around that spot apart (the router keeps the clearance by construction; report the bench if this persists)' }],
    });
  }
  if (violations.length > MAX_DRC) out[out.length - 1].note += ` — ${violations.length - MAX_DRC} more violations not listed`;
  return out;
}
