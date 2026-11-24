/**
 * Orthogonal wire router on a lattice (one cell = one grid pitch). A* over
 * (cell, heading) states with turn and crossing penalties:
 *
 *  - component bodies are BLOCKED cells;
 *  - a pin cell and its exit cell are RESERVED for the pin's net;
 *  - cells already carrying a wire of another net may be CROSSED only at a
 *    right angle, straight through (no turn, no stop inside);
 *  - cells of the same net are free and are also the goals (the route joins
 *    the net's existing tree there).
 *
 * Deterministic: the open set is an ordered binary heap with a stable
 * insertion counter, neighbours are expanded in a fixed order.
 */

export type Axis = 'h' | 'v' | 'x';

export interface Cell {
  i: number;
  j: number;
}

export const DIRS: readonly { di: number; dj: number; axis: Axis }[] = [
  { di: 1, dj: 0, axis: 'h' },
  { di: -1, dj: 0, axis: 'h' },
  { di: 0, dj: 1, axis: 'v' },
  { di: 0, dj: -1, axis: 'v' },
];

const COST_STEP = 1;
const COST_TURN = 4;
const COST_CROSS = 14;
const COST_NEAR_BODY = 1;

export class Grid {
  readonly w: number;
  readonly h: number;
  /** 0 free · 1 blocked · 2 near-body (soft) */
  private readonly solid: Uint8Array;
  /** Owner net id per cell (0 = none). */
  private readonly owner: Int32Array;
  /** Wire axis per cell: 0 none, 1 h, 2 v, 3 both/corner. */
  private readonly axis: Uint8Array;
  private readonly netIds = new Map<string, number>();
  private readonly netNames: string[] = [''];

  constructor(w: number, h: number) {
    this.w = w;
    this.h = h;
    this.solid = new Uint8Array(w * h);
    this.owner = new Int32Array(w * h);
    this.axis = new Uint8Array(w * h);
  }

  netId(net: string): number {
    let id = this.netIds.get(net);
    if (id === undefined) {
      id = this.netNames.length;
      this.netNames.push(net);
      this.netIds.set(net, id);
    }
    return id;
  }

  inside(i: number, j: number): boolean {
    return i >= 0 && j >= 0 && i < this.w && j < this.h;
  }

  private idx(i: number, j: number): number {
    return j * this.w + i;
  }

  block(i: number, j: number): void {
    if (this.inside(i, j)) this.solid[this.idx(i, j)] = 1;
  }

  /** Soft penalty around bodies so wires keep one cell of air when they can. */
  soften(i: number, j: number): void {
    if (this.inside(i, j) && this.solid[this.idx(i, j)] === 0) this.solid[this.idx(i, j)] = 2;
  }

  /** Remove the soft penalty (approach lanes of pins). */
  unsoften(i: number, j: number): void {
    if (this.inside(i, j) && this.solid[this.idx(i, j)] === 2) this.solid[this.idx(i, j)] = 0;
  }

  blockRect(i0: number, j0: number, i1: number, j1: number): void {
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) this.block(i, j);
  }

  isBlocked(i: number, j: number): boolean {
    return !this.inside(i, j) || this.solid[this.idx(i, j)] === 1;
  }

  /** Reserve a cell for a net (pin cells, exits, ports). */
  reserve(i: number, j: number, net: string): void {
    if (!this.inside(i, j)) return;
    const k = this.idx(i, j);
    this.solid[k] = 0;
    this.owner[k] = this.netId(net);
  }

  /** Record a wire through a cell. */
  occupy(i: number, j: number, net: string, axis: Axis): void {
    if (!this.inside(i, j)) return;
    const k = this.idx(i, j);
    this.owner[k] = this.netId(net);
    const a = axis === 'h' ? 1 : axis === 'v' ? 2 : 3;
    this.axis[k] = this.axis[k] === 0 || this.axis[k] === a ? a : 3;
  }

  ownerOf(i: number, j: number): string | undefined {
    if (!this.inside(i, j)) return undefined;
    const id = this.owner[this.idx(i, j)];
    return id === 0 ? undefined : this.netNames[id];
  }

  axisOf(i: number, j: number): Axis | undefined {
    if (!this.inside(i, j)) return undefined;
    const a = this.axis[this.idx(i, j)];
    return a === 0 ? undefined : a === 1 ? 'h' : a === 2 ? 'v' : 'x';
  }

  isSoft(i: number, j: number): boolean {
    return this.inside(i, j) && this.solid[this.idx(i, j)] === 2;
  }
}

export interface RouteStart {
  i: number;
  j: number;
  /** Index into DIRS of the mandatory first move (outward from the pin). */
  dir: number;
}

const key = (i: number, j: number): number => j * 65536 + i;

interface HeapNode {
  f: number;
  seq: number;
  state: number; // (key << 2) | dir
  g: number;
}

class Heap {
  private a: HeapNode[] = [];
  push(n: HeapNode): void {
    const a = this.a;
    a.push(n);
    let k = a.length - 1;
    while (k > 0) {
      const p = (k - 1) >> 1;
      if (less(a[k], a[p])) {
        [a[k], a[p]] = [a[p], a[k]];
        k = p;
      } else break;
    }
  }
  pop(): HeapNode | undefined {
    const a = this.a;
    if (a.length === 0) return undefined;
    const top = a[0];
    const last = a.pop()!;
    if (a.length > 0) {
      a[0] = last;
      let k = 0;
      for (;;) {
        const l = 2 * k + 1;
        const r = l + 1;
        let m = k;
        if (l < a.length && less(a[l], a[m])) m = l;
        if (r < a.length && less(a[r], a[m])) m = r;
        if (m === k) break;
        [a[k], a[m]] = [a[m], a[k]];
        k = m;
      }
    }
    return top;
  }
  get size(): number {
    return this.a.length;
  }
}

