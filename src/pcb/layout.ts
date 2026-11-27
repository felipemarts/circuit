/**
 * Board layout: resolve every component's footprint and pin → pad map, put
 * the placed footprints on the board, check them (P801–P807), suggest a free
 * spot for unplaced parts, and compute the ratsnest (the airwires the router
 * will have to turn into copper). Pure and deterministic — the CLI stage and
 * the web viewer call the same function on the same data.
 */
import type { Diagnostic, Fix, NetlistComponent } from '../schema/types';
import type { BoardSpec, FootprintDef, PcbAirwire, PcbRecord, PcbSpec, PcbTech, PlacementSpec } from './types';
import { getFootprint } from './footprints';
import { defaultFootprint, pinMap } from './assign';
import { bbox, distPointPoly, distToOutline, insideOutline, outlinePolygon, overlapDepth, placeRect, polyArea, round, toBoard, type Poly, type Pt } from './geometry';

export interface PlacedPad {
  /** 'R1.1', 'D1.K'. */
  ref: string;
  comp: string;
  name: string;
  /** Component pin on this pad (absent: not connected). */
  pin?: string;
  net?: string;
  x: number;
  y: number;
  w: number;
  h: number;
  shape: FootprintDef['pads'][number]['shape'];
  drill?: number;
  /** Copper layer: 'through' for drilled pads, else the placement side. */
  layer: 'top' | 'bottom' | 'through';
  /** Rotation of the pad on the board (degrees CCW). */
  rot: number;
  poly: Poly;
}

export interface PlacedPart {
  id: string;
  type: string;
  footprint: FootprintDef;
  x: number;
  y: number;
  rot: number;
  side: 'top' | 'bottom';
  tech: PcbTech;
  courtyards: Poly[];
  pads: PlacedPad[];
  holes: { x: number; y: number; d: number }[];
  /** pin → pad names. */
  pinPads: Record<string, string[]>;
  /** Footprint-local → board transform. */
  place: { x: number; y: number; rot: number; side: 'top' | 'bottom' };
}

export interface BoardLayout {
  board: BoardSpec;
  outline: Poly;
  parts: PlacedPart[];
  offBoard: string[];
  unplaced: { id: string; footprint: FootprintDef; suggested?: { x: number; y: number; rot: number } }[];
  /** Board holes and the holes of placed footprints. */
  holes: { x: number; y: number; d: number; owner?: string }[];
  ratsnest: PcbAirwire[];
  diagnostics: Diagnostic[];
  record: PcbRecord;
}

export interface LayoutLocations {
  /** tb.place(...) location per component id (default: the placement's own `at`, then the tb.add location). */
  place?: Record<string, string | undefined>;
}

const CONNECTOR_RE = /^(HDR-|TERM-|UNO-SHIELD$)/;
const fmt = (v: number): string => String(round(Math.round(v * 100) / 100));

function diag(code: string, slug: string, message: string, o: { severity?: 'error' | 'warning'; components?: string[]; net?: string; note?: string; evidence?: Record<string, unknown>; fixes?: Fix[]; at?: string }): Diagnostic {
  return {
    code,
    slug,
    severity: o.severity ?? 'error',
    stage: 'pcb',
    message,
    ...(o.components || o.net ? { subject: { ...(o.net ? { net: o.net } : {}), ...(o.components ? { components: o.components } : {}) } } : {}),
    ...(o.note ? { note: o.note } : {}),
    ...(o.evidence ? { evidence: o.evidence } : {}),
    fixes: o.fixes ?? [],
    ...(o.at ? { at: o.at } : {}),
  };
}

interface Resolved {
  c: NetlistComponent;
  fp: FootprintDef;
  map: Record<string, string[]>;
  pl: PlacementSpec;
  /** pad name → net (connected pads only). */
  padNet: Map<string, string>;
  padPin: Map<string, string>;
}

