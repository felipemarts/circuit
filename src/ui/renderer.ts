import { type PlacedComponent, type Point, getComponentDef, formatValue, getPinWorldPos, GRID_SIZE } from './types';

const PIN_RADIUS = 4;
const PIN_HIT_RADIUS = 12;

const COLORS = {
  bg: '#0a0e17',
  gridDot: '#1e293b',
  wire: '#cbd5e1',
  wireShadow: 'rgba(203,213,225,0.18)',
  wireFlow: '#22c55e',
  component: '#e2e8f0',
  componentSelected: '#22d3ee',
  componentGlow: 'rgba(34,211,238,0.35)',
  pin: '#94a3b8',
  pinConnected: '#cbd5e1',
  pinHover: '#f472b6',
  pinHoverGlow: 'rgba(244,114,182,0.4)',
  ground: '#94a3b8',
  text: '#94a3b8',
  textLabel: '#cbd5e1',
  textValue: '#fbbf24',
  resultBg: 'rgba(10,14,23,0.88)',
  resultV: '#22d3ee',
  resultI: '#34d399',
  wirePreview: 'rgba(34,211,238,0.4)',
  compBg: '#0a0e17',
};

// ─── Grid ────────────────────────────────────────────────────────────────────

export function drawGrid(ctx: CanvasRenderingContext2D, width: number, height: number) {
  ctx.fillStyle = COLORS.gridDot;
  const step = GRID_SIZE;
  for (let x = step; x < width; x += step) {
    for (let y = step; y < height; y += step) {
      ctx.beginPath();
      ctx.arc(x, y, 0.8, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

// ─── Component background mask ───────────────────────────────────────────────

export function drawComponentMask(ctx: CanvasRenderingContext2D, comp: PlacedComponent) {
  ctx.save();
  ctx.translate(comp.x, comp.y);
  ctx.rotate((comp.rotation * Math.PI) / 180);
  ctx.fillStyle = COLORS.compBg;

  // Draw opaque background behind the component body so wires are hidden
  const isVertical = comp.type === 'VoltageSource' || comp.type === 'CurrentSource';
  const isGround = comp.type === 'Ground';
  const isJunction = comp.type === 'Junction';
  if (isJunction) {
    // No mask — junction is a tiny dot rendered on top of the wire intentionally
  } else if (isGround) {
    ctx.fillRect(-14, -4, 28, 16);
  } else if (isVertical) {
    ctx.fillRect(-22, -22, 44, 44);
  } else {
    ctx.fillRect(-24, -16, 48, 32);
  }
  ctx.restore();
}

// ─── Components ──────────────────────────────────────────────────────────────

export function drawComponent(ctx: CanvasRenderingContext2D, comp: PlacedComponent, selected: boolean, showResults: boolean, connectedPins: Set<string>) {
  const color = selected ? COLORS.componentSelected : COLORS.component;

  ctx.save();
  ctx.translate(comp.x, comp.y);
  ctx.rotate((comp.rotation * Math.PI) / 180);

  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = selected ? 3 : 2.5;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  switch (comp.type) {
    case 'Resistor': drawResistor(ctx); break;
    case 'VoltageSource': drawVoltageSource(ctx, color); break;
    case 'CurrentSource': drawCurrentSource(ctx, color); break;
    case 'Capacitor': drawCapacitor(ctx); break;
    case 'Inductor': drawInductor(ctx); break;
    case 'Diode': drawDiode(ctx, color); break;
    case 'LED': drawLED(ctx, color); break;
    case 'Ground': drawGround(ctx, selected); break;
    case 'Junction': drawJunction(ctx, selected); break;
    default: {
      const customDef = getComponentDef(comp.type);
      if (customDef?.draw) {
        customDef.draw(ctx, 60, 40);
      } else {
        drawGenericBox(ctx, comp.label, color);
      }
      break;
    }
  }

  ctx.restore();

  // Determine actual visual orientation: VoltageSource/CurrentSource are
  // intrinsically vertical (pins top/bottom), so rotation 0/180 keeps them
  // vertical; for everything else, rotation 0/180 means horizontal layout.
  const isVerticalSource = comp.type === 'VoltageSource' || comp.type === 'CurrentSource';
  const baseHorizontal = comp.rotation === 0 || comp.rotation === 180;
  const landscape = isVerticalSource ? !baseHorizontal : baseHorizontal;
  const def = getComponentDef(comp.type);

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  // Component label — placed beyond the body so it never overlaps
  if (comp.label) {
    ctx.font = 'bold 11px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.fillStyle = selected ? COLORS.componentSelected : COLORS.textLabel;
    if (landscape) {
      ctx.fillText(comp.label, comp.x, comp.y - 26);
    } else {
      ctx.textAlign = 'right';
      ctx.fillText(comp.label, comp.x - 30, comp.y);
      ctx.textAlign = 'center';
    }
  }

  // Value
  if (def?.unit && comp.value) {
    ctx.font = '10px "SF Mono", "Fira Code", monospace';
    ctx.fillStyle = COLORS.textValue;
    if (landscape) {
      ctx.fillText(formatValue(comp.value, def.unit), comp.x, comp.y + 26);
    } else {
      ctx.textAlign = 'left';
      ctx.fillText(formatValue(comp.value, def.unit), comp.x + 30, comp.y);
      ctx.textAlign = 'center';
    }
  }

  // Draw results as floating badge
  if (showResults && comp.voltage !== undefined) {
    // Live readings: text only (no opaque background) placed away from leads
    // so the wire and pin remain visible.
    const badgeX = comp.x + (landscape ? 0 : 56);
    const badgeY = comp.y + (landscape ? 46 : 22);

    ctx.font = '9px "SF Mono", "Fira Code", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    // Subtle dark halo behind text to keep readability over wires
    ctx.shadowColor = 'rgba(10,14,23,0.95)';
    ctx.shadowBlur = 4;

    ctx.fillStyle = COLORS.resultV;
    ctx.fillText(`${comp.voltage.toFixed(2)}V`, badgeX, badgeY);
    ctx.fillStyle = COLORS.resultI;
    ctx.fillText(`${formatValue(comp.current ?? 0, 'A')}`, badgeX, badgeY + 11);

    ctx.shadowBlur = 0;
  }

  // Pins
  for (const pinDef of comp.pins) {
    const pos = getPinWorldPos(comp, pinDef.name);
    const key = `${comp.id}:${pinDef.name}`;
    const isConnected = connectedPins.has(key);

    ctx.beginPath();
    ctx.arc(pos.x, pos.y, PIN_RADIUS, 0, Math.PI * 2);
    ctx.fillStyle = isConnected ? COLORS.pinConnected : COLORS.pin;
    ctx.fill();
  }
}

function drawResistor(ctx: CanvasRenderingContext2D) {
  // Leads
  ctx.beginPath();
  ctx.moveTo(-40, 0); ctx.lineTo(-20, 0);
  ctx.moveTo(20, 0); ctx.lineTo(40, 0);
  ctx.stroke();

  // Rectangular body (European style for cleaner look)
  ctx.strokeRect(-20, -8, 40, 16);
}

function drawVoltageSource(ctx: CanvasRenderingContext2D, color: string) {
  // Leads
  ctx.beginPath();
  ctx.moveTo(0, -35); ctx.lineTo(0, -20);
  ctx.moveTo(0, 20); ctx.lineTo(0, 35);
  ctx.stroke();

  // Circle
  ctx.beginPath();
  ctx.arc(0, 0, 20, 0, Math.PI * 2);
  ctx.stroke();

  // Plus
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(-5, -9); ctx.lineTo(5, -9);
  ctx.moveTo(0, -14); ctx.lineTo(0, -4);
  ctx.stroke();

  // Minus
  ctx.beginPath();
  ctx.moveTo(-5, 9); ctx.lineTo(5, 9);
  ctx.stroke();
  ctx.lineWidth = 2.5;
}

function drawCurrentSource(ctx: CanvasRenderingContext2D, color: string) {
  // Leads
  ctx.beginPath();
  ctx.moveTo(0, -35); ctx.lineTo(0, -20);
  ctx.moveTo(0, 20); ctx.lineTo(0, 35);
  ctx.stroke();

  // Circle
  ctx.beginPath();
  ctx.arc(0, 0, 20, 0, Math.PI * 2);
  ctx.stroke();

  // Arrow (pointing up = into +)
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(0, 12); ctx.lineTo(0, -12);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(0, -12); ctx.lineTo(-5, -5);
  ctx.moveTo(0, -12); ctx.lineTo(5, -5);
  ctx.stroke();
  ctx.lineWidth = 2.5;
}

function drawCapacitor(ctx: CanvasRenderingContext2D) {
  // Leads
  ctx.beginPath();
  ctx.moveTo(-30, 0); ctx.lineTo(-7, 0);
  ctx.moveTo(7, 0); ctx.lineTo(30, 0);
  ctx.stroke();

  // Plates
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(-7, -14); ctx.lineTo(-7, 14);
  ctx.moveTo(7, -14); ctx.lineTo(7, 14);
  ctx.stroke();
  ctx.lineWidth = 2.5;
}

function drawInductor(ctx: CanvasRenderingContext2D) {
  // Leads
  ctx.beginPath();
  ctx.moveTo(-40, 0); ctx.lineTo(-26, 0);
  ctx.moveTo(26, 0); ctx.lineTo(40, 0);
  ctx.stroke();

  // 4 arcs (coil)
  for (let i = 0; i < 4; i++) {
    ctx.beginPath();
    ctx.arc(-19.5 + i * 13, 0, 6.5, Math.PI, 0);
    ctx.stroke();
  }
}

function drawDiode(ctx: CanvasRenderingContext2D, color: string) {
  // Leads
  ctx.beginPath();
  ctx.moveTo(-30, 0); ctx.lineTo(-12, 0);
  ctx.moveTo(12, 0); ctx.lineTo(30, 0);
  ctx.stroke();

  // Triangle (filled)
  ctx.beginPath();
  ctx.moveTo(-12, -10);
  ctx.lineTo(-12, 10);
  ctx.lineTo(12, 0);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.globalAlpha = 0.15;
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.stroke();

  // Bar
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(12, -10); ctx.lineTo(12, 10);
  ctx.stroke();
  ctx.lineWidth = 2.5;
}

function drawLED(ctx: CanvasRenderingContext2D, color: string) {
  drawDiode(ctx, color);

  // Light emission arrows
  ctx.lineWidth = 1.5;
  // Arrow 1
  ctx.beginPath();
  ctx.moveTo(3, -14); ctx.lineTo(9, -22);
  ctx.moveTo(9, -22); ctx.lineTo(5, -19);
  ctx.moveTo(9, -22); ctx.lineTo(9, -17);
  ctx.stroke();
  // Arrow 2
  ctx.beginPath();
  ctx.moveTo(9, -10); ctx.lineTo(15, -18);
  ctx.moveTo(15, -18); ctx.lineTo(11, -15);
  ctx.moveTo(15, -18); ctx.lineTo(15, -13);
  ctx.stroke();
  ctx.lineWidth = 2.5;
}

function drawGround(ctx: CanvasRenderingContext2D, selected: boolean) {
  // Draw in component-local coords. Pin is at (0, -25) (top), so the symbol
  // has a longer stem then descends from y=-2 (top bar) to y=+10 (smallest bar).
  const stroke = selected ? COLORS.componentSelected : COLORS.ground;
  ctx.strokeStyle = stroke;
  ctx.lineCap = 'round';

  // Stem from pin to first bar
  ctx.beginPath();
  ctx.moveTo(0, -25);
  ctx.lineTo(0, -2);
  ctx.stroke();

  // Three horizontal bars decreasing in width
  const bars: Array<[number, number]> = [
    [12, -2],
    [8, 4],
    [4, 10],
  ];
  for (const [w, y] of bars) {
    ctx.beginPath();
    ctx.moveTo(-w, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }
}

function drawJunction(ctx: CanvasRenderingContext2D, selected: boolean) {
  // Small filled dot at the center; pin is at (0, 0).
  const fill = selected ? COLORS.componentSelected : COLORS.wire;
  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.arc(0, 0, 4, 0, Math.PI * 2);
  ctx.fill();
}

function drawGenericBox(ctx: CanvasRenderingContext2D, label: string, color: string) {
  // Generic rectangle with label for custom components
  ctx.strokeRect(-25, -18, 50, 36);

  // Draw component name inside
  ctx.font = 'bold 10px -apple-system, BlinkMacSystemFont, sans-serif';
  ctx.fillStyle = color;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, 0, 0);

  // Draw pin leads at the edges
  ctx.beginPath();
  ctx.moveTo(-40, 0); ctx.lineTo(-25, 0);
  ctx.moveTo(25, 0); ctx.lineTo(40, 0);
  ctx.stroke();
}

// ─── Wires ───────────────────────────────────────────────────────────────────

export interface Rect { minX: number; minY: number; maxX: number; maxY: number }
export interface Segment { p1: Point; p2: Point }

export function drawWirePath(
  ctx: CanvasRenderingContext2D,
  path: Point[],
  flowOffset = 0,
  selected = false,
) {
  // Glow
  ctx.strokeStyle = selected ? COLORS.componentGlow : COLORS.wireShadow;
  ctx.lineWidth = selected ? 8 : 6;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.setLineDash([]);
  drawPath(ctx, path);

  // Wire body
  ctx.strokeStyle = selected ? COLORS.componentSelected : COLORS.wire;
  ctx.lineWidth = selected ? 3 : 2.5;
  drawPath(ctx, path);

  if (flowOffset !== 0) {
    drawWireFlowMarkers(ctx, path, flowOffset);
  }
}

/** Draw small green squares moving along the wire to indicate current flow. */
function drawWireFlowMarkers(
  ctx: CanvasRenderingContext2D,
  path: Point[],
  flowOffset: number,
) {
  const SPACING = 28;
  const SIZE = 6;
  const HALF = SIZE / 2;

  // Cumulative segment lengths for arc-length parameterisation
  let total = 0;
  const lens: number[] = [0];
  for (let i = 1; i < path.length; i++) {
    total += Math.abs(path[i].x - path[i - 1].x) + Math.abs(path[i].y - path[i - 1].y);
    lens.push(total);
  }
  if (total < SIZE) return;

  // Phase ∈ [0, SPACING)
  const phase = ((flowOffset % SPACING) + SPACING) % SPACING;

  ctx.fillStyle = COLORS.wireFlow;
  ctx.shadowColor = COLORS.wireFlow;
  ctx.shadowBlur = 6;

  for (let s = phase; s <= total - HALF; s += SPACING) {
    if (s < HALF) continue;
    let seg = 0;
    while (seg < lens.length - 2 && lens[seg + 1] < s) seg++;
    const a = path[seg];
    const b = path[seg + 1];
    const segLen = lens[seg + 1] - lens[seg];
    if (segLen <= 0) continue;
    const t = (s - lens[seg]) / segLen;
    const x = a.x + (b.x - a.x) * t;
    const y = a.y + (b.y - a.y) * t;
    ctx.fillRect(Math.round(x - HALF), Math.round(y - HALF), SIZE, SIZE);
  }
  ctx.shadowBlur = 0;
}

export function drawWirePreviewPath(ctx: CanvasRenderingContext2D, path: Point[]) {
  ctx.strokeStyle = COLORS.wirePreview;
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.setLineDash([8, 5]);
  drawPath(ctx, path);
  ctx.setLineDash([]);
}

// Convenience wrappers (back-compat)
export function drawWire(
  ctx: CanvasRenderingContext2D, from: Point, to: Point,
  obstacles: Rect[] = [], blocked: Segment[] = [],
) {
  drawWirePath(ctx, routeWire(from, to, obstacles, blocked));
}
export function drawWirePreview(
  ctx: CanvasRenderingContext2D, from: Point, to: Point,
  obstacles: Rect[] = [], blocked: Segment[] = [],
) {
  drawWirePreviewPath(ctx, routeWire(from, to, obstacles, blocked));
}

/** Convert a polyline into a list of axis-aligned segments. */
export function pathToSegments(path: Point[]): Segment[] {
  const out: Segment[] = [];
  for (let i = 1; i < path.length; i++) out.push({ p1: path[i - 1], p2: path[i] });
  return out;
}

/** Build axis-aligned bounding boxes for components that wires should avoid. */
export function buildComponentObstacles(
  components: Array<{ x: number; y: number; type: string; rotation: number }>,
): Rect[] {
  const out: Rect[] = [];
  for (const c of components) {
    if (c.type === 'Junction') continue; // junctions are passthroughs, no obstacle
    const isVertical = c.type === 'VoltageSource' || c.type === 'CurrentSource';
    const isGround = c.type === 'Ground';
    const rotated = c.rotation === 90 || c.rotation === 270;
    let halfW: number, halfH: number;
    if (isVertical) {
      halfW = halfH = 22;
    } else if (isGround) {
      // Ground body sits below the (now-longer) pin: body y∈[-2, +10]
      halfW = 14;
      halfH = 12;
      out.push({
        minX: c.x - halfW,
        minY: c.y - 4,
        maxX: c.x + halfW,
        maxY: c.y + halfH,
      });
      continue;
    } else if (rotated) {
      halfW = 16;
      halfH = 24;
    } else {
      halfW = 24;
      halfH = 16;
    }
    out.push({
      minX: c.x - halfW,
      minY: c.y - halfH,
      maxX: c.x + halfW,
      maxY: c.y + halfH,
    });
  }
  return out;
}

/** Classify how an axis-aligned candidate segment interacts with another. */
type SegInteraction = 'none' | 'cross' | 'overlap';
function classifySegments(p1: Point, p2: Point, s: Segment): SegInteraction {
  const aH = p1.y === p2.y;
  const aV = p1.x === p2.x;
  const bH = s.p1.y === s.p2.y;
  const bV = s.p1.x === s.p2.x;

  if (aH && bH) {
    if (p1.y !== s.p1.y) return 'none';
    const xMin1 = Math.min(p1.x, p2.x);
    const xMax1 = Math.max(p1.x, p2.x);
    const xMin2 = Math.min(s.p1.x, s.p2.x);
    const xMax2 = Math.max(s.p1.x, s.p2.x);
    return xMax1 > xMin2 && xMin1 < xMax2 ? 'overlap' : 'none';
  }
  if (aV && bV) {
    if (p1.x !== s.p1.x) return 'none';
    const yMin1 = Math.min(p1.y, p2.y);
    const yMax1 = Math.max(p1.y, p2.y);
    const yMin2 = Math.min(s.p1.y, s.p2.y);
    const yMax2 = Math.max(s.p1.y, s.p2.y);
    return yMax1 > yMin2 && yMin1 < yMax2 ? 'overlap' : 'none';
  }
  // Perpendicular
  let hY: number, vX: number, hMinX: number, hMaxX: number, vMinY: number, vMaxY: number;
  if (aH) {
    hY = p1.y; hMinX = Math.min(p1.x, p2.x); hMaxX = Math.max(p1.x, p2.x);
    vX = s.p1.x; vMinY = Math.min(s.p1.y, s.p2.y); vMaxY = Math.max(s.p1.y, s.p2.y);
  } else {
    hY = s.p1.y; hMinX = Math.min(s.p1.x, s.p2.x); hMaxX = Math.max(s.p1.x, s.p2.x);
    vX = p1.x; vMinY = Math.min(p1.y, p2.y); vMaxY = Math.max(p1.y, p2.y);
  }
  // Strict interior crossing (touching at endpoints is allowed, e.g. shared pin)
  return vX > hMinX && vX < hMaxX && hY > vMinY && hY < vMaxY ? 'cross' : 'none';
}

/** True if axis-aligned segment (p1→p2) intersects rect interior. */
function segmentHitsRect(p1: Point, p2: Point, r: Rect): boolean {
  if (p1.y === p2.y) {
    if (p1.y <= r.minY || p1.y >= r.maxY) return false;
    const xMin = Math.min(p1.x, p2.x);
    const xMax = Math.max(p1.x, p2.x);
    return xMax > r.minX && xMin < r.maxX;
  }
  if (p1.x === p2.x) {
    if (p1.x <= r.minX || p1.x >= r.maxX) return false;
    const yMin = Math.min(p1.y, p2.y);
    const yMax = Math.max(p1.y, p2.y);
    return yMax > r.minY && yMin < r.maxY;
  }
  return false;
}

function pathHits(path: Point[], obstacles: Rect[]): number {
  let hits = 0;
  for (let i = 1; i < path.length; i++) {
    for (const r of obstacles) {
      if (segmentHitsRect(path[i - 1], path[i], r)) hits++;
    }
  }
  return hits;
}

function pathLength(path: Point[]): number {
  let len = 0;
  for (let i = 1; i < path.length; i++) {
    len += Math.abs(path[i].x - path[i - 1].x) + Math.abs(path[i].y - path[i - 1].y);
  }
  return len;
}

// ─── A* router ────────────────────────────────────────────────────────────
// Grid-based pathfinding: routes around obstacles, prefers straight runs by
// penalising bends, simplifies collinear segments at the end.

type Dir = 0 | 1 | 2 | 3 | 4; // 0=none, 1=E, 2=W, 3=N, 4=S

interface AStarNode {
  x: number;
  y: number;
  dir: Dir;
  g: number;
  f: number;
  parent: AStarNode | null;
}

class MinHeap<T> {
  private items: T[] = [];
  constructor(private less: (a: T, b: T) => boolean) {}
  size(): number { return this.items.length; }
  push(item: T): void {
    this.items.push(item);
    this.bubbleUp(this.items.length - 1);
  }
  pop(): T | undefined {
    if (this.items.length === 0) return undefined;
    const top = this.items[0];
    const last = this.items.pop()!;
    if (this.items.length > 0) {
      this.items[0] = last;
      this.bubbleDown(0);
    }
    return top;
  }
  private bubbleUp(i: number): void {
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.less(this.items[i], this.items[p])) {
        [this.items[i], this.items[p]] = [this.items[p], this.items[i]];
        i = p;
      } else break;
    }
  }
  private bubbleDown(i: number): void {
    const n = this.items.length;
    while (true) {
      const l = 2 * i + 1;
      const r = 2 * i + 2;
      let s = i;
      if (l < n && this.less(this.items[l], this.items[s])) s = l;
      if (r < n && this.less(this.items[r], this.items[s])) s = r;
      if (s === i) break;
      [this.items[i], this.items[s]] = [this.items[s], this.items[i]];
      i = s;
    }
  }
}

function manhattan(a: Point, b: Point): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

function aStarRoute(
  from: Point, to: Point, obstacles: Rect[], blocked: Segment[],
): Point[] | null {
  // STEP=5 divides every pin offset cleanly (±5, ±10, ±20, ±30, ±35, ±40),
  // so snapped start/goal land exactly on the pin and no loop-back is added.
  const STEP = 5;
  const BEND_PENALTY = STEP * 1.2;
  const CROSS_PENALTY = STEP * 8;
  const MAX_ITER = 25000;

  const start: Point = { x: Math.round(from.x / STEP) * STEP, y: Math.round(from.y / STEP) * STEP };
  const goal: Point = { x: Math.round(to.x / STEP) * STEP, y: Math.round(to.y / STEP) * STEP };

  if (start.x === goal.x && start.y === goal.y) return [from, to];

  let minX = Math.min(start.x, goal.x);
  let minY = Math.min(start.y, goal.y);
  let maxX = Math.max(start.x, goal.x);
  let maxY = Math.max(start.y, goal.y);
  for (const r of obstacles) {
    minX = Math.min(minX, r.minX);
    minY = Math.min(minY, r.minY);
    maxX = Math.max(maxX, r.maxX);
    maxY = Math.max(maxY, r.maxY);
  }
  const PAD = 6 * STEP;
  minX -= PAD; minY -= PAD; maxX += PAD; maxY += PAD;

  const MOVES: Array<{ dx: number; dy: number; dir: Dir }> = [
    { dx: STEP, dy: 0, dir: 1 },
    { dx: -STEP, dy: 0, dir: 2 },
    { dx: 0, dy: -STEP, dir: 3 },
    { dx: 0, dy: STEP, dir: 4 },
  ];

  const heap = new MinHeap<AStarNode>((a, b) => a.f < b.f);
  const closed = new Map<number, number>(); // key -> best g

  const w = Math.floor((maxX - minX) / STEP) + 1;
  const keyOf = (x: number, y: number, dir: Dir): number => {
    const ix = Math.floor((x - minX) / STEP);
    const iy = Math.floor((y - minY) / STEP);
    return ((iy * w + ix) * 5) + dir;
  };

  heap.push({
    x: start.x, y: start.y, dir: 0,
    g: 0, f: manhattan(start, goal), parent: null,
  });

  let iter = 0;
  while (heap.size() > 0 && iter++ < MAX_ITER) {
    const cur = heap.pop()!;

    if (cur.x === goal.x && cur.y === goal.y) {
      return reconstructPath(cur, from, to);
    }

    const ck = keyOf(cur.x, cur.y, cur.dir);
    const prevG = closed.get(ck);
    if (prevG !== undefined && prevG <= cur.g) continue;
    closed.set(ck, cur.g);

    for (const m of MOVES) {
      // Don't reverse direction
      if ((cur.dir === 1 && m.dir === 2) || (cur.dir === 2 && m.dir === 1) ||
          (cur.dir === 3 && m.dir === 4) || (cur.dir === 4 && m.dir === 3)) continue;

      const nx = cur.x + m.dx;
      const ny = cur.y + m.dy;
      if (nx < minX || nx > maxX || ny < minY || ny > maxY) continue;

      // Reject move if segment crosses any component obstacle interior
      const seg1: Point = { x: cur.x, y: cur.y };
      const seg2: Point = { x: nx, y: ny };
      let hitObstacle = false;
      for (const r of obstacles) {
        if (segmentHitsRect(seg1, seg2, r)) { hitObstacle = true; break; }
      }
      if (hitObstacle) continue;

      // Compare against already-routed wire segments: overlap is forbidden,
      // perpendicular crossing is allowed but penalised.
      let crossPenalty = 0;
      let overlapping = false;
      for (const ws of blocked) {
        const cl = classifySegments(seg1, seg2, ws);
        if (cl === 'overlap') { overlapping = true; break; }
        if (cl === 'cross') crossPenalty += CROSS_PENALTY;
      }
      if (overlapping) continue;

      const bend = (cur.dir !== 0 && cur.dir !== m.dir) ? BEND_PENALTY : 0;
      const ng = cur.g + STEP + bend + crossPenalty;
      const nk = keyOf(nx, ny, m.dir);
      const prev = closed.get(nk);
      if (prev !== undefined && prev <= ng) continue;

      heap.push({
        x: nx, y: ny, dir: m.dir,
        g: ng, f: ng + manhattan({ x: nx, y: ny }, goal),
        parent: cur,
      });
    }
  }

  return null;
}

function reconstructPath(end: AStarNode, originalFrom: Point, originalTo: Point): Point[] {
  const pts: Point[] = [];
  let cur: AStarNode | null = end;
  while (cur) {
    pts.unshift({ x: cur.x, y: cur.y });
    cur = cur.parent;
  }
  const first = pts[0];
  if (originalFrom.x !== first.x || originalFrom.y !== first.y) {
    pts.unshift({ x: originalFrom.x, y: originalFrom.y });
  }
  const last = pts[pts.length - 1];
  if (originalTo.x !== last.x || originalTo.y !== last.y) {
    pts.push({ x: originalTo.x, y: originalTo.y });
  }
  return simplifyPath(pts);
}

function simplifyPath(pts: Point[]): Point[] {
  if (pts.length <= 2) return pts;
  const out: Point[] = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const c = pts[i + 1];
    // Drop b if collinear with a and c (cross product zero)
    if ((b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x) === 0) continue;
    out.push(b);
  }
  out.push(pts[pts.length - 1]);
  return out;
}

export function routeWire(
  from: Point, to: Point,
  obstacles: Rect[] = [],
  blocked: Segment[] = [],
): Point[] {
  if (Math.abs(to.x - from.x) < 2 && Math.abs(to.y - from.y) < 2) return [from, to];

  if (obstacles.length === 0 && blocked.length === 0) {
    if (Math.abs(to.x - from.x) < 2) return [from, to];
    if (Math.abs(to.y - from.y) < 2) return [from, to];
    return Math.abs(to.x - from.x) >= Math.abs(to.y - from.y)
      ? [from, { x: to.x, y: from.y }, to]
      : [from, { x: from.x, y: to.y }, to];
  }

  const result = aStarRoute(from, to, obstacles, blocked);
  if (result) return result;

  // Fallback: best L-shape (ignores wire conflicts but at least avoids fewest components)
  const hv: Point[] = [from, { x: to.x, y: from.y }, to];
  const vh: Point[] = [from, { x: from.x, y: to.y }, to];
  const hvHits = pathHits(hv, obstacles);
  const vhHits = pathHits(vh, obstacles);
  if (hvHits !== vhHits) return hvHits < vhHits ? hv : vh;
  return pathLength(hv) <= pathLength(vh) ? hv : vh;
}

function drawPath(ctx: CanvasRenderingContext2D, path: Point[]) {
  if (path.length < 2) return;
  ctx.beginPath();
  ctx.moveTo(path[0].x, path[0].y);
  for (let i = 1; i < path.length; i++) {
    ctx.lineTo(path[i].x, path[i].y);
  }
  ctx.stroke();
}

// ─── Ground ──────────────────────────────────────────────────────────────────

export function drawGroundSymbol(ctx: CanvasRenderingContext2D, pos: Point) {
  ctx.strokeStyle = COLORS.ground;
  ctx.lineWidth = 2.5;
  ctx.lineCap = 'round';

  ctx.beginPath();
  ctx.moveTo(pos.x, pos.y);
  ctx.lineTo(pos.x, pos.y + 12);
  ctx.stroke();

  const lines = [
    { w: 12, y: 12 },
    { w: 8, y: 16 },
    { w: 4, y: 20 },
  ];

  for (const l of lines) {
    ctx.beginPath();
    ctx.moveTo(pos.x - l.w, pos.y + l.y);
    ctx.lineTo(pos.x + l.w, pos.y + l.y);
    ctx.stroke();
  }
}

// ─── Pin hover ───────────────────────────────────────────────────────────────

export function drawPinHighlight(ctx: CanvasRenderingContext2D, pos: Point) {
  // Glow ring
  ctx.beginPath();
  ctx.arc(pos.x, pos.y, PIN_HIT_RADIUS, 0, Math.PI * 2);
  ctx.fillStyle = COLORS.pinHoverGlow;
  ctx.fill();
  ctx.strokeStyle = COLORS.pinHover;
  ctx.lineWidth = 2;
  ctx.stroke();
}

// ─── Probe marker ─────────────────────────────────────────────────────────────

export function drawProbeMarker(ctx: CanvasRenderingContext2D, pos: Point, color: string) {
  ctx.save();
  ctx.translate(pos.x, pos.y);

  ctx.shadowColor = color;
  ctx.shadowBlur = 8;

  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(0, -8);
  ctx.lineTo(6, 0);
  ctx.lineTo(0, 8);
  ctx.lineTo(-6, 0);
  ctx.closePath();
  ctx.fill();

  ctx.shadowBlur = 0;

  ctx.fillStyle = '#fff';
  ctx.globalAlpha = 0.4;
  ctx.beginPath();
  ctx.arc(0, 0, 2, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1;

  ctx.restore();
}

// ─── Hit testing ─────────────────────────────────────────────────────────────

export function hitTestPin(comp: PlacedComponent, worldX: number, worldY: number): string | null {
  for (const pinDef of comp.pins) {
    const pos = getPinWorldPos(comp, pinDef.name);
    const dx = worldX - pos.x;
    const dy = worldY - pos.y;
    if (dx * dx + dy * dy <= PIN_HIT_RADIUS * PIN_HIT_RADIUS) {
      return pinDef.name;
    }
  }
  return null;
}

export function hitTestComponent(comp: PlacedComponent, worldX: number, worldY: number): boolean {
  const dx = Math.abs(worldX - comp.x);
  const dy = Math.abs(worldY - comp.y);
  return dx <= 45 && dy <= 35;
}