const less = (x: HeapNode, y: HeapNode): boolean => x.f < y.f || (x.f === y.f && x.seq < y.seq);

/**
 * Route from a pin to any goal cell of the same net. Returns the lattice
 * path (start included, goal included) or null when no route exists.
 */
export function route(grid: Grid, start: RouteStart, goals: Set<number>, net: string, maxExpansions = 60000): Cell[] | null {
  if (goals.size === 0) return null;
  const goalList = [...goals].map(k => ({ i: k % 65536, j: Math.floor(k / 65536) }));
  const heuristic = (i: number, j: number): number => {
    let best = Infinity;
    for (const g of goalList) {
      const d = Math.abs(g.i - i) + Math.abs(g.j - j);
      if (d < best) best = d;
    }
    return best * COST_STEP;
  };

  const first = DIRS[start.dir];
  const si = start.i + first.di;
  const sj = start.j + first.dj;
  if (!grid.inside(si, sj) || grid.isBlocked(si, sj)) return null;
  const own = grid.ownerOf(si, sj);
  if (own !== undefined && own !== net) return null;

  const gScore = new Map<number, number>();
  const parent = new Map<number, number>();
  const heap = new Heap();
  let seq = 0;
  const startKey = key(start.i, start.j);
  const s0 = (key(si, sj) << 2) | start.dir;
  gScore.set(s0, COST_STEP);
  parent.set(s0, (startKey << 2) | start.dir);
  heap.push({ f: COST_STEP + heuristic(si, sj), seq: seq++, state: s0, g: COST_STEP });
  if (goals.has(key(si, sj))) return [{ i: start.i, j: start.j }, { i: si, j: sj }];

  let expansions = 0;
  while (heap.size > 0 && expansions++ < maxExpansions) {
    const cur = heap.pop()!;
    if ((gScore.get(cur.state) ?? Infinity) < cur.g) continue;
    const ci = (cur.state >> 2) % 65536;
    const cj = Math.floor((cur.state >> 2) / 65536);
    const cdir = cur.state & 3;
    const curOwner = grid.ownerOf(ci, cj);
    const crossing = curOwner !== undefined && curOwner !== net;

    for (let d = 0; d < 4; d++) {
      // No U-turns; inside a foreign wire cell we must continue straight.
      if ((d ^ 1) === cdir) continue;
      if (crossing && d !== cdir) continue;
      const dd = DIRS[d];
      const ni = ci + dd.di;
      const nj = cj + dd.dj;
      if (!grid.inside(ni, nj) || grid.isBlocked(ni, nj)) continue;
      const nOwner = grid.ownerOf(ni, nj);
      let cost = COST_STEP + (d !== cdir ? COST_TURN : 0) + (grid.isSoft(ni, nj) ? COST_NEAR_BODY : 0);
      const nk = key(ni, nj);
      const isGoal = goals.has(nk);
      if (nOwner !== undefined && nOwner !== net) {
        // Foreign wire: cross only perpendicular, never through a corner/junction or a reserved pin cell.
        const ax = grid.axisOf(ni, nj);
        if (ax === undefined || ax === 'x') continue;
        if ((ax === 'h') !== (dd.axis === 'v')) continue;
        // The cell beyond must be enterable (we cannot stop inside the crossing).
        const bi = ni + dd.di;
        const bj = nj + dd.dj;
        if (!grid.inside(bi, bj) || grid.isBlocked(bi, bj)) continue;
        cost += COST_CROSS;
      } else if (nOwner === net && !isGoal) {
        // Our own reserved cell (another pin's exit) that is not yet in the tree: fine to pass.
      }
      const ng = cur.g + cost;
      const ns = (nk << 2) | d;
      if (ng >= (gScore.get(ns) ?? Infinity)) continue;
      gScore.set(ns, ng);
      parent.set(ns, cur.state);
      if (isGoal) {
        // Reconstruct.
        const path: Cell[] = [{ i: ni, j: nj }];
        let s = cur.state;
        for (;;) {
          const pi = (s >> 2) % 65536;
          const pj = Math.floor((s >> 2) / 65536);
          path.push({ i: pi, j: pj });
          if ((s >> 2) === startKey) break;
          const p = parent.get(s);
          if (p === undefined) break;
          s = p;
        }
        path.reverse();
        return path;
      }
      heap.push({ f: ng + heuristic(ni, nj), seq: seq++, state: ns, g: ng });
    }
  }
  return null;
}

/** Collapse a lattice path into its corner points. */
export function corners(path: Cell[]): Cell[] {
  if (path.length <= 2) return path.slice();
  const out: Cell[] = [path[0]];
  for (let k = 1; k < path.length - 1; k++) {
    const a = path[k - 1];
    const b = path[k];
    const c = path[k + 1];
    const straight = (a.i === b.i && b.i === c.i) || (a.j === b.j && b.j === c.j);
    if (!straight) out.push(b);
  }
  out.push(path[path.length - 1]);
  return out;
}
