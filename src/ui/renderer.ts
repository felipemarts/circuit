import { type PlacedComponent, type Point, getComponentDef, formatValue, getPinWorldPos, GRID_SIZE } from './types';

const PIN_RADIUS = 3.6;
const PIN_HIT_RADIUS = 12;

/**
 * Renderer palette. Mutable so the theme can be switched at runtime
 * (`applyRendererTheme`); every draw call reads from this object.
 */
export const COLORS = {
  bg: '#070b14',
  gridDot: 'rgba(148,163,184,0.16)',
  gridDotMajor: 'rgba(148,163,184,0.28)',
  wire: '#b9c4d6',
  wireGlow: 'rgba(185,196,214,0.16)',
  dot: '#fef3c7',
  dotHalo: 'rgba(251,191,36,0.30)',
  component: '#e8eef8',
  componentSelected: '#22d3ee',
  componentGlow: 'rgba(34,211,238,0.35)',
  activeGlow: 'rgba(34,211,238,0.22)',
  pin: '#7f8da6',
  pinConnected: '#c7d0df',
  pinHover: '#f472b6',
  pinHoverGlow: 'rgba(244,114,182,0.4)',
  ground: '#8b9bb4',
  text: '#9aa8bf',
  textLabel: '#d5dce8',
  textValue: '#fbbf24',
  resultV: '#22d3ee',
  resultI: '#34d399',
  resultHalo: 'rgba(7,11,20,0.95)',
  wirePreview: 'rgba(34,211,238,0.5)',
  compBg: '#070b14',
  ledOn: '#fbbf24',
  ledHalo: '251,191,36',
  sourceFill: 'rgba(34,211,238,0.06)',
};

const DARK = { ...COLORS };
const LIGHT: typeof COLORS = {
  bg: '#f3f5fa',
  gridDot: 'rgba(15,23,42,0.12)',
  gridDotMajor: 'rgba(15,23,42,0.22)',
  wire: '#475569',
  wireGlow: 'rgba(71,85,105,0.14)',
  dot: '#b45309',
  dotHalo: 'rgba(217,119,6,0.22)',
  component: '#0f172a',
  componentSelected: '#0891b2',
  componentGlow: 'rgba(8,145,178,0.3)',
  activeGlow: 'rgba(8,145,178,0.18)',
  pin: '#94a3b8',
  pinConnected: '#334155',
  pinHover: '#db2777',
  pinHoverGlow: 'rgba(219,39,119,0.3)',
  ground: '#64748b',
  text: '#475569',
  textLabel: '#1e293b',
  textValue: '#b45309',
  resultV: '#0e7490',
  resultI: '#047857',
  resultHalo: 'rgba(243,245,250,0.95)',
  wirePreview: 'rgba(8,145,178,0.6)',
  compBg: '#f3f5fa',
  ledOn: '#f59e0b',
  ledHalo: '245,158,11',
  sourceFill: 'rgba(8,145,178,0.06)',
};

export function applyRendererTheme(light: boolean): void {
  Object.assign(COLORS, light ? LIGHT : DARK);
}

const FONT_LABEL = "600 11px 'Inter', -apple-system, BlinkMacSystemFont, sans-serif";
const FONT_VALUE = "500 10px 'JetBrains Mono', 'SF Mono', ui-monospace, monospace";
const FONT_RESULT = "500 9.5px 'JetBrains Mono', 'SF Mono', ui-monospace, monospace";

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

/** Brightness 0..1.2 of an LED from its forward current (full at ~10 mA). */
function ledBrightness(comp: PlacedComponent): number {
  const i = comp.current ?? 0;
  if (!(i > 2e-5)) return 0;
  return Math.min(1.2, Math.sqrt(i / 0.01));
}

