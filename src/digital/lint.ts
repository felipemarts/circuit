/**
 * Structural lint for digital netlists (F130–F134). Pure graph analysis on
 * the plain-JSON netlist, before any event is simulated.
 *
 *   F130 floating-input      input pin on a net nothing drives
 *   F131 multiple-drivers    push-pull output shares its net with another driver
 *   F132 output-short        two outputs of the same part tied together
 *   F133 zero-delay-loop     combinational feedback whose delays sum to zero
 *   F134 unconnected-clock   clock pin on a net nothing drives
 */
import type { DigitalDiagnostic } from './diagnostics';
import { makeDiagnostic } from './diagnostics';
import type { DigitalInputPort, DigitalNetlist, ResolvedComponent } from './netlist';
import { resolveNetlist } from './netlist';
import { partDef } from './parts';
import { toTicks } from './units';

interface NetInfo {
  name: string;
  /** Output refs with their driver kind. */
  drivers: { ref: string; comp: string; kind: 'strong' | 'tristate' | 'weak' }[];
  input: boolean;
  loads: { ref: string; comp: string; pin: string; clock: boolean }[];
}

const isAuto = (net: string): boolean => net.includes('.');

/** How to attach a new driver to a net in builder code. */
function attach(net: string, part: string, id: string): string {
  if (!isAuto(net)) return `c.add('${id}', ${part}, { y: '${net}' });`;
  const [comp, pin] = net.split('.');
  return `c.add('${id}', ${part}).pin('y').connect(c.get('${comp}').pin('${pin}'));`;
}

const safeId = (s: string): string => s.replace(/[^A-Za-z0-9_]/g, '_');

