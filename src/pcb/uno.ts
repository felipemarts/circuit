/**
 * Arduino Uno R3 shield: the four header strips and the four mounting holes of
 * the Uno, as one footprint. A board that plugs onto an Uno places this
 * footprint for its ArduinoUno component; the pads carry the Uno pin names
 * ('D13', 'A0', '5V', 'GND'…), and pads that share a name (the three GND pins)
 * are joined on the Uno itself.
 *
 * Coordinates: Arduino's own UNO Rev3 board file (arduino_Uno_Rev3-02-TH.brd),
 * cross-checked against the KiCad library footprint Module:Arduino_UNO_R3 and
 * Adafruit's ARDUINOR3 shield package. Pads 1.6 mm / drill 1.0 mm (KiCad), holes
 * 3.2 mm. The footprint origin is the centre of the Uno board (34.29, 26.67 mm
 * from its lower-left corner, USB jack on the left), so `tb.board({ preset:
 * 'uno-shield' })` + `tb.place('U1', { x: 34.29, y: 26.67 })` lines everything up.
 */
import type { FootprintDef, PadDef } from './types';
import { round } from './geometry';

export const UNO_CENTER: [number, number] = [34.29, 26.67];

/** Uno R3 board outline (lower-left origin): 1 mm corner radii omitted, chamfered tab on the right. */
export const UNO_OUTLINE: [number, number][] = [
  [0, 0],
  [66.04, 0],
  [66.04, 2.54],
  [68.58, 5.08],
  [68.58, 37.846],
  [66.04, 40.386],
  [66.04, 51.816],
  [64.516, 53.34],
  [0, 53.34],
];

export const UNO_HOLES: { x: number; y: number; d: number }[] = [
  { x: 13.97, y: 2.54, d: 3.2 },
  { x: 15.24, y: 50.8, d: 3.2 },
  { x: 66.04, y: 7.62, d: 3.2 },
  { x: 66.04, y: 35.56, d: 3.2 },
];

const TOP = 50.8;
const BOTTOM = 2.54;
const STRIPS: { y: number; x0: number; names: string[] }[] = [
  { y: TOP, x0: 18.796, names: ['SCL', 'SDA', 'AREF', 'GND', 'D13', 'D12', 'D11', 'D10', 'D9', 'D8'] },
  { y: TOP, x0: 45.72, names: ['D7', 'D6', 'D5', 'D4', 'D3', 'D2', 'D1', 'D0'] },
  { y: BOTTOM, x0: 27.94, names: ['NC', 'IOREF', 'RESET', '3V3', '5V', 'GND', 'GND', 'VIN'] },
  { y: BOTTOM, x0: 50.8, names: ['A0', 'A1', 'A2', 'A3', 'A4', 'A5'] },
];

const [CX, CY] = UNO_CENTER;
const PAD = 1.6;
const MARGIN = 0.25;

const pads: PadDef[] = [];
const courtyard: FootprintDef['courtyard'] = [];
for (const s of STRIPS) {
  s.names.forEach((name, i) => {
    pads.push({ name, x: round(s.x0 + i * 2.54 - CX), y: round(s.y - CY), shape: name === 'NC' ? 'rect' : 'circle', w: PAD, h: PAD, drill: 1.0 });
  });
  const x1 = s.x0 - PAD / 2 - MARGIN;
  const x2 = s.x0 + (s.names.length - 1) * 2.54 + PAD / 2 + MARGIN;
  courtyard.push({ x: round((x1 + x2) / 2 - CX), y: round(s.y - CY), w: round(x2 - x1), h: round(PAD + 2 * MARGIN) });
}

export const UNO_SHIELD: FootprintDef = {
  name: 'UNO-SHIELD',
  description: 'Arduino Uno R3 shield headers (10 + 8 digital, 8 power, 6 analog) and the Uno mounting holes; origin = centre of the Uno board',
  tech: 'tht',
  pads,
  courtyard,
  holes: UNO_HOLES.map(h => ({ x: round(h.x - CX), y: round(h.y - CY), d: h.d })),
  silk: STRIPS.map(s => {
    const x1 = round(s.x0 - 1.27 - CX);
    const x2 = round(s.x0 + (s.names.length - 1) * 2.54 + 1.27 - CX);
    const y1 = round(s.y - 1.27 - CY);
    const y2 = round(s.y + 1.27 - CY);
    return { kind: 'line' as const, points: [[x1, y1], [x2, y1], [x2, y2], [x1, y2], [x1, y1]] as [number, number][] };
  }),
};
