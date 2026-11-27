/**
 * Validation + normalization of what a bench writes (`tb.board`, `tb.place`)
 * into the plain PcbSpec shapes. Idempotent — normalizing a normalized spec
 * returns it unchanged — so a circuit document replays to the same spec.
 * Every problem throws an Error whose message names the field and the fix.
 */
import type { BoardSpec, FootprintDef, PadDef, PadShape, PcbHole, PcbTech, PlacementSpec, SilkShape } from './types';
import { getFootprint } from './footprints';
import { round } from './geometry';
import { UNO_OUTLINE } from './uno';

/** A length: a number (mm) or a string with a unit: '1.6mm', '0.1in', '100mil', '2cm', '250um'. */
export type LengthLike = number | string;

const UNIT_MM: Record<string, number> = { mm: 1, cm: 10, um: 0.001, in: 25.4, mil: 0.0254, mils: 0.0254, '': 1 };

export function parseLength(v: unknown, what: string): number {
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error(`${what}: ${v} is not a finite length`);
    return round(v);
  }
  if (typeof v === 'string') {
    const m = v.trim().match(/^([-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)\s*(mm|cm|um|in|mils?|)$/i);
    if (m) return round(Number(m[1]) * UNIT_MM[m[2].toLowerCase()]);
  }
  throw new Error(`${what}: expected a length in mm (a number) or a string with a unit like '1.6mm', '0.1in', '100mil', got ${JSON.stringify(v)}`);
}

const positive = (v: unknown, what: string): number => {
  const n = parseLength(v, what);
  if (!(n > 0)) throw new Error(`${what} must be > 0, got ${n} mm`);
  return n;
};

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function onlyKeys(obj: Record<string, unknown>, keys: string[], what: string): void {
  for (const k of Object.keys(obj)) {
    if (!keys.includes(k)) throw new Error(`${what}: unknown option '${k}'. Valid options: ${keys.join(', ')}`);
  }
}

export interface BoardInput {
  /** Rectangular board size. */
  width?: LengthLike;
  height?: LengthLike;
  cornerRadius?: LengthLike;
  /** Polygon outline (absolute), instead of width/height. */
  outline?: [LengthLike, LengthLike][];
  /** A standard outline: 'uno-shield' (the Arduino Uno R3 board shape, 68.58 × 53.34 mm). */
  preset?: 'uno-shield';
  /** Copper layers, 1 or 2 (default 2). */
  layers?: 1 | 2;
  /** Board thickness (default 1.6 mm). */
  thickness?: LengthLike;
  /** Default footprint technology of generic parts (default 'tht'). */
  tech?: PcbTech;
  /** Mounting holes (non-plated): [{ x, y, d }]. */
  holes?: { x: LengthLike; y: LengthLike; d: LengthLike }[];
  rules?: {
    trace?: LengthLike;
    clearance?: LengthLike;
    edgeClearance?: LengthLike;
    via?: { drill?: LengthLike; diameter?: LengthLike };
  };
}

const BOARD_KEYS = ['width', 'height', 'cornerRadius', 'outline', 'preset', 'layers', 'thickness', 'tech', 'holes', 'rules'];