function placePart(r: Resolved, place: { x: number; y: number; rot: number; side: 'top' | 'bottom' }): PlacedPart {
  const { c, fp } = r;
  const pads: PlacedPad[] = fp.pads.map(p => {
    const [x, y] = toBoard(p.x, p.y, place);
    const net = r.padNet.get(p.name);
    const pin = r.padPin.get(p.name);
    return {
      ref: `${c.id}.${p.name}`,
      comp: c.id,
      name: p.name,
      ...(pin !== undefined ? { pin } : {}),
      ...(net !== undefined ? { net } : {}),
      x,
      y,
      w: p.w,
      h: p.h,
      shape: p.shape,
      ...(p.drill !== undefined ? { drill: p.drill } : {}),
      layer: p.drill !== undefined ? 'through' : place.side,
      rot: place.rot,
      poly: placeRect(p.x, p.y, p.w, p.h, place),
    };
  });
  return {
    id: c.id,
    type: c.type,
    footprint: fp,
    x: place.x,
    y: place.y,
    rot: place.rot,
    side: place.side,
    tech: fp.tech,
    courtyards: fp.courtyard.map(k => placeRect(k.x, k.y, k.w, k.h, place)),
    pads,
    holes: (fp.holes ?? []).map(h => {
      const [x, y] = toBoard(h.x, h.y, place);
      return { x, y, d: h.d };
    }),
    pinPads: r.map,
    place,
  };
}

/** Two parts collide: courtyards on the same side, or a drilled part's pads under the other's courtyard. */
function collision(a: PlacedPart, b: PlacedPart): number {
  let depth = 0;
  if (a.side === b.side) {
    for (const ca of a.courtyards) for (const cb of b.courtyards) depth = Math.max(depth, overlapDepth(ca, cb));
    return depth;
  }
  const drilled = (p: PlacedPart, other: PlacedPart) => {
    for (const pad of p.pads) if (pad.layer === 'through') for (const k of other.courtyards) depth = Math.max(depth, overlapDepth(pad.poly, k));
  };
  drilled(a, b);
  drilled(b, a);
  return depth;
}

/**
 * Lay out a board. `components` is the canonical netlist (ascending id);
 * every pin's net comes from `components[].pins`.
 */
