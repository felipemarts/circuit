/**
 * Footprint library — parametric land patterns for the parts the simulator
 * knows. Geometry follows the KiCad standard libraries (IPC-7351 nominal
 * densities for SMD chips): pad positions and sizes in millimetres, footprint
 * origin at the centre of the pads' bounding box, x right, y up.
 *
 * Fixed names ('AXIAL-0.4', 'TO-92', '0805', 'LED-5MM'…) and parametric
 * families ('DIP-<n>', 'SOIC-<n>', 'HDR-1x<n>', 'HDR-2x<n>', 'TERM-<n>') are
 * looked up case-insensitively by getFootprint(). `circuitsvibe catalog
 * footprints` lists them.
 */
import type { BodyDef, FootprintDef, PadDef, PadShape, PcbTech, SilkShape } from './types';
import { round } from './geometry';
import { UNO_SHIELD } from './uno';

const IN = 2.54;
/** Courtyard margin around pads and body (IPC-7351 nominal: 0.25 mm). */
const MARGIN = 0.25;

const pad = (name: string, x: number, y: number, shape: PadShape, w: number, h: number, drill?: number): PadDef => ({
  name,
  x: round(x),
  y: round(y),
  shape,
  w,
  h,
  ...(drill !== undefined ? { drill } : {}),
});

const box = (x: number, y: number, w: number, h: number): SilkShape => ({
  kind: 'line',
  points: [
    [round(x - w / 2), round(y - h / 2)],
    [round(x + w / 2), round(y - h / 2)],
    [round(x + w / 2), round(y + h / 2)],
    [round(x - w / 2), round(y + h / 2)],
    [round(x - w / 2), round(y - h / 2)],
  ],
});

/** Courtyard: bounding box of pads and bodies plus the margin, rounded outward to 0.01 mm. */
function courtyardOf(pads: PadDef[], body: BodyDef[] = []): FootprintDef['courtyard'] {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const grow = (x1: number, y1: number, x2: number, y2: number) => {
    minX = Math.min(minX, x1);
    minY = Math.min(minY, y1);
    maxX = Math.max(maxX, x2);
    maxY = Math.max(maxY, y2);
  };
  for (const p of pads) grow(p.x - p.w / 2, p.y - p.h / 2, p.x + p.w / 2, p.y + p.h / 2);
  for (const b of body) {
    const [w, h] = b.shape === 'cylinder' && !b.axial ? [b.w, b.w] : [b.w, b.h];
    grow(b.x - w / 2, b.y - h / 2, b.x + w / 2, b.y + h / 2);
  }
  const lo = (v: number) => Math.floor((v - MARGIN) * 100) / 100;
  const hi = (v: number) => Math.ceil((v + MARGIN) * 100) / 100;
  const [x1, y1, x2, y2] = [lo(minX), lo(minY), hi(maxX), hi(maxY)];
  return [{ x: round((x1 + x2) / 2), y: round((y1 + y2) / 2), w: round(x2 - x1), h: round(y2 - y1) }];
}

function fp(name: string, description: string, tech: PcbTech, pads: PadDef[], body: BodyDef[] = [], silk: SilkShape[] = []): FootprintDef {
  return { name, description, tech, pads, courtyard: courtyardOf(pads, body), ...(silk.length ? { silk } : {}), ...(body.length ? { body } : {}) };
}

// ─── through-hole ────────────────────────────────────────────────────────────

/** Axial part lying flat: two pads `pitch` apart along x, a cylinder body between them. */
function axial(name: string, description: string, o: { pitch: number; drill: number; pad: number; len: number; dia: number; names?: [string, string]; color: string; band?: boolean }): FootprintDef {
  const [n1, n2] = o.names ?? ['1', '2'];
  const pads = [pad(n1, -o.pitch / 2, 0, 'rect', o.pad, o.pad, o.drill), pad(n2, o.pitch / 2, 0, 'circle', o.pad, o.pad, o.drill)];
  const body: BodyDef[] = [{ shape: 'cylinder', axial: true, x: 0, y: 0, w: o.len, h: o.dia, height: o.dia, color: o.color }];
  const silk: SilkShape[] = [box(0, 0, o.len, o.dia)];
  if (o.band) {
    const bx = round(-o.len / 2 + o.len * 0.15);
    silk.push({ kind: 'line', points: [[bx, round(-o.dia / 2)], [bx, round(o.dia / 2)]] });
  }
  return fp(name, description, 'tht', pads, body, silk);
}

