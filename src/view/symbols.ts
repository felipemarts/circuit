/**
 * Schematic symbol registry for the share-link viewer. Keyed by component
 * `type` (built-in engine types, logic IC catalog ids, logic primitives,
 * op-amp / comparator type names, and a generic labelled box for anything
 * else — MCU boards, VHDL blocks, custom definitions).
 *
 * Geometry is in symbol-local coordinates, unrotated, on a 10 px grid:
 * every pin sits on the symbol's bounding box edge at a grid point, with a
 * `side` the layout uses to decide signal flow (inputs left, outputs right,
 * supplies top, returns bottom). `svg()` returns the body markup; wire stubs
 * from each pin to the body are drawn by the renderer so they take the net
 * voltage color.
 */
import type { CircuitComponent } from '../doc/types';
import { findIcDef } from '../mixed/ics';
import { LOGIC_PRIMITIVE_TYPES } from '../mixed/device';
import { PART_DEFS } from '../digital/parts';
import { isZener, valueLabel } from './format';

/** Grid pitch (px). All symbol coordinates are multiples of this. */
export const G = 10;

export type Side = 'l' | 'r' | 't' | 'b';

export interface PinGeom {
  name: string;
  /** Position of the wire attachment point (symbol-local, unrotated). */
  x: number;
  y: number;
  side: Side;
  /** Where the stub meets the body (symbol-local). */
  bx: number;
  by: number;
  /** Datasheet pin number (ICs). */
  number?: number;
  /** Logical role used by the layout. */
  role: 'in' | 'out' | 'vcc' | 'gnd' | 'passive' | 'analog';
}

export type SymbolKind = 'two' | 'source' | 'transistor' | 'switch' | 'ic' | 'gate' | 'box' | 'opamp';

export interface SymbolGeom {
  kind: SymbolKind;
  /** Bounding box (symbol-local, unrotated): x in [-w/2, w/2], y in [-h/2, h/2]. Pins lie on its edge. */
  w: number;
  h: number;
  pins: PinGeom[];
  /** Body markup (unrotated). */
  svg: string;
  /** Primary label (id) and secondary label (value / part). */
  label: string;
  value?: string;
  /** Pin names rendered inside the body (ICs, boxes). */
  showPinNames: boolean;
}

const SEMI_TYPES = new Set(['Diode', 'LED', 'NPN', 'PNP', 'NMOS', 'PMOS']);
export const TWO_TERMINAL_TYPES = new Set(['Resistor', 'Capacitor', 'Inductor', 'Diode', 'LED', 'Button']);
export const SOURCE_TYPES = new Set(['VoltageSource', 'CurrentSource']);
const OPAMP_TYPES = new Set(['OpAmp', 'IdealOpAmp', 'Comparator', 'IdealComparator']);
const GATE_SHAPES = new Set(['Buf', 'Not', 'And', 'Or', 'Nand', 'Nor', 'Xor', 'Xnor']);

const pin = (name: string, x: number, y: number, side: Side, bx: number, by: number, role: PinGeom['role'] = 'passive', number?: number): PinGeom => ({
  name, x, y, side, bx, by, role, ...(number !== undefined ? { number } : {}),
});

const S = 'class="sym"'; // stroke body
const F = 'class="sym sym-fill"'; // filled body

// ─── two-terminal bodies (horizontal, pins at ±30) ───────────────────────────

const RESISTOR = `<path ${S} d="M-20 0l3-8 6 16 6-16 6 16 6-16 6 16 3-8"/>`;
const CAPACITOR = `<path ${S} d="M-20 0h17M3 0h17"/><path ${S} stroke-width="2.4" d="M-3 -12v24M3 -12v24"/>`;
const INDUCTOR = `<path ${S} d="M-20 0a5 5 0 0 1 10 0a5 5 0 0 1 10 0a5 5 0 0 1 10 0a5 5 0 0 1 10 0"/>`;
const DIODE = `<path ${S} d="M-20 0h8M12 0h8"/><path ${F} d="M-12 -10v20l24 -10z"/><path ${S} stroke-width="2.2" d="M12 -10v20"/>`;
const ZENER = `<path ${S} d="M-20 0h8M12 0h8"/><path ${F} d="M-12 -10v20l24 -10z"/><path ${S} stroke-width="2.2" d="M12 -10v20"/><path ${S} d="M12 -10l-5 -4M12 10l5 4"/>`;
const LED = `<path ${S} d="M-20 0h8M12 0h8"/><path ${F} d="M-12 -10v20l24 -10z"/><path ${S} stroke-width="2.2" d="M12 -10v20"/>` +
  `<circle class="led-glow" cx="0" cy="0" r="22"/>` +
  `<path ${S} class="sym led-ray" d="M-4 -14l8 -9M4 -23h-5M4 -23v5M6 -12l8 -9M14 -21h-5M14 -21v5"/>`;
