/**
 * Autorouter — turns the ratsnest of a laid-out board into copper.
 *
 * A grid router (default pitch 0.25 mm) on one or two copper layers: A* with
 * 45° moves, a bend penalty and a via cost, one net at a time. A net grows as
 * a tree: from the copper it already has (pads, then its own new tracks) the
 * search reaches the nearest pad group still unconnected, until every group
 * is joined. Clearance is exact, not rasterized: a grid move is allowed only
 * when the trace segment (width + clearance) keeps clear of every piece of
 * foreign copper, every hole and the board edge, measured on the real shapes.
 *
 * Nets are routed shortest-first; when some fail, the failed nets go first
 * in the next pass (rip-up and retry, at most PASSES passes) and the best
 * pass wins. Pure and deterministic: same layout, same copper.
 */
import type { BoardLayout, PlacedPad } from './layout';
import type { PcbAirwire, PcbNetRoute, PcbRouting, PcbTrack, PcbVia } from './types';
import { CopperIndex, distSegShape, item, onLayer, padShape, type CopperItem } from './copper';
import { round } from './geometry';

const PASSES = 4;
/** Widest trace the router attempts (mm). */
const MAX_WIDTH = 20;
/** Cost of a via, in mm of track. */
const VIA_COST_MM = 2.5;
/** Extra cost of a 45° / 90° / sharper turn, in grid steps. */
const TURN_COST = [0, 0.4, 1.5, 6, 12];
/** Moves against the layer's preferred direction (top: horizontal, bottom: vertical) cost this much more on 2-layer boards. */
const OFF_AXIS = 1.15;
/** A* expansions allowed per connection, per grid cell of the board. */
const EXPAND_PER_CELL = 6;

const DX = [1, 1, 0, -1, -1, -1, 0, 1];
const DY = [0, 1, 1, 1, 0, -1, -1, -1];

export interface NetPlan {
  net: string;
  width: number;
  widthFrom: PcbNetRoute['widthFrom'];
  current?: number;
  requiredWidth?: number;
}

/** Binary min-heap of states keyed by f, ties by insertion order (deterministic). */
class Heap {
  private f: number[] = [];
  private s: number[] = [];
  private o: number[] = [];
  private n = 0;
  private seq = 0;
  get size(): number {
    return this.n;
  }
  clear(): void {
    this.n = 0;
    this.seq = 0;
  }
  private less(a: number, b: number): boolean {
    return this.f[a] < this.f[b] || (this.f[a] === this.f[b] && this.o[a] < this.o[b]);
  }
  private swap(a: number, b: number): void {
    [this.f[a], this.f[b]] = [this.f[b], this.f[a]];
    [this.s[a], this.s[b]] = [this.s[b], this.s[a]];
    [this.o[a], this.o[b]] = [this.o[b], this.o[a]];
  }
  push(f: number, s: number): void {
    let i = this.n++;
    this.f[i] = f;
    this.s[i] = s;
    this.o[i] = this.seq++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.less(i, p)) break;
      this.swap(i, p);
      i = p;
    }
  }
  pop(): number {
    const top = this.s[0];
    this.n--;
    if (this.n > 0) {
      this.f[0] = this.f[this.n];
      this.s[0] = this.s[this.n];
      this.o[0] = this.o[this.n];
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < this.n && this.less(l, m)) m = l;
        if (r < this.n && this.less(r, m)) m = r;
        if (m === i) break;
        this.swap(i, m);
        i = m;
      }
    }
    return top;
  }
}

interface Group {
  /** Pads of one component sharing a name (joined inside the part). */
  pads: PlacedPad[];
  /** Grid states (layer·N + cell) inside the group's copper. */
  states: number[];
}

interface NetJob {
  plan: NetPlan;
  groups: Group[];
  /** Estimated length (sum of its ratsnest airwires), for the routing order. */
  estimate: number;
}

interface NetResult {
  tracks: PcbTrack[];
  vias: PcbVia[];
  items: CopperItem[];
  /** Index of the groups left unconnected. */
  missing: number[];
  /** Groups connected to the tree. */
  connected: number[];
}