function radial(name: string, description: string, o: { pitch: number; dia: number; height: number; drill: number; pad: number; color: string; polarized?: boolean }): FootprintDef {
  const pads = [pad('1', -o.pitch / 2, 0, o.polarized ? 'rect' : 'circle', o.pad, o.pad, o.drill), pad('2', o.pitch / 2, 0, 'circle', o.pad, o.pad, o.drill)];
  const body: BodyDef[] = [{ shape: 'cylinder', x: 0, y: 0, w: o.dia, h: o.dia, height: o.height, color: o.color }];
  return fp(name, description, 'tht', pads, body, [{ kind: 'circle', x: 0, y: 0, r: round(o.dia / 2 + 0.12) }]);
}

function led(name: string, dia: number, height: number): FootprintDef {
  const pads = [pad('K', -IN / 2, 0, 'rect', 1.8, 1.8, 0.9), pad('A', IN / 2, 0, 'circle', 1.8, 1.8, 0.9)];
  const body: BodyDef[] = [{ shape: 'cylinder', x: 0, y: 0, w: dia, h: dia, height, color: '#dc2626' }];
  // The flat on the flange marks the cathode (−x).
  const r = round(dia / 2 + 0.3);
  const flat = round(-dia / 2 - 0.3);
  return fp(name, `${dia} mm through-hole LED, 2.54 mm lead pitch (pad K = cathode, square)`, 'tht', pads, body, [
    { kind: 'circle', x: 0, y: 0, r },
    { kind: 'line', points: [[flat, round(-r * 0.75)], [flat, round(r * 0.75)]] },
  ]);
}

/** Inline 3-lead package with leads `pitch` apart along x (TO-92, TO-220, TO-126). */
function inline3(name: string, description: string, o: { pitch: number; drill: number; padW: number; padH: number; body: { w: number; h: number; y: number; height: number }; color: string }): FootprintDef {
  const pads = [1, 2, 3].map(i => pad(String(i), (i - 2) * o.pitch, 0, i === 1 ? 'rect' : 'oval', o.padW, o.padH, o.drill));
  const b = o.body;
  return fp(name, description, 'tht', pads, [{ shape: 'box', x: 0, y: b.y, w: b.w, h: b.h, height: b.height, color: o.color }], [box(0, b.y, b.w, b.h)]);
}

/** Dual in-line: pin 1 top-left, counter-clockwise; rows 7.62 mm (0.3") apart. */
function dip(n: number): FootprintDef {
  const m = n / 2;
  const top = ((m - 1) / 2) * IN;
  const pads: PadDef[] = [];
  for (let k = 0; k < m; k++) pads.push(pad(String(k + 1), -3.81, top - k * IN, k === 0 ? 'rect' : 'circle', 1.6, 1.6, 0.8));
  for (let k = 0; k < m; k++) pads.push(pad(String(m + k + 1), 3.81, -top + k * IN, 'circle', 1.6, 1.6, 0.8));
  const len = round(m * IN - 0.89);
  const silk: SilkShape[] = [box(0, 0, 6.35, len), { kind: 'circle', x: 0, y: round(len / 2), r: 0.6 }];
  return fp(`DIP-${n}`, `${n}-pin dual in-line package, 2.54 mm pitch, 7.62 mm row spacing (pin 1 top-left, square pad)`, 'tht', pads, [
    { shape: 'box', x: 0, y: 0, w: 6.35, h: len, height: 3.3, z: 0.5, color: '#1f2937' },
  ], silk);
}

/** Pin header, 2.54 mm pitch. 1×n runs along x; 2×n is odd pins on the top row, even below. */
function header(rows: 1 | 2, n: number): FootprintDef {
  const pads: PadDef[] = [];
  const x0 = (-(n - 1) / 2) * IN;
  for (let c = 0; c < n; c++) {
    for (let r = 0; r < rows; r++) {
      const num = rows === 1 ? c + 1 : c * 2 + r + 1;
      const y = rows === 1 ? 0 : r === 0 ? IN / 2 : -IN / 2;
      pads.push(pad(String(num), x0 + c * IN, y, num === 1 ? 'rect' : 'circle', 1.7, 1.7, 1.0));
    }
  }
  const w = round(n * IN);
  const h = round(rows * IN);
  return fp(`HDR-${rows}x${n}`, `${rows}×${n} pin header, 2.54 mm pitch (pin 1 square)`, 'tht', pads, [
    { shape: 'box', x: 0, y: 0, w, h, height: 2.5, color: '#111827' },
  ], [box(0, 0, w, h)]);
}