const BUTTON = `<path ${S} d="M-20 0h8M12 0h8"/><circle ${F} cx="-12" cy="0" r="2"/><circle ${F} cx="12" cy="0" r="2"/><path ${S} d="M-14 -8h28M0 -8v-6"/><path ${S} d="M-6 -14h12"/>`;

const SOURCE_V = `<circle ${S} cx="0" cy="0" r="16"/><path ${S} d="M0 -10v8M-4 -6h8M-4 6h8"/>`;
const SOURCE_I = `<circle ${S} cx="0" cy="0" r="16"/><path ${S} d="M0 9v-18M-5 -4l5 -5 5 5"/>`;
const WAVE_SIN = `<path class="sym wave" d="M-8 0q4 -9 8 0t8 0" transform="translate(0,-26)"/>`;
const WAVE_PULSE = `<path class="sym wave" d="M-9 4v-8h6v8h6v-8h6" transform="translate(0,-26)"/>`;
const WAVE_PWM = `<path class="sym wave" d="M-9 4v-8h3v8h7v-8h2v8h6" transform="translate(0,-26)"/>`;
const WAVE_PWL = `<path class="sym wave" d="M-9 4l5 -8 4 5 4 -3 5 6" transform="translate(0,-26)"/>`;
const WAVE_AC = `<path class="sym wave" d="M-8 0q4 -7 8 0t8 0" transform="translate(0,-26)"/><text class="sym-txt wave-txt" x="12" y="-23">~</text>`;

function waveGlyph(params: Record<string, unknown>): string {
  if (params.sin) return WAVE_SIN;
  if (params.pulse) return WAVE_PULSE;
  if (params.pwm) return WAVE_PWM;
  if (params.pwl) return WAVE_PWL;
  if (params.ac) return WAVE_AC;
  return '';
}

// ─── transistors (b/g left, c/d top, e/s bottom; pins at x = 10 on top/bottom) ─

const NPN = `<circle ${S} cx="4" cy="0" r="17"/><path ${S} d="M-8 0h4"/><path ${S} stroke-width="2.4" d="M-4 -11v22"/><path ${S} d="M-4 -5l14 -9M-4 5l14 9"/><path ${F} d="M10 14l-7 -3 2 -4z"/><path ${S} d="M10 -14v-4M10 14v4"/>`;
const PNP = `<circle ${S} cx="4" cy="0" r="17"/><path ${S} d="M-8 0h4"/><path ${S} stroke-width="2.4" d="M-4 -11v22"/><path ${S} d="M-4 -5l14 -9M-4 5l14 9"/><path ${F} d="M1 -8l6 1 -2 4z"/><path ${S} d="M10 -14v-4M10 14v4"/>`;
const NMOS = `<circle ${S} cx="4" cy="0" r="17"/><path ${S} d="M-8 0h2"/><path ${S} stroke-width="2" d="M-6 -10v20"/><path ${S} stroke-width="2.2" d="M-1 -12v6M-1 -3v6M-1 6v6"/><path ${S} d="M-1 -9h11v-9M-1 9h11v9M-1 0h11v9"/><path ${F} d="M5 -3l5 3 -5 3z"/>` +
  `<path class="sym body-diode" d="M14 -12v6M14 6v6M11 -6h6M11 6h6M14 6l-3 -6 6 0z"/>`;