export function normalizeBoard(input: BoardInput): BoardSpec {
  if (!isObj(input)) throw new Error(`tb.board(spec): expected an object like { width: 50, height: 30 } (mm)`);
  onlyKeys(input, BOARD_KEYS, 'tb.board');
  const spec: Partial<BoardSpec> = {};
  if (input.preset !== undefined) {
    if (input.preset !== 'uno-shield') throw new Error(`tb.board: unknown preset ${JSON.stringify(input.preset)}; presets: 'uno-shield'`);
    if (input.outline || input.width !== undefined || input.height !== undefined) throw new Error(`tb.board: preset '${input.preset}' sets the outline; drop width/height/outline`);
    spec.outline = UNO_OUTLINE.map(([x, y]) => [x, y]);
  } else if (input.outline !== undefined) {
    if (input.width !== undefined || input.height !== undefined || input.cornerRadius !== undefined) throw new Error(`tb.board: give either { width, height[, cornerRadius] } or { outline }, not both`);
    if (!Array.isArray(input.outline) || input.outline.length < 3) throw new Error(`tb.board outline: expected at least 3 points [[x, y], …] (mm)`);
    spec.outline = input.outline.map((p, i) => {
      if (!Array.isArray(p) || p.length !== 2) throw new Error(`tb.board outline[${i}]: expected [x, y]`);
      return [parseLength(p[0], `tb.board outline[${i}].x`), parseLength(p[1], `tb.board outline[${i}].y`)];
    });
    let area = 0;
    const o = spec.outline;
    for (let i = 0; i < o.length; i++) area += o[i][0] * o[(i + 1) % o.length][1] - o[(i + 1) % o.length][0] * o[i][1];
    if (Math.abs(area) < 1) throw new Error(`tb.board outline: the polygon has (almost) no area`);
  } else {
    if (input.width === undefined || input.height === undefined) throw new Error(`tb.board: give the board size { width, height } in mm (or an outline, or preset: 'uno-shield')`);
    spec.width = positive(input.width, 'tb.board width');
    spec.height = positive(input.height, 'tb.board height');
    if (input.cornerRadius !== undefined) {
      const r = parseLength(input.cornerRadius, 'tb.board cornerRadius');
      if (r < 0 || r > Math.min(spec.width, spec.height) / 2) throw new Error(`tb.board cornerRadius must be between 0 and half the shorter side (${Math.min(spec.width, spec.height) / 2} mm), got ${r}`);
      if (r > 0) spec.cornerRadius = r;
    }
  }
  const layers = input.layers ?? 2;
  if (layers !== 1 && layers !== 2) throw new Error(`tb.board layers must be 1 or 2, got ${JSON.stringify(input.layers)}`);
  spec.layers = layers;
  spec.thickness = input.thickness !== undefined ? positive(input.thickness, 'tb.board thickness') : 1.6;
  const tech = input.tech ?? 'tht';
  if (tech !== 'tht' && tech !== 'smd') throw new Error(`tb.board tech must be 'tht' or 'smd', got ${JSON.stringify(input.tech)}`);
  spec.tech = tech;

  const r = input.rules ?? {};
  if (!isObj(r)) throw new Error(`tb.board rules: expected an object { trace, clearance, edgeClearance, via }`);
  onlyKeys(r, ['trace', 'clearance', 'edgeClearance', 'via'], 'tb.board rules');
  const via = r.via ?? {};
  if (!isObj(via)) throw new Error(`tb.board rules.via: expected { drill, diameter }`);
  onlyKeys(via, ['drill', 'diameter'], 'tb.board rules.via');
  spec.rules = {
    trace: r.trace !== undefined ? positive(r.trace, 'tb.board rules.trace') : 0.25,
    clearance: r.clearance !== undefined ? positive(r.clearance, 'tb.board rules.clearance') : 0.2,
    via: {
      drill: via.drill !== undefined ? positive(via.drill, 'tb.board rules.via.drill') : 0.3,
      diameter: via.diameter !== undefined ? positive(via.diameter, 'tb.board rules.via.diameter') : 0.6,
    },
    edgeClearance: r.edgeClearance !== undefined ? parseLength(r.edgeClearance, 'tb.board rules.edgeClearance') : 0.5,
  };
  if (spec.rules.edgeClearance < 0) throw new Error(`tb.board rules.edgeClearance must be ≥ 0`);
  if (!(spec.rules.via.diameter > spec.rules.via.drill)) throw new Error(`tb.board rules.via: diameter (${spec.rules.via.diameter} mm) must be larger than drill (${spec.rules.via.drill} mm)`);

  const holes = input.holes ?? [];
  if (!Array.isArray(holes)) throw new Error(`tb.board holes: expected an array [{ x, y, d }]`);
  spec.holes = holes.map((h, i): PcbHole => {
    if (!isObj(h)) throw new Error(`tb.board holes[${i}]: expected { x, y, d }`);
    onlyKeys(h, ['x', 'y', 'd'], `tb.board holes[${i}]`);
    return { x: parseLength(h.x, `tb.board holes[${i}].x`), y: parseLength(h.y, `tb.board holes[${i}].y`), d: positive(h.d, `tb.board holes[${i}].d`) };
  });
  // Canonical key order.
  const out: BoardSpec = {
    ...(spec.width !== undefined ? { width: spec.width, height: spec.height } : {}),
    ...(spec.cornerRadius !== undefined ? { cornerRadius: spec.cornerRadius } : {}),
    ...(spec.outline ? { outline: spec.outline } : {}),
    layers: spec.layers,
    thickness: spec.thickness,
    tech: spec.tech,
    rules: spec.rules,
    holes: spec.holes,
  } as BoardSpec;
  return out;
}