function terminal(n: number): FootprintDef {
  const P = 5.08;
  const x0 = (-(n - 1) / 2) * P;
  const pads = Array.from({ length: n }, (_, i) => pad(String(i + 1), x0 + i * P, 0, i === 0 ? 'rect' : 'circle', 2.6, 2.6, 1.3));
  const w = round(n * P);
  return fp(`TERM-${n}`, `${n}-way screw terminal block, 5.08 mm pitch`, 'tht', pads, [
    { shape: 'box', x: 0, y: 0.6, w, h: 8.2, height: 10, color: '#16a34a' },
  ], [box(0, 0.6, w, 8.2)]);
}

// ─── surface mount ───────────────────────────────────────────────────────────

/** Two-terminal chip (KiCad R_xxxx_Metric nominal land pattern). */
function chip(name: string, description: string, o: { px: number; w: number; h: number; body: [number, number, number]; names?: [string, string]; color: string }): FootprintDef {
  const [n1, n2] = o.names ?? ['1', '2'];
  const pads = [pad(n1, -o.px, 0, 'roundrect', o.w, o.h), pad(n2, o.px, 0, 'roundrect', o.w, o.h)];
  const [bw, bh, bz] = o.body;
  return fp(name, description, 'smd', pads, [{ shape: 'box', x: 0, y: 0, w: bw, h: bh, height: bz, color: o.color }]);
}

const CHIPS: [string, number, number, number, [number, number, number]][] = [
  // code, pad centre x, pad w, pad h, body [w, h, height]
  ['0402', 0.51, 0.54, 0.64, [1.0, 0.5, 0.35]],
  ['0603', 0.825, 0.8, 0.95, [1.6, 0.8, 0.45]],
  ['0805', 0.9125, 1.025, 1.4, [2.0, 1.25, 0.5]],
  ['1206', 1.4625, 1.125, 1.75, [3.2, 1.6, 0.6]],
  ['1210', 1.4625, 1.125, 2.65, [3.2, 2.5, 0.6]],
];

function soic(n: number): FootprintDef {
  const m = n / 2;
  const top = ((m - 1) / 2) * 1.27;
  const pads: PadDef[] = [];
  for (let k = 0; k < m; k++) pads.push(pad(String(k + 1), -2.475, top - k * 1.27, 'roundrect', 1.95, 0.6));
  for (let k = 0; k < m; k++) pads.push(pad(String(m + k + 1), 2.475, -top + k * 1.27, 'roundrect', 1.95, 0.6));
  const len = round(m * 1.27 - 0.2);
  return fp(`SOIC-${n}`, `${n}-pin small-outline IC, 1.27 mm pitch, 3.9 mm body (pin 1 top-left)`, 'smd', pads, [
    { shape: 'box', x: 0, y: 0, w: 3.9, h: len, height: 1.5, color: '#1f2937' },
  ], [{ kind: 'circle', x: -1.3, y: round(len / 2 - 0.6), r: 0.25 }]);
}

const sot23 = (): FootprintDef =>
  fp('SOT-23', 'SOT-23 3-lead small-outline transistor (pins 1, 2 on the left, 3 on the right)', 'smd', [
    pad('1', -1.1375, 0.95, 'roundrect', 1.325, 0.6),
    pad('2', -1.1375, -0.95, 'roundrect', 1.325, 0.6),
    pad('3', 1.1375, 0, 'roundrect', 1.325, 0.6),
  ], [{ shape: 'box', x: 0, y: 0, w: 1.3, h: 2.9, height: 1.1, color: '#1f2937' }]);

// ─── switches ────────────────────────────────────────────────────────────────

const tact6 = (): FootprintDef =>
  fp('TACT-6MM', '6×6 mm through-hole tactile switch (pads named 1 are joined inside the part, so are pads 2)', 'tht', [
    pad('1', -3.25, 2.25, 'circle', 2.0, 2.0, 1.1),
    pad('1', 3.25, 2.25, 'circle', 2.0, 2.0, 1.1),
    pad('2', -3.25, -2.25, 'circle', 2.0, 2.0, 1.1),
    pad('2', 3.25, -2.25, 'circle', 2.0, 2.0, 1.1),
  ], [
    { shape: 'box', x: 0, y: 0, w: 6, h: 6, height: 3.5, color: '#1f2937' },
    { shape: 'cylinder', x: 0, y: 0, w: 3.5, h: 3.5, height: 5, color: '#9ca3af' },
  ], [box(0, 0, 6, 6), { kind: 'circle', x: 0, y: 0, r: 1.75 }]);

