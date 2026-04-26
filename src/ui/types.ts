export type BuiltinComponentType = 'Resistor' | 'VoltageSource' | 'CurrentSource' | 'Capacitor' | 'Inductor' | 'Diode' | 'LED' | 'Ground' | 'Junction';
export type ComponentType = string;
export type ToolType = 'select' | BuiltinComponentType | 'wire' | 'probe';

export interface Point {
  x: number;
  y: number;
}

export interface PinDef {
  name: string;
  offset: Point; // relative to component position
}

export interface PlacedComponent {
  id: string;
  type: ComponentType;
  x: number;
  y: number;
  rotation: number; // 0, 90, 180, 270
  value: number;
  label: string;
  pins: PinDef[];
  // AC parameters (for VoltageSource)
  acAmplitude?: number;
  frequency?: number;
  // Simulation results
  voltage?: number;
  current?: number;
}

export interface Wire {
  id: string;
  from: { componentId: string; pinName: string } | { x: number; y: number };
  to: { componentId: string; pinName: string } | { x: number; y: number };
  /** Optional axis-aligned constraint for the route (set when the user drags
   * the wire). `axis: 'y'` pins the middle horizontal stretch at `value`;
   * `axis: 'x'` pins the middle vertical stretch at `value`. */
  via?: { axis: 'x' | 'y'; value: number };
}

export interface GroundNode {
  id: string;
  componentId: string;
  pinName: string;
}

export const GRID_SIZE = 20;

export interface ComponentDefUI {
  defaultValue: number;
  unit: string;
  label: string;
  pins: PinDef[];
  draw?: (ctx: CanvasRenderingContext2D, w: number, h: number) => void;
}

export const customComponentDefs = new Map<string, ComponentDefUI>();

export function getComponentDef(type: string): ComponentDefUI | undefined {
  return COMPONENT_DEFS[type as BuiltinComponentType] ?? customComponentDefs.get(type);
}

export const COMPONENT_DEFS: Record<string, ComponentDefUI> = {
  Resistor: {
    defaultValue: 1000,
    unit: 'Ω',
    label: 'R',
    pins: [
      { name: '1', offset: { x: -40, y: 0 } },
      { name: '2', offset: { x: 40, y: 0 } },
    ],
  },
  VoltageSource: {
    defaultValue: 5,
    unit: 'V',
    label: 'V',
    pins: [
      { name: '+', offset: { x: 0, y: -35 } },
      { name: '-', offset: { x: 0, y: 35 } },
    ],
  },
  CurrentSource: {
    defaultValue: 0.01,
    unit: 'A',
    label: 'I',
    pins: [
      { name: '+', offset: { x: 0, y: -35 } },
      { name: '-', offset: { x: 0, y: 35 } },
    ],
  },
  Capacitor: {
    defaultValue: 0.000001,
    unit: 'F',
    label: 'C',
    pins: [
      { name: '1', offset: { x: -30, y: 0 } },
      { name: '2', offset: { x: 30, y: 0 } },
    ],
  },
  Inductor: {
    defaultValue: 0.001,
    unit: 'H',
    label: 'L',
    pins: [
      { name: '1', offset: { x: -40, y: 0 } },
      { name: '2', offset: { x: 40, y: 0 } },
    ],
  },
  Diode: {
    defaultValue: 0,
    unit: '',
    label: 'D',
    pins: [
      { name: 'anode', offset: { x: -30, y: 0 } },
      { name: 'cathode', offset: { x: 30, y: 0 } },
    ],
  },
  LED: {
    defaultValue: 0,
    unit: '',
    label: 'LED',
    pins: [
      { name: 'anode', offset: { x: -30, y: 0 } },
      { name: 'cathode', offset: { x: 30, y: 0 } },
    ],
  },
  Ground: {
    defaultValue: 0,
    unit: '',
    label: '', // empty -> renderer skips drawing the label
    pins: [
      { name: '1', offset: { x: 0, y: -25 } },
    ],
  },
  Junction: {
    defaultValue: 0,
    unit: '',
    label: '', // junctions have no visible label
    pins: [
      { name: '1', offset: { x: 0, y: 0 } },
    ],
  },
};

export interface Probe {
  id: string;
  componentId: string;
  pinName: string;
  type: 'voltage' | 'current';
  color: string;
  label: string;
}

export interface ProjectFile {
  name: string;
  content: string;
}

export interface ProjectData {
  version: 1;
  name: string;
  files: ProjectFile[];
  canvas: {
    components: PlacedComponent[];
    wires: Wire[];
    grounds: GroundNode[];
    probes: Probe[];
  };
  settings: { simDt: string; simDuration: string };
  view?: { panX: number; panY: number; zoom: number };
}

export const PROBE_COLORS = ['#22d3ee', '#f472b6', '#fbbf24', '#34d399', '#a78bfa', '#fb923c'];

export function formatValue(value: number, unit: string): string {
  if (unit === '' || value === 0) return '';
  const abs = Math.abs(value);
  if (abs >= 1e6) return (value / 1e6).toFixed(1) + 'M' + unit;
  if (abs >= 1e3) return (value / 1e3).toFixed(1) + 'k' + unit;
  if (abs >= 1) return value.toFixed(1) + unit;
  if (abs >= 1e-3) return (value * 1e3).toFixed(1) + 'm' + unit;
  if (abs >= 1e-6) return (value * 1e6).toFixed(1) + 'µ' + unit;
  if (abs >= 1e-9) return (value * 1e9).toFixed(1) + 'n' + unit;
  return (value * 1e12).toFixed(1) + 'p' + unit;
}

export function getPinWorldPos(comp: PlacedComponent, pinName: string): Point {
  const pinDef = comp.pins.find(p => p.name === pinName)!;
  const rad = (comp.rotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return {
    x: comp.x + pinDef.offset.x * cos - pinDef.offset.y * sin,
    y: comp.y + pinDef.offset.x * sin + pinDef.offset.y * cos,
  };
}