export function drawComponent(
  ctx: CanvasRenderingContext2D,
  comp: PlacedComponent,
  selected: boolean,
  showResults: boolean,
  connectedPins: Set<string>,
  live = false,
) {
  const color = selected ? COLORS.componentSelected : COLORS.component;
  const isLED = comp.type === 'LED';
  const bright = live && isLED ? ledBrightness(comp) : 0;

  // LED halo (world space, behind the symbol)
  if (bright > 0) {
    const r = 26 + 16 * bright;
    const g = ctx.createRadialGradient(comp.x, comp.y, 1, comp.x, comp.y, r);
    g.addColorStop(0, `rgba(${COLORS.ledHalo},${(0.55 * bright).toFixed(3)})`);
    g.addColorStop(0.5, `rgba(${COLORS.ledHalo},${(0.18 * bright).toFixed(3)})`);
    g.addColorStop(1, `rgba(${COLORS.ledHalo},0)`);
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(comp.x, comp.y, r, 0, Math.PI * 2); ctx.fill();
  }

  ctx.save();
  ctx.translate(comp.x, comp.y);
  ctx.rotate((comp.rotation * Math.PI) / 180);

  // Soft glow on active parts while simulating / selection ring
  const active = live && Math.abs(comp.current ?? 0) > 1e-6 && comp.type !== 'Ground' && comp.type !== 'Junction';
  if (selected || active) {
    ctx.shadowColor = selected ? COLORS.componentGlow : COLORS.activeGlow;
    ctx.shadowBlur = selected ? 12 : 8;
  }

  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = selected ? 2.8 : 2.2;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  switch (comp.type) {
    case 'Resistor': drawResistor(ctx); break;
    case 'VoltageSource': drawVoltageSource(ctx, color); break;
    case 'CurrentSource': drawCurrentSource(ctx, color); break;
    case 'Capacitor': drawCapacitor(ctx); break;
    case 'Inductor': drawInductor(ctx); break;
    case 'Diode': drawDiode(ctx, color, 0); break;
    case 'LED': drawLED(ctx, color, bright); break;
    case 'Ground': drawGround(ctx, selected); break;
    case 'Junction': drawJunction(ctx, selected); break;
    case 'Switch': drawSwitch(ctx, !!comp.closed); break;
    case 'Button': drawButton(ctx, !!comp.closed); break;
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
    ctx.font = FONT_LABEL;
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
    ctx.font = FONT_VALUE;
    ctx.fillStyle = COLORS.textValue;
    if (landscape) {
      ctx.fillText(formatValue(comp.value, def.unit), comp.x, comp.y + 26);
    } else {
      ctx.textAlign = 'left';
      ctx.fillText(formatValue(comp.value, def.unit), comp.x + 30, comp.y);
      ctx.textAlign = 'center';
    }
  }

  // Live readings: text only (no opaque background) placed away from leads
  if (showResults && comp.voltage !== undefined) {
    const badgeX = comp.x + (landscape ? 0 : 56);
    const badgeY = comp.y + (landscape ? 46 : 22);

    ctx.font = FONT_RESULT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowColor = COLORS.resultHalo;
    ctx.shadowBlur = 4;

    ctx.fillStyle = COLORS.resultV;
    ctx.fillText(`${comp.voltage.toFixed(2)} V`, badgeX, badgeY);
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
    ctx.arc(pos.x, pos.y, isConnected ? PIN_RADIUS : PIN_RADIUS + 0.6, 0, Math.PI * 2);
    if (isConnected) {
      ctx.fillStyle = COLORS.pinConnected;
      ctx.fill();
    } else {
      // Open pin: hollow ring so dangling pins are easy to spot
      ctx.fillStyle = COLORS.compBg;
      ctx.fill();
      ctx.strokeStyle = COLORS.pin;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  }
}

function drawResistor(ctx: CanvasRenderingContext2D) {
  // Leads
  ctx.beginPath();
  ctx.moveTo(-40, 0); ctx.lineTo(-22, 0);
  ctx.moveTo(22, 0); ctx.lineTo(40, 0);
  ctx.stroke();

  // Zig-zag body (ANSI style), 6 peaks across 44 px
  ctx.beginPath();
  ctx.moveTo(-22, 0);
  const amp = 7;
  const pts = [[-18.3, -1], [-11, 1], [-3.7, -1], [3.7, 1], [11, -1], [18.3, 1]];
  for (const [x, s] of pts) ctx.lineTo(x, s * amp);
  ctx.lineTo(22, 0);
  ctx.stroke();
}

function drawVoltageSource(ctx: CanvasRenderingContext2D, _color: string) {
  // Leads
  ctx.beginPath();
  ctx.moveTo(0, -35); ctx.lineTo(0, -20);
  ctx.moveTo(0, 20); ctx.lineTo(0, 35);
  ctx.stroke();

  // Circle
  ctx.beginPath();
  ctx.arc(0, 0, 20, 0, Math.PI * 2);
  ctx.fillStyle = COLORS.sourceFill;
  ctx.fill();
  ctx.stroke();

  // Plus
  const lw = ctx.lineWidth;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(-5, -9); ctx.lineTo(5, -9);
  ctx.moveTo(0, -14); ctx.lineTo(0, -4);
  ctx.stroke();

  // Minus
  ctx.beginPath();
  ctx.moveTo(-5, 9); ctx.lineTo(5, 9);
  ctx.stroke();
  ctx.lineWidth = lw;
}

function drawCurrentSource(ctx: CanvasRenderingContext2D, _color: string) {
  // Leads
  ctx.beginPath();
  ctx.moveTo(0, -35); ctx.lineTo(0, -20);
  ctx.moveTo(0, 20); ctx.lineTo(0, 35);
  ctx.stroke();

  // Circle
  ctx.beginPath();
  ctx.arc(0, 0, 20, 0, Math.PI * 2);
  ctx.fillStyle = COLORS.sourceFill;
  ctx.fill();
  ctx.stroke();

  // Arrow (pointing up = into +)
  const lw = ctx.lineWidth;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(0, 12); ctx.lineTo(0, -12);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(0, -12); ctx.lineTo(-5, -5);
  ctx.moveTo(0, -12); ctx.lineTo(5, -5);
  ctx.stroke();
  ctx.lineWidth = lw;
}

function drawCapacitor(ctx: CanvasRenderingContext2D) {
  // Leads
  ctx.beginPath();
  ctx.moveTo(-30, 0); ctx.lineTo(-6, 0);
  ctx.moveTo(6, 0); ctx.lineTo(30, 0);
  ctx.stroke();

  // Plates
  const lw = ctx.lineWidth;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(-6, -14); ctx.lineTo(-6, 14);
  ctx.moveTo(6, -14); ctx.lineTo(6, 14);
  ctx.stroke();
  ctx.lineWidth = lw;
}

function drawInductor(ctx: CanvasRenderingContext2D) {
  // Leads
  ctx.beginPath();
  ctx.moveTo(-40, 0); ctx.lineTo(-26, 0);
  ctx.moveTo(26, 0); ctx.lineTo(40, 0);
  ctx.stroke();

  // 4 arcs (coil)
  ctx.beginPath();
  for (let i = 0; i < 4; i++) {
    ctx.arc(-19.5 + i * 13, 0, 6.5, Math.PI, 0);
  }
  ctx.stroke();
}

function drawDiode(ctx: CanvasRenderingContext2D, color: string, bright: number) {
  // Leads
  ctx.beginPath();
  ctx.moveTo(-30, 0); ctx.lineTo(-12, 0);
  ctx.moveTo(12, 0); ctx.lineTo(30, 0);
  ctx.stroke();

  // Triangle (filled); LEDs fill with their emission color when lit
  ctx.beginPath();
  ctx.moveTo(-12, -10);
  ctx.lineTo(-12, 10);
  ctx.lineTo(12, 0);
  ctx.closePath();
  if (bright > 0) {
    ctx.fillStyle = `rgba(${COLORS.ledHalo},${(0.25 + 0.6 * Math.min(1, bright)).toFixed(3)})`;
    ctx.fill();
  } else {
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.15;
    ctx.fill();
    ctx.globalAlpha = 1;
  }
  ctx.stroke();

  // Bar
  const lw = ctx.lineWidth;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(12, -10); ctx.lineTo(12, 10);
  ctx.stroke();
  ctx.lineWidth = lw;
}

function drawLED(ctx: CanvasRenderingContext2D, color: string, bright: number) {
  drawDiode(ctx, color, bright);

  // Light emission arrows — tinted and brighter as the current rises
  const lw = ctx.lineWidth;
  ctx.lineWidth = 1.5;
  const prev = ctx.strokeStyle;
  if (bright > 0) {
    ctx.strokeStyle = COLORS.ledOn;
    ctx.globalAlpha = 0.5 + 0.5 * Math.min(1, bright);
  }
  ctx.beginPath();
  ctx.moveTo(3, -14); ctx.lineTo(9, -22);
  ctx.moveTo(9, -22); ctx.lineTo(5, -19);
  ctx.moveTo(9, -22); ctx.lineTo(9, -17);
  ctx.moveTo(9, -10); ctx.lineTo(15, -18);
  ctx.moveTo(15, -18); ctx.lineTo(11, -15);
  ctx.moveTo(15, -18); ctx.lineTo(15, -13);
  ctx.stroke();
  ctx.globalAlpha = 1;
  ctx.strokeStyle = prev;
  ctx.lineWidth = lw;
}

function drawGround(ctx: CanvasRenderingContext2D, selected: boolean) {
  // Draw in component-local coords. Pin is at (0, -25) (top), so the symbol
  // has a longer stem then descends from y=-2 (top bar) to y=+10 (smallest bar).
  const stroke = selected ? COLORS.componentSelected : COLORS.ground;
  ctx.strokeStyle = stroke;
  ctx.lineCap = 'round';

  ctx.beginPath();
  ctx.moveTo(0, -25);
  ctx.lineTo(0, -2);
  ctx.stroke();

  const bars: Array<[number, number]> = [[12, -2], [8, 4], [4, 10]];
  ctx.beginPath();
  for (const [w, y] of bars) {
    ctx.moveTo(-w, y);
    ctx.lineTo(w, y);
  }
  ctx.stroke();
}

function drawJunction(ctx: CanvasRenderingContext2D, selected: boolean) {
  const fill = selected ? COLORS.componentSelected : COLORS.wire;
  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.arc(0, 0, 4, 0, Math.PI * 2);
  ctx.fill();
}

function dot(ctx: CanvasRenderingContext2D, x: number, y: number, r = 2.5) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
}