export interface RouteOutput {
  routing: PcbRouting;
  /** All copper on the board (pads, tracks, vias) and the holes, for the design-rule check. */
  copper: CopperItem[];
}

export function routeBoard(layout: BoardLayout, plans: NetPlan[], currents: PcbRouting['currents']): RouteOutput {
  const { board, outline } = layout;
  const rules = board.rules;
  const g = rules.grid ?? 0.25;
  const layers = board.layers;
  const viaR = rules.via.diameter / 2;
  const clearance = rules.clearance;
  const edge = rules.edgeClearance;

  // ── grid ──
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of outline) {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  const x0 = Math.ceil(minX / g) * g;
  const y0 = Math.ceil(minY / g) * g;
  const nx = Math.floor((maxX - x0) / g) + 1;
  const ny = Math.floor((maxY - y0) / g) + 1;
  const N = nx * ny;
  const cx = (c: number): number => x0 + (c % nx) * g;
  const cy = (c: number): number => y0 + Math.floor(c / nx) * g;
  const cellAt = (x: number, y: number): number => {
    const i = Math.round((x - x0) / g);
    const j = Math.round((y - y0) / g);
    return i < 0 || j < 0 || i >= nx || j >= ny ? -1 : j * nx + i;
  };

  // Distance from each cell centre to the board edge (−1 outside the outline).
  const edgeDist = new Float32Array(N);
  const ox = outline.map(p => p[0]);
  const oy = outline.map(p => p[1]);
  for (let c = 0; c < N; c++) {
    const px = cx(c), py = cy(c);
    let inside = false;
    let d = Infinity;
    for (let i = 0, j = ox.length - 1; i < ox.length; j = i++) {
      if (oy[i] > py !== oy[j] > py && px < ((ox[j] - ox[i]) * (py - oy[i])) / (oy[j] - oy[i]) + ox[i]) inside = !inside;
      const ddx = ox[i] - ox[j], ddy = oy[i] - oy[j];
      const len2 = ddx * ddx + ddy * ddy;
      let t = len2 > 0 ? ((px - ox[j]) * ddx + (py - oy[j]) * ddy) / len2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      d = Math.min(d, Math.hypot(px - (ox[j] + t * ddx), py - (oy[j] + t * ddy)));
    }
    edgeDist[c] = inside ? d : -1;
  }

  // ── fixed copper: pads and holes ──
  // A trace wider than this cannot be routed on any board the stage handles: it fails (P810) without a search.
  const routable = (p: NetPlan): boolean => p.width <= MAX_WIDTH;
  const maxHalf = Math.max(rules.trace / 2, ...plans.filter(routable).map(p => p.width / 2), viaR);
  const reach = maxHalf + clearance + g * 1.5;
  const padItems: CopperItem[] = [];
  for (const part of layout.parts) {
    for (const pad of part.pads) {
      padItems.push(item(pad.net ?? `~${pad.ref}`, pad.layer === 'through' ? 'both' : pad.layer, 'pad', pad.ref, padShape(pad)));
    }
  }
  const holeItems = layout.holes.map(h => item('~hole', 'both', 'hole', 'hole', { kind: 'circle', x: h.x, y: h.y, r: h.d / 2 }));

  // ── the jobs ──
  const padsOf = new Map<string, Map<string, PlacedPad[]>>();
  for (const part of layout.parts) {
    for (const pad of part.pads) {
      if (pad.net === undefined) continue;
      const m = padsOf.get(pad.net) ?? new Map<string, PlacedPad[]>();
      const key = `${part.id}\u0000${pad.name}`;
      m.set(key, [...(m.get(key) ?? []), pad]);
      padsOf.set(pad.net, m);
    }
  }
  const estimate = new Map<string, number>();
  for (const a of layout.ratsnest) estimate.set(a.net, (estimate.get(a.net) ?? 0) + a.length);
  const jobs: NetJob[] = [];
  for (const plan of plans) {
    const m = padsOf.get(plan.net);
    if (!m || m.size < 2) continue;
    const groups = [...m.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, pads]) => ({ pads, states: [] as number[] }));
    jobs.push({ plan, groups, estimate: estimate.get(plan.net) ?? 0 });
  }
  jobs.sort((a, b) => a.estimate - b.estimate || (a.plan.net < b.plan.net ? -1 : 1));

  // ── per-net search state ──
  const S = N * layers;
  const clear = [new Float32Array(N), new Float32Array(N)]; // distance to foreign copper per layer (−1: not computed)
  const gScore = new Float64Array(S);
  const came = new Int32Array(S);
  const dirOf = new Int8Array(S);
  const stamp = new Int32Array(S);
  const closed = new Int32Array(S);
  const target = new Int32Array(S); // group index + 1
  const targetStamp = new Int32Array(S);
  let search = 0;
  const heap = new Heap();
  const viaCost = VIA_COST_MM / g;
  const maxExpand = Math.max(200_000, EXPAND_PER_CELL * S);

  const routePass = (order: NetJob[]): { results: Map<string, NetResult>; failed: string[] } => {
    const index = new CopperIndex(2.5, reach);
    for (const it of padItems) index.add(it);
    for (const it of holeItems) index.add(it);
    const results = new Map<string, NetResult>();
    const failed: string[] = [];

    for (const job of order) {
      const net = job.plan.net;
      if (!routable(job.plan)) {
        results.set(net, { tracks: [], vias: [], items: [], missing: job.groups.map((_, k) => k).slice(1), connected: [0] });
        failed.push(net);
        continue;
      }
      const hw = job.plan.width / 2;
      const need = hw + clearance;
      clear[0].fill(-1);
      clear[1].fill(-1);
      const layerName = (l: number): 'top' | 'bottom' => (l === 0 ? 'top' : 'bottom');

      /** Distance from the cell centre to the nearest foreign copper / hole on a layer. */
      const clearAt = (l: number, c: number): number => {
        const cached = clear[l][c];
        if (cached >= 0) return cached;
        const px = cx(c), py = cy(c);
        let d = 1e9;
        for (const it of index.near(px, py)) {
          if (it.net === net || !onLayer(it, layerName(l))) continue;
          const v = distSegShape(px, py, px, py, it.shape);
          if (v < d) d = v;
        }
        clear[l][c] = d;
        return d;
      };
      const cellOk = (l: number, c: number, half: number): boolean => edgeDist[c] >= half + edge + g * 0.75 && clearAt(l, c) >= half + clearance;
      const moveOk = (l: number, a: number, b: number): boolean => {
        if (!cellOk(l, b, hw)) return false;
        // Endpoints far enough from everything: the segment between them is too.
        if (Math.min(clearAt(l, a), clearAt(l, b)) >= need + g * 0.75) return true;
        const ax = cx(a), ay = cy(a), bx = cx(b), by = cy(b);
        const seen = new Set<CopperItem>();
        for (const list of [index.near(ax, ay), index.near(bx, by)]) {
          for (const it of list) {
            if (seen.has(it) || it.net === net || !onLayer(it, layerName(l))) continue;
            seen.add(it);
            if (distSegShape(ax, ay, bx, by, it.shape) < need) return false;
          }
        }
        return true;
      };
      const viaOk = (c: number): boolean => edgeDist[c] >= viaR + edge + g * 0.75 && clearAt(0, c) >= viaR + clearance && clearAt(1, c) >= viaR + clearance;

      // Group states: cells whose centre is on the group's copper, on the pads' layers, usable at this width.
      for (const grp of job.groups) {
        const states: number[] = [];
        for (const pad of grp.pads) {
          const shape = padShape(pad);
          const r = Math.max(pad.w, pad.h);
          const padLayers = pad.layer === 'through' ? [0, 1].slice(0, layers) : pad.layer === 'top' ? [0] : layers === 2 ? [1] : [];
          for (let j = Math.ceil((pad.y - r - y0) / g); j <= Math.floor((pad.y + r - y0) / g); j++) {
            for (let i = Math.ceil((pad.x - r - x0) / g); i <= Math.floor((pad.x + r - x0) / g); i++) {
              if (i < 0 || j < 0 || i >= nx || j >= ny) continue;
              const c = j * nx + i;
              if (distSegShape(cx(c), cy(c), cx(c), cy(c), shape) > 1e-9) continue;
              for (const l of padLayers) if (cellOk(l, c, hw)) states.push(l * N + c);
            }
          }
          // A pad smaller than the grid: its nearest cell.
          if (states.length === 0) {
            const c = cellAt(pad.x, pad.y);
            if (c >= 0) for (const l of padLayers) if (cellOk(l, c, hw)) states.push(l * N + c);
          }
        }
        grp.states = [...new Set(states)].sort((a, b) => a - b);
      }

      const tracks: PcbTrack[] = [];
      const vias: PcbVia[] = [];
      const netItems: CopperItem[] = [];
      const addCopper = (it: CopperItem): void => {
        index.add(it);
        netItems.push(it);
      };
      /** A stub from a pad centre to the first grid cell, when it keeps its clearance. */
      const stubOk = (l: number, x: number, y: number, c: number): boolean => {
        const bx = cx(c), by = cy(c);
        for (const it of index.near(bx, by)) {
          if (it.net === net || !onLayer(it, layerName(l))) continue;
          if (distSegShape(x, y, bx, by, it.shape) < need) return false;
        }
        return true;
      };
      const tree = new Set<number>(job.groups[0].states);
      const connected = [0];
      const left = new Set(job.groups.map((_, k) => k).slice(1));

      while (left.size > 0) {
        search++;
        heap.clear();
        // Targets: the states of every group still unconnected.
        const goals: { x: number; y: number; r: number }[] = [];
        for (const k of left) {
          for (const s of job.groups[k].states) {
            target[s] = k + 1;
            targetStamp[s] = search;
          }
          for (const pad of job.groups[k].pads) goals.push({ x: pad.x, y: pad.y, r: Math.max(pad.w, pad.h) / 2 });
        }
        const h = (c: number): number => {
          const px = cx(c), py = cy(c);
          let best = Infinity;
          for (const q of goals) {
            const ddx = Math.abs(px - q.x), ddy = Math.abs(py - q.y);
            const oct = (Math.max(ddx, ddy) + (Math.SQRT2 - 1) * Math.min(ddx, ddy) - q.r) / g;
            if (oct < best) best = oct;
          }
          return Math.max(0, best);
        };
        for (const s of [...tree].sort((a, b) => a - b)) {
          stamp[s] = search;
          gScore[s] = 0;
          came[s] = -1;
          dirOf[s] = -1;
          heap.push(h(s % N), s);
        }
        let reached = -1;
        let expanded = 0;
        while (heap.size > 0) {
          const s = heap.pop();
          if (closed[s] === search) continue;
          closed[s] = search;
          if (targetStamp[s] === search && target[s] > 0 && !tree.has(s)) {
            reached = s;
            break;
          }
          if (++expanded > maxExpand) break;
          const l = s >= N ? 1 : 0;
          const c = s - l * N;
          const ci = c % nx, cj = (c - ci) / nx;
          const gs = gScore[s];
          const pd = dirOf[s];
          for (let d = 0; d < 8; d++) {
            const ni = ci + DX[d], nj = cj + DY[d];
            if (ni < 0 || nj < 0 || ni >= nx || nj >= ny) continue;
            const nc = nj * nx + ni;
            const ns = l * N + nc;
            if (closed[ns] === search) continue;
            let step = d % 2 === 1 ? Math.SQRT2 : 1;
            if (layers === 2 && d % 2 === 0 && (l === 0 ? d % 4 === 2 : d % 4 === 0)) step *= OFF_AXIS;
            const turn = pd < 0 ? 0 : TURN_COST[Math.min(Math.abs(d - pd), 8 - Math.abs(d - pd))];
            const ng = gs + step + turn;
            if (stamp[ns] === search && ng >= gScore[ns]) continue;
            if (!moveOk(l, c, nc)) continue;
            stamp[ns] = search;
            gScore[ns] = ng;
            came[ns] = s;
            dirOf[ns] = d;
            heap.push(ng + h(nc), ns);
          }
          if (layers === 2) {
            const ns = (1 - l) * N + c;
            if (closed[ns] !== search && viaOk(c) && cellOk(1 - l, c, hw)) {
              const ng = gs + viaCost;
              if (!(stamp[ns] === search && ng >= gScore[ns])) {
                stamp[ns] = search;
                gScore[ns] = ng;
                came[ns] = s;
                dirOf[ns] = pd;
                heap.push(ng + h(c), ns);
              }
            }
          }
        }
        if (reached < 0) break;

        // ── the path → tracks, vias, new copper ──
        const path: number[] = [];
        for (let s = reached; s >= 0; s = came[s]) path.push(s);
        path.reverse();
        const k = target[reached] - 1;
        const startPad = padUnder(job.groups, path[0] % N, cx, cy, g);
        const endPad = padUnder([job.groups[k]], reached % N, cx, cy, g);
        let run: [number, number][] = [];
        let runLayer = path[0] >= N ? 1 : 0;
        if (startPad && !samePoint(startPad, cx(path[0] % N), cy(path[0] % N)) && stubOk(runLayer, startPad.x, startPad.y, path[0] % N)) run.push([startPad.x, startPad.y]);
        const flush = (): void => {
          const pts = simplify(run);
          if (pts.length >= 2) {
            const track: PcbTrack = { layer: runLayer === 0 ? 'top' : 'bottom', width: job.plan.width, points: pts.map(([x, y]) => [round(x), round(y)]) };
            tracks.push(track);
            for (let i = 1; i < track.points.length; i++) {
              const [ax, ay] = track.points[i - 1];
              const [bx, by] = track.points[i];
              addCopper(item(net, track.layer, 'track', 'track', { kind: 'capsule', ax, ay, bx, by, r: hw }));
            }
          }
          run = [];
        };
        for (const s of path) {
          const l = s >= N ? 1 : 0;
          const c = s - l * N;
          if (l !== runLayer) {
            run.push([cx(c), cy(c)]);
            flush();
            const via: PcbVia = { x: round(cx(c)), y: round(cy(c)), drill: rules.via.drill, diameter: rules.via.diameter };
            vias.push(via);
            addCopper(item(net, 'both', 'via', 'via', { kind: 'circle', x: via.x, y: via.y, r: viaR }));
            runLayer = l;
          }
          run.push([cx(c), cy(c)]);
        }
        if (endPad && !samePoint(endPad, cx(reached % N), cy(reached % N)) && stubOk(runLayer, endPad.x, endPad.y, reached % N)) run.push([endPad.x, endPad.y]);
        flush();
        for (const s of path) tree.add(s);
        for (const s of job.groups[k].states) tree.add(s);
        left.delete(k);
        connected.push(k);
      }
      results.set(net, { tracks, vias, items: netItems, missing: [...left].sort((a, b) => a - b), connected });
      if (left.size > 0) failed.push(net);
    }
    return { results, failed };
  };

  // ── passes: failed nets first in the next one; the best pass wins ──
  let order = jobs;
  let best: { results: Map<string, NetResult>; failed: string[]; missing: number; length: number; pass: number } | undefined;
  const seen = new Set<string>();
  for (let pass = 1; pass <= PASSES; pass++) {
    const key = order.map(j => j.plan.net).join('\u0000');
    if (seen.has(key)) break;
    seen.add(key);
    const { results, failed } = routePass(order);
    let missing = 0;
    let length = 0;
    for (const r of results.values()) {
      missing += r.missing.length;
      for (const t of r.tracks) length += polyLength(t.points);
    }
    if (!best || missing < best.missing || (missing === best.missing && length < best.length - 1e-9)) best = { results, failed, missing, length, pass };
    if (failed.length === 0) break;
    order = [...order.filter(j => failed.includes(j.plan.net)), ...order.filter(j => !failed.includes(j.plan.net))];
  }

  // ── record ──
  const nets: PcbNetRoute[] = [];
  const unrouted: PcbAirwire[] = [];
  const copper: CopperItem[] = [...padItems, ...holeItems];
  let connections = 0;
  let totalLength = 0;
  let viaCount = 0;
  const jobOf = new Map(jobs.map(j => [j.plan.net, j]));
  for (const plan of [...plans].sort((a, b) => (a.net < b.net ? -1 : a.net > b.net ? 1 : 0))) {
    const job = jobOf.get(plan.net);
    if (!job) continue;
    const r = best?.results.get(plan.net);
    connections += job.groups.length - 1;
    const tracks = r?.tracks ?? [];
    const vias = r?.vias ?? [];
    const length = tracks.reduce((s, t) => s + polyLength(t.points), 0);
    totalLength += length;
    viaCount += vias.length;
    if (r) copper.push(...r.items);
    const missing = r ? r.missing : job.groups.map((_, k) => k).slice(1);
    // Airwires left: each missing group to the nearest connected pad of the net.
    const connectedPads = (r ? r.connected : [0]).flatMap(k => job.groups[k].pads);
    for (const k of missing) {
      let bestPair: [number, PlacedPad, PlacedPad] = [Infinity, job.groups[k].pads[0], connectedPads[0]];
      for (const a of job.groups[k].pads) for (const b of connectedPads) {
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (d < bestPair[0] - 1e-9) bestPair = [d, a, b];
      }
      const [d, a, b] = bestPair;
      const [from, to] = a.ref < b.ref ? [a.ref, b.ref] : [b.ref, a.ref];
      unrouted.push({ net: plan.net, from, to, length: round(Math.round(d * 100) / 100) });
    }
    nets.push({
      net: plan.net,
      width: plan.width,
      widthFrom: plan.widthFrom,
      ...(plan.current !== undefined ? { current: plan.current } : {}),
      ...(plan.requiredWidth !== undefined ? { requiredWidth: plan.requiredWidth } : {}),
      tracks,
      vias,
      length: round(Math.round(length * 100) / 100),
      complete: missing.length === 0,
    });
  }
  const routed = connections - unrouted.length;
  return {
    routing: {
      grid: g,
      currents,
      nets,
      unrouted,
      stats: {
        nets: nets.length,
        connections,
        routed,
        unrouted: unrouted.length,
        completion: connections > 0 ? round(Math.round((routed / connections) * 1000) / 1000) : 1,
        length: round(Math.round(totalLength * 100) / 100),
        vias: viaCount,
        passes: best?.pass ?? 0,
      },
    },
    copper,
  };
}

