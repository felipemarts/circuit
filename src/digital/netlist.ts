/**
 * The canonical, plain-JSON description of a digital circuit. Everything the
 * simulator and the lint need is in here; `JSON.parse(JSON.stringify(n))`
 * rebuilds the identical circuit.
 */
import type { Logic, Strength } from './logic';
import { parseLogic } from './logic';
import type { PartParams, PinLayout } from './parts';
import { partDef } from './parts';

export const DIGITAL_NETLIST_SCHEMA = 'circuitsvibe-digital/0.1';

export interface DigitalNetlistComponent {
  id: string;
  type: string;
  params: PartParams;
  /** pin name → net name (every pin of the layout; unwired pins sit alone on a net named '<id>.<pin>'). */
  pins: Record<string, string>;
  /** Source location 'file:line' of the code that added it, when the builder was given a locator. */
  at?: string;
}

export interface DigitalInputPort {
  /** Net driven from outside (testbench `drive()` or an analog→digital bridge). */
  net: string;
  /** Value before the first drive. */
  initial: Logic;
  strength: Strength;
}

export interface DigitalNetlist {
  schema: typeof DIGITAL_NETLIST_SCHEMA;
  /** Sorted by id. */
  components: DigitalNetlistComponent[];
  /** Sorted by net. */
  inputs: DigitalInputPort[];
  /** net name → sorted 'component.pin' refs (derived; informational). */
  nets: Record<string, string[]>;
}

export const ID_RE = /^[A-Za-z][A-Za-z0-9_]*$/;
/** User net names: like ids, plus [] for bus bits ('Q[3]'). Dots are reserved for auto names ('U1.y'). */
export const NET_RE = /^[A-Za-z_][A-Za-z0-9_[\]]*$/;

export interface ResolvedComponent {
  id: string;
  type: string;
  params: PartParams;
  layout: PinLayout;
  /** Every layout pin → net name. */
  pins: Record<string, string>;
  at?: string;
}

export interface ResolvedNetlist {
  components: ResolvedComponent[];
  inputs: DigitalInputPort[];
  /** Sorted net names. */
  netNames: string[];
}

/**
 * Validate a (possibly hand-written) netlist and fill defaults: params are
 * re-normalized (idempotent), unwired pins get their own '<id>.<pin>' net,
 * and everything is sorted (components by id, nets by name) so the result
 * does not depend on the order things were declared in.
 */
export function resolveNetlist(n: Pick<DigitalNetlist, 'components'> & { inputs?: DigitalInputPort[] }): ResolvedNetlist {
  if (!n || !Array.isArray(n.components)) throw new Error(`digital netlist: 'components' must be an array`);
  const seen = new Set<string>();
  const components: ResolvedComponent[] = [];
  const nets = new Set<string>();
  for (const c of n.components) {
    if (!c || typeof c.id !== 'string' || !ID_RE.test(c.id)) {
      throw new Error(`digital netlist: invalid component id ${JSON.stringify(c?.id)} (letters/digits/underscore, starting with a letter)`);
    }
    if (seen.has(c.id)) throw new Error(`digital netlist: duplicate component id '${c.id}'`);
    seen.add(c.id);
    const def = partDef(c.type);
    const params = def.normalize((c.params ?? {}) as Record<string, unknown>);
    const layout = def.pins(params);
    const all = [...layout.inputs, ...layout.outputs];
    const pins: Record<string, string> = {};
    for (const [pin, net] of Object.entries(c.pins ?? {})) {
      if (!all.includes(pin)) throw new Error(`digital netlist: ${c.type} '${c.id}' has no pin '${pin}'. Pins: ${all.join(', ')}`);
      if (typeof net !== 'string' || net.length === 0) throw new Error(`digital netlist: ${c.id}.${pin} must map to a net name`);
      pins[pin] = net;
    }
    for (const pin of all) {
      if (!(pin in pins)) pins[pin] = `${c.id}.${pin}`;
      nets.add(pins[pin]);
    }
    components.push({ id: c.id, type: c.type, params, layout, pins, ...(typeof c.at === 'string' ? { at: c.at } : {}) });
  }
  components.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const inputs: DigitalInputPort[] = [];
  const inputNets = new Set<string>();
  for (const i of n.inputs ?? []) {
    if (!i || typeof i.net !== 'string' || !NET_RE.test(i.net)) throw new Error(`digital netlist: invalid input net ${JSON.stringify(i?.net)}`);
    if (inputNets.has(i.net)) throw new Error(`digital netlist: input '${i.net}' declared twice`);
    inputNets.add(i.net);
    const strength = i.strength ?? 'strong';
    if (strength !== 'strong' && strength !== 'weak') throw new Error(`digital netlist: input '${i.net}' strength must be 'strong' or 'weak'`);
    inputs.push({ net: i.net, initial: parseLogic(i.initial ?? 'Z', `input ${i.net} initial`), strength });
    nets.add(i.net);
  }
  inputs.sort((a, b) => (a.net < b.net ? -1 : a.net > b.net ? 1 : 0));
  return { components, inputs, netNames: [...nets].sort() };
}

/** Net → sorted refs, from resolved components. */
export function netRefs(r: ResolvedNetlist): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const name of r.netNames) out[name] = [];
  for (const c of r.components) for (const [pin, net] of Object.entries(c.pins)) out[net].push(`${c.id}.${pin}`);
  for (const name of r.netNames) out[name].sort();
  return out;
}

/** Canonical JSON form of a resolved netlist. */
export function toNetlist(r: ResolvedNetlist): DigitalNetlist {
  return {
    schema: DIGITAL_NETLIST_SCHEMA,
    components: r.components.map(c => ({
      id: c.id,
      type: c.type,
      params: c.params,
      pins: Object.fromEntries([...c.layout.inputs, ...c.layout.outputs].map(p => [p, c.pins[p]])),
      ...(c.at !== undefined ? { at: c.at } : {}),
    })),
    inputs: r.inputs.map(i => ({ ...i })),
    nets: netRefs(r),
  };
}
