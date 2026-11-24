/**
 * Automatic schematic layout for a circuit document (no positions needed —
 * LLM-made documents never have any). Deterministic, pure, browser-safe.
 *
 * 1. Classify nets: `gnd`, supply rails (a DC source whose return is ground
 *    and whose output net feeds ≥ 3 pins), unconnected pins, signal nets.
 * 2. Classify components: supplies (drawn once in a power column with a rail
 *    port), shunt chains (two-terminal parts whose far end reaches ground or
 *    a rail: drawn vertically, stacked on their anchor net), series parts
 *    (everything else: the left-to-right signal flow).
 * 3. Layer series parts by BFS from the stimulus (sources, clocks), order rows
 *    by barycenter, align each part's input pin with its upstream pin so
 *    wires run straight; chains hang above (to a rail) or below (to ground)
 *    their anchor, directly under top/bottom pins or in the inter-layer zone.
 * 4. Ground and rail pins get repeated port symbols (grouped into a bus for
 *    an IC's tied inputs); signal nets are routed orthogonally on a lattice
 *    (A*, see router.ts) as spanning trees with junction dots; routes that
 *    fail or that would run very long on a named net become net labels.
 *
 * A document `layout` with positions for every component is honoured for
 * placement; wiring is still computed here.
 */
import type { CircuitDoc, CircuitComponent } from '../doc/types';
import { G, symbolFor, type PinGeom, type Side, type SymbolGeom } from './symbols';
import { Grid, route, corners, DIRS, type Cell } from './router';
import { eng } from './format';

export type Rotation = 0 | 90 | 180 | 270;

export interface Point {
  x: number;
  y: number;
}

export interface PlacedPin extends Point {
  name: string;
  /** Outward direction after rotation. */
  dir: Side;
  /** Stub end on the body. */
  bx: number;
  by: number;
  net: string;
  ref: string;
}

export interface PlacedComponent {
  id: string;
  type: string;
  doc: CircuitComponent;
  sym: SymbolGeom;
  x: number;
  y: number;
  rotation: Rotation;
  /** Rotated bounding box half sizes. */
  hw: number;
  hh: number;
  pins: PlacedPin[];
  /** Zero-size anchor of a net without series parts (not drawn). */
  virtual?: boolean;
  role: 'supply' | 'series' | 'chain' | 'bleeder' | 'node';
}

export interface Wire {
  net: string;
  points: Point[];
  /** Pin ref the route started from. */
  from: string;
}

export interface Port {
  kind: 'gnd' | 'rail';
  net: string;
  /** Symbol position. */
  x: number;
  y: number;
  /** 'down' ground / 'up' rail; the symbol is drawn pointing this way. */
  dirY: 1 | -1;
  label?: string;
  /** Wire from the pin(s) to the symbol. */
  points: Point[][];
  pinRefs: string[];
}

export interface NetLabel {
  net: string;
  x: number;
  y: number;
  /** Flag style at a pin (route fallback) or floating caption over a wire. */
  kind: 'flag' | 'caption';
  dir?: Side;
}

export interface Junction extends Point {
  net: string;
}

export interface NoConnect extends Point {
  ref: string;
}

export interface Layout {
  width: number;
  height: number;
  components: PlacedComponent[];
  wires: Wire[];
  ports: Port[];
  labels: NetLabel[];
  junctions: Junction[];
  noConnects: NoConnect[];
  /** Net name per pin ref 'R1.1'. */
  netOfPin: Record<string, string>;
  /** Rail nets with their display label. */
  rails: Record<string, string>;
  /** Pins whose signal net could not be wired and is shown by labels only. */
  labelledNets: string[];
}

// ─── geometry helpers ───────────────────────────────────────────────────────

const SIDES: Side[] = ['r', 'b', 'l', 't']; // clockwise order
export function rotateSide(side: Side, r: Rotation): Side {
  return SIDES[(SIDES.indexOf(side) + r / 90) % 4];
}
export function rotatePoint(x: number, y: number, r: Rotation): Point {
  switch (r) {
    case 90:
      return { x: -y, y: x };
    case 180:
      return { x: -x, y: -y };
    case 270:
      return { x: y, y: -x };
    default:
      return { x, y };
  }
}
const DIR_INDEX: Record<Side, number> = { r: 0, l: 1, b: 2, t: 3 };
const DELTA: Record<Side, Point> = { r: { x: 1, y: 0 }, l: { x: -1, y: 0 }, b: { x: 0, y: 1 }, t: { x: 0, y: -1 } };
const snap = (v: number): number => Math.round(v / G) * G;

function placePins(c: CircuitComponent, sym: SymbolGeom, x: number, y: number, rotation: Rotation): PlacedPin[] {
  return sym.pins.map(p => {
    const rp = rotatePoint(p.x, p.y, rotation);
    const rb = rotatePoint(p.bx, p.by, rotation);
    return { name: p.name, x: x + rp.x, y: y + rp.y, bx: x + rb.x, by: y + rb.y, dir: rotateSide(p.side, rotation), net: c.pins[p.name] ?? '', ref: `${c.id}.${p.name}` };
  });
}

function makePlaced(c: CircuitComponent, sym: SymbolGeom, x: number, y: number, rotation: Rotation, role: PlacedComponent['role']): PlacedComponent {
  const swap = rotation === 90 || rotation === 270;
  return { id: c.id, type: c.type, doc: c, sym, x, y, rotation, hw: (swap ? sym.h : sym.w) / 2, hh: (swap ? sym.w : sym.h) / 2, pins: placePins(c, sym, x, y, rotation), role };
}

// ─── classification ─────────────────────────────────────────────────────────

interface Rail {
  net: string;
  label: string;
  source: string;
  polarity: 1 | -1;
}

interface Chain {
  anchorNet: string;
  comps: string[];
  target: 'gnd' | 'rail';
  targetNet: string;
}

function isDcOnly(c: CircuitComponent): boolean {
  const keys = Object.keys(c.params).filter(k => k !== 'v' && k !== 'i');
  return keys.length === 0;
}

function pinCount(netPins: Map<string, string[]>, net: string): number {
  return netPins.get(net)?.length ?? 0;
}

// ─── layout ─────────────────────────────────────────────────────────────────