export function layoutBoard(pcb: PcbSpec, components: NetlistComponent[], loc: LayoutLocations = {}): BoardLayout {
  const board = pcb.board;
  const outline = outlinePolygon(board);
  const box = bbox(outline);
  const diagnostics: Diagnostic[] = [];
  const atOf = (id: string, c?: NetlistComponent) => loc.place?.[id] ?? pcb.placements[id]?.at ?? c?.at ?? components.find(x => x.id === id)?.at;
  const members = new Map<string, number>();
  for (const c of components) for (const net of Object.values(c.pins)) members.set(net, (members.get(net) ?? 0) + 1);

  // ── resolve footprints and pin maps ──
  const resolved: Resolved[] = [];
  const offBoard: string[] = [];
  const sorted = [...components].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const c of sorted) {
    const pl = pcb.placements[c.id] ?? {};
    if (pl.offBoard) {
      offBoard.push(c.id);
      continue;
    }
    let fp: FootprintDef | undefined;
    let why = '';
    if (pl.footprint) {
      fp = pcb.footprints?.[pl.footprint] ?? getFootprint(pl.footprint);
      why = `footprint '${pl.footprint}' is neither a library footprint nor in pcb.footprints`;
    } else {
      const choice = defaultFootprint(c, board.tech);
      fp = choice.name ? getFootprint(choice.name) : undefined;
      why = choice.reason;
    }
    if (!fp) {
      diagnostics.push(
        diag('P803', 'no-footprint', `${c.id} (${c.type}) has no footprint: ${why}`, {
          components: [c.id],
          note: 'only parts with a physical package can go on a board; abstract parts (logic primitives, VHDL blocks, defineComponent parts) and packages without a library footprint need an explicit one',
          fixes: [
            { kind: 'give-footprint', confidence: 'suggested', detail: `tb.place('${c.id}', { x, y, footprint: '<name>', pads: { <pin>: '<pad>' } }) — circuitsvibe catalog footprints lists the library; a custom footprint is { name, pads: [{ name, x, y, w, h, drill? }] }` },
            { kind: 'off-board', confidence: 'mechanical', detail: `if ${c.id} is not on this board (a bench instrument, an external module): tb.place('${c.id}', { offBoard: true })`, patch: `tb.place('${c.id}', { offBoard: true });` },
          ],
          at: atOf(c.id, c),
        }),
      );
      continue;
    }
    const { map, errors } = pinMap(c, fp, pl.pads);
    for (const e of errors) {
      diagnostics.push(diag('P807', 'bad-pad-map', `${c.id}: ${e.message}`, { components: [c.id], fixes: [{ kind: 'fix-pad-map', confidence: 'suggested', detail: `map each pin of ${c.id} to pads of ${fp.name}: ${fp.pads.map(p => p.name).filter((v, i, a) => a.indexOf(v) === i).join(', ')}` }], at: atOf(c.id, c) }));
    }
    const padNet = new Map<string, string>();
    const padPin = new Map<string, string>();
    for (const pin of Object.keys(map).sort()) {
      const net = c.pins[pin];
      for (const pad of map[pin]) {
        const prev = padNet.get(pad);
        if (prev !== undefined && prev !== net) {
          diagnostics.push(
            diag('P807', 'bad-pad-map', `${c.id}: pad '${pad}' of ${fp.name} would join nets '${prev}' and '${net}' (pins ${padPin.get(pad)} and ${pin})`, {
              components: [c.id],
              note: 'one copper pad is one electrical node: two pins on different nets cannot share it',
              fixes: [{ kind: 'fix-pad-map', confidence: 'suggested', detail: `give ${c.id}.${pin} its own pad with tb.place('${c.id}', { pads: { ${JSON.stringify(pin).replace(/"/g, "'")}: '<pad>' } })` }],
              at: atOf(c.id, c),
            }),
          );
          continue;
        }
        if (prev === undefined) {
          padNet.set(pad, net);
          padPin.set(pad, pin);
        }
      }
    }
    const missing = Object.keys(c.pins).filter(p => !map[p] && (members.get(c.pins[p]) ?? 0) > 1);
    if (missing.length > 0) {
      diagnostics.push(
        diag('P804', 'pin-without-pad', `${c.id}: pin${missing.length > 1 ? 's' : ''} ${missing.join(', ')} ${missing.length > 1 ? 'are' : 'is'} connected but ${missing.length > 1 ? 'have' : 'has'} no pad on footprint ${fp.name}`, {
          components: [c.id],
          note: 'a connected pin must land on copper, or its net is cut on the board',
          evidence: { footprint: fp.name, pins: missing, pads: [...new Set(fp.pads.map(p => p.name))] },
          fixes: [{ kind: 'map-pads', confidence: 'suggested', detail: `tb.place('${c.id}', { pads: { ${missing.map(p => `'${p}': '<pad>'`).join(', ')} } }) — or choose a footprint whose pinout covers every pin` }],
          at: atOf(c.id, c),
        }),
      );
    }
    resolved.push({ c, fp, map, pl, padNet, padPin });
  }

  // ── place ──
  const parts: PlacedPart[] = [];
  const pending: Resolved[] = [];
  for (const r of resolved) {
    if (r.pl.x === undefined || r.pl.y === undefined) pending.push(r);
    else parts.push(placePart(r, { x: r.pl.x, y: r.pl.y, rot: r.pl.rot ?? 0, side: r.pl.side ?? 'top' }));
  }
  const holes: BoardLayout['holes'] = [...board.holes.map(h => ({ ...h })), ...parts.flatMap(p => p.holes.map(h => ({ ...h, owner: p.id })))];
  const clearance = board.rules.clearance;
  const edge = board.rules.edgeClearance;

  // ── P801: outline and edge clearance ──
  board.holes.forEach((h, i) => {
    const ring: Poly = placeRect(0, 0, h.d, h.d, { x: h.x, y: h.y, rot: 0, side: 'top' });
    if (!insideOutline(ring, outline)) {
      diagnostics.push(diag('P801', 'outside-board', `mounting hole ${i + 1} at (${fmt(h.x)}, ${fmt(h.y)}) mm is not inside the board outline`, { evidence: { hole: i + 1, x: h.x, y: h.y, d: h.d }, fixes: [{ kind: 'move-hole', confidence: 'suggested', detail: 'move the hole inside the outline (tb.board({ holes }))' }] }));
    }
  });
  for (const p of parts) {
    const out = p.courtyards.some(k => !insideOutline(k, outline));
    let nearest = Infinity;
    for (const pad of p.pads) nearest = Math.min(nearest, insideOutline(pad.poly, outline) ? distToOutline(pad.poly, outline) : 0);
    if (out || nearest < edge - 1e-6) {
      const what = out ? `${p.id} (${p.footprint.name}) at (${fmt(p.x)}, ${fmt(p.y)}) mm sticks out of the board outline` : `${p.id}'s copper is ${fmt(nearest)} mm from the board edge (rule: ≥ ${fmt(edge)} mm)`;
      diagnostics.push(
        diag('P801', 'outside-board', what, {
          components: [p.id],
          note: 'the fab routes the outline with a tolerance: copper closer to the edge than the edge clearance gets cut or exposed, and a courtyard over the edge means the part does not fit',
          evidence: { x: p.x, y: p.y, rot: p.rot, edgeDistance: Number.isFinite(nearest) ? round(nearest) : 0, edgeClearance: edge },
          fixes: [{ kind: 'move-part', confidence: 'suggested', detail: `move ${p.id} inward (tb.place('${p.id}', { x, y })), rotate it, or enlarge the board` }],
          at: atOf(p.id),
        }),
      );
    }
  }

  // ── P802: collisions (parts, holes) ──
  for (let i = 0; i < parts.length; i++) {
    for (let j = i + 1; j < parts.length; j++) {
      const depth = collision(parts[i], parts[j]);
      if (depth > 1e-3) {
        const [a, b] = [parts[i], parts[j]];
        diagnostics.push(
          diag('P802', 'courtyard-overlap', `${a.id} and ${b.id} overlap by ${fmt(depth)} mm`, {
            components: [a.id, b.id],
            note: a.side === b.side ? 'courtyards are the keep-out of a part (pads, body and assembly margin): two overlapping courtyards cannot both be built' : 'a through-hole part pierces the board: its pads are on both sides, under the other part',
            evidence: { depth: round(depth), sides: [a.side, b.side] },
            fixes: [{ kind: 'move-part', confidence: 'suggested', detail: `move ${b.id} (or ${a.id}) at least ${fmt(depth + 0.1)} mm apart, or rotate one of them` }],
            at: atOf(b.id),
          }),
        );
      }
    }
  }
  for (const [hi, h] of holes.entries()) {
    const r = h.d / 2 + clearance;
    for (const p of parts) {
      if (p.id === h.owner) continue;
      const d = Math.min(...p.courtyards.map(k => distPointPoly([h.x, h.y], k)));
      if (d < r - 1e-6) {
        const label = h.owner ? `${h.owner}'s mounting hole at (${fmt(h.x)}, ${fmt(h.y)})` : `mounting hole ${hi + 1} at (${fmt(h.x)}, ${fmt(h.y)})`;
        diagnostics.push(
          diag('P802', 'courtyard-overlap', `${p.id} is on ${label} mm`, {
            components: [p.id],
            note: `a mounting hole keeps ${fmt(r)} mm (radius + clearance) free of parts: a screw head and its washer sit there`,
            evidence: { hole: { x: h.x, y: h.y, d: h.d }, distance: round(d), required: round(r) },
            fixes: [{ kind: 'move-part', confidence: 'suggested', detail: `move ${p.id} at least ${fmt(r - d + 0.1)} mm away from the hole` }],
            at: atOf(p.id),
          }),
        );
      }
    }
  }

  // ── unplaced: a free spot near the parts it connects to ──
  const unplaced: BoardLayout['unplaced'] = [];
  const taken: PlacedPart[] = [...parts];
  const center: Pt = [(box.minX + box.maxX) / 2, (box.minY + box.maxY) / 2];
  for (const r of pending) {
    const nets = new Set(r.padNet.values());
    const anchors = taken.flatMap(p => p.pads.filter(pad => pad.net !== undefined && pad.net !== 'gnd' && nets.has(pad.net)));
    const target: Pt = anchors.length > 0 ? [anchors.reduce((s, a) => s + a.x, 0) / anchors.length, anchors.reduce((s, a) => s + a.y, 0) / anchors.length] : center;
    const suggested = findSpot(r, target, outline, box, taken, holes, edge, clearance);
    unplaced.push({ id: r.c.id, footprint: r.fp, ...(suggested ? { suggested } : {}) });
    if (suggested) taken.push(placePart(r, { ...suggested, side: r.pl.side ?? 'top' }));
    const fields = [`x: ${fmt(suggested?.x ?? 0)}`, `y: ${fmt(suggested?.y ?? 0)}`, ...(suggested?.rot ? [`rot: ${suggested.rot}`] : []), ...(r.pl.side ? [`side: '${r.pl.side}'`] : []), ...(r.pl.footprint && getFootprint(r.pl.footprint) ? [`footprint: '${r.pl.footprint}'`] : [])];
    diagnostics.push(
      diag('P805', 'not-placed', `${r.c.id} (${r.fp.name}) is not placed on the board`, {
        components: [r.c.id],
        note: 'every on-board part needs a position: tb.place(id, { x, y, rot?, side? }) in mm from the board origin (lower-left), degrees counter-clockwise',
        ...(suggested ? { evidence: { suggested } } : {}),
        fixes: suggested
          ? [{ kind: 'place-part', confidence: 'mechanical', detail: `free spot near the parts ${r.c.id} connects to: tb.place('${r.c.id}', { ${fields.join(', ')} })`, patch: `tb.place('${r.c.id}', { ${fields.join(', ')} });` }]
          : [{ kind: 'enlarge-board', confidence: 'suggested', detail: `no free spot fits ${r.fp.name} on the board: enlarge it (tb.board({ width, height })) or move parts closer together` }],
        at: atOf(r.c.id, r.c),
      }),
    );
  }

  // ── P806: off-board parts reached without a connector ──
  const onBoardNets = new Map<string, boolean>(); // net → has a connector pad
  for (const r of resolved) {
    const isConnector = CONNECTOR_RE.test(r.fp.name) || r.c.type === 'VoltageSource' || r.c.type === 'CurrentSource';
    for (const net of r.padNet.values()) onBoardNets.set(net, (onBoardNets.get(net) ?? false) || isConnector);
  }
  for (const id of offBoard) {
    const c = sorted.find(x => x.id === id)!;
    const nets = [...new Set(Object.values(c.pins))].filter(n => onBoardNets.has(n) && !onBoardNets.get(n)).sort();
    if (nets.length > 0) {
      diagnostics.push(
        diag('P806', 'off-board-without-connector', `${id} is off the board, but net${nets.length > 1 ? 's' : ''} ${nets.join(', ')} connect${nets.length > 1 ? '' : 's'} it to on-board parts with no connector`, {
          severity: 'warning',
          components: [id],
          note: 'an off-board supply or instrument reaches the board through a connector; without one, these nets have no way in',
          evidence: { nets },
          fixes: [{ kind: 'place-connector', confidence: 'suggested', detail: `place ${id} on the board (a source's footprint is a 2-pin header): tb.place('${id}', { x, y }), or add a header on ${nets.join(', ')}` }],
          at: atOf(id, c),
        }),
      );
    }
  }

  // ── ratsnest: MST per net over pad groups (same-name pads are one group) ──
  const ratsnest = buildRatsnest(parts);
  const padCount = parts.reduce((s, p) => s + p.pads.length, 0);
  const netCount = new Set(ratsnest.map(a => a.net)).size;
  const width = round(box.maxX - box.minX);
  const height = round(box.maxY - box.minY);
  const record: PcbRecord = {
    board: { width, height, layers: board.layers, thickness: board.thickness, tech: board.tech, area: round(polyArea(outline)) },
    placed: parts.map(p => ({ id: p.id, footprint: p.footprint.name, tech: p.tech, x: p.x, y: p.y, rot: p.rot, side: p.side })),
    offBoard,
    unplaced: unplaced.map(u => ({ id: u.id, footprint: u.footprint.name, ...(u.suggested ? { suggested: u.suggested } : {}) })),
    ratsnest,
    stats: {
      placed: parts.length,
      offBoard: offBoard.length,
      unplaced: unplaced.length,
      pads: padCount,
      nets: netCount,
      airwires: ratsnest.length,
      airwireLength: round(Math.round(ratsnest.reduce((s, a) => s + a.length, 0) * 100) / 100),
    },
  };
  return { board, outline, parts, offBoard, unplaced, holes, ratsnest, diagnostics, record };
}

