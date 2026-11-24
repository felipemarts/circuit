/**
 * Lint rules of the amplifier family (F120–F124) and the DC-graph facts the
 * generic lint needs about op-amps and comparators.
 *
 *   F120 opamp-supply-unconnected   error    supply pins left open / on one net
 *   F121 opamp-input-no-dc-path     error    an input net has no DC path (replaces F101 there)
 *   F122 opamp-positive-feedback    warning  output feeds inp, nothing feeds inn
 *   F123 ideal-opamp-output-forced  error    IdealOpAmp output on gnd / across an ideal source
 *   F124 open-collector-no-pullup   warning  comparator output with nothing to pull it up
 */
import type { Elaboration } from '../elab/bench';
import type { Diagnostic, NetlistComponent } from '../schema/types';

const AMPS = new Set(['IdealOpAmp', 'OpAmp', 'Comparator']);
const OPAMPS = new Set(['IdealOpAmp', 'OpAmp']);

export function isAmplifier(type: string): boolean {
  return AMPS.has(type);
}

/** Emitter net of a comparator's open-collector output. */
function emitterNet(c: NetlistComponent): string {
  return c.pins['emit'] ?? c.pins['v-'];
}

/**
 * Nets an amplifier connects at DC (for the floating-net analysis), or null
 * for other types. Inputs and supply pins draw no current that could define a
 * node voltage, so they are in no group: each needs its own DC path. An
 * op-amp output is a driven node (anchored, like a source to ground); a
 * comparator output conducts to its emitter.
 */
export function amplifierDcGroups(c: NetlistComponent): string[][] | null {
  if (!AMPS.has(c.type)) return null;
  if (c.type === 'Comparator') return [[c.pins['out'], emitterNet(c)]];
  return [[c.pins['out'], 'gnd']];
}

/**
 * Open supply pins that F101/F106 must not report: an IdealOpAmp's when both
 * are open (no rails — intended), and any other open amplifier supply pin
 * (F120 reports it, with the specific fix).
 */
export function isOptionalOpenPin(c: NetlistComponent, pin: string, nets: Record<string, string[]>): boolean {
  if (!AMPS.has(c.type) || (pin !== 'v+' && pin !== 'v-')) return false;
  const net = c.pins[pin];
  return net !== 'gnd' && (nets[net] ?? []).length === 1;
}

/** 'U1.inp' / 'U1.inn' refs of amplifier inputs among `pins`. */
export function amplifierInputRefs(elab: Elaboration, pins: string[]): string[] {
  const types = new Map(elab.netlist.components.map(c => [c.id, c.type]));
  return pins.filter(ref => {
    const [id, pin] = ref.split('.');
    return AMPS.has(types.get(id) ?? '') && (pin === 'inp' || pin === 'inn');
  });
}

/** F121 in place of F101 for a floating island that contains amplifier inputs. */
export function floatingInputDiagnostic(elab: Elaboration, nets: string[], pins: string[], inputs: string[]): Diagnostic {
  const first = inputs[0];
  const id = first.split('.')[0];
  return {
    code: 'F121',
    slug: 'opamp-input-no-dc-path',
    severity: 'error',
    stage: 'lint',
    message: `${inputs.join(', ')} on net${nets.length > 1 ? 's' : ''} ${nets.join(', ')} ha${inputs.length > 1 ? 've' : 's'} no DC path to ground — the input bias point is undefined`,
    subject: { net: nets[0], pins, components: [...new Set(inputs.map(r => r.split('.')[0]))].sort() },
    note: 'an op-amp/comparator input draws (almost) no current, so it cannot set its own voltage: a net reached only through capacitors, current sources or the input itself floats. A real amplifier drifts to a rail; the simulator would have a singular matrix',
    fixes: [
      {
        kind: 'add-component',
        confidence: 'suggested',
        detail: `give ${first} a DC bias path: a resistor from ${nets[0]} to gnd (or to a mid-supply reference) — e.g. 100k for an AC-coupled input, or close the feedback loop with a resistor from the output`,
        patch: `const rb = tb.add('Rb_${nets[0]}', new Resistor('100k'));\nrb.pin('1').connect(${id.toLowerCase()}.pin('${first.split('.')[1]}'));\nrb.pin('2').connect(tb.gnd);`,
      },
    ],
    at: elab.locOf.get(id),
  };
}

/** Two-terminal parts a feedback signal can travel through (with their conducting pin pairs). */
function passiveEdges(c: NetlistComponent): [string, string][] {
  switch (c.type) {
    case 'Resistor':
    case 'Capacitor':
    case 'Inductor':
      return [[c.pins['1'], c.pins['2']]];
    case 'Diode':
    case 'LED':
      return [[c.pins['anode'], c.pins['cathode']]];
    case 'Button':
      return c.params['pressed'] === true ? [[c.pins['1'], c.pins['2']]] : [];
    case 'Switch':
      return [[c.pins['com'], c.params['closed'] === true ? c.pins['b'] : c.pins['a']]];
    default:
      return [];
  }
}