const PMOS = `<circle ${S} cx="4" cy="0" r="17"/><path ${S} d="M-8 0h1"/><circle ${S} cx="-5" cy="0" r="2"/><path ${S} stroke-width="2.2" d="M-1 -12v6M-1 -3v6M-1 6v6"/><path ${S} d="M-1 -9h11v-9M-1 9h11v9M-1 0h11v-9"/><path ${F} d="M10 -3l-5 3 5 3z"/>` +
  `<path class="sym body-diode" d="M14 -12v6M14 6v6M11 -6h6M11 6h6M14 -6l-3 6 6 0z"/>`;

const SWITCH = `<path ${S} d="M-20 0h6"/><circle ${F} cx="-12" cy="0" r="2"/><circle ${F} cx="12" cy="-10" r="2"/><circle ${F} cx="12" cy="10" r="2"/><path ${S} d="M14 -10h6M14 10h6"/>`;
const switchBlade = (closedToA: boolean): string => (closedToA ? `<path ${S} stroke-width="2" d="M-12 0l24 -10"/>` : `<path ${S} stroke-width="2" d="M-12 0l24 10"/>`);

// ─── IC / box helpers ────────────────────────────────────────────────────────

interface BoxPin {
  name: string;
  side: Side;
  role: PinGeom['role'];
  number?: number;
}

const ROW = 2 * G;

function boxSymbol(kind: SymbolKind, c: CircuitComponent, pinsIn: BoxPin[], title: string, subtitle?: string, minW = 12 * G): SymbolGeom {
  const left = pinsIn.filter(p => p.side === 'l');
  const right = pinsIn.filter(p => p.side === 'r');
  const top = pinsIn.filter(p => p.side === 't');
  const bottom = pinsIn.filter(p => p.side === 'b');
  const rows = Math.max(left.length, right.length, 1);
  const longest = Math.max(0, ...pinsIn.filter(p => p.side === 'l' || p.side === 'r').map(p => p.name.length));
  const bodyW = Math.max(minW, Math.ceil((longest * 6.2 * 2 + 44 + Math.max(title.length, (subtitle ?? '').length) * 7) / ROW) * ROW, (Math.max(top.length, bottom.length) + 1) * ROW);
  const bodyH = Math.max((rows + 1) * ROW, 4 * G + (top.length ? ROW : 0) + (bottom.length ? ROW : 0));
  const w = bodyW + 2 * G;
  const h = bodyH + 2 * G;
  const hw = bodyW / 2;
  const hh = bodyH / 2;
  const pins: PinGeom[] = [];
  const place = (list: BoxPin[], side: Side) => {
    const n = list.length;
    list.forEach((p, i) => {
      if (side === 'l' || side === 'r') {
        const y = -((n - 1) * ROW) / 2 + i * ROW;
        const sx = side === 'l' ? -hw - G : hw + G;
        pins.push(pin(p.name, sx, y, side, side === 'l' ? -hw : hw, y, p.role, p.number));
      } else {
        const x = -((n - 1) * ROW) / 2 + i * ROW;
        const sy = side === 't' ? -hh - G : hh + G;
        pins.push(pin(p.name, x, sy, side, x, side === 't' ? -hh : hh, p.role, p.number));
      }
    });
  };
  place(left, 'l');
  place(right, 'r');
  place(top, 't');
  place(bottom, 'b');
  // Snap pin coordinates to the grid (odd row counts give half-row offsets).
  for (const p of pins) {
    p.x = Math.round(p.x / G) * G;
    p.y = Math.round(p.y / G) * G;
    p.bx = Math.round(p.bx / G) * G;
    p.by = Math.round(p.by / G) * G;
  }
  let svg = `<rect class="sym ic-body" x="${-hw}" y="${-hh}" width="${bodyW}" height="${bodyH}" rx="3"/>`;
  svg += `<text class="sym-txt ic-title" x="0" y="${subtitle ? -2 : 4}" text-anchor="middle">${esc(title)}</text>`;
  if (subtitle) svg += `<text class="sym-txt ic-sub" x="0" y="12" text-anchor="middle">${esc(subtitle)}</text>`;
  for (const p of pins) {
    if (p.side === 'l') svg += `<text class="sym-txt pin-name" x="${p.bx + 4}" y="${p.y + 3.5}">${esc(p.name)}</text>`;
    else if (p.side === 'r') svg += `<text class="sym-txt pin-name" x="${p.bx - 4}" y="${p.y + 3.5}" text-anchor="end">${esc(p.name)}</text>`;
    else if (p.side === 't') svg += `<text class="sym-txt pin-name" x="${p.x}" y="${p.by + 10}" text-anchor="middle">${esc(p.name)}</text>`;
    else svg += `<text class="sym-txt pin-name" x="${p.x}" y="${p.by - 4}" text-anchor="middle">${esc(p.name)}</text>`;
    if (p.number !== undefined) {
      const nx = p.side === 'l' ? p.bx - 5 : p.side === 'r' ? p.bx + 5 : p.x + (p.side === 't' ? 4 : 4);
      const ny = p.side === 'l' || p.side === 'r' ? p.y - 3 : p.side === 't' ? p.by - 4 : p.by + 9;
      svg += `<text class="sym-txt pin-num" x="${nx}" y="${ny}" text-anchor="${p.side === 'l' ? 'end' : 'start'}">${p.number}</text>`;
    }
    // Inversion bubble for active-low pins (~OE, QN…).
    if (/^~|^Q?N$|^\/|^!/.test(p.name) && (p.side === 'l' || p.side === 'r')) {
      const cx = p.side === 'l' ? p.bx - 3 : p.bx + 3;
      svg += `<circle class="sym" cx="${cx}" cy="${p.y}" r="2.6"/>`;
    }
    if (/^(CLK|CLOCK|SRCLK|RCLK|clk|CP)$/i.test(p.name) && p.side === 'l') {
      svg += `<path class="sym" d="M${p.bx} ${p.y - 5}l6 5 -6 5"/>`;
    }
  }
  return { kind, w, h, pins, svg, label: c.id, value: valueLabel(c), showPinNames: true };
}