/** A custom footprint as data (tb.place('U1', { footprint: { name, pads } })). */
export interface FootprintInput {
  name: string;
  description?: string;
  tech?: PcbTech;
  pads: { name: string | number; x: LengthLike; y: LengthLike; shape?: PadShape; w: LengthLike; h?: LengthLike; drill?: LengthLike }[];
  courtyard?: { x?: LengthLike; y?: LengthLike; w: LengthLike; h: LengthLike }[];
  holes?: { x: LengthLike; y: LengthLike; d: LengthLike }[];
  silk?: SilkShape[];
}

const FP_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.\-]*$/;

export function normalizeFootprintDef(input: FootprintInput): FootprintDef {
  if (!isObj(input)) throw new Error(`footprint: expected { name, pads: [...] }`);
  onlyKeys(input, ['name', 'description', 'tech', 'pads', 'courtyard', 'holes', 'silk'], 'footprint');
  if (typeof input.name !== 'string' || !FP_NAME_RE.test(input.name)) throw new Error(`footprint name ${JSON.stringify(input.name)}: use letters, digits, '.', '_' or '-'`);
  if (getFootprint(input.name)) throw new Error(`footprint name '${input.name}' is a library footprint; give the custom footprint another name`);
  if (!Array.isArray(input.pads) || input.pads.length === 0) throw new Error(`footprint '${input.name}': pads must be a non-empty array`);
  const what = `footprint '${input.name}'`;
  const pads: PadDef[] = input.pads.map((p, i) => {
    if (!isObj(p)) throw new Error(`${what} pads[${i}]: expected { name, x, y, w, h, shape?, drill? }`);
    onlyKeys(p, ['name', 'x', 'y', 'shape', 'w', 'h', 'drill'], `${what} pads[${i}]`);
    const name = String(p.name);
    if (name === '' || /\s/.test(name)) throw new Error(`${what} pads[${i}]: pad name must be non-empty with no spaces`);
    const shape = p.shape ?? 'rect';
    if (!['rect', 'circle', 'oval', 'roundrect'].includes(shape)) throw new Error(`${what} pads[${i}].shape must be rect, circle, oval or roundrect`);
    const w = positive(p.w, `${what} pads[${i}].w`);
    const h = p.h !== undefined ? positive(p.h, `${what} pads[${i}].h`) : w;
    const drill = p.drill !== undefined ? positive(p.drill, `${what} pads[${i}].drill`) : undefined;
    if (drill !== undefined && drill >= Math.min(w, h)) throw new Error(`${what} pads[${i}]: drill ${drill} mm leaves no copper ring on a ${w}×${h} mm pad`);
    return { name, x: parseLength(p.x, `${what} pads[${i}].x`), y: parseLength(p.y, `${what} pads[${i}].y`), shape, w, h, ...(drill !== undefined ? { drill } : {}) };
  });
  const tech: PcbTech = input.tech ?? (pads.some(p => p.drill !== undefined) ? 'tht' : 'smd');
  if (tech !== 'tht' && tech !== 'smd') throw new Error(`${what} tech must be 'tht' or 'smd'`);
  let courtyard: FootprintDef['courtyard'];
  if (input.courtyard !== undefined) {
    if (!Array.isArray(input.courtyard) || input.courtyard.length === 0) throw new Error(`${what} courtyard: expected [{ x, y, w, h }]`);
    courtyard = input.courtyard.map((c, i) => {
      if (!isObj(c)) throw new Error(`${what} courtyard[${i}]: expected { x, y, w, h }`);
      onlyKeys(c, ['x', 'y', 'w', 'h'], `${what} courtyard[${i}]`);
      return { x: c.x !== undefined ? parseLength(c.x, `${what} courtyard[${i}].x`) : 0, y: c.y !== undefined ? parseLength(c.y, `${what} courtyard[${i}].y`) : 0, w: positive(c.w, `${what} courtyard[${i}].w`), h: positive(c.h, `${what} courtyard[${i}].h`) };
    });
  } else {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of pads) {
      minX = Math.min(minX, p.x - p.w / 2);
      maxX = Math.max(maxX, p.x + p.w / 2);
      minY = Math.min(minY, p.y - p.h / 2);
      maxY = Math.max(maxY, p.y + p.h / 2);
    }
    courtyard = [{ x: round((minX + maxX) / 2), y: round((minY + maxY) / 2), w: round(maxX - minX + 0.5), h: round(maxY - minY + 0.5) }];
  }
  const holes = (input.holes ?? []).map((h, i) => ({ x: parseLength(h.x, `${what} holes[${i}].x`), y: parseLength(h.y, `${what} holes[${i}].y`), d: positive(h.d, `${what} holes[${i}].d`) }));
  if (input.silk !== undefined && !Array.isArray(input.silk)) throw new Error(`${what} silk: expected an array of shapes`);
  return {
    name: input.name,
    description: typeof input.description === 'string' ? input.description : 'custom footprint',
    tech,
    pads,
    courtyard,
    ...(holes.length > 0 ? { holes } : {}),
    ...(input.silk && input.silk.length > 0 ? { silk: JSON.parse(JSON.stringify(input.silk)) as SilkShape[] } : {}),
  };
}