function drawSwitch(ctx: CanvasRenderingContext2D, closed: boolean) {
  // SPDT layout. Pins (relative): com=(-30,0), a=(30,-10), b=(30,10).
  ctx.beginPath();
  ctx.moveTo(-30, 0);  ctx.lineTo(-14, 0);     // com
  ctx.moveTo(14, -10); ctx.lineTo(30, -10);    // a
  ctx.moveTo(14, 10);  ctx.lineTo(30, 10);     // b
  ctx.stroke();

  dot(ctx, -14, 0);
  dot(ctx, 14, -10);
  dot(ctx, 14, 10);

  // Pivoting blade — connects com to whichever output is currently selected
  const targetY = closed ? 10 : -10;
  ctx.beginPath();
  ctx.moveTo(-14, 0); ctx.lineTo(14, targetY);
  ctx.stroke();
}

function drawButton(ctx: CanvasRenderingContext2D, pressed: boolean) {
  ctx.beginPath();
  ctx.moveTo(-30, 0); ctx.lineTo(-12, 0);
  ctx.moveTo(12, 0); ctx.lineTo(30, 0);
  ctx.stroke();

  dot(ctx, -12, 0);
  dot(ctx, 12, 0);

  // Plate: rests up (open) or drops to touch the contacts (closed)
  const plateY = pressed ? -2 : -10;
  ctx.beginPath();
  ctx.moveTo(-14, plateY); ctx.lineTo(14, plateY);
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(0, plateY); ctx.lineTo(0, plateY - 5);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(0, plateY - 8, 3, 0, Math.PI * 2);
  ctx.stroke();
}