export function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ─── role heuristics for pins we only know by name (future components) ──────

const SUPPLY_TOP = /^(vcc|vdd|v\+|vp|vs\+|avcc|5v|3v3|3\.3v|vin|v_?pos|vbat|vref)$/i;
const SUPPLY_BOTTOM = /^(gnd|vss|vee|v-|vn|vs-|agnd|dgnd|v_?neg|0v)$/i;
const INPUT_LIKE = /(^|[^a-z])(in|inp|inn|d|clk|clock|rst|reset|en|enable|a|b|sel|cs|rx|sck|miso|set|ce|oe|we|cp|trig|thres|cont|ctrl)\d*$/i;
const OUTPUT_LIKE = /(^|[^a-z])(out|q|qn|y|tx|do|miso|carry|disch|ready|irq)\d*$/i;

function genericSides(names: string[]): BoxPin[] {
  const out: BoxPin[] = [];
  const rest: string[] = [];
  for (const n of names) {
    if (SUPPLY_TOP.test(n)) out.push({ name: n, side: 't', role: 'vcc' });
    else if (SUPPLY_BOTTOM.test(n)) out.push({ name: n, side: 'b', role: 'gnd' });
    else rest.push(n);
  }
  const ins = rest.filter(n => INPUT_LIKE.test(n) && !OUTPUT_LIKE.test(n));
  const outs = rest.filter(n => OUTPUT_LIKE.test(n) && !INPUT_LIKE.test(n));
  const unknown = rest.filter(n => !ins.includes(n) && !outs.includes(n));
  // Balance unknown pins between the two sides, keeping their order.
  const target = Math.ceil((ins.length + outs.length + unknown.length) / 2);
  const leftExtra = Math.max(0, target - ins.length);
  unknown.forEach((n, i) => (i < leftExtra ? ins.push(n) : outs.push(n)));
  for (const n of ins) out.push({ name: n, side: 'l', role: 'in' });
  for (const n of outs) out.push({ name: n, side: 'r', role: 'out' });
  return out;
}

// ─── gate shapes ─────────────────────────────────────────────────────────────

