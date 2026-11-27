/**
 * PCB data model — the board, the placements and the footprints of a bench,
 * as plain JSON. The same shapes live in the bench elaboration
 * (`tb.board(...)`, `tb.place(...)`), in the circuit document (`pcb` field)
 * and in the RunRecord (`stages.pcb`).
 *
 * Lengths are MILLIMETRES (the EDA convention: Gerber, Excellon, KiCad),
 * angles are degrees counter-clockwise, and the board's coordinate system has
 * x to the right and y UP with the origin at the lower-left corner of a
 * rectangular board (the Gerber convention). See docs/PCB.md.
 */

/** Footprint technology: through-hole or surface-mount. */
export type PcbTech = 'tht' | 'smd';

export type PadShape = 'rect' | 'circle' | 'oval' | 'roundrect';

/** One copper pad of a footprint, in footprint-local coordinates (mm). */
export interface PadDef {
  /**
   * Pad name: '1', '2'… for numbered packages, 'A' / 'K' for diodes. Pads
   * sharing a name are connected inside the part (a tactile switch's legs).
   */
  name: string;
  x: number;
  y: number;
  shape: PadShape;
  /** Size along x and y (mm). */
  w: number;
  h: number;
  /** Through-hole drill diameter (mm). Absent: an SMD pad on the placement side. */
  drill?: number;
}

/** Simple 2D drawing primitive of a footprint (silkscreen outline), local mm. */
export type SilkShape =
  | { kind: 'line'; points: [number, number][] }
  | { kind: 'circle'; x: number; y: number; r: number };

/** Simplified 3D body: a box or a vertical cylinder, local mm. */
export interface BodyDef {
  shape: 'box' | 'cylinder';
  x: number;
  y: number;
  /** Box: size along x / y. Cylinder: w = diameter (h ignored). */
  w: number;
  h: number;
  /** Height above the board surface. */
  height: number;
  /** Lift above the board (e.g. axial parts on their leads). */
  z?: number;
  /** Cylinder lying along the x axis (axial resistors, diodes). */
  axial?: boolean;
  color?: string;
}

export interface FootprintDef {
  name: string;
  description: string;
  tech: PcbTech;
  pads: PadDef[];
  /**
   * Keep-out rectangles (centre x/y, size w/h), local mm. Together they cover
   * every pad and the body; usually one, several for spread-out parts (the
   * four header strips of an Uno shield leave the board between them free).
   */
  courtyard: { x: number; y: number; w: number; h: number }[];
  /** Non-plated mounting holes that belong to the footprint (local mm). */
  holes?: { x: number; y: number; d: number }[];
  silk?: SilkShape[];
  body?: BodyDef[];
}

/** Design rules (mm). */
export interface PcbRules {
  /** Default trace width. */
  trace: number;
  /** Minimum copper-to-copper clearance. */
  clearance: number;
  via: { drill: number; diameter: number };
  /** Minimum copper-to-board-edge distance. */
  edgeClearance: number;
  /** Copper weight in oz/ft² (default 1 = 35 µm): sets the current a trace width carries. */
  copper?: number;
  /** Allowed trace temperature rise in °C for the current-capacity check (default 10). */
  tempRise?: number;
  /** Router grid pitch (default 0.25 mm). */
  grid?: number;
}

/** Per-net routing options (`tb.board({ nets: { vcc: { width: 0.5 } } })`). */
export interface NetRule {
  /** Trace width of this net (mm), instead of the one sized from its simulated current. */
  width: number;
}

export interface PcbHole {
  x: number;
  y: number;
  /** Drill diameter (non-plated). */
  d: number;
}

/** Normalized board specification (every default filled in). */
export interface BoardSpec {
  /** Rectangle size (absent when `outline` is given). */
  width?: number;
  height?: number;
  /** Corner radius of a rectangular board. */
  cornerRadius?: number;
  /** Polygon outline (absolute mm, counter-clockwise or clockwise), instead of width/height. */
  outline?: [number, number][];
  /** Copper layers: 1 (top only) or 2. */
  layers: 1 | 2;
  thickness: number;
  /** Default technology of generic parts (R, C, L, diodes, LEDs, transistors, op-amps). */
  tech: PcbTech;
  rules: PcbRules;
  holes: PcbHole[];
  /** Per-net trace widths, by net name (named with tb.name). */
  nets?: Record<string, NetRule>;
  /** false: no autorouting (placement checks and ratsnest only). */
  route?: false;
}