export function lintDigital(netlist: Pick<DigitalNetlist, 'components'> & { inputs?: DigitalInputPort[] }): DigitalDiagnostic[] {
  const r = resolveNetlist(netlist);
  const nets = new Map<string, NetInfo>(r.netNames.map(n => [n, { name: n, drivers: [], input: false, loads: [] }]));
  const byId = new Map<string, ResolvedComponent>(r.components.map(c => [c.id, c]));
  for (const i of r.inputs) nets.get(i.net)!.input = true;
  for (const c of r.components) {
    const def = partDef(c.type);
    for (const pin of c.layout.outputs) nets.get(c.pins[pin])!.drivers.push({ ref: `${c.id}.${pin}`, comp: c.id, kind: def.driver });
    for (const pin of c.layout.inputs) {
      nets.get(c.pins[pin])!.loads.push({ ref: `${c.id}.${pin}`, comp: c.id, pin, clock: c.layout.clocks.includes(pin) });
    }
  }
  const at = (comp: string): string | undefined => byId.get(comp)?.at;
  const out: DigitalDiagnostic[] = [];

  for (const net of nets.values()) {
    const driven = net.drivers.length > 0 || net.input;

    // ── F130 / F134: undriven inputs ──
    if (!driven) {
      const data = net.loads.filter(l => !l.clock);
      const clocks = net.loads.filter(l => l.clock);
      if (data.length > 0) {
        const refs = data.map(l => l.ref).sort();
        const comps = [...new Set(data.map(l => l.comp))].sort();
        out.push(
          makeDiagnostic('F130', {
            message: `input${refs.length > 1 ? 's' : ''} ${refs.join(', ')} ${refs.length > 1 ? 'are' : 'is'} not driven by anything${isAuto(net.name) ? '' : ` (net ${net.name})`} — floating`,
            subject: { net: net.name, components: comps, pins: refs },
            note: 'a floating CMOS input picks up noise and sits mid-rail; the simulator reads it as Z → X, so everything downstream becomes unknown',
            fixes: [
              { kind: 'rewire', confidence: 'suggested', detail: `connect ${refs[0]} to the output that should drive it` },
              {
                kind: 'add-component',
                confidence: 'mechanical',
                detail: `tie it to a fixed level with a Const (or a Pull for a default), or declare it as an external input with c.input(...)`,
                patch: attach(net.name, 'new Const(0)', `K_${safeId(net.name)}`),
              },
            ],
            at: at(comps[0]),
          }),
        );
      }
      for (const l of clocks) {
        out.push(
          makeDiagnostic('F134', {
            message: `clock input ${l.ref} is not driven${isAuto(net.name) ? '' : ` (net ${net.name} has no driver)`} — ${l.comp} can never change state`,
            subject: { net: net.name, components: [l.comp], pins: [l.ref] },
            note: 'an edge-triggered element only acts on a clock edge; with a floating clock it holds its power-on state forever (or goes X on noise)',
            fixes: [
              {
                kind: 'add-component',
                confidence: 'mechanical',
                detail: `drive ${l.ref} from a Clock (or the clock net of the design)`,
                patch: attach(net.name, `new Clock({ freq: '1M' })`, `CLK_${safeId(l.comp)}`),
              },
            ],
            at: at(l.comp),
          }),
        );
      }
    }

    // ── F132: outputs of the same part tied together ──
    const perComp = new Map<string, string[]>();
    for (const d of net.drivers) perComp.set(d.comp, [...(perComp.get(d.comp) ?? []), d.ref]);
    for (const [comp, refs] of [...perComp.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      if (refs.length < 2) continue;
      refs.sort();
      out.push(
        makeDiagnostic('F132', {
          message: `outputs ${refs.join(' and ')} of ${comp} are shorted together${isAuto(net.name) ? '' : ` on net ${net.name}`}`,
          subject: { net: net.name, components: [comp], pins: refs },
          note: 'two outputs of one part (e.g. q and qn) normally drive different values; tied together they fight every time they differ',
          fixes: [{ kind: 'rewire', confidence: 'suggested', detail: `keep only one of ${refs.join(', ')} on this net` }],
          at: at(comp),
        }),
      );
    }

    // ── F131: push-pull output sharing a net with other drivers ──
    const strongs = net.drivers.filter(d => d.kind === 'strong');
    const others = net.drivers.filter(d => d.kind !== 'weak');
    const distinctComps = new Set(others.map(d => d.comp));
    if (strongs.length > 0 && (distinctComps.size > 1 || (net.input && others.length > 0))) {
      const refs = others.map(d => d.ref).sort();
      const comps = [...distinctComps].sort();
      out.push(
        makeDiagnostic('F131', {
          message: `net ${net.name} has ${refs.length + (net.input ? 1 : 0)} drivers (${[...refs, ...(net.input ? [`external input ${net.name}`] : [])].join(', ')}) and ${strongs.map(s => s.ref).sort().join(', ')} ${strongs.length > 1 ? 'are' : 'is'} push-pull — they will fight whenever they disagree`,
          subject: { net: net.name, components: comps, pins: refs },
          note: 'a push-pull output always drives 0 or 1; any other driver on the same net causes contention (X, and real over-current) whenever their values differ. Shared buses need tri-state outputs',
          fixes: [
            { kind: 'tristate', confidence: 'suggested', detail: `replace the outputs driving ${net.name} with TriBuf parts whose enables are mutually exclusive, or merge the signals with a gate or Mux` },
          ],
          at: at(comps[0]),
        }),
      );
    }
  }

  // ── F133: zero-delay combinational loops (Tarjan SCC over nets) ──
  const idx = new Map<string, number>(r.netNames.map((n, i) => [n, i]));
  const edges: { to: number; comp: string }[][] = r.netNames.map(() => []);
  for (const c of r.components) {
    for (const p of partDef(c.type).combPaths(c.params)) {
      if (toTicks(p.delay) !== 0) continue;
      edges[idx.get(c.pins[p.from])!].push({ to: idx.get(c.pins[p.to])!, comp: c.id });
    }
  }
  for (const list of edges) list.sort((a, b) => a.to - b.to || (a.comp < b.comp ? -1 : a.comp > b.comp ? 1 : 0));
  for (const scc of stronglyConnected(edges)) {
    const inScc = new Set(scc);
    const selfLoop = scc.length === 1 && edges[scc[0]].some(e => e.to === scc[0]);
    if (scc.length < 2 && !selfLoop) continue;
    const cycle = shortestCycle(edges, Math.min(...scc), inScc);
    const comps = [...new Set(scc.flatMap(n => edges[n].filter(e => inScc.has(e.to)).map(e => e.comp)))].sort();
    const netNames = scc.map(n => r.netNames[n]).sort();
    const path = cycle.map(s => `${r.netNames[s.net]} →(${s.comp})`).join(' ') + ` ${r.netNames[cycle[0].net]}`;
    out.push(
      makeDiagnostic('F133', {
        message: `zero-delay combinational loop through ${comps.join(', ')}: ${path}`,
        subject: { net: netNames[0], nets: netNames, components: comps },
        note: 'with no propagation delay the loop is resolved entirely in delta cycles at one instant: an inverting loop oscillates forever (D504 at runtime) and a non-inverting one latches arbitrarily',
        fixes: [
          { kind: 'add-delay', confidence: 'suggested', detail: `give a part of the loop a real delay (e.g. new Not({ delay: '1n' })), or break the feedback with a DFF if it should be synchronous` },
        ],
        at: at(comps[0]),
      }),
    );
  }

  return out.sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : (a.subject?.net ?? '') < (b.subject?.net ?? '') ? -1 : (a.subject?.net ?? '') > (b.subject?.net ?? '') ? 1 : 0));
}