function findSpot(r: Resolved, target: Pt, outline: Poly, box: { minX: number; minY: number; maxX: number; maxY: number }, taken: PlacedPart[], holes: BoardLayout['holes'], edge: number, clearance: number): { x: number; y: number; rot: number } | undefined {
  const STEP = 1.27;
  const candidates: { x: number; y: number; rot: number; d: number }[] = [];
  for (let x = Math.ceil(box.minX / STEP) * STEP; x <= box.maxX; x += STEP) {
    for (let y = Math.ceil(box.minY / STEP) * STEP; y <= box.maxY; y += STEP) {
      const d = Math.hypot(x - target[0], y - target[1]);
      for (const rot of [0, 90]) candidates.push({ x: round(x), y: round(y), rot, d: d + (rot ? 0.01 : 0) });
    }
  }
  candidates.sort((a, b) => a.d - b.d || a.y - b.y || a.x - b.x || a.rot - b.rot);
  const side = r.pl.side ?? 'top';
  for (const cand of candidates) {
    const p = placePart(r, { x: cand.x, y: cand.y, rot: cand.rot, side });
    if (!p.courtyards.every(k => insideOutline(k, outline))) continue;
    if (p.pads.some(pad => distToOutline(pad.poly, outline) < edge)) continue;
    if (taken.some(t => collision(t, p) > 1e-3)) continue;
    if (holes.some(h => Math.min(...p.courtyards.map(k => distPointPoly([h.x, h.y], k))) < h.d / 2 + clearance)) continue;
    return { x: cand.x, y: cand.y, rot: cand.rot };
  }
  return undefined;
}

