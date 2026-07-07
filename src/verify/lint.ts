import type { Elaboration } from '../elab/bench';
import type { Diagnostic } from '../schema/types';
import { conductsAtDC, isDCVoltageSourceEdge, describeComponent } from '../elab/describe';
import type { Component } from '../core/Component';

/**
 * L0 — structural lint. Pure graph analysis over the elaborated netlist,
 * BEFORE any matrix is built. Converts what would become a generic
 * "singular matrix" solver crash into named topological causes.
 */
export function runLint(elab: Elaboration): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const doc = elab.netlist;
  const ids = doc.components.map(c => c.id);
  const byId = new Map(doc.components.map(c => [c.id, c]));
  const compOf = (id: string): Component => elab.components.get(id)!;

  const netsOf = (id: string): string[] => [...new Set(Object.values(byId.get(id)!.pins))];

  // Fixpoint reachability from gnd over components passing the filter.
  const reach = (filter: (id: string) => boolean): { nets: Set<string>; comps: Set<string> } => {
    const nets = new Set<string>(['gnd']);
    const comps = new Set<string>();
    let changed = true;
    while (changed) {
      changed = false;
      for (const id of ids) {
        if (comps.has(id) || !filter(id)) continue;
        const cNets = netsOf(id);
        if (cNets.some(n => nets.has(n))) {
          comps.add(id);
          for (const n of cNets) {
            if (!nets.has(n)) {
              nets.add(n);
              changed = true;
            }
          }
          changed = true;
        }
      }
    }
    return { nets, comps };
  };

  // ── F103: components not connected to the ground-reachable circuit at all ──
  const all = reach(() => true);
  const unreached = ids.filter(id => !all.comps.has(id)).sort();
  if (unreached.length > 0) {
    diagnostics.push({
      code: 'F103',
      slug: 'unreached-component',
      severity: 'error',
      stage: 'lint',
      message:
        unreached.length === ids.length
          ? `no component is connected to ground — the circuit floats entirely`
          : `component${unreached.length > 1 ? 's' : ''} ${unreached.join(', ')} not connected to the grounded circuit`,
      subject: { components: unreached },
      note: 'the simulator solves the subgraph reachable from ground; anything else would be silently ignored, so it is an error here',
      fixes: [
        {
          kind: 'rewire',
          confidence: 'suggested',
          detail:
            unreached.length === ids.length
              ? `connect the circuit's return path to tb.gnd (e.g. v1.pin('-').connect(tb.gnd))`
              : `wire ${unreached.join(', ')} into the grounded circuit, or remove ${unreached.length > 1 ? 'them' : 'it'}`,
        },
      ],
      at: elab.locOf.get(unreached[0]),
    });
  }
  const reachedComps = all.comps;

  // ── F101: nets with no DC path to ground (islands isolated by caps/current sources) ──
  const dc = reach(id => reachedComps.has(id) && conductsAtDC(compOf(id)));
  const reachedNets = new Set<string>(['gnd']);
  for (const id of reachedComps) for (const n of netsOf(id)) reachedNets.add(n);
  const floating = [...reachedNets].filter(n => !dc.nets.has(n)).sort();

  if (floating.length > 0) {
    // Group floating nets into islands via components whose nets are all floating.
    const parent = new Map<string, string>(floating.map(n => [n, n]));
    const find = (x: string): string => {
      let r = x;
      while (parent.get(r) !== r) r = parent.get(r)!;
      parent.set(x, r);
      return r;
    };
    for (const id of [...reachedComps].sort()) {
      const cNets = netsOf(id).filter(n => parent.has(n));
      for (let i = 1; i < cNets.length; i++) {
        const a = find(cNets[0]);
        const b = find(cNets[i]);
        if (a !== b) parent.set(b, a);
      }
    }
    const islands = new Map<string, string[]>();
    for (const n of floating) {
      const root = find(n);
      islands.set(root, [...(islands.get(root) ?? []), n]);
    }
    for (const nets of [...islands.values()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      const pins = nets.flatMap(n => doc.nets[n] ?? []).sort();
      const exampleRef = pins[0];
      diagnostics.push({
        code: 'F101',
        slug: 'floating-net',
        severity: 'error',
        stage: 'lint',
        message: `net${nets.length > 1 ? 's' : ''} ${nets.join(', ')} (${pins.join(', ')}) ha${nets.length > 1 ? 've' : 's'} no DC path to ground`,
        subject: { net: nets[0], pins },
        note: 'capacitors block DC and current sources do not fix node voltages; the DC operating point of these nets is undefined (MNA matrix would be singular)',
        fixes: [
          {
            kind: 'add-component',
            confidence: 'suggested',
            detail: `connect a bleed resistor (e.g. 1M) from ${nets[0]} to gnd, or rewire the net to one with a DC path`,
            patch: `const rb = tb.add('Rb_${nets[0]}', new Resistor('1M'));\nrb.pin('1').connect(/* pin on ${exampleRef} */);\nrb.pin('2').connect(tb.gnd);`,
          },
        ],
        at: exampleRef ? elab.locOf.get(exampleRef.split('.')[0]) : undefined,
      });
    }
  }

  // ── F104: ideal voltage-source shorts and loops (inductors are 0 V sources at DC) ──
  {
    const parent = new Map<string, string>();
    const find = (x: string): string => {
      if (!parent.has(x)) parent.set(x, x);
      let r = x;
      while (parent.get(r) !== r) r = parent.get(r)!;
      parent.set(x, r);
      return r;
    };
    for (const id of [...reachedComps].sort()) {
      const comp = compOf(id);
      if (!isDCVoltageSourceEdge(comp)) continue;
      const cNets = netsOf(id);
      if (cNets.length === 0 || cNets.length > 2) continue;
      const type = describeComponent(comp).type;
      const isInductor = type === 'Inductor';
      if (cNets.length === 1) {
        const a = cNets[0];
        diagnostics.push({
          code: 'F104',
          slug: 'voltage-source-short',
          severity: 'error',
          stage: 'lint',
          message: `${id} has both terminals on net ${a}${isInductor ? ' (an inductor is a 0 V source at DC)' : ''} — ideal source shorted`,
          subject: { net: a, components: [id] },
          note: 'an ideal voltage source with both terminals on the same net demands V=const across zero impedance; the MNA matrix is singular',
          fixes: [
            { kind: 'rewire', confidence: 'suggested', detail: `separate the terminals of ${id} onto different nets, or remove it` },
          ],
          at: elab.locOf.get(id),
        });
        continue;
      }
      const [a, b] = cNets;
      if (find(a) === find(b)) {
        diagnostics.push({
          code: 'F104',
          slug: 'voltage-source-loop',
          severity: 'error',
          stage: 'lint',
          message: `${id} closes a loop of ideal voltage sources between nets ${a} and ${b}${isInductor ? ' (inductors are 0 V sources at DC)' : ''}`,
          subject: { components: [id] },
          note: 'two parallel ideal sources (or a source paralleled by an inductor at DC) over-constrain the same voltage; the MNA matrix is singular even when their values agree',
          fixes: [
            {
              kind: 'add-component',
              confidence: 'suggested',
              detail: `if the parallel connection is intentional, add a small series resistance (e.g. 10m) in the ${id} branch; otherwise rewire ${id}`,
            },
          ],
          at: elab.locOf.get(id),
        });
        continue;
      }
      parent.set(find(b), find(a));
    }
  }

  // ── F105: diode/LED forward-clamped directly across an ideal voltage source ──
  for (const comp of doc.components) {
    if (!reachedComps.has(comp.id)) continue;
    if (comp.type !== 'Diode' && comp.type !== 'LED') continue;
    const anodeNet = comp.pins['anode'];
    const cathodeNet = comp.pins['cathode'];
    if (!anodeNet || !cathodeNet || anodeNet === cathodeNet) continue;
    for (const src of doc.components) {
      if (src.type !== 'VoltageSource' || !reachedComps.has(src.id)) continue;
      const plus = src.pins['+'];
      const minus = src.pins['-'];
      const v = src.params['v'];
      if (typeof v !== 'number') continue;
      const forward =
        (anodeNet === plus && cathodeNet === minus && v > 0.4) ||
        (anodeNet === minus && cathodeNet === plus && v < -0.4);
      if (forward) {
        diagnostics.push({
          code: 'F105',
          slug: 'source-clamped-diode',
          severity: 'error',
          stage: 'lint',
          message: `${comp.id} is forward-clamped directly across ${src.id} (${Math.abs(v)} V) with no series resistance`,
          subject: { components: [comp.id, src.id] },
          note: `an ideal source fixes the diode voltage; the exponential current at ${Math.abs(v)} V is astronomically large and newton-raphson blows up — nothing limits the current`,
          fixes: [
            {
              kind: 'add-component',
              confidence: 'suggested',
              detail: `insert a series resistor between ${src.id} and ${comp.id}.anode (e.g. 330 for an LED at 5 V), then re-run`,
            },
          ],
          at: elab.locOf.get(comp.id),
        });
        break;
      }
    }
  }

  // ── F106: dangling pins (warning) ──
  for (const comp of doc.components) {
    if (!reachedComps.has(comp.id)) continue;
    const dangling = Object.entries(comp.pins)
      .filter(([, net]) => net !== 'gnd' && (doc.nets[net] ?? []).length === 1)
      .map(([pin]) => pin)
      .sort();
    if (dangling.length > 0) {
      diagnostics.push({
        code: 'F106',
        slug: 'dangling-pin',
        severity: 'warning',
        stage: 'lint',
        message: `${comp.id} pin${dangling.length > 1 ? 's' : ''} ${dangling.map(p => `'${p}'`).join(', ')} not connected to anything`,
        subject: { components: [comp.id], pins: dangling.map(p => `${comp.id}.${p}`) },
        note: 'an open pin carries no current; if that is intentional this warning can be ignored',
        fixes: [
          { kind: 'rewire', confidence: 'suggested', detail: `connect ${comp.id}.${dangling[0]} or remove ${comp.id}` },
        ],
        at: elab.locOf.get(comp.id),
      });
    }
  }

  return diagnostics;
}