function gateSymbol(c: CircuitComponent, inputs: string[], outputs: string[]): SymbolGeom {
  const type = c.type;
  const n = Math.max(inputs.length, 1);
  const h = Math.max(4 * G, (n + 1) * ROW);
  const w = 6 * G;
  const pins: PinGeom[] = [];
  inputs.forEach((name, i) => {
    const y = Math.round((-((n - 1) * ROW) / 2 + i * ROW) / G) * G;
    pins.push(pin(name, -30, y, 'l', -20, y, 'in'));
  });
  outputs.forEach((name, i) => {
    const y = Math.round((-((outputs.length - 1) * ROW) / 2 + i * ROW) / G) * G;
    pins.push(pin(name, 30, y, 'r', 20, y, 'out'));
  });
  const hh = h / 2 - 4;
  let body = '';
  const inverted = type === 'Not' || type === 'Nand' || type === 'Nor' || type === 'Xnor';
  if (type === 'Buf' || type === 'Not') {
    body = `<path ${S} d="M-16 ${-hh}v${2 * hh}l30 ${-hh}z"/>`;
  } else if (type === 'And' || type === 'Nand') {
    body = `<path ${S} d="M-18 ${-hh}h14a${hh} ${hh} 0 0 1 0 ${2 * hh}h-14z"/>`;
  } else if (type === 'Or' || type === 'Nor') {
    body = `<path ${S} d="M-20 ${-hh}q8 ${hh} 0 ${2 * hh}h12q14 0 24 ${-hh}q-10 ${-hh} -24 ${-hh}z"/>`;
  } else {
    body = `<path ${S} d="M-16 ${-hh}q8 ${hh} 0 ${2 * hh}h10q14 0 24 ${-hh}q-10 ${-hh} -24 ${-hh}z"/><path ${S} d="M-21 ${-hh}q8 ${hh} 0 ${2 * hh}"/>`;
  }
  if (inverted) body += `<circle ${S} cx="19" cy="0" r="3"/>`;
  body += `<text class="sym-txt gate-txt" x="-2" y="4" text-anchor="middle">${esc(type.toUpperCase())}</text>`;
  return { kind: 'gate', w, h, pins, svg: body, label: c.id, value: valueLabel(c), showPinNames: false };
}

// ─── op-amp / comparator triangle ────────────────────────────────────────────

function opampSymbol(c: CircuitComponent, names: string[]): SymbolGeom {
  const pins: PinGeom[] = [];
  const rest: string[] = [];
  let plus: string | undefined;
  let minus: string | undefined;
  let out: string | undefined;
  let vp: string | undefined;
  let vn: string | undefined;
  for (const n of names) {
    const l = n.toLowerCase();
    if (!plus && /^(in\+|inp|\+|p|in_p|vin\+|non|noninv|ip)$/.test(l)) plus = n;
    else if (!minus && /^(in-|inn|-|n|in_n|vin-|inv|im)$/.test(l)) minus = n;
    else if (!out && /^(out|o|vout|y)$/.test(l)) out = n;
    else if (!vp && /^(v\+|vcc|vdd|vp|vs\+|vpos)$/.test(l)) vp = n;
    else if (!vn && /^(v-|vee|vss|vn|vs-|vneg|gnd)$/.test(l)) vn = n;
    else rest.push(n);
  }
  const leftovers = [...rest];
  plus ??= leftovers.shift();
  minus ??= leftovers.shift();
  out ??= leftovers.shift();
  const h = 6 * G;
  const w = 8 * G;
  if (plus) pins.push(pin(plus, -40, -10, 'l', -24, -10, 'in'));
  if (minus) pins.push(pin(minus, -40, 10, 'l', -24, 10, 'in'));
  if (out) pins.push(pin(out, 40, 0, 'r', 24, 0, 'out'));
  if (vp) pins.push(pin(vp, 0, -30, 't', 0, -12, 'vcc'));
  if (vn) pins.push(pin(vn, 0, 30, 'b', 0, 12, 'gnd'));
  leftovers.forEach((n, i) => pins.push(pin(n, 40, 20 + i * 0, 'r', 24, 10, 'analog')));
  const comparator = /Comparator/.test(c.type);
  let svg = `<path ${S} d="M-24 -24v48l48 -24z"/>`;
  svg += `<text class="sym-txt gate-txt" x="-18" y="-6">+</text><text class="sym-txt gate-txt" x="-18" y="15">−</text>`;
  if (comparator) svg += `<path class="sym" d="M-8 6h6v-10h6"/>`;
  return { kind: 'opamp', w, h, pins, svg, label: c.id, value: valueLabel(c) ?? (typeof c.params.part === 'string' ? c.params.part : c.type), showPinNames: false };
}