/** Minimum spanning tree (Prim) per net; nodes are pad groups (one component's pads of one name). */
export function buildRatsnest(parts: PlacedPart[]): PcbAirwire[] {
  const groups = new Map<string, Map<string, PlacedPad[]>>(); // net → group key → pads
  for (const p of parts) {
    for (const pad of p.pads) {
      if (pad.net === undefined) continue;
      const byKey = groups.get(pad.net) ?? new Map<string, PlacedPad[]>();
      const key = `${p.id}\u0000${pad.name}`;
      byKey.set(key, [...(byKey.get(key) ?? []), pad]);
      groups.set(pad.net, byKey);
    }
  }
  const wires: PcbAirwire[] = [];
  for (const net of [...groups.keys()].sort()) {
    const nodes = [...groups.get(net)!.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, pads]) => pads);
    if (nodes.length < 2) continue;
    const inTree = new Array(nodes.length).fill(false);
    const best = new Array(nodes.length).fill(Infinity);
    const via: ([PlacedPad, PlacedPad] | undefined)[] = new Array(nodes.length).fill(undefined);
    const closest = (a: PlacedPad[], b: PlacedPad[]): [number, PlacedPad, PlacedPad] => {
      let r: [number, PlacedPad, PlacedPad] = [Infinity, a[0], b[0]];
      for (const x of a) for (const y of b) {
        const d = Math.hypot(x.x - y.x, x.y - y.y);
        if (d < r[0] - 1e-9) r = [d, x, y];
      }
      return r;
    };
    inTree[0] = true;
    for (let k = 1; k < nodes.length; k++) {
      const [d, x, y] = closest(nodes[0], nodes[k]);
      best[k] = d;
      via[k] = [x, y];
    }
    for (let added = 1; added < nodes.length; added++) {
      let next = -1;
      for (let k = 0; k < nodes.length; k++) if (!inTree[k] && (next < 0 || best[k] < best[next] - 1e-9)) next = k;
      inTree[next] = true;
      const [from, to] = via[next]!;
      wires.push({ net, from: from.ref, to: to.ref, length: round(Math.round(best[next] * 100) / 100) });
      for (let k = 0; k < nodes.length; k++) {
        if (inTree[k]) continue;
        const [d, x, y] = closest(nodes[next], nodes[k]);
        if (d < best[k] - 1e-9) {
          best[k] = d;
          via[k] = [x, y];
        }
      }
    }
  }
  return wires;
}