function drawGenericBox(ctx: CanvasRenderingContext2D, label: string, color: string) {
  // Rounded body for custom components
  const x = -25, y = -18, w = 50, h = 36, r = 5;
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y); ctx.closePath();
  ctx.fillStyle = COLORS.sourceFill;
  ctx.fill();
  ctx.stroke();

  ctx.font = FONT_LABEL;
  ctx.fillStyle = color;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, 0, 0);

  ctx.beginPath();
  ctx.moveTo(-40, 0); ctx.lineTo(-25, 0);
  ctx.moveTo(25, 0); ctx.lineTo(40, 0);
  ctx.stroke();
}

// ─── Wires ───────────────────────────────────────────────────────────────────

export interface Rect { minX: number; minY: number; maxX: number; maxY: number }
export interface Segment { p1: Point; p2: Point }

/**
 * Draw a routed wire. `wireColor` (node-voltage color) overrides the neutral
 * wire color; `flowOffset` ≠ 0 animates the current dots along the path.
 */
export function drawWirePath(
  ctx: CanvasRenderingContext2D,
  path: Point[],
  flowOffset = 0,
  selected = false,
  wireColor?: string,
) {
  const body = selected ? COLORS.componentSelected : (wireColor ?? COLORS.wire);

  // Glow underlay
  ctx.strokeStyle = selected ? COLORS.componentGlow : (wireColor ? withAlpha(wireColor, 0.22) : COLORS.wireGlow);
  ctx.lineWidth = selected ? 9 : 7;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.setLineDash([]);
  drawPath(ctx, path);

  // Wire body
  ctx.strokeStyle = body;
  ctx.lineWidth = selected ? 2.8 : 2.3;
  drawPath(ctx, path);

  if (flowOffset !== 0) {
    drawWireFlowMarkers(ctx, path, flowOffset);
  }
}