export interface PlacementInput {
  x?: LengthLike;
  y?: LengthLike;
  /** Degrees counter-clockwise. */
  rot?: number;
  side?: 'top' | 'bottom';
  footprint?: string | FootprintInput;
  pads?: Record<string, string | number | (string | number)[]>;
  offBoard?: boolean;
}

/**
 * Normalize one tb.place(...) call. A custom footprint object is added to
 * `custom` (by name; the same name must mean the same footprint).
 */
export function normalizePlacement(id: string, input: PlacementInput, custom: Record<string, FootprintDef>): PlacementSpec {
  const what = `tb.place('${id}')`;
  if (!isObj(input)) throw new Error(`${what}: expected { x, y, rot?, side?, footprint? } (mm, degrees) or { offBoard: true }`);
  onlyKeys(input, ['x', 'y', 'rot', 'side', 'footprint', 'pads', 'offBoard'], what);
  if (input.offBoard !== undefined) {
    if (input.offBoard !== true) throw new Error(`${what}: offBoard must be true (omit it for a part on the board)`);
    const others = Object.keys(input).filter(k => k !== 'offBoard');
    if (others.length > 0) throw new Error(`${what}: an offBoard part takes no ${others.join(', ')}`);
    return { offBoard: true };
  }
  if ((input.x === undefined) !== (input.y === undefined)) throw new Error(`${what}: give both x and y (or neither, to only choose the footprint)`);
  const out: PlacementSpec = {};
  if (input.x !== undefined) {
    out.x = parseLength(input.x, `${what} x`);
    out.y = parseLength(input.y, `${what} y`);
  }
  if (input.rot !== undefined) {
    if (typeof input.rot !== 'number' || !Number.isFinite(input.rot)) throw new Error(`${what} rot: expected degrees (a number), got ${JSON.stringify(input.rot)}`);
    const r = round(((input.rot % 360) + 360) % 360);
    if (r !== 0) out.rot = r === 360 ? 0 : r;
  }
  if (input.side !== undefined) {
    if (input.side !== 'top' && input.side !== 'bottom') throw new Error(`${what} side must be 'top' or 'bottom'`);
    if (input.side === 'bottom') out.side = 'bottom';
  }
  if (input.footprint !== undefined) {
    if (typeof input.footprint === 'string') {
      const lib = getFootprint(input.footprint);
      if (lib) out.footprint = lib.name;
      else if (custom[input.footprint]) out.footprint = input.footprint;
      else throw new Error(`${what}: unknown footprint '${input.footprint}' (circuitsvibe catalog footprints lists the library; or pass a custom footprint object { name, pads })`);
    } else {
      const def = normalizeFootprintDef(input.footprint as FootprintInput);
      const prev = custom[def.name];
      if (prev && JSON.stringify(prev) !== JSON.stringify(def)) throw new Error(`${what}: a different footprint named '${def.name}' was already given`);
      custom[def.name] = def;
      out.footprint = def.name;
    }
  }
  if (input.pads !== undefined) {
    if (!isObj(input.pads)) throw new Error(`${what} pads: expected { pin: pad | [pads] }, e.g. { anode: 'A', cathode: 'K' }`);
    const pads: Record<string, string | string[]> = {};
    for (const pin of Object.keys(input.pads).sort()) {
      const v = input.pads[pin];
      if (Array.isArray(v)) pads[pin] = v.map(String);
      else if (typeof v === 'string' || typeof v === 'number') pads[pin] = String(v);
      else throw new Error(`${what} pads.${pin}: expected a pad name or an array of pad names`);
    }
    out.pads = pads;
  }
  return out;
}