const spdt = (): FootprintDef =>
  fp('SW-SPDT', 'SPDT slide switch, 3 leads at 2.54 mm (pad 2 = common)', 'tht', [
    pad('1', -IN, 0, 'oval', 1.5, 2.0, 0.9),
    pad('2', 0, 0, 'oval', 1.5, 2.0, 0.9),
    pad('3', IN, 0, 'oval', 1.5, 2.0, 0.9),
  ], [{ shape: 'box', x: 0, y: 0, w: 8.6, h: 3.6, height: 3.5, color: '#374151' }], [box(0, 0, 8.6, 3.6)]);

// ─── registry ────────────────────────────────────────────────────────────────

const FIXED_LIST: [string, () => FootprintDef][] = Object.entries({
  'AXIAL-0.3': () => axial('AXIAL-0.3', 'axial resistor / inductor lying flat, 7.62 mm (0.3") lead pitch', { pitch: 7.62, drill: 0.8, pad: 1.6, len: 3.6, dia: 1.6, color: '#d6c08f' }),
  'AXIAL-0.4': () => axial('AXIAL-0.4', 'axial resistor / inductor lying flat, 10.16 mm (0.4") lead pitch (1/4 W resistor)', { pitch: 10.16, drill: 0.8, pad: 1.6, len: 6.3, dia: 2.5, color: '#d6c08f' }),
  'AXIAL-0.5': () => axial('AXIAL-0.5', 'axial part lying flat, 12.7 mm (0.5") lead pitch (1/2 W resistor)', { pitch: 12.7, drill: 1.0, pad: 2.0, len: 9.0, dia: 3.2, color: '#d6c08f' }),
  'DO-35': () => axial('DO-35', 'DO-35 glass axial diode, 7.62 mm pitch (pad K = cathode, band side)', { pitch: 7.62, drill: 0.8, pad: 1.6, len: 4.0, dia: 2.0, names: ['K', 'A'], color: '#f59e0b', band: true }),
  'DO-41': () => axial('DO-41', 'DO-41 axial diode, 10.16 mm pitch (pad K = cathode, band side)', { pitch: 10.16, drill: 1.0, pad: 2.0, len: 5.2, dia: 2.7, names: ['K', 'A'], color: '#111827', band: true }),
  'DISC-5MM': () => fp('DISC-5MM', 'ceramic disc / MLCC through-hole capacitor, 5.08 mm lead pitch', 'tht', [pad('1', -2.54, 0, 'circle', 1.6, 1.6, 0.8), pad('2', 2.54, 0, 'circle', 1.6, 1.6, 0.8)], [{ shape: 'box', x: 0, y: 0, w: 5.0, h: 2.5, height: 5, color: '#c2410c' }], [box(0, 0, 5.0, 2.5)]),
  'RADIAL-5MM': () => radial('RADIAL-5MM', 'radial electrolytic capacitor, 5 mm diameter, 2.0 mm pitch (pad 1 = +, square)', { pitch: 2.0, dia: 5, height: 11, drill: 0.8, pad: 1.6, color: '#1e3a8a', polarized: true }),
  'RADIAL-8MM': () => radial('RADIAL-8MM', 'radial electrolytic capacitor, 8 mm diameter, 3.5 mm pitch (pad 1 = +, square)', { pitch: 3.5, dia: 8, height: 12, drill: 1.0, pad: 2.0, color: '#1e3a8a', polarized: true }),
  'LED-3MM': () => led('LED-3MM', 3, 5.3),
  'LED-5MM': () => led('LED-5MM', 5, 8.6),
  'TO-92': () => inline3('TO-92', 'TO-92 inline, 1.27 mm lead pitch (flat face toward −y)', { pitch: 1.27, drill: 0.75, padW: 1.05, padH: 1.5, body: { w: 4.8, h: 3.8, y: 0.4, height: 4.8 }, color: '#111827' }),
  'TO-220': () => inline3('TO-220', 'TO-220 vertical, 2.54 mm lead pitch (metal tab toward +y)', { pitch: 2.54, drill: 1.1, padW: 1.9, padH: 2.4, body: { w: 10.2, h: 4.6, y: 1.3, height: 15.6 }, color: '#111827' }),
  'TO-126': () => inline3('TO-126', 'TO-126 / TO-225 vertical, 2.29 mm lead pitch', { pitch: 2.29, drill: 1.0, padW: 1.6, padH: 2.2, body: { w: 8.0, h: 3.2, y: 0.9, height: 11 }, color: '#111827' }),
  'LED-0603': () => chip('LED-0603', '0603 chip LED (pad K = cathode)', { px: 0.825, w: 0.8, h: 0.95, body: [1.6, 0.8, 0.6], names: ['K', 'A'], color: '#fca5a5' }),
  'LED-0805': () => chip('LED-0805', '0805 chip LED (pad K = cathode)', { px: 0.9125, w: 1.025, h: 1.4, body: [2.0, 1.25, 0.8], names: ['K', 'A'], color: '#fca5a5' }),
  'SOD-123': () => chip('SOD-123', 'SOD-123 SMD diode (pad K = cathode)', { px: 1.65, w: 0.9, h: 1.2, body: [2.7, 1.6, 1.1], names: ['K', 'A'], color: '#111827' }),
  SMA: () => chip('SMA', 'SMA / DO-214AC SMD diode (pad K = cathode)', { px: 2.0, w: 2.5, h: 1.7, body: [4.3, 2.6, 2.1], names: ['K', 'A'], color: '#111827' }),
  'SOT-23': sot23,
  'TACT-6MM': tact6,
  'SW-SPDT': spdt,
  'UNO-SHIELD': () => UNO_SHIELD,
});
// Chip codes look like integers ('1206'), which an object literal would move to the front: splice them in.
FIXED_LIST.splice(
  FIXED_LIST.findIndex(([n]) => n === 'LED-0603'),
  0,
  ...CHIPS.map(([code, px, w, h, body]): [string, () => FootprintDef] => [code, () => chip(code, `${code} (${metric(code)} metric) two-terminal chip resistor / capacitor / inductor`, { px, w, h, body, color: '#78716c' })]),
);
const FIXED = new Map(FIXED_LIST);