/** The pad whose copper holds the cell (or, for a pad smaller than the grid, the one it was snapped to). */
function padUnder(groups: Group[], c: number, cx: (c: number) => number, cy: (c: number) => number, g: number): PlacedPad | undefined {
  const x = cx(c), y = cy(c);
  let best: PlacedPad | undefined;
  let bestD = Infinity;
  for (const grp of groups) {
    for (const pad of grp.pads) {
      if (distSegShape(x, y, x, y, padShape(pad)) > 1e-9 && Math.hypot(pad.x - x, pad.y - y) > g * 0.75) continue;
      const d = Math.hypot(pad.x - x, pad.y - y);
      if (d < bestD) {
        bestD = d;
        best = pad;
      }
    }
  }
  return best;
}

const samePoint = (p: { x: number; y: number }, x: number, y: number): boolean => Math.abs(p.x - x) < 1e-6 && Math.abs(p.y - y) < 1e-6;

/** Drop the interior points of straight runs. */
function simplify(pts: [number, number][]): [number, number][] {
  const out: [number, number][] = [];
  for (const p of pts) {
    if (out.length > 0 && Math.abs(out[out.length - 1][0] - p[0]) < 1e-9 && Math.abs(out[out.length - 1][1] - p[1]) < 1e-9) continue;
    while (out.length >= 2) {
      const [a, b] = [out[out.length - 2], out[out.length - 1]];
      const crossZ = (b[0] - a[0]) * (p[1] - b[1]) - (b[1] - a[1]) * (p[0] - b[0]);
      const dot = (b[0] - a[0]) * (p[0] - b[0]) + (b[1] - a[1]) * (p[1] - b[1]);
      if (Math.abs(crossZ) < 1e-9 && dot > 0) out.pop();
      else break;
    }
    out.push(p);
  }
  return out;
}

export function polyLength(pts: [number, number][]): number {
  let s = 0;
  for (let i = 1; i < pts.length; i++) s += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return s;
}