export function layoutCircuit(doc: CircuitDoc): Layout {
  const comps = [...doc.components].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const byId = new Map(comps.map(c => [c.id, c]));
  const syms = new Map(comps.map(c => [c.id, symbolFor(c)]));
  const netOfPin: Record<string, string> = {};
  const netPins = new Map<string, string[]>();
  for (const c of comps) {
    for (const [pin, net] of Object.entries(c.pins)) {
      const ref = `${c.id}.${pin}`;
      netOfPin[ref] = net;
      const list = netPins.get(net) ?? [];
      list.push(ref);
      netPins.set(net, list);
    }
  }
  for (const list of netPins.values()) list.sort();
  const compOfRef = (ref: string): string => ref.slice(0, ref.indexOf('.'));
  const pinOfRef = (ref: string): string => ref.slice(ref.indexOf('.') + 1);
  const otherPinNet = (c: CircuitComponent, pinName: string): string | undefined => {
    const names = Object.keys(c.pins);
    if (names.length !== 2) return undefined;
    return c.pins[names[0] === pinName ? names[1] : names[0]];
  };

  // Rails.
  const rails = new Map<string, Rail>();
  const supplies = new Set<string>();
  // With two or more ground-referenced DC sources every one of them is a supply (power section).
  const dcSources = comps.filter(c => (c.type === 'VoltageSource' || c.type === 'CurrentSource') && isDcOnly(c) && (c.pins['-'] === 'gnd' || c.pins['+'] === 'gnd'));
  const manySupplies = dcSources.length >= 2;
  for (const c of comps) {
    if (c.type !== 'VoltageSource' && c.type !== 'CurrentSource') continue;
    if (!isDcOnly(c)) continue;
    const plus = c.pins['+'];
    const minus = c.pins['-'];
    const value = typeof c.params.v === 'number' ? c.params.v : typeof c.params.i === 'number' ? c.params.i : 0;
    const unit = c.type === 'VoltageSource' ? 'V' : 'A';
    // A rail: feeds ≥ 3 pins, or powers an IC / box supply pin.
    const feedsSupplyPin = (net: string): boolean => (netPins.get(net) ?? []).some(r => syms.get(compOfRef(r))?.pins.find(p => p.name === pinOfRef(r))?.role === 'vcc');
    if (minus === 'gnd' && plus !== 'gnd' && (pinCount(netPins, plus) >= 3 || feedsSupplyPin(plus) || manySupplies) && !rails.has(plus)) {
      rails.set(plus, { net: plus, label: '', source: c.id, polarity: 1 });
      supplies.add(c.id);
    } else if (plus === 'gnd' && minus !== 'gnd' && (pinCount(netPins, minus) >= 3 || feedsSupplyPin(minus) || manySupplies) && !rails.has(minus)) {
      rails.set(minus, { net: minus, label: '', source: c.id, polarity: -1 });
      supplies.add(c.id);
    }
    void value;
    void unit;
  }
  // Rail labels: the user's net name, else "+5 V" (disambiguated by source id).
  const autoNet = (n: string): boolean => /^n\d+$/.test(n);
  const seenLabels = new Map<string, number>();
  for (const r of rails.values()) {
    const src = byId.get(r.source)!;
    const v = typeof src.params.v === 'number' ? src.params.v : typeof src.params.i === 'number' ? src.params.i : 0;
    const base = autoNet(r.net) ? `${r.polarity > 0 ? '+' : '−'}${eng(Math.abs(v), src.type === 'VoltageSource' ? 'V' : 'A')}` : r.net;
    seenLabels.set(base, (seenLabels.get(base) ?? 0) + 1);
    r.label = base;
  }
  for (const r of rails.values()) if ((seenLabels.get(r.label) ?? 0) > 1) r.label = `${r.label} (${r.source})`;

  const isRail = (net: string): boolean => rails.has(net);
  const isGnd = (net: string): boolean => net === 'gnd';
  const isSignal = (net: string): boolean => !isGnd(net) && !isRail(net) && pinCount(netPins, net) >= 2;

  // Shunt chains.
  const chainOf = new Map<string, Chain>();
  const inChain = new Set<string>();
  const findChain = (id: string, fromNet: string, visited: Set<string>): { comps: string[]; target: 'gnd' | 'rail'; targetNet: string } | null => {
    const c = byId.get(id)!;
    if (syms.get(id)!.kind !== 'two' || visited.has(id) || supplies.has(id) || inChain.has(id)) return null;
    const pinName = Object.keys(c.pins).find(p => c.pins[p] === fromNet);
    if (!pinName) return null;
    const other = otherPinNet(c, pinName);
    if (other === undefined || other === fromNet) return null;
    if (isGnd(other)) return { comps: [id], target: 'gnd', targetNet: other };
    if (isRail(other)) return { comps: [id], target: 'rail', targetNet: other };
    const refs = netPins.get(other) ?? [];
    if (refs.length !== 2 || visited.size >= 3) return null;
    const nextId = compOfRef(refs.find(r => compOfRef(r) !== id)!);
    const sub = findChain(nextId, other, new Set([...visited, id]));
    return sub ? { ...sub, comps: [id, ...sub.comps] } : null;
  };
  // Prefer anchoring on nets with the most pins (the busy node), then by id.
  const candidates: { id: string; anchor: string; pins: number }[] = [];
  for (const c of comps) {
    if (syms.get(c.id)!.kind !== 'two' || supplies.has(c.id)) continue;
    for (const net of Object.values(c.pins)) if (isSignal(net)) candidates.push({ id: c.id, anchor: net, pins: pinCount(netPins, net) });
  }
  candidates.sort((a, b) => b.pins - a.pins || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) || a.anchor.localeCompare(b.anchor));
  for (const cand of candidates) {
    if (inChain.has(cand.id)) continue;
    // Never anchor on a 2-pin net whose other member is itself a chainable part:
    // that part will build the longer chain through this one.
    const anchorRefs = netPins.get(cand.anchor) ?? [];
    if (anchorRefs.length === 2) {
      const otherId = compOfRef(anchorRefs.find(r => compOfRef(r) !== cand.id)!);
      const oc = byId.get(otherId)!;
      if (syms.get(otherId)!.kind === 'two' && !supplies.has(otherId) && !inChain.has(otherId) && Object.values(oc.pins).some(n => isSignal(n) && n !== cand.anchor)) continue;
    }
    const found = findChain(cand.id, cand.anchor, new Set());
    if (!found || found.comps.some(id => inChain.has(id))) continue;
    // Keep a chain only if it has no other series part attached mid-way (findChain already guarantees 2-pin links).
    const chain: Chain = { anchorNet: cand.anchor, comps: found.comps, target: found.target, targetNet: found.targetNet };
    for (const id of found.comps) {
      inChain.add(id);
      chainOf.set(id, chain);
    }
  }
  const chains = [...new Set(chainOf.values())];

  // Bleeders: two-terminal parts between rails/ground only.
  const bleeders = comps.filter(c => !supplies.has(c.id) && !inChain.has(c.id) && syms.get(c.id)!.kind === 'two' && Object.values(c.pins).every(n => isGnd(n) || isRail(n)));
  const bleederIds = new Set(bleeders.map(c => c.id));

  const series = comps.filter(c => !supplies.has(c.id) && !inChain.has(c.id) && !bleederIds.has(c.id));

  // Virtual anchors: signal nets that have chains but no series pin.
  const seriesIds = new Set(series.map(c => c.id));
  const virtualNets = [...new Set(chains.map(ch => ch.anchorNet))].filter(net => !(netPins.get(net) ?? []).some(r => seriesIds.has(compOfRef(r)))).sort();
  const virtualComps: CircuitComponent[] = virtualNets.map(net => ({ id: `__node_${net}`, type: '__node', params: {}, pins: { n: net } }));
  const nodeSym = (): SymbolGeom => ({ kind: 'box', w: 0, h: 0, pins: [{ name: 'n', x: 0, y: 0, side: 'r', bx: 0, by: 0, role: 'passive' }], svg: '', label: '', showPinNames: false });
  for (const v of virtualComps) {
    byId.set(v.id, v);
    syms.set(v.id, nodeSym());
    seriesIds.add(v.id);
  }
  const flow = [...series, ...virtualComps];

  // Chains attached to each anchor net.
  const chainsOnNet = new Map<string, Chain[]>();
  for (const ch of chains) {
    const l = chainsOnNet.get(ch.anchorNet) ?? [];
    l.push(ch);
    chainsOnNet.set(ch.anchorNet, l);
  }
  for (const l of chainsOnNet.values()) l.sort((a, b) => (a.target === b.target ? a.comps[0].localeCompare(b.comps[0]) : a.target === 'rail' ? -1 : 1));

  // ── islands over the flow parts (connected through signal nets) ──
  const parent = new Map<string, string>();
  const find = (a: string): string => {
    let r = a;
    while (parent.get(r) !== r) r = parent.get(r)!;
    let x = a;
    while (parent.get(x) !== r) {
      const nx = parent.get(x)!;
      parent.set(x, r);
      x = nx;
    }
    return r;
  };
  const union = (a: string, b: string): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb);
  };
  for (const c of flow) parent.set(c.id, c.id);
  for (const [net, refs] of netPins) {
    if (!isSignal(net)) continue;
    const members = refs.map(compOfRef).filter(id => seriesIds.has(id));
    // chains connect their anchor net's members with nothing else; a chain passing through a net joins both ends' islands
    for (let i = 1; i < members.length; i++) union(members[0], members[i]);
  }
  for (const vc of virtualComps) for (const r of netPins.get(vc.pins.n) ?? []) if (seriesIds.has(compOfRef(r))) union(vc.id, compOfRef(r));
  const islandOf = new Map<string, number>();
  const islandRoots = [...new Set(flow.map(c => find(c.id)))].sort();
  islandRoots.forEach((root, k) => {
    for (const c of flow) if (find(c.id) === root) islandOf.set(c.id, k);
  });

  // ── layering per island ──
  const layerOf = new Map<string, number>();
  const netDepth = new Map<string, number>();
  const isSeed = (c: CircuitComponent): boolean => {
    const sym = syms.get(c.id)!;
    if (sym.kind === 'source') return true;
    const roles = sym.pins.filter(p => c.pins[p.name] !== undefined && !isGnd(c.pins[p.name]) && !isRail(c.pins[p.name])).map(p => p.role);
    return roles.length > 0 && roles.every(r => r === 'out');
  };
  // Signal direction through a pin: inputs look left (the net is upstream),
  // outputs look right (the net is downstream), passive pins follow the flow.
  const pinRole = (id: string, pinName: string): PinGeom['role'] => syms.get(id)!.pins.find(p => p.name === pinName)?.role ?? 'passive';
  for (let k = 0; k < islandRoots.length; k++) {
    const members = flow.filter(c => islandOf.get(c.id) === k);
    let seeds = members.filter(c => isSeed(c));
    if (seeds.length === 0) {
      // No stimulus: start from the busiest part (an IC, a transistor), ties by id.
      const real = members.filter(c => !c.id.startsWith('__node'));
      real.sort((a, b) => Object.keys(b.pins).length - Object.keys(a.pins).length || a.id.localeCompare(b.id));
      seeds = real.slice(0, 1);
    }
    if (seeds.length === 0) seeds = members.slice(0, 1);
    const queue: string[] = [];
    for (const s of seeds) {
      layerOf.set(s.id, 0);
      queue.push(s.id);
    }
    // A net is 'down'stream of the part that drove the visit (its output or a
    // passive pin) or 'up'stream (reached through an input): passive parts on
    // an upstream net are laid to the LEFT of their consumer, keeping e.g. an
    // NE555's timing network on the trigger side.
    const netDir = new Map<string, 'up' | 'down'>();
    const pinSide = (id: string, pinName: string): Side => syms.get(id)!.pins.find(p => p.name === pinName)?.side ?? 'l';
    const visitNet = (net: string, depth: number, dir: 'up' | 'down'): void => {
      if (netDepth.has(net)) return;
      netDepth.set(net, depth);
      netDir.set(net, dir);
      for (const ref of netPins.get(net) ?? []) {
        const nid = compOfRef(ref);
        if (!seriesIds.has(nid) || layerOf.has(nid)) continue;
        const role = pinRole(nid, pinOfRef(ref));
        const passive = syms.get(nid)!.kind === 'two' || nid.startsWith('__node');
        let L: number;
        if (role === 'out') L = depth;
        else if (role === 'in') L = depth + 1;
        else if (passive) L = dir === 'up' ? depth : depth + 1;
        else L = dir === 'up' ? depth : depth + 1;
        layerOf.set(nid, L);
        queue.push(nid);
      }
    };
    while (queue.length > 0) {
      const id = queue.shift()!;
      const c = byId.get(id)!;
      const L = layerOf.get(id)!;
      const passive = syms.get(id)!.kind === 'two' || id.startsWith('__node');
      // The net this part was reached from tells the flow direction for its other pins.
      const reachedVia = Object.values(c.pins).find(n => isSignal(n) && netDepth.has(n));
      const flowDir: 'up' | 'down' = reachedVia ? netDir.get(reachedVia) ?? 'down' : 'down';
      const pins = Object.keys(c.pins).sort((a, b) => {
        // outputs first so a part's downstream nets get the shallower depth
        const w = (r: string) => (r === 'out' ? 0 : r === 'in' ? 2 : 1);
        return w(pinRole(id, a)) - w(pinRole(id, b)) || a.localeCompare(b);
      });
      for (const pinName of pins) {
        const net = c.pins[pinName];
        if (!isSignal(net)) continue;
        const role = pinRole(id, pinName);
        const side = pinSide(id, pinName);
        if (passive) visitNet(net, flowDir === 'up' ? L - 1 : L, flowDir);
        else if (role === 'in' || (role === 'analog' && side === 'l')) visitNet(net, L - 1, 'up');
        else visitNet(net, L, 'down');
      }
    }
    // Unreached members (should not happen inside an island) go to the end.
    const maxL = Math.max(0, ...members.map(c => layerOf.get(c.id) ?? 0));
    for (const c of members) if (!layerOf.has(c.id)) layerOf.set(c.id, maxL + 1);
    // Normalise to 0-based layers per island.
    const minL = Math.min(...members.map(c => layerOf.get(c.id)!));
    if (minL !== 0) {
      for (const c of members) layerOf.set(c.id, layerOf.get(c.id)! - minL);
      const nets = new Set(members.flatMap(c => Object.values(c.pins)).filter(n => isSignal(n) && netDepth.has(n)));
      for (const net of nets) netDepth.set(net, netDepth.get(net)! - minL);
    }
  }
  for (const [net, refs] of netPins) {
    if (!isSignal(net) || netDepth.has(net)) continue;
    const ds = refs.map(r => layerOf.get(compOfRef(r))).filter((d): d is number => d !== undefined);
    if (ds.length > 0) netDepth.set(net, Math.min(...ds));
  }
  const depthOf = (net: string): number => netDepth.get(net) ?? Infinity;

  // ── orientation of series parts ──
  const rotationOf = new Map<string, Rotation>();
  for (const c of flow) {
    const sym = syms.get(c.id)!;
    let r: Rotation = 0;
    if (sym.kind === 'two') {
      const [a, b] = sym.pins;
      const da = depthOf(c.pins[a.name]);
      const db = depthOf(c.pins[b.name]);
      if (db < da) r = 180;
    } else if (sym.kind === 'source') {
      const plus = c.pins['+'];
      const minus = c.pins['-'];
      if (!isGnd(minus) && !isRail(minus) && !isGnd(plus)) r = depthOf(minus) <= depthOf(plus) ? 90 : 270;
    }
    rotationOf.set(c.id, r);
  }

  // ── chain geometry helpers ──
  const CHAIN_W = 6 * G; // slot width
  const CHAIN_STEP = 7 * G; // vertical pitch per part (6G body + 1G wire)
  const PORT_H = 3 * G; // room for a ground / rail symbol
  const chainGap = (zone: string): number => (zone === 'inline' ? 2 * G : G);
  const chainHeight = (ch: Chain, zone: string): number => chainGap(zone) + ch.comps.length * CHAIN_STEP + PORT_H;

  // Where do the chains of a net attach? The anchor pin: a flow part pin on that net
  // (prefer right-side outputs on the lowest layer, else lowest layer).
  const anchorPinOf = new Map<string, { comp: string; pin: PinGeom }>();
  for (const net of chainsOnNet.keys()) {
    const cands: { comp: string; pin: PinGeom; score: number }[] = [];
    for (const ref of netPins.get(net) ?? []) {
      const id = compOfRef(ref);
      if (!seriesIds.has(id)) continue;
      const sym = syms.get(id)!;
      const pin = sym.pins.find(p => p.name === pinOfRef(ref));
      if (!pin) continue;
      const side = rotateSide(pin.side, rotationOf.get(id) ?? 0);
      const L = layerOf.get(id) ?? 0;
      cands.push({ comp: id, pin, score: L * 10 + (side === 'r' ? 0 : side === 't' || side === 'b' ? 1 : 5) });
    }
    cands.sort((a, b) => a.score - b.score || a.comp.localeCompare(b.comp));
    if (cands.length > 0) anchorPinOf.set(net, { comp: cands[0].comp, pin: cands[0].pin });
  }

  // For each flow part: chains placed at its pins, grouped by placement.
  interface Hang {
    pin: PinGeom;
    side: Side; // rotated side of the anchor pin
    chain: Chain;
    dirY: 1 | -1; // -1 above (rail), +1 below (gnd)
    zone: 'r' | 'l' | 'inline';
    slot: number;
  }
  const hangs = new Map<string, Hang[]>();
  for (const [net, list] of chainsOnNet) {
    const anchor = anchorPinOf.get(net);
    if (!anchor) continue;
    const side = rotateSide(anchor.pin.side, rotationOf.get(anchor.comp) ?? 0);
    const arr = hangs.get(anchor.comp) ?? [];
    let slotAbove = 0;
    let slotBelow = 0;
    for (const chain of list) {
      const dirY: 1 | -1 = chain.target === 'rail' && (rails.get(chain.targetNet)?.polarity ?? 1) > 0 ? -1 : 1;
      const inline = (side === 't' && dirY === -1) || (side === 'b' && dirY === 1);
      const zone: Hang['zone'] = inline ? 'inline' : side === 'l' ? 'l' : 'r';
      let slot: number;
      if (inline) slot = dirY === -1 ? slotAbove++ : slotBelow++;
      else slot = dirY === -1 ? slotAbove++ : slotBelow++;
      arr.push({ pin: anchor.pin, side, chain, dirY, zone, slot });
    }
    hangs.set(anchor.comp, arr);
  }
  // Slot indices restart per pin; offset them per part so pins on the same side do not collide.
  for (const arr of hangs.values()) {
    const bySide = new Map<string, Hang[]>();
    for (const h of arr) {
      const k = h.zone;
      const l = bySide.get(k) ?? [];
      l.push(h);
      bySide.set(k, l);
    }
    for (const list of bySide.values()) {
      const pins = [...new Set(list.map(h => h.pin.name))].sort();
      let base = 0;
      for (const pn of pins) {
        const mine = list.filter(h => h.pin.name === pn);
        for (const h of mine) h.slot += base;
        base += Math.max(mine.filter(h => h.dirY === -1).length, mine.filter(h => h.dirY === 1).length);
      }
    }
  }

  // ── vertical extents of a flow part (own body + hanging chains) ──
  const extents = (id: string): { top: number; bottom: number; left: number; right: number; zoneL: number; zoneR: number } => {
    const c = byId.get(id)!;
    const sym = syms.get(id)!;
    const r = rotationOf.get(id) ?? 0;
    const swap = r === 90 || r === 270;
    const bodyHH = (swap ? sym.w : sym.h) / 2;
    const bodyHW = (swap ? sym.h : sym.w) / 2;
    let top = bodyHH;
    let bottom = bodyHH;
    let left = bodyHW;
    let right = bodyHW;
    // Labels sit to the right of vertical parts, sources, transistors and switches: keep room for them.
    const rightLabelled = sym.kind === 'transistor' || sym.kind === 'source' || sym.kind === 'switch' || swap;
    if (rightLabelled) {
      const chars = Math.max(sym.label.length, (sym.value ?? '').length);
      right = Math.max(right, snap(bodyHW + 6 + chars * 6.4 + G - 1));
    }
    // Ports directly on the body's pins.
    for (const p of sym.pins) {
      const net = c.pins[p.name];
      const side = rotateSide(p.side, r);
      if (isGnd(net) || isRail(net)) {
        if (side === 'b') bottom = Math.max(bottom, bodyHH + PORT_H);
        if (side === 't') top = Math.max(top, bodyHH + PORT_H);
        if (side === 'l') left = Math.max(left, bodyHW + 2 * G);
        if (side === 'r') right = Math.max(right, bodyHW + 2 * G);
      }
    }
    // Inline stacks (under top/bottom pins) widen the body footprint; zone
    // stacks start beyond that footprint.
    let inlineL = bodyHW;
    let inlineR = bodyHW;
    const list = hangs.get(id) ?? [];
    for (const h of list) {
      const rp = rotatePoint(h.pin.x, h.pin.y, r);
      const hgt = chainHeight(h.chain, h.zone);
      if (h.dirY === -1) top = Math.max(top, -rp.y + hgt);
      else bottom = Math.max(bottom, rp.y + hgt);
      if (h.zone === 'inline') {
        inlineR = Math.max(inlineR, rp.x + h.slot * CHAIN_W + 3 * G);
        inlineL = Math.max(inlineL, -(rp.x + h.slot * CHAIN_W) + 3 * G);
      }
    }
    const zoneL = Math.max(left, inlineL) + 2 * G;
    const zoneR = Math.max(right, inlineR) + 2 * G;
    left = Math.max(left, inlineL);
    right = Math.max(right, inlineR);
    for (const h of list) {
      if (h.zone === 'r') right = Math.max(right, zoneR + (h.slot + 1) * CHAIN_W);
      if (h.zone === 'l') left = Math.max(left, zoneL + (h.slot + 1) * CHAIN_W);
    }
    return { top: snap(top) + 2 * G, bottom: snap(bottom) + 2 * G, left, right, zoneL, zoneR };
  };

  // ── placement ──
  const placed = new Map<string, PlacedComponent>();
  const docLayout = doc.layout?.components;
  const hasFullLayout = !!docLayout && comps.every(c => docLayout[c.id] && Number.isFinite(docLayout[c.id].x) && Number.isFinite(docLayout[c.id].y));

  if (hasFullLayout) {
    for (const c of comps) {
      const p = docLayout![c.id];
      const rot = ([0, 90, 180, 270].includes(p.rotation ?? 0) ? (p.rotation ?? 0) : 0) as Rotation;
      placed.set(c.id, makePlaced(c, syms.get(c.id)!, snap(p.x), snap(p.y), rot, supplies.has(c.id) ? 'supply' : inChain.has(c.id) ? 'chain' : 'series'));
    }
  } else {
    let islandTop = 0;
    const ROW_GAP = 2 * G;
    for (let k = 0; k < islandRoots.length; k++) {
      const members = flow.filter(c => islandOf.get(c.id) === k);
      const maxLayer = Math.max(0, ...members.map(c => layerOf.get(c.id)!));
      const layers: CircuitComponent[][] = [];
      for (let L = 0; L <= maxLayer; L++) layers.push(members.filter(c => layerOf.get(c.id) === L));
      const ext = new Map(members.map(c => [c.id, extents(c.id)]));

      // Column x positions.
      const colX: number[] = [];
      let x = 0;
      for (let L = 0; L <= maxLayer; L++) {
        const leftW = Math.max(0, ...layers[L].map(c => ext.get(c.id)!.left));
        const rightW = Math.max(0, ...layers[L].map(c => ext.get(c.id)!.right));
        if (L > 0) {
          const prevRight = Math.max(0, ...layers[L - 1].map(c => ext.get(c.id)!.right));
          x += prevRight + 4 * G + leftW;
        } else x = leftW;
        colX.push(snap(x));
        void rightW;
      }

      // Row order by barycenter of upstream connections, then y assignment with pin alignment.
      const order = new Map<string, number>();
      const baseline = Math.max(0, ...layers.map(l => Math.max(0, ...l.map(c => ext.get(c.id)!.top))));
      const yOf = new Map<string, number>();
      for (let L = 0; L <= maxLayer; L++) {
        const list = layers[L];
        if (L > 0) {
          const bary = new Map<string, number>();
          for (const c of list) {
            const ups: number[] = [];
            for (const net of Object.values(c.pins)) {
              if (!isSignal(net)) continue;
              for (const ref of netPins.get(net) ?? []) {
                const oid = compOfRef(ref);
                if (oid !== c.id && order.has(oid) && (layerOf.get(oid) ?? 0) < L) ups.push(order.get(oid)!);
              }
            }
            bary.set(c.id, ups.length > 0 ? ups.reduce((a, b) => a + b, 0) / ups.length : Infinity);
          }
          list.sort((a, b) => bary.get(a.id)! - bary.get(b.id)! || a.id.localeCompare(b.id));
        } else list.sort((a, b) => a.id.localeCompare(b.id));
        list.forEach((c, i) => order.set(c.id, i));

        // Every column starts at a common baseline so first rows line up.
        let cursor = islandTop + baseline - (list.length > 0 ? ext.get(list[0].id)!.top : 0);
        for (const c of list) {
          const e = ext.get(c.id)!;
          const r = rotationOf.get(c.id) ?? 0;
          const sym = syms.get(c.id)!;
          // Desired y: align the input pin with the upstream pin it connects to.
          let desired: number | undefined;
          if (L > 0) {
            const targets: number[] = [];
            for (const p of sym.pins) {
              const net = c.pins[p.name];
              if (!isSignal(net) || depthOf(net) >= L) continue;
              const rp = rotatePoint(p.x, p.y, r);
              for (const ref of netPins.get(net) ?? []) {
                const oid = compOfRef(ref);
                const op = placed.get(oid);
                if (!op || (layerOf.get(oid) ?? Infinity) >= L) continue;
                const opin = op.pins.find(pp => pp.name === pinOfRef(ref));
                if (opin) targets.push(opin.y - rp.y);
              }
            }
            if (targets.length > 0) {
              targets.sort((a, b) => a - b);
              desired = snap(targets[Math.floor((targets.length - 1) / 2)]);
            }
          }
          const y = Math.max(desired ?? -Infinity, cursor + e.top);
          yOf.set(c.id, y);
          placed.set(c.id, makePlaced(c, sym, colX[L], y, r, c.id.startsWith('__node') ? 'node' : 'series'));
          cursor = y + e.bottom + ROW_GAP;
        }
      }
      // Hang the chains.
      for (const c of members) {
        const pc = placed.get(c.id)!;
        const e = ext.get(c.id)!;
        for (const h of hangs.get(c.id) ?? []) {
          const apin = pc.pins.find(p => p.name === h.pin.name)!;
          let sx: number;
          const y0 = apin.y + h.dirY * chainGap(h.zone);
          if (h.zone === 'inline') sx = apin.x + h.slot * CHAIN_W;
          else if (h.zone === 'r') sx = pc.x + e.zoneR + h.slot * CHAIN_W + 3 * G;
          else sx = pc.x - e.zoneL - h.slot * CHAIN_W - 3 * G;
          sx = snap(sx);
          let net = h.chain.anchorNet;
          h.chain.comps.forEach((id, k) => {
            const cc = byId.get(id)!;
            const sym = syms.get(id)!;
            const first = sym.pins[0].name;
            const anchorIsFirst = cc.pins[first] === net;
            // rotation 90: pin[0] on top; 270: pin[0] at the bottom.
            const rot: Rotation = h.dirY === 1 ? (anchorIsFirst ? 90 : 270) : anchorIsFirst ? 270 : 90;
            const cy = y0 + h.dirY * (k * CHAIN_STEP + 3 * G);
            void CHAIN_STEP;
            placed.set(id, makePlaced(cc, sym, sx, snap(cy), rot, 'chain'));
            net = otherPinNet(cc, anchorIsFirst ? first : sym.pins[1].name) ?? net;
          });
        }
      }
      const bottoms = members.map(c => placed.get(c.id)!).map(p => yOf.get(p.id)! + ext.get(p.id)!.bottom);
      islandTop = Math.max(islandTop, ...bottoms) + 4 * G;
    }

    // Supplies + bleeders: a power column at the left.
    const powerParts = [...supplies].sort().map(id => byId.get(id)!).concat(bleeders);
    if (powerParts.length > 0) {
      const minX = Math.min(...[...placed.values()].map(p => p.x - p.hw), 0);
      const px = snap(minX - 8 * G);
      let y = 0;
      for (const c of powerParts) {
        const sym = syms.get(c.id)!;
        const rot: Rotation = supplies.has(c.id) ? 0 : isRail(c.pins[sym.pins[0].name]) ? 90 : 270;
        const neg = supplies.has(c.id) && (rails.get(c.pins['-'])?.polarity ?? 1) < 0 && c.pins['+'] === 'gnd';
        const cy = y + PORT_H + 3 * G;
        placed.set(c.id, makePlaced(c, sym, px, snap(cy), neg ? 180 : rot, supplies.has(c.id) ? 'supply' : 'bleeder'));
        y = cy + 3 * G + PORT_H + 2 * G;
      }
    }
  }

  // Any component still unplaced (defensive): stack below.
  {
    let y = Math.max(0, ...[...placed.values()].map(p => p.y + p.hh)) + 6 * G;
    for (const c of comps) {
      if (placed.has(c.id)) continue;
      placed.set(c.id, makePlaced(c, syms.get(c.id)!, 0, snap(y), 0, 'series'));
      y += 8 * G;
    }
  }

  // ── normalise coordinates ──
  const all = [...placed.values()];
  const MARGIN = 6 * G;
  const minX = Math.min(...all.map(p => p.x - p.hw)) - MARGIN;
  const minY = Math.min(...all.map(p => p.y - p.hh)) - MARGIN - 3 * G;
  const dx = -snap(minX);
  const dy = -snap(minY);
  const components: PlacedComponent[] = all
    .map(p => makePlaced(p.doc, p.sym, p.x + dx, p.y + dy, p.rotation, p.role))
    .map(p => ({ ...p, virtual: p.doc.type === '__node' }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const placedById = new Map(components.map(p => [p.id, p]));

  // ── grid ──
  const maxX = Math.max(...components.map(p => p.x + p.hw)) + MARGIN + 8 * G;
  const maxY = Math.max(...components.map(p => p.y + p.hh)) + MARGIN + 6 * G;
  const grid = new Grid(Math.ceil(maxX / G) + 2, Math.ceil(maxY / G) + 2);
  const cell = (x: number, y: number): Cell => ({ i: Math.round(x / G), j: Math.round(y / G) });
  const ckey = (c: Cell): number => c.j * 65536 + c.i;

  for (const p of components) {
    if (p.virtual) continue;
    const c0 = cell(p.x - p.hw, p.y - p.hh);
    const c1 = cell(p.x + p.hw, p.y + p.hh);
    grid.blockRect(c0.i, c0.j, c1.i, c1.j);
    for (let i = c0.i - 1; i <= c1.i + 1; i++) {
      grid.soften(i, c0.j - 1);
      grid.soften(i, c1.j + 1);
    }
    for (let j = c0.j - 1; j <= c1.j + 1; j++) {
      grid.soften(c0.i - 1, j);
      grid.soften(c1.i + 1, j);
    }
  }
  for (const p of components) {
    for (const pin of p.pins) {
      const c = cell(pin.x, pin.y);
      grid.reserve(c.i, c.j, pin.net || `__nc_${pin.ref}`);
      const d = DELTA[pin.dir];
      grid.reserve(c.i + d.x, c.j + d.y, pin.net || `__nc_${pin.ref}`);
      // Approach lane: a wire may run straight into the exit without a detour penalty.
      for (let k = 1; k <= 3; k++) {
        if (d.x !== 0) {
          grid.unsoften(c.i + d.x, c.j - k);
          grid.unsoften(c.i + d.x, c.j + k);
        } else {
          grid.unsoften(c.i - k, c.j + d.y);
          grid.unsoften(c.i + k, c.j + d.y);
        }
      }
    }
  }

  // ── ground / rail ports ──
  const ports: Port[] = [];
  const noConnects: NoConnect[] = [];
  const occupyPath = (pts: Point[], net: string): void => {
    for (let k = 1; k < pts.length; k++) {
      const a = cell(pts[k - 1].x, pts[k - 1].y);
      const b = cell(pts[k].x, pts[k].y);
      const axis = a.j === b.j ? 'h' : 'v';
      const si = Math.sign(b.i - a.i);
      const sj = Math.sign(b.j - a.j);
      let i = a.i;
      let j = a.j;
      for (;;) {
        grid.occupy(i, j, net, k > 1 && i === a.i && j === a.j ? 'x' : axis);
        if (i === b.i && j === b.j) break;
        i += si;
        j += sj;
      }
    }
  };
  const blockAround = (x: number, y: number, rx: number, ry: number): void => {
    const c0 = cell(x - rx, y - ry);
    const c1 = cell(x + rx, y + ry);
    grid.blockRect(c0.i, c0.j, c1.i, c1.j);
  };

  const portPins: { p: PlacedComponent; pin: PlacedPin; kind: 'gnd' | 'rail'; dirY: 1 | -1 }[] = [];
  for (const p of components) {
    for (const pin of p.pins) {
      if (isGnd(pin.net)) portPins.push({ p, pin, kind: 'gnd', dirY: 1 });
      else if (isRail(pin.net)) portPins.push({ p, pin, kind: 'rail', dirY: rails.get(pin.net)!.polarity > 0 ? -1 : 1 });
      else if (pinCount(netPins, pin.net) < 2) {
        const d = DELTA[pin.dir];
        noConnects.push({ ref: pin.ref, x: pin.x + d.x * G, y: pin.y + d.y * G });
      }
    }
  }
  // Group side pins per (component, side, net) → one bus with a single symbol.
  const groups = new Map<string, typeof portPins>();
  for (const pp of portPins) {
    const k = pp.pin.dir === 'l' || pp.pin.dir === 'r' ? `${pp.p.id}|${pp.pin.dir}|${pp.pin.net}` : `${pp.pin.ref}`;
    const l = groups.get(k) ?? [];
    l.push(pp);
    groups.set(k, l);
  }
  for (const k of [...groups.keys()].sort()) {
    const g = groups.get(k)!.sort((a, b) => a.pin.y - b.pin.y || a.pin.x - b.pin.x);
    const { kind, dirY } = g[0];
    const net = g[0].pin.net;
    const label = kind === 'rail' ? rails.get(net)!.label : undefined;
    const first = g[0].pin;
    if (first.dir === 't' || first.dir === 'b') {
      const up = first.dir === 't';
      const symY = first.y + (up ? -2 * G : 2 * G);
      const dy2: 1 | -1 = up ? -1 : 1;
      ports.push({ kind, net, x: first.x, y: symY, dirY: dy2, label, points: [[{ x: first.x, y: first.y }, { x: first.x, y: symY }]], pinRefs: [first.ref] });
      occupyPath([{ x: first.x, y: first.y }, { x: first.x, y: symY }], net);
      blockAround(first.x, symY + dy2 * G, 2 * G, G);
    } else {
      const out = first.dir === 'l' ? -1 : 1;
      const busX = first.x + out * 3 * G;
      const pts: Point[][] = g.map(pp => [{ x: pp.pin.x, y: pp.pin.y }, { x: busX, y: pp.pin.y }]);
      const yTop = g[0].pin.y;
      const yBot = g[g.length - 1].pin.y;
      const symY = dirY > 0 ? yBot + 3 * G : yTop - 3 * G;
      pts.push([{ x: busX, y: dirY > 0 ? yTop : yBot }, { x: busX, y: symY }]);
      ports.push({ kind, net, x: busX, y: symY, dirY, label, points: pts, pinRefs: g.map(pp => pp.pin.ref) });
      for (const seg of pts) occupyPath(seg, net);
      blockAround(busX, symY + dirY * G, G, G);
    }
  }
  for (const nc of noConnects) {
    const c = cell(nc.x, nc.y);
    grid.block(c.i, c.j);
  }

  // ── route signal nets ──
  const wires: Wire[] = [];
  const labels: NetLabel[] = [];
  const labelledNets: string[] = [];
  const pinByRef = new Map<string, PlacedPin>();
  for (const p of components) for (const pin of p.pins) pinByRef.set(pin.ref, pin);
  const signalNets = [...netPins.keys()].filter(isSignal).sort((a, b) => {
    const pa = netPins.get(a)!;
    const pb = netPins.get(b)!;
    if (pa.length !== pb.length) return pa.length - pb.length;
    const span = (refs: string[]) => {
      const pts = refs.map(r => pinByRef.get(r)!);
      return Math.max(...pts.map(p => p.x)) - Math.min(...pts.map(p => p.x)) + Math.max(...pts.map(p => p.y)) - Math.min(...pts.map(p => p.y));
    };
    return span(pa) - span(pb) || a.localeCompare(b);
  });
  const LONG_ROUTE = 70;
  const wireHints = new Map<string, Point[]>();
  for (const w of doc.layout?.wires ?? []) if (w.points && w.points.length > 0) wireHints.set(`${w.from}>${w.to}`, w.points.map(([x, y]) => ({ x: snap(x), y: snap(y) })));

  for (const net of signalNets) {
    const refs = (netPins.get(net) ?? []).map(r => pinByRef.get(r)!).filter(Boolean);
    const virtualFirst = (a: PlacedPin, b: PlacedPin) => Number(!a.ref.startsWith('__node')) - Number(!b.ref.startsWith('__node')) || a.x - b.x || a.y - b.y || a.ref.localeCompare(b.ref);
    refs.sort(virtualFirst);
    const tree = new Set<number>();
    const addPinToTree = (pin: PlacedPin) => {
      const c = cell(pin.x, pin.y);
      tree.add(ckey(c));
      const d = DELTA[pin.dir];
      const e = { i: c.i + d.x, j: c.j + d.y };
      if (!grid.isBlocked(e.i, e.j)) {
        tree.add(ckey(e));
        grid.occupy(e.i, e.j, net, pin.dir === 'l' || pin.dir === 'r' ? 'h' : 'v');
      }
      grid.occupy(c.i, c.j, net, pin.dir === 'l' || pin.dir === 'r' ? 'h' : 'v');
    };
    const flagAt = (pin: PlacedPin) => {
      const d = DELTA[pin.dir];
      labels.push({ net, x: pin.x + d.x * G, y: pin.y + d.y * G, kind: 'flag', dir: pin.dir });
      if (!labelledNets.includes(net)) labelledNets.push(net);
    };
    let seeded = false;
    let wiredAny = false;
    let labelledSeed = false;
    const seed = refs[0];
    const seedExit = { x: seed.x + DELTA[seed.dir].x * G, y: seed.y + DELTA[seed.dir].y * G };
    const wiresBefore = wires.length;
    for (let k = 0; k < refs.length; k++) {
      const pin = refs[k];
      if (!seeded) {
        addPinToTree(pin);
        seeded = true;
        continue;
      }
      // Touching pins (a chain part sitting on its neighbour): already connected.
      if (tree.has(ckey(cell(pin.x, pin.y)))) {
        wires.push({ net, points: [{ x: pin.x, y: pin.y }], from: pin.ref });
        addPinToTree(pin);
        wiredAny = true;
        continue;
      }
      // Honour an explicit wire hint between two pins of this net.
      const hint = wireHints.get(`${seed.ref}>${pin.ref}`) ?? wireHints.get(`${pin.ref}>${seed.ref}`);
      if (hint) {
        const pts = [{ x: pin.x, y: pin.y }, ...hint, { x: seed.x, y: seed.y }];
        wires.push({ net, points: pts, from: pin.ref });
        occupyPath(pts, net);
        for (const pt of pts) tree.add(ckey(cell(pt.x, pt.y)));
        wiredAny = true;
        continue;
      }
      const c = cell(pin.x, pin.y);
      const path = route(grid, { i: c.i, j: c.j, dir: DIR_INDEX[pin.dir] }, tree, net);
      const named = !autoNet(net);
      if (!path || (named && path.length > LONG_ROUTE && refs.length > 2)) {
        flagAt(pin);
        if (!wiredAny && !labelledSeed) {
          flagAt(seed);
          labelledSeed = true;
        }
        continue;
      }
      const pts = corners(path).map(cc => ({ x: cc.i * G, y: cc.j * G }));
      wires.push({ net, points: pts, from: pin.ref });
      occupyPath(pts, net);
      for (const cc of path) tree.add(ckey(cc));
      wiredAny = true;
    }
    if (!wiredAny && refs.length >= 2 && !labelledSeed && labels.some(l => l.net === net)) flagAt(seed);
    // The seed's exit cell is part of the tree; draw its stub only when a route actually ends there.
    if (wires.slice(wiresBefore).some(w => w.points.length > 1 && w.points[w.points.length - 1].x === seedExit.x && w.points[w.points.length - 1].y === seedExit.y)) {
      wires.push({ net, points: [{ x: seed.x, y: seed.y }, seedExit], from: seed.ref });
    }
  }

  // ── junction dots ──
  const junctions: Junction[] = [];
  {
    const degree = new Map<string, Map<number, number>>();
    const bump = (net: string, c: Cell, n = 1) => {
      const m = degree.get(net) ?? new Map<number, number>();
      m.set(ckey(c), (m.get(ckey(c)) ?? 0) + n);
      degree.set(net, m);
    };
    const walk = (net: string, pts: Point[]) => {
      for (let k = 1; k < pts.length; k++) {
        const a = cell(pts[k - 1].x, pts[k - 1].y);
        const b = cell(pts[k].x, pts[k].y);
        const si = Math.sign(b.i - a.i);
        const sj = Math.sign(b.j - a.j);
        let i = a.i;
        let j = a.j;
        while (i !== b.i || j !== b.j) {
          bump(net, { i, j });
          i += si;
          j += sj;
          bump(net, { i, j });
        }
      }
    };
    for (const w of wires) walk(w.net, w.points);
    for (const p of components) for (const pin of p.pins) if (isSignal(pin.net) && !p.virtual) bump(pin.net, cell(pin.x, pin.y));
    for (const [net, m] of degree) {
      for (const [k, d] of m) {
        if (d >= 3) junctions.push({ net, x: (k % 65536) * G, y: Math.floor(k / 65536) * G });
      }
    }
    junctions.sort((a, b) => a.net.localeCompare(b.net) || a.x - b.x || a.y - b.y);
  }

  // ── captions for named nets ──
  for (const net of signalNets) {
    if (autoNet(net)) continue;
    if (labels.some(l => l.net === net && l.kind === 'flag')) continue;
    const segs: { x: number; y: number; len: number }[] = [];
    for (const w of wires) {
      if (w.net !== net) continue;
      for (let k = 1; k < w.points.length; k++) {
        const a = w.points[k - 1];
        const b = w.points[k];
        if (a.y === b.y && Math.abs(b.x - a.x) >= 2 * G) segs.push({ x: (a.x + b.x) / 2, y: a.y, len: Math.abs(b.x - a.x) });
      }
    }
    if (segs.length > 0) {
      segs.sort((a, b) => b.len - a.len || a.x - b.x);
      labels.push({ net, x: segs[0].x, y: segs[0].y - 5, kind: 'caption' });
    } else {
      const pin = (netPins.get(net) ?? []).map(r => pinByRef.get(r)!).filter(p => p && !p.ref.startsWith('__node'))[0];
      if (pin) {
        const d = DELTA[pin.dir];
        labels.push({ net, x: pin.x + d.x * G, y: pin.y + d.y * G - 5, kind: 'caption' });
      }
    }
  }

  const width = snap(Math.max(...components.map(p => p.x + p.hw), ...ports.map(p => p.x + 4 * G), ...wires.flatMap(w => w.points.map(p => p.x))) + MARGIN);
  const height = snap(Math.max(...components.map(p => p.y + p.hh), ...ports.map(p => p.y + 3 * G), ...wires.flatMap(w => w.points.map(p => p.y))) + MARGIN);
  const railLabels: Record<string, string> = {};
  for (const r of rails.values()) railLabels[r.net] = r.label;
  return {
    width,
    height,
    components: components.filter(p => !p.virtual),
    wires,
    ports,
    labels,
    junctions,
    noConnects,
    netOfPin,
    rails: railLabels,
    labelledNets,
  };
}