/** Placement of one component. */
export interface PlacementSpec {
  /** Position of the footprint origin (mm): the centre of its pads for library parts. Absent: not placed yet (P805). */
  x?: number;
  y?: number;
  /** Degrees counter-clockwise, in [0, 360). */
  rot?: number;
  side?: 'top' | 'bottom';
  /** Footprint name (library or `pcb.footprints`). Absent: the default for the part. */
  footprint?: string;
  /** Pin → pad name(s), overriding the default mapping for the given pins. */
  pads?: Record<string, string | string[]>;
  /** Not on this board (a bench instrument, an external supply). */
  offBoard?: boolean;
  /** Circuit documents only: origin location (`file:line` of the tb.place call); dropped from share links. */
  at?: string;
}

/** The `pcb` field of a circuit document / of an elaboration. */
export interface PcbSpec {
  board: BoardSpec;
  /** Per component id, ascending. */
  placements: Record<string, PlacementSpec>;
  /** Custom footprints by name. */
  footprints?: Record<string, FootprintDef>;
}

// ─── RunRecord: stages.pcb ───────────────────────────────────────────────────

export interface PcbAirwire {
  net: string;
  /** Pad refs 'R1.1', 'D1.K'. */
  from: string;
  to: string;
  /** Straight-line length (mm). */
  length: number;
}

export interface PcbPlacedRecord {
  id: string;
  footprint: string;
  tech: PcbTech;
  x: number;
  y: number;
  rot: number;
  side: 'top' | 'bottom';
}

/** A routed trace: a polyline of one width on one copper layer. */
export interface PcbTrack {
  layer: 'top' | 'bottom';
  width: number;
  points: [number, number][];
}

export interface PcbVia {
  x: number;
  y: number;
  drill: number;
  diameter: number;
}

/** The copper of one net. */
export interface PcbNetRoute {
  net: string;
  /** Trace width used (mm). */
  width: number;
  /** Where the width comes from: the simulated current (IPC-2221), the minimum rule, or tb.board({ nets }). */
  widthFrom: 'current' | 'rule' | 'net';
  /** Largest current the net carries between its pads (A): half the sum of its pin currents, op or transient RMS. */
  current?: number;
  /** Narrowest trace for that current (mm), IPC-2221. */
  requiredWidth?: number;
  tracks: PcbTrack[];
  vias: PcbVia[];
  /** Total track length (mm). */
  length: number;
  /** Every pad group of the net is connected. */
  complete: boolean;
}

export interface PcbRouting {
  /** Router grid pitch (mm). */
  grid: number;
  /** Which simulation sized the traces: the operating point, plus the transient RMS when the bench has one, or none (--stage pcb). */
  currents: 'op' | 'op+tran' | 'none';
  nets: PcbNetRoute[];
  /** Connections the router could not make (airwires left). */
  unrouted: PcbAirwire[];
  stats: {
    /** Nets with two or more pad groups. */
    nets: number;
    /** Pad-group connections to make (the ratsnest size). */
    connections: number;
    routed: number;
    unrouted: number;
    /** routed / connections, 0–1. */
    completion: number;
    /** Total track length (mm). */
    length: number;
    vias: number;
    /** Router passes (rip-up and retry rounds) it took. */
    passes: number;
  };
}

export interface PcbRecord {
  board: { width: number; height: number; layers: 1 | 2; thickness: number; tech: PcbTech; area: number };
  placed: PcbPlacedRecord[];
  offBoard: string[];
  /** Components with a footprint but no position, with a free spot that fits. */
  unplaced: { id: string; footprint: string; suggested?: { x: number; y: number; rot: number } }[];
  ratsnest: PcbAirwire[];
  /** The autorouter's copper (absent when the placement has errors or tb.board({ route: false })). */
  routing?: PcbRouting;
  stats: {
    placed: number;
    offBoard: number;
    unplaced: number;
    pads: number;
    /** Nets that connect two or more pad groups on the board. */
    nets: number;
    airwires: number;
    /** Sum of the airwire lengths (mm): a placement-quality figure (lower is better). */
    airwireLength: number;
  };
}
