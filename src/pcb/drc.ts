/**
 * Design-rule check of the routed board — measured on the final copper, not
 * trusted from the router: copper of two nets closer than the clearance on a
 * layer, copper closer to a drilled hole than the clearance, tracks and vias
 * closer to the board edge than the edge clearance. Pad-to-pad spacing inside
 * one footprint is the footprint's own (fine-pitch parts are tighter than the
 * board rule) and pad positions are the placement check's job (P801/P802),
 * so every violation involves a track or a via.
 */
import type { Poly } from './geometry';
import { round } from './geometry';
import type { BoardSpec } from './types';
import { CopperIndex, distSegSeg, distSegShape, distShapes, type CopperItem } from './copper';

export interface DrcViolation {
  kind: 'clearance' | 'hole' | 'edge';
  /** The two pieces (track / via / pad ref / hole / edge). */
  a: CopperItem;
  b?: CopperItem;
  layer: 'top' | 'bottom';
  /** Measured distance (mm). */
  distance: number;
  /** Required distance (mm). */
  required: number;
  /** Where (mm): the midpoint of the offending piece. */
  x: number;
  y: number;
}

const EPS = 1e-3;

function centre(it: CopperItem): [number, number] {
  return [round((it.minX + it.maxX) / 2), round((it.minY + it.maxY) / 2)];
}

export function checkDesignRules(copper: CopperItem[], board: BoardSpec, outline: Poly): DrcViolation[] {
  const { clearance, edgeClearance } = board.rules;
  const out: DrcViolation[] = [];
  const index = new CopperIndex(2.5, clearance + 0.01);
  for (const it of copper) index.add(it);
  const seen = new Set<string>();
  const id = new Map(copper.map((it, k) => [it, k]));

  for (const a of copper) {
    if (a.kind !== 'track' && a.kind !== 'via') continue;
    const layers: ('top' | 'bottom')[] = a.layer === 'both' ? ['top', 'bottom'] : [a.layer];
    // Copper and holes: buckets along the piece.
    const near = new Set<CopperItem>();
    for (let x = a.minX; x <= a.maxX + 2.5; x += 2.5) for (let y = a.minY; y <= a.maxY + 2.5; y += 2.5) for (const b of index.near(Math.min(x, a.maxX), Math.min(y, a.maxY))) near.add(b);
    for (const b of [...near].sort((p, q) => id.get(p)! - id.get(q)!)) {
      if (b === a || b.net === a.net) continue;
      const layer = layers.find(l => b.layer === 'both' || b.layer === l);
      if (!layer) continue;
      if (b.kind === 'track' || b.kind === 'via') {
        // Each pair once.
        const key = id.get(a)! < id.get(b)! ? `${id.get(a)}:${id.get(b)}:${layer}` : `${id.get(b)}:${id.get(a)}:${layer}`;
        if (seen.has(key)) continue;
        seen.add(key);
      }
      const d = distShapes(a.shape, b.shape);
      if (d < clearance - EPS) {
        const [x, y] = centre(a);
        out.push({ kind: b.kind === 'hole' ? 'hole' : 'clearance', a, b, layer, distance: round(d), required: clearance, x, y });
      }
    }
    // Board edge.
    let dEdge = Infinity;
    for (let i = 0; i < outline.length; i++) {
      const [px, py] = outline[i];
      const [qx, qy] = outline[(i + 1) % outline.length];
      if (a.shape.kind === 'capsule') dEdge = Math.min(dEdge, distSegSeg(a.shape.ax, a.shape.ay, a.shape.bx, a.shape.by, px, py, qx, qy) - a.shape.r);
      else dEdge = Math.min(dEdge, distSegShape(px, py, qx, qy, a.shape));
    }
    if (dEdge < edgeClearance - EPS) {
      const [x, y] = centre(a);
      out.push({ kind: 'edge', a, layer: layers[0], distance: round(Math.max(0, dEdge)), required: edgeClearance, x, y });
    }
  }
  return out;
}
