import { type PlacedComponent, type Point, getComponentDef, formatValue, getPinWorldPos, GRID_SIZE } from './types';

const PIN_RADIUS = 4;
const PIN_HIT_RADIUS = 12;

const COLORS = {
  bg: '#111827',
  gridDot: '#1e293b',
  wire: '#22d3ee',
  wireShadow: 'rgba(34,211,238,0.25)',
  component: '#e2e8f0',
  componentSelected: '#22d3ee',
  componentGlow: 'rgba(34,211,238,0.35)',
  pin: '#94a3b8',
  pinConnected: '#22d3ee',
  pinHover: '#f472b6',
  pinHoverGlow: 'rgba(244,114,182,0.4)',
  ground: '#f87171',
  text: '#94a3b8',
  textLabel: '#cbd5e1',
  textValue: '#fbbf24',
  resultBg: 'rgba(15,23,42,0.85)',
  resultV: '#22d3ee',
  resultI: '#34d399',
  wirePreview: 'rgba(34,211,238,0.4)',
  compBg: '#111827',
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
  if (isVertical) {
    ctx.fillRect(-22, -22, 44, 44);
  } else {
    ctx.fillRect(-24, -16, 48, 32);
  }
  ctx.restore();
}

// ─── Components ──────────────────────────────────────────────────────────────

export function drawComponent(ctx: CanvasRenderingContext2D, comp: PlacedComponent, selected: boolean, showResults: boolean, connectedPins: Set<string>) {
  const color = selected ? COLORS.componentSelected : COLORS.component;

  // Glow for selected
  if (selected) {
    ctx.save();
    ctx.translate(comp.x, comp.y);
    ctx.shadowColor = COLORS.componentGlow;
    ctx.shadowBlur = 16;
    ctx.strokeStyle = COLORS.componentSelected;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(0, 0, 26, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
    ctx.shadowBlur = 0;
    ctx.shadowColor = 'transparent';
  }

  ctx.save();
  ctx.translate(comp.x, comp.y);
  ctx.rotate((comp.rotation * Math.PI) / 180);

  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 2.5;
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

  // Labels positioned based on rotation
  const isHorizontal = comp.rotation === 0 || comp.rotation === 180;
  const def = getComponentDef(comp.type);

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  // Component label
  ctx.font = 'bold 11px -apple-system, BlinkMacSystemFont, sans-serif';
  ctx.fillStyle = COLORS.textLabel;
  if (isHorizontal) {
    ctx.fillText(comp.label, comp.x, comp.y - 22);
  } else {
    ctx.fillText(comp.label, comp.x - 28, comp.y);
  }

  // Value
  if (def?.unit && comp.value) {
    ctx.font = '10px "SF Mono", "Fira Code", monospace';
    ctx.fillStyle = COLORS.textValue;
    if (isHorizontal) {
      ctx.fillText(formatValue(comp.value, def.unit), comp.x, comp.y + 22);
    } else {
      ctx.fillText(formatValue(comp.value, def.unit), comp.x + 28, comp.y);
    }
  }

  // Draw results as floating badge
  if (showResults && comp.voltage !== undefined) {
    const badgeX = comp.x + (isHorizontal ? 52 : 0);
    const badgeY = comp.y + (isHorizontal ? 0 : 40);

    // Badge background
    ctx.fillStyle = COLORS.resultBg;
    const bw = 72;
    const bh = 28;
    const rx = badgeX - bw / 2;
    const ry = badgeY - bh / 2;
    ctx.beginPath();
    ctx.roundRect(rx, ry, bw, bh, 4);
    ctx.fill();

    ctx.font = '9px "SF Mono", monospace';
    ctx.textAlign = 'center';
    ctx.fillStyle = COLORS.resultV;
    ctx.fillText(`${comp.voltage.toFixed(2)}V`, badgeX, badgeY - 5);
    ctx.fillStyle = COLORS.resultI;
    ctx.fillText(`${formatValue(comp.current ?? 0, 'A')}`, badgeX, badgeY + 7);
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

export function drawWire(ctx: CanvasRenderingContext2D, from: Point, to: Point) {
  const path = routeWire(from, to);

  // Glow
  ctx.strokeStyle = COLORS.wireShadow;
  ctx.lineWidth = 6;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  drawPath(ctx, path);

  // Wire
  ctx.strokeStyle = COLORS.wire;
  ctx.lineWidth = 2.5;
  drawPath(ctx, path);
}

export function drawWirePreview(ctx: CanvasRenderingContext2D, from: Point, to: Point) {
  const path = routeWire(from, to);

  ctx.strokeStyle = COLORS.wirePreview;
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.setLineDash([8, 5]);
  drawPath(ctx, path);
  ctx.setLineDash([]);
}

function routeWire(from: Point, to: Point): Point[] {
  const dx = to.x - from.x;
  const dy = to.y - from.y;

  // If aligned, straight line
  if (Math.abs(dx) < 2) return [from, to];
  if (Math.abs(dy) < 2) return [from, to];

  // L-shape: go horizontal first then vertical, or vice versa
  // Choose based on which makes a cleaner path
  if (Math.abs(dx) >= Math.abs(dy)) {
    // Horizontal first
    const mid = { x: to.x, y: from.y };
    return [from, mid, to];
  } else {
    // Vertical first
    const mid = { x: from.x, y: to.y };
    return [from, mid, to];
  }
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