function withAlpha(color: string, alpha: number): string {
  const m = /^rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(color);
  if (m) return `rgba(${m[1]},${m[2]},${m[3]},${alpha})`;
  const h = /^#([0-9a-f]{6})$/i.exec(color);
  if (h) {
    const n = parseInt(h[1], 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
  }
  return color;
}

/** Glowing round dots moving along the wire (EveryCircuit-style current). */
function drawWireFlowMarkers(
  ctx: CanvasRenderingContext2D,
  path: Point[],
  flowOffset: number,
) {
  const SPACING = 24;
  const R = 2.7;
  const HALO = 6.5;

  let total = 0;
  const lens: number[] = [0];
  for (let i = 1; i < path.length; i++) {
    total += Math.abs(path[i].x - path[i - 1].x) + Math.abs(path[i].y - path[i - 1].y);
    lens.push(total);
  }
  if (total < SPACING * 0.5) return;

  const phase = ((flowOffset % SPACING) + SPACING) % SPACING;

  // Halo pass then core pass (two fills instead of per-dot shadowBlur: cheap)
  const pts: Point[] = [];
  for (let s = phase; s <= total; s += SPACING) {
    if (s < R || s > total - R) continue;
    let seg = 0;
    while (seg < lens.length - 2 && lens[seg + 1] < s) seg++;
    const a = path[seg];
    const b = path[seg + 1];
    const segLen = lens[seg + 1] - lens[seg];
    if (segLen <= 0) continue;
    const t = (s - lens[seg]) / segLen;
    pts.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  }
  if (pts.length === 0) return;

  ctx.fillStyle = COLORS.dotHalo;
  ctx.beginPath();
  for (const p of pts) { ctx.moveTo(p.x + HALO, p.y); ctx.arc(p.x, p.y, HALO, 0, Math.PI * 2); }
  ctx.fill();

  ctx.fillStyle = COLORS.dot;
  ctx.beginPath();
  for (const p of pts) { ctx.moveTo(p.x + R, p.y); ctx.arc(p.x, p.y, R, 0, Math.PI * 2); }
  ctx.fill();
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
  ctx.lineWidth = 2.2;
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