// ─── registry ────────────────────────────────────────────────────────────────

function twoTerminal(c: CircuitComponent, a: string, b: string, body: string): SymbolGeom {
  return {
    kind: 'two',
    w: 6 * G,
    h: 2 * G,
    pins: [pin(a, -30, 0, 'l', -20, 0), pin(b, 30, 0, 'r', 20, 0)],
    svg: body,
    label: c.id,
    value: valueLabel(c),
    showPinNames: false,
  };
}

function sourceSymbol(c: CircuitComponent): SymbolGeom {
  const isV = c.type === 'VoltageSource';
  return {
    kind: 'source',
    w: 4 * G,
    h: 6 * G,
    pins: [pin('+', 0, -30, 't', 0, -16, 'out'), pin('-', 0, 30, 'b', 0, 16, 'gnd')],
    svg: (isV ? SOURCE_V : SOURCE_I) + waveGlyph(c.params),
    label: c.id,
    value: valueLabel(c),
    showPinNames: false,
  };
}

function transistorSymbol(c: CircuitComponent): SymbolGeom {
  const bjt = c.type === 'NPN' || c.type === 'PNP';
  const hasBulk = !bjt && 'b' in c.pins;
  const w = hasBulk ? 8 * G : 6 * G;
  const pins: PinGeom[] = [];
  if (c.type === 'NPN') pins.push(pin('b', -30, 0, 'l', -8, 0, 'in'), pin('c', 10, -30, 't', 10, -18, 'analog'), pin('e', 10, 30, 'b', 10, 18, 'analog'));
  else if (c.type === 'PNP') pins.push(pin('b', -30, 0, 'l', -8, 0, 'in'), pin('e', 10, -30, 't', 10, -18, 'analog'), pin('c', 10, 30, 'b', 10, 18, 'analog'));
  else if (c.type === 'NMOS') pins.push(pin('g', -30, 0, 'l', -8, 0, 'in'), pin('d', 10, -30, 't', 10, -18, 'analog'), pin('s', 10, 30, 'b', 10, 18, 'analog'));
  else pins.push(pin('g', -30, 0, 'l', -8, 0, 'in'), pin('s', 10, -30, 't', 10, -18, 'analog'), pin('d', 10, 30, 'b', 10, 18, 'analog'));
  if (hasBulk) pins.push(pin('b', 40, 0, 'r', 17, 0, 'analog'));
  const body = c.type === 'NPN' ? NPN : c.type === 'PNP' ? PNP : c.type === 'NMOS' ? NMOS : PMOS;
  return { kind: 'transistor', w, h: 6 * G, pins, svg: body, label: c.id, value: valueLabel(c) ?? c.type, showPinNames: false };
}

function icSymbol(c: CircuitComponent): SymbolGeom | undefined {
  const def = findIcDef(c.type);
  if (!def) return undefined;
  const names = Object.keys(c.pins);
  const byName = new Map(def.pins.map(p => [p.name, p] as const));
  const boxPins: BoxPin[] = [];
  const ordered = [...names].sort((a, b) => (byName.get(a)?.number ?? 0) - (byName.get(b)?.number ?? 0));
  for (const name of ordered) {
    const p = byName.get(name);
    let role = p?.role ?? 'analog';
    // NE555: the discharge pin belongs to the timing network on the trigger side.
    if (def.kind === 'timer' && name === 'DISCH') role = 'analog';
    let side: Side;
    if (role === 'vcc') side = 't';
    else if (role === 'gnd') side = 'b';
    else if (role === 'out') side = 'r';
    else if (role === 'in') side = 'l';
    else side = /^(OUT|Q|Y)/.test(name) ? 'r' : 'l';
    boxPins.push({ name, side, role: role === 'analog' ? 'analog' : role, number: p?.number });
  }
  // NE555: conventional arrangement (TRIG/THRES/CONT/RESET left, OUT/DISCH right).
  if (def.kind === 'timer') {
    const order = ['TRIG', 'THRES', 'CONT', 'RESET'];
    boxPins.sort((a, b) => (a.side === b.side && a.side === 'l' ? order.indexOf(a.name) - order.indexOf(b.name) : 0));
  }
  const geom = boxSymbol('ic', c, boxPins, def.id, def.summary.length <= 16 ? def.summary : undefined, 12 * G);
  geom.value = undefined; // the part id is the box title
  return geom;
}

