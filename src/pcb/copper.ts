/**
 * Copper geometry shared by the router and the design-rule check: every
 * piece of copper (pad, track segment, via) and every drilled hole as a
 * simple shape with an exact distance function, plus a bucket index for
 * "what is near this point / segment" queries.
 *
 * Shapes: circles (round pads, vias, holes), capsules (track segments, oval
 * pads) and convex polygons (rectangular pads, as placed on the board).
 */
import type { PlacedPad } from './layout';

export type Shape =
  | { kind: 'circle'; x: number; y: number; r: number }
  | { kind: 'capsule'; ax: number; ay: number; bx: number; by: number; r: number }
  | { kind: 'poly'; pts: number[] };

/** Which copper layers a piece occupies. */
export type LayerSet = 'top' | 'bottom' | 'both';

export interface CopperItem {
  /** Net name; pads on no net get a private name ('~R1.3') so every other net keeps clear of them. */
  net: string;
  layer: LayerSet;
  kind: 'pad' | 'track' | 'via' | 'hole';
  /** Pad ref, 'track', 'via' or 'hole'. */
  ref: string;
  shape: Shape;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export const onLayer = (item: { layer: LayerSet }, layer: 'top' | 'bottom'): boolean => item.layer === 'both' || item.layer === layer;

function distPointSegXY(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

const cross = (ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number => (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);

function segsIntersect(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number): boolean {
  const d1 = cross(cx, cy, dx, dy, ax, ay);
  const d2 = cross(cx, cy, dx, dy, bx, by);
  const d3 = cross(ax, ay, bx, by, cx, cy);
  const d4 = cross(ax, ay, bx, by, dx, dy);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/** Distance between two segments (0 when they cross). */
export function distSegSeg(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number): number {
  if (segsIntersect(ax, ay, bx, by, cx, cy, dx, dy)) return 0;
  return Math.min(distPointSegXY(ax, ay, cx, cy, dx, dy), distPointSegXY(bx, by, cx, cy, dx, dy), distPointSegXY(cx, cy, ax, ay, bx, by), distPointSegXY(dx, dy, ax, ay, bx, by));
}

function insidePoly(px: number, py: number, pts: number[]): boolean {
  let inside = false;
  const n = pts.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = pts[2 * i], yi = pts[2 * i + 1], xj = pts[2 * j], yj = pts[2 * j + 1];
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Distance from the segment a–b (a point when a = b) to the shape's copper; 0 when they touch or overlap. */
export function distSegShape(ax: number, ay: number, bx: number, by: number, s: Shape): number {
  switch (s.kind) {
    case 'circle':
      return Math.max(0, distPointSegXY(s.x, s.y, ax, ay, bx, by) - s.r);
    case 'capsule':
      return Math.max(0, distSegSeg(ax, ay, bx, by, s.ax, s.ay, s.bx, s.by) - s.r);
    case 'poly': {
      const p = s.pts;
      if (insidePoly(ax, ay, p) || insidePoly(bx, by, p)) return 0;
      let best = Infinity;
      const n = p.length / 2;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const d = distSegSeg(ax, ay, bx, by, p[2 * i], p[2 * i + 1], p[2 * j], p[2 * j + 1]);
        if (d < best) best = d;
        if (best === 0) return 0;
      }
      return best;
    }
  }
}

/** Distance between two shapes' copper (0 when they touch). */
export function distShapes(a: Shape, b: Shape): number {
  switch (a.kind) {
    case 'circle':
      return Math.max(0, distSegShape(a.x, a.y, a.x, a.y, b) - a.r);
    case 'capsule':
      return Math.max(0, distSegShape(a.ax, a.ay, a.bx, a.by, b) - a.r);
    case 'poly': {
      if (b.kind !== 'poly') return distShapes(b, a);
      const p = a.pts;
      const n = p.length / 2;
      if (insidePoly(b.pts[0], b.pts[1], p)) return 0;
      let best = Infinity;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        best = Math.min(best, distSegShape(p[2 * i], p[2 * i + 1], p[2 * j], p[2 * j + 1], b));
        if (best === 0) return 0;
      }
      return best;
    }
  }
}

function boundsOf(s: Shape): [number, number, number, number] {
  switch (s.kind) {
    case 'circle':
      return [s.x - s.r, s.y - s.r, s.x + s.r, s.y + s.r];
    case 'capsule':
      return [Math.min(s.ax, s.bx) - s.r, Math.min(s.ay, s.by) - s.r, Math.max(s.ax, s.bx) + s.r, Math.max(s.ay, s.by) + s.r];
    case 'poly': {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (let i = 0; i < s.pts.length; i += 2) {
        x0 = Math.min(x0, s.pts[i]);
        x1 = Math.max(x1, s.pts[i]);
        y0 = Math.min(y0, s.pts[i + 1]);
        y1 = Math.max(y1, s.pts[i + 1]);
      }
      return [x0, y0, x1, y1];
    }
  }
}

export function item(net: string, layer: LayerSet, kind: CopperItem['kind'], ref: string, shape: Shape): CopperItem {
  const [minX, minY, maxX, maxY] = boundsOf(shape);
  return { net, layer, kind, ref, shape, minX, minY, maxX, maxY };
}

/** A pad's copper: a circle (round pad), a capsule (oval pad) or its placed rectangle. */
export function padShape(pad: PlacedPad): Shape {
  if ((pad.shape === 'circle' || pad.shape === 'oval') && Math.abs(pad.w - pad.h) < 1e-9) return { kind: 'circle', x: pad.x, y: pad.y, r: pad.w / 2 };
  if (pad.shape === 'oval') {
    // Long axis from the placed rectangle: the longer of its first two edges.
    const [p0, p1, p2] = pad.poly;
    const e1: [number, number] = [p1[0] - p0[0], p1[1] - p0[1]];
    const e2: [number, number] = [p2[0] - p1[0], p2[1] - p1[1]];
    const [ex, ey] = Math.hypot(...e1) >= Math.hypot(...e2) ? e1 : e2;
    const len = Math.hypot(ex, ey);
    const r = Math.min(pad.w, pad.h) / 2;
    const half = Math.max(pad.w, pad.h) / 2 - r;
    const ux = ex / len, uy = ey / len;
    return { kind: 'capsule', ax: pad.x - ux * half, ay: pad.y - uy * half, bx: pad.x + ux * half, by: pad.y + uy * half, r };
  }
  return { kind: 'poly', pts: pad.poly.flatMap(([x, y]) => [x, y]) };
}

/** Bucket index over copper items: an item is filed in every bucket its bounds (plus `reach`) touch. */
export class CopperIndex {
  readonly items: CopperItem[] = [];
  private readonly buckets = new Map<number, CopperItem[]>();
  constructor(
    private readonly size: number,
    private readonly reach: number,
  ) {}

  private key(i: number, j: number): number {
    return (i + 4096) * 8192 + (j + 4096);
  }

  add(it: CopperItem): void {
    this.items.push(it);
    const i0 = Math.floor((it.minX - this.reach) / this.size), i1 = Math.floor((it.maxX + this.reach) / this.size);
    const j0 = Math.floor((it.minY - this.reach) / this.size), j1 = Math.floor((it.maxY + this.reach) / this.size);
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        const k = this.key(i, j);
        const b = this.buckets.get(k);
        if (b) b.push(it);
        else this.buckets.set(k, [it]);
      }
    }
  }

  /** Items whose bounds are within `reach` of the point. */
  near(x: number, y: number): CopperItem[] {
    return this.buckets.get(this.key(Math.floor(x / this.size), Math.floor(y / this.size))) ?? [];
  }
}
