/**
 * Plane geometry for the PCB checks: placement transforms, convex-polygon
 * overlap (separating axis), containment in a possibly concave outline, and
 * distances. Everything is in millimetres; polygons are arrays of [x, y].
 */

export type Pt = [number, number];
export type Poly = Pt[];

/** Coordinates are rounded to 0.1 µm so results are stable across platforms. */
export const round = (v: number): number => {
  const r = Math.round(v * 1e4) / 1e4;
  return r === 0 ? 0 : r;
};

/** Footprint-local → board: mirror x on the bottom side, rotate CCW, translate. */
export function toBoard(px: number, py: number, place: { x: number; y: number; rot: number; side: 'top' | 'bottom' }): Pt {
  const lx = place.side === 'bottom' ? -px : px;
  const a = (place.rot * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  // Exact quarter turns: no 6e-17 residue from cos(90°).
  const [cc, ss] = place.rot % 90 === 0 ? [Math.round(c), Math.round(s)] : [c, s];
  return [round(place.x + lx * cc - py * ss), round(place.y + lx * ss + py * cc)];
}

export function rectPoly(cx: number, cy: number, w: number, h: number): Poly {
  return [
    [cx - w / 2, cy - h / 2],
    [cx + w / 2, cy - h / 2],
    [cx + w / 2, cy + h / 2],
    [cx - w / 2, cy + h / 2],
  ];
}

/** A local rectangle moved onto the board. */
export function placeRect(cx: number, cy: number, w: number, h: number, place: { x: number; y: number; rot: number; side: 'top' | 'bottom' }): Poly {
  return rectPoly(cx, cy, w, h).map(([x, y]) => toBoard(x, y, place));
}

function axesOf(poly: Poly): Pt[] {
  const axes: Pt[] = [];
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i];
    const [x2, y2] = poly[(i + 1) % poly.length];
    const nx = -(y2 - y1);
    const ny = x2 - x1;
    const len = Math.hypot(nx, ny);
    if (len > 0) axes.push([nx / len, ny / len]);
  }
  return axes;
}

/** Penetration depth of two convex polygons (> 0: they overlap by that much; ≤ 0: separated or touching). */
export function overlapDepth(a: Poly, b: Poly): number {
  let depth = Infinity;
  for (const [ax, ay] of [...axesOf(a), ...axesOf(b)]) {
    let aMin = Infinity, aMax = -Infinity, bMin = Infinity, bMax = -Infinity;
    for (const [x, y] of a) {
      const p = x * ax + y * ay;
      if (p < aMin) aMin = p;
      if (p > aMax) aMax = p;
    }
    for (const [x, y] of b) {
      const p = x * ax + y * ay;
      if (p < bMin) bMin = p;
      if (p > bMax) bMax = p;
    }
    const d = Math.min(aMax, bMax) - Math.max(aMin, bMin);
    if (d < depth) depth = d;
    if (depth <= 0) return depth;
  }
  return depth;
}

/** Overlap beyond a 1 µm tolerance (courtyards that merely touch are fine). */
export const overlaps = (a: Poly, b: Poly): boolean => overlapDepth(a, b) > 1e-3;

export function pointInPolygon([x, y]: Pt, poly: Poly): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function distPointSeg([px, py]: Pt, [ax, ay]: Pt, [bx, by]: Pt): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function segmentsCross(a: Pt, b: Pt, c: Pt, d: Pt): boolean {
  const o = (p: Pt, q: Pt, r: Pt) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const d1 = o(c, d, a);
  const d2 = o(c, d, b);
  const d3 = o(a, b, c);
  const d4 = o(a, b, d);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

const edges = (poly: Poly): [Pt, Pt][] => poly.map((p, i) => [p, poly[(i + 1) % poly.length]] as [Pt, Pt]);

/** Minimum distance between a polygon's boundary and an outline's edges (0 when they cross). */
export function distToOutline(poly: Poly, outline: Poly): number {
  let best = Infinity;
  for (const [a, b] of edges(outline)) {
    for (const [c, d] of edges(poly)) {
      if (segmentsCross(a, b, c, d)) return 0;
      best = Math.min(best, distPointSeg(a, c, d), distPointSeg(b, c, d), distPointSeg(c, a, b), distPointSeg(d, a, b));
    }
  }
  return best;
}

/** Every vertex inside the outline and no edge crossing it (handles concave outlines). */
export function insideOutline(poly: Poly, outline: Poly): boolean {
  if (!poly.every(p => pointInPolygon(p, outline))) return false;
  for (const [a, b] of edges(outline)) for (const [c, d] of edges(poly)) if (segmentsCross(a, b, c, d)) return false;
  // An outline vertex poking into the polygon (a notch) also means "not inside".
  return !outline.some(p => pointInPolygon(p, poly));
}

/** Distance from a point to a convex polygon (0 inside). */
export function distPointPoly(p: Pt, poly: Poly): number {
  if (pointInPolygon(p, poly)) return 0;
  return Math.min(...edges(poly).map(([a, b]) => distPointSeg(p, a, b)));
}

export function polyArea(poly: Poly): number {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i];
    const [x2, y2] = poly[(i + 1) % poly.length];
    s += x1 * y2 - x2 * y1;
  }
  return Math.abs(s) / 2;
}

export function bbox(points: Pt[]): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of points) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY };
}

/** Board outline polygon: the explicit outline, or the rectangle with optionally rounded corners (8 segments per corner). */
export function outlinePolygon(board: { width?: number; height?: number; cornerRadius?: number; outline?: Pt[] }): Poly {
  if (board.outline) return board.outline.map(([x, y]) => [x, y] as Pt);
  const w = board.width!;
  const h = board.height!;
  const r = Math.min(board.cornerRadius ?? 0, w / 2, h / 2);
  if (!(r > 0)) return [[0, 0], [w, 0], [w, h], [0, h]];
  const out: Poly = [];
  const corners: [number, number, number][] = [
    [w - r, r, -90],
    [w - r, h - r, 0],
    [r, h - r, 90],
    [r, r, 180],
  ];
  for (const [cx, cy, start] of corners) {
    for (let k = 0; k <= 8; k++) {
      const a = ((start + (90 * k) / 8) * Math.PI) / 180;
      out.push([round(cx + r * Math.cos(a)), round(cy + r * Math.sin(a))]);
    }
  }
  return out;
}