function primitiveSymbol(c: CircuitComponent): SymbolGeom | undefined {
  const def = PART_DEFS[c.type];
  if (!def) return undefined;
  let layout: { inputs: string[]; outputs: string[] };
  try {
    layout = def.pins(def.normalize(c.params as Record<string, unknown>));
  } catch {
    layout = { inputs: Object.keys(c.pins).filter(n => !/^(y|q|qn|out)/i.test(n)), outputs: Object.keys(c.pins).filter(n => /^(y|q|qn|out)/i.test(n)) };
  }
  const inputs = layout.inputs.filter(n => n in c.pins);
  const outputs = layout.outputs.filter(n => n in c.pins);
  if (GATE_SHAPES.has(c.type)) return gateSymbol(c, inputs, outputs);
  const boxPins: BoxPin[] = [...inputs.map(n => ({ name: n, side: 'l' as Side, role: 'in' as const })), ...outputs.map(n => ({ name: n, side: 'r' as Side, role: 'out' as const }))];
  return boxSymbol('box', c, boxPins, c.type, undefined, 7 * G);
}

export function symbolFor(c: CircuitComponent): SymbolGeom {
  switch (c.type) {
    case 'Resistor':
      return twoTerminal(c, '1', '2', RESISTOR);
    case 'Capacitor':
      return twoTerminal(c, '1', '2', CAPACITOR);
    case 'Inductor':
      return twoTerminal(c, '1', '2', INDUCTOR);
    case 'Button':
      return twoTerminal(c, '1', '2', BUTTON);
    case 'Diode':
      return twoTerminal(c, 'anode', 'cathode', isZener(c) ? ZENER : DIODE);
    case 'LED':
      return twoTerminal(c, 'anode', 'cathode', LED);
    case 'VoltageSource':
    case 'CurrentSource':
      return sourceSymbol(c);
    case 'NPN':
    case 'PNP':
    case 'NMOS':
    case 'PMOS':
      return transistorSymbol(c);
    case 'Switch':
      return {
        kind: 'switch',
        w: 6 * G,
        h: 4 * G,
        pins: [pin('com', -30, 0, 'l', -20, 0, 'in'), pin('a', 30, -10, 'r', 20, -10, 'out'), pin('b', 30, 10, 'r', 20, 10, 'out')],
        svg: SWITCH + switchBlade(c.params.closed !== false),
        label: c.id,
        value: valueLabel(c),
        showPinNames: true,
      };
  }
  if (OPAMP_TYPES.has(c.type) || /op-?amp|comparator/i.test(c.type)) return opampSymbol(c, Object.keys(c.pins));
  if (LOGIC_PRIMITIVE_TYPES.includes(c.type)) {
    const s = primitiveSymbol(c);
    if (s) return s;
  }
  const ic = icSymbol(c);
  if (ic) return ic;
  // Generic labelled box: MCU boards, VHDL blocks, custom definitions, anything new.
  const subtitle = typeof c.params.part === 'string' ? c.params.part : typeof c.params.board === 'string' ? c.params.board : typeof c.params.entity === 'string' ? c.params.entity : undefined;
  return boxSymbol('box', c, genericSides(Object.keys(c.pins)), c.type, subtitle, 10 * G);
}

/** Whether a component type is a semiconductor (for part-id labels). */
export const isSemiconductor = (type: string): boolean => SEMI_TYPES.has(type);