function metric(code: string): string {
  return { '0402': '1005', '0603': '1608', '0805': '2012', '1206': '3216', '1210': '3225' }[code] ?? code;
}

const FAMILIES: { re: RegExp; pattern: string; description: string; make: (n: number, m?: number) => FootprintDef | undefined }[] = [
  { re: /^DIP-(\d+)$/, pattern: 'DIP-<n>', description: 'dual in-line package, n even 4–64 (DIP-8, DIP-14, DIP-16, DIP-28…)', make: n => (n >= 4 && n <= 64 && n % 2 === 0 ? dip(n) : undefined) },
  { re: /^SOIC-(\d+)$/, pattern: 'SOIC-<n>', description: 'narrow (3.9 mm) small-outline IC, 1.27 mm pitch, n = 8, 14 or 16 (same pin numbering as DIP-<n>)', make: n => ([8, 14, 16].includes(n) ? soic(n) : undefined) },
  { re: /^HDR-1X(\d+)$/, pattern: 'HDR-1x<n>', description: 'single-row pin header, 2.54 mm pitch, n 1–40', make: n => (n >= 1 && n <= 40 ? header(1, n) : undefined) },
  { re: /^HDR-2X(\d+)$/, pattern: 'HDR-2x<n>', description: 'dual-row pin header, 2.54 mm pitch, 2n pins (n 1–40); odd pins on the top row', make: n => (n >= 1 && n <= 40 ? header(2, n) : undefined) },
  { re: /^TERM-(\d+)$/, pattern: 'TERM-<n>', description: 'screw terminal block, 5.08 mm pitch, n 2–12', make: n => (n >= 2 && n <= 12 ? terminal(n) : undefined) },
];

const cache = new Map<string, FootprintDef | null>();

/** A library footprint by name (case-insensitive), or undefined. */
export function getFootprint(name: string): FootprintDef | undefined {
  const key = name.trim().toUpperCase();
  if (cache.has(key)) return cache.get(key) ?? undefined;
  let found: FootprintDef | undefined;
  const fixed = [...FIXED.keys()].find(k => k.toUpperCase() === key);
  if (fixed) found = FIXED.get(fixed)!();
  else {
    for (const f of FAMILIES) {
      const m = key.match(f.re);
      if (m) {
        found = f.make(Number(m[1]));
        break;
      }
    }
  }
  cache.set(key, found ?? null);
  return found;
}

/** Library listing for `circuitsvibe catalog footprints`. */
export function footprintCatalog(): { name: string; tech: PcbTech | 'tht/smd'; description: string; pads?: number }[] {
  const fixed = [...FIXED.keys()].map(name => {
    const f = getFootprint(name)!;
    return { name: f.name, tech: f.tech, description: f.description, pads: f.pads.length };
  });
  const families = FAMILIES.map(f => ({ name: f.pattern, tech: (f.pattern.startsWith('SOIC') ? 'smd' : 'tht') as PcbTech, description: f.description }));
  return [...fixed, ...families];
}