/** Tarjan's algorithm, iterative; SCCs come out in a deterministic order. */
function stronglyConnected(edges: { to: number }[][]): number[][] {
  const n = edges.length;
  const index = new Int32Array(n).fill(-1);
  const low = new Int32Array(n);
  const onStack = new Uint8Array(n);
  const stack: number[] = [];
  const result: number[][] = [];
  let counter = 0;
  for (let s = 0; s < n; s++) {
    if (index[s] !== -1) continue;
    const work: [number, number][] = [[s, 0]];
    index[s] = low[s] = counter++;
    stack.push(s);
    onStack[s] = 1;
    while (work.length > 0) {
      const top = work[work.length - 1];
      const [v, i] = top;
      if (i < edges[v].length) {
        top[1]++;
        const w = edges[v][i].to;
        if (index[w] === -1) {
          index[w] = low[w] = counter++;
          stack.push(w);
          onStack[w] = 1;
          work.push([w, 0]);
        } else if (onStack[w]) {
          low[v] = Math.min(low[v], index[w]);
        }
      } else {
        work.pop();
        if (work.length > 0) {
          const parent = work[work.length - 1][0];
          low[parent] = Math.min(low[parent], low[v]);
        }
        if (low[v] === index[v]) {
          const comp: number[] = [];
          let w: number;
          do {
            w = stack.pop()!;
            onStack[w] = 0;
            comp.push(w);
          } while (w !== v);
          result.push(comp.sort((a, b) => a - b));
        }
      }
    }
  }
  return result;
}

/** BFS for the shortest cycle from `start` back to itself inside an SCC. */
function shortestCycle(edges: { to: number; comp: string }[][], start: number, inScc: Set<number>): { net: number; comp: string }[] {
  const prev = new Map<number, { from: number; comp: string }>();
  const queue = [start];
  let closing: { from: number; comp: string } | undefined;
  for (let qi = 0; qi < queue.length && !closing; qi++) {
    const v = queue[qi];
    for (const e of edges[v]) {
      if (!inScc.has(e.to)) continue;
      if (e.to === start) {
        closing = { from: v, comp: e.comp };
        break;
      }
      if (!prev.has(e.to)) {
        prev.set(e.to, { from: v, comp: e.comp });
        queue.push(e.to);
      }
    }
  }
  if (!closing) return [{ net: start, comp: '?' }];
  // Walk back from the closing edge to rebuild the forward path.
  const steps: { net: number; comp: string }[] = [{ net: closing.from, comp: closing.comp }];
  let v = closing.from;
  while (v !== start) {
    const p = prev.get(v)!;
    steps.unshift({ net: p.from, comp: p.comp });
    v = p.from;
  }
  return steps;
}