/** The amplifier-family lint rules other than F121. */
export function lintAmplifiers(elab: Elaboration, reached: Set<string>): Diagnostic[] {
  const out: Diagnostic[] = [];
  const doc = elab.netlist;
  const amps = doc.components.filter(c => AMPS.has(c.type) && reached.has(c.id));
  if (amps.length === 0) return out;
  const netSize = (net: string) => (doc.nets[net] ?? []).length;
  const open = (net: string) => net !== 'gnd' && netSize(net) === 1;

  // ── F120: supply pins ──
  for (const c of amps) {
    const vp = c.pins['v+'];
    const vn = c.pins['v-'];
    if (c.type === 'IdealOpAmp') {
      if (open(vp) !== open(vn)) {
        const missing = open(vp) ? 'v+' : 'v-';
        out.push(f120(elab, c, `${c.id} (IdealOpAmp) has only one supply pin connected — '${missing}' is open`, `connect both 'v+' and 'v-' (output clamped to the rails) or neither (unclamped ideal VCVS)`, [missing]));
      } else if (!open(vp) && vp === vn) {
        out.push(f120(elab, c, `${c.id} (IdealOpAmp) has 'v+' and 'v-' on the same net ${vp} — the rails are shorted, the output window is zero`, `wire 'v+' to the positive supply and 'v-' to the negative supply (or gnd)`, ['v+', 'v-']));
      }
      continue;
    }
    const missing = (['v+', 'v-'] as const).filter(p => open(c.pins[p]));
    if (missing.length > 0) {
      out.push(
        f120(
          elab,
          c,
          `${c.id} (${c.type}${c.params['part'] ? ` ${c.params['part']}` : ''}) supply pin${missing.length > 1 ? 's' : ''} ${missing.map(p => `'${p}'`).join(' and ')} not connected — the macro model needs its supply`,
          `connect 'v+' to the positive supply and 'v-' to the negative supply or gnd (single supply), e.g. u1.pin('v+').connect(vcc.pin('+')); u1.pin('v-').connect(tb.gnd)`,
          missing,
        ),
      );
    } else if (vp === vn) {
      out.push(f120(elab, c, `${c.id} (${c.type}) has 'v+' and 'v-' on the same net ${vp} — it has no supply voltage`, `wire 'v+' to the positive supply and 'v-' to the negative supply or gnd`, ['v+', 'v-']));
    }
  }

  // ── F122: positive feedback only (op-amps; comparators use it on purpose) ──
  {
    const blocked = new Set<string>(['gnd']);
    for (const c of doc.components) {
      if (c.type === 'VoltageSource') for (const n of Object.values(c.pins)) blocked.add(n);
      if (AMPS.has(c.type)) blocked.add(c.pins['out']);
    }
    const edges = doc.components.flatMap(passiveEdges).filter(([a, b]) => a !== undefined && b !== undefined);
    for (const c of amps) {
      if (!OPAMPS.has(c.type)) continue;
      const start = c.pins['out'];
      const seen = new Set<string>([start]);
      const queue = [start];
      while (queue.length > 0) {
        const n = queue.pop()!;
        if (n !== start && blocked.has(n)) continue;
        for (const [a, b] of edges) {
          const other = a === n ? b : b === n ? a : undefined;
          if (other !== undefined && !seen.has(other)) {
            seen.add(other);
            queue.push(other);
          }
        }
      }
      const inp = c.pins['inp'];
      const inn = c.pins['inn'];
      if (seen.has(inp) && !seen.has(inn) && inp !== 'gnd') {
        out.push({
          code: 'F122',
          slug: 'opamp-positive-feedback',
          severity: 'warning',
          stage: 'lint',
          message: `${c.id} output feeds back only to its non-inverting input 'inp' (net ${inp}); nothing from the output reaches 'inn' — positive feedback, the output latches to a rail`,
          subject: { components: [c.id], pins: [`${c.id}.out`, `${c.id}.inp`] },
          note: 'with feedback only into inp the loop gain is positive: a linear amplifier is impossible and the output snaps to a rail (a Schmitt trigger). If a linear stage was intended, the feedback network goes to inn',
          fixes: [
            {
              kind: 'rewire',
              confidence: 'suggested',
              detail: `for a linear amplifier, swap the inputs of ${c.id} (feedback to 'inn'); for an intentional Schmitt trigger use a Comparator (no warning)`,
            },
          ],
          at: elab.locOf.get(c.id),
        });
      }
    }
  }

  // ── F123: an IdealOpAmp output is an ideal voltage source to ground ──
  {
    const parent = new Map<string, string>();
    const find = (x: string): string => {
      if (!parent.has(x)) parent.set(x, x);
      let r = x;
      while (parent.get(r) !== r) r = parent.get(r)!;
      parent.set(x, r);
      return r;
    };
    for (const c of doc.components) {
      if (!reached.has(c.id)) continue;
      const pair = c.type === 'VoltageSource' ? [c.pins['+'], c.pins['-']] : c.type === 'Inductor' ? [c.pins['1'], c.pins['2']] : null;
      if (!pair || pair[0] === pair[1] || find(pair[0]) === find(pair[1])) continue; // loops are F104
      parent.set(find(pair[0]), find(pair[1]));
    }
    const drivenBy = new Map<string, string>();
    for (const c of amps) {
      if (c.type !== 'IdealOpAmp') continue;
      const o = c.pins['out'];
      if (find(o) === find('gnd')) {
        const other = [...drivenBy.entries()].find(([root]) => root === find(o))?.[1];
        out.push({
          code: 'F123',
          slug: 'ideal-opamp-output-forced',
          severity: 'error',
          stage: 'lint',
          message:
            o === 'gnd'
              ? `${c.id} (IdealOpAmp) output is wired to gnd — an ideal output (zero output resistance) cannot be shorted`
              : other
                ? `${c.id} (IdealOpAmp) output net ${o} is also driven by ${other}'s ideal output — two ideal sources on one net`
                : `${c.id} (IdealOpAmp) output net ${o} is fixed by ideal voltage source(s) — the ideal output is in parallel with a source`,
          subject: { net: o, components: [c.id] },
          note: 'the ideal op-amp output is a voltage source to ground; another ideal source (or ground) on the same net over-constrains the node and the MNA matrix is singular',
          fixes: [
            { kind: 'rewire', confidence: 'suggested', detail: `remove the short or the parallel source on ${o}, or add a series resistor at the output of ${c.id}; use OpAmp (finite output resistance, current limit) to study a shorted output` },
          ],
          at: elab.locOf.get(c.id),
        });
        continue;
      }
      drivenBy.set(find(o), c.id);
      parent.set(find(o), find('gnd'));
    }
  }

  // ── F124: open-collector output with nothing to pull it up ──
  {
    const groups: string[][] = [];
    for (const c of doc.components) {
      if (!reached.has(c.id)) continue;
      if (c.type === 'Comparator') continue; // an open collector only pulls down
      const g = amplifierDcGroups(c);
      if (g) groups.push(...g);
      else if (c.type !== 'Capacitor' && c.type !== 'CurrentSource') groups.push([...new Set(Object.values(c.pins))]);
    }
    const sourceNets = new Set<string>();
    for (const c of doc.components) {
      if (c.type === 'VoltageSource' || c.type === 'CurrentSource') for (const n of Object.values(c.pins)) sourceNets.add(n);
      if (OPAMPS.has(c.type)) sourceNets.add(c.pins['out']);
    }
    sourceNets.delete('gnd');
    for (const c of amps) {
      if (c.type !== 'Comparator') continue;
      const o = c.pins['out'];
      if (o === 'gnd' || open(o)) continue; // shorted or unused (F106)
      const seen = new Set<string>([o]);
      const queue = [o];
      let pulled = false;
      while (queue.length > 0 && !pulled) {
        const n = queue.pop()!;
        if (sourceNets.has(n)) {
          pulled = true;
          break;
        }
        for (const g of groups) {
          if (!g.includes(n)) continue;
          for (const m of g) {
            if (m !== 'gnd' && !seen.has(m)) {
              seen.add(m);
              queue.push(m);
            }
          }
        }
      }
      if (!pulled) {
        out.push({
          code: 'F124',
          slug: 'open-collector-no-pullup',
          severity: 'warning',
          stage: 'lint',
          message: `${c.id} (Comparator) open-collector output on net ${o} has no pull-up — nothing can drive it high`,
          subject: { net: o, components: [c.id] },
          note: 'an open-collector output only sinks current; with no resistor to a supply (or other source) the "high" state is undefined and the simulated value is just the leakage settling point',
          fixes: [
            {
              kind: 'add-component',
              confidence: 'suggested',
              detail: `add a pull-up resistor (e.g. 4.7k–10k) from ${o} to the logic supply`,
              patch: `const rpu = tb.add('Rpu_${c.id}', new Resistor('10k'));\nrpu.pin('1').connect(/* supply + */);\nrpu.pin('2').connect(${c.id.toLowerCase()}.pin('out'));`,
            },
          ],
          at: elab.locOf.get(c.id),
        });
      }
    }
  }
  return out;
}

function f120(elab: Elaboration, c: NetlistComponent, message: string, fix: string, pins: string[]): Diagnostic {
  return {
    code: 'F120',
    slug: 'opamp-supply-unconnected',
    severity: 'error',
    stage: 'lint',
    message,
    subject: { components: [c.id], pins: pins.map(p => `${c.id}.${p}`) },
    note: 'the output of a real (macro-model) op-amp or comparator lives between its supply rails and its quiescent current flows through them; without a supply there is no output window and the output is meaningless',
    fixes: [{ kind: 'rewire', confidence: 'suggested', detail: fix }],
    at: elab.locOf.get(c.id),
  };
}
