# PCB: board, footprints and placement

A bench can declare the printed circuit board it is built on. The **pcb stage**, the last rung
of the ladder (lint → op → dc → ac → tran → **pcb**), resolves a footprint and a pin → pad map
for every component, checks the placement (P801–P807) and reports the **ratsnest**: the
connections the router will turn into copper.

```ts
import { bench, VoltageSource, Resistor, LED } from 'circuitsvibe';

export default bench('led-driver-board', (tb) => {
  const v1 = tb.add('V1', new VoltageSource(5));
  const r1 = tb.add('R1', new Resistor('330'));
  const d1 = tb.add('D1', new LED());
  v1.pin('+').connect(r1.pin('1'));
  r1.pin('2').connect(d1.pin('anode'));
  d1.pin('cathode').connect(tb.gnd);
  v1.pin('-').connect(tb.gnd);
  tb.expect.op('D1.i').toBeWithin('5m', '15m');

  tb.board({ width: 30, height: 20, holes: [{ x: 3, y: 3, d: 3.2 }, { x: 27, y: 17, d: 3.2 }] });
  tb.place('V1', { x: 5, y: 12, rot: 90 });   // a source is a 2-pin header (pad 1 = +)
  tb.place('R1', { x: 15, y: 10 });           // AXIAL-0.4 (board tech 'tht')
  tb.place('D1', { x: 25, y: 8, rot: 90 });   // LED-5MM
});
```

```
  ✓ pcb   pass
        board 30×20 mm, 2 layers, tht · 3 placed · 3 nets to route, 3 airwires (30.98 mm)
```

Status: footprints, placement checks and the ratsnest are done. **Routing**, design-rule
checks (P81x), current-aware trace widths, Gerber / Excellon / BOM / pick-and-place output and
the 3D view are the next phases.

## Coordinates and units

- Lengths are **millimetres** (the EDA convention: Gerber, Excellon, KiCad). The DSL also
  accepts strings with a unit: `'1.6mm'`, `'0.1in'`, `'100mil'`, `'2cm'`. A circuit document
  stores plain numbers in mm.
- Origin at the **lower-left** corner of a rectangular board, x to the right, **y up** (the
  Gerber convention).
- `rot` is in degrees, **counter-clockwise**, and any angle works. `side: 'bottom'` mirrors the
  footprint in x before rotating, as if you look through the board from the top.
- `x, y` is the **footprint origin**: the centre of its pads for every library footprint
  (`UNO-SHIELD`: the centre of the Uno board).

## `tb.board(spec)`

| Option | Default | |
|--------|---------|--|
| `width`, `height` | required for a rectangle | board size |
| `cornerRadius` | 0 | rounded corners of a rectangular board |
| `outline` | — | polygon `[[x, y], …]` instead of width/height (concave is fine) |
| `preset` | — | `'uno-shield'`: the Arduino Uno R3 outline (68.58 × 53.34 mm, chamfered tab) |
| `layers` | 2 | copper layers, 1 or 2 |
| `thickness` | 1.6 | board thickness |
| `tech` | `'tht'` | default footprint technology of **generic** parts: `'tht'` or `'smd'` |
| `holes` | `[]` | non-plated mounting holes `[{ x, y, d }]` |
| `rules.trace` | 0.25 | default trace width (used by the router) |
| `rules.clearance` | 0.2 | copper-to-copper clearance; also the keep-out around mounting holes |
| `rules.via` | `{ drill: 0.3, diameter: 0.6 }` | via geometry |
| `rules.edgeClearance` | 0.5 | minimum copper-to-edge distance (P801) |

Unknown options throw, so a typo fails at elaboration (exit 3) instead of being ignored.

## `tb.place(id, placement)`

```ts
tb.place('U1', { x: 20, y: 15 });                                   // default footprint, top
tb.place('R3', { x: 8, y: 4, rot: 90, side: 'bottom', footprint: '0805' });
tb.place('Q1', { x: 12, y: 9, footprint: 'SOT-23' });               // generic SOT-23 pinout
tb.place('U2', { x: 30, y: 9, footprint: 'DIP-14', pads: { VCC: '14' } });
tb.place('CLK', { offBoard: true });                                 // a bench instrument
tb.place('R5', { footprint: '1206' });                               // footprint only: P805 suggests a spot
```

- One `tb.place` per component, after `tb.board`, for a component registered with `tb.add`.
- Every component is either placed, or `{ offBoard: true }`. A part with a footprint and no
  position is **P805**, whose fix is a mechanical patch with a free spot.
- `pads` overrides the pin → pad map for the pins it names: `{ pin: 'pad' }` or
  `{ pin: ['pad', 'pad'] }`.
- `footprint` is a library name (case-insensitive) or a **custom footprint** object (below).

## Footprint library

`npx circuitsvibe catalog footprints` lists the library; `npx circuitsvibe catalog DIP-8`
prints the pads of one footprint. Geometry follows the KiCad standard libraries (IPC-7351
nominal land patterns for SMD chips).

| Family | Names |
|--------|-------|
| axial (R, L) | `AXIAL-0.3`, `AXIAL-0.4`, `AXIAL-0.5` (lead pitch in inches) |
| diodes | `DO-35`, `DO-41`, `SOD-123`, `SMA` (pads `K` = cathode, `A`) |
| capacitors | `DISC-5MM` (ceramic), `RADIAL-5MM`, `RADIAL-8MM` (electrolytic, pad 1 = +) |
| LEDs | `LED-3MM`, `LED-5MM`, `LED-0603`, `LED-0805` (pads `K`, `A`) |
| SMD chips | `0402`, `0603`, `0805`, `1206`, `1210` |
| transistors | `TO-92` (1.27 mm inline), `TO-220`, `TO-126`, `SOT-23` |
| ICs | `DIP-<n>` (n even, 4–64), `SOIC-<n>` (8, 14, 16; same numbering as DIP) |
| connectors | `HDR-1x<n>`, `HDR-2x<n>` (2.54 mm), `TERM-<n>` (5.08 mm screw terminal) |
| switches | `TACT-6MM` (pads with the same name are joined inside the part), `SW-SPDT` |
| boards | `UNO-SHIELD`: the Uno R3 header strips and its four mounting holes |

### Default footprints

**Catalog parts keep their datasheet package and pin numbers**: `Part('2N3904')` → TO-92 with
E/B/C on pads 1/2/3, `Part('BC547B')` → TO-92 with C/B/E, `Part('IRLZ44N')` → TO-220 G/D/S,
`Part('1N4148')` → DO-35. **ICs, op-amps and timers follow the board tech**, because DIP-n and
SOIC-n share the numbering: `Part('74HC04')` → DIP-14 on a `'tht'` board, SOIC-14 on an
`'smd'` one; `Part('LM358')` is channel 1 of a DIP-8 / SOIC-8. Discrete transistors keep their
package, because the SMD version of a part (MMBT3904) has another pinout.

**Generic parts use the board tech:**

| Part | `'tht'` | `'smd'` | Pinout |
|------|---------|---------|--------|
| Resistor | AXIAL-0.4 | 0805 | 1, 2 |
| Capacitor | DISC-5MM (< 1 µF), RADIAL-5MM (≥ 1 µF) | 0805 (1206 > 10 µF) | 1, 2 |
| Inductor | AXIAL-0.4 | 1210 | 1, 2 |
| Diode | DO-35 | SOD-123 | A, K |
| LED | LED-5MM | LED-0805 | A, K |
| NPN / PNP | TO-92 | SOT-23 | TO-92: E B C · SOT-23: B E C · TO-220: B C E |
| NMOS / PMOS | TO-92 | SOT-23 | TO-92: S G D · SOT-23: G S D · TO-220: G D S (bulk on the source pad) |
| OpAmp / IdealOpAmp | DIP-8 | SOIC-8 | standard single op-amp: 2 −, 3 +, 4 V−, 6 out, 7 V+ |
| Comparator | DIP-8 | SOIC-8 | LM393 channel 1 (1 out, 2 −, 3 +, 4 V−, 8 V+); with `emit`: LM311 |
| VoltageSource / CurrentSource | HDR-1x2 | HDR-1x2 | pad 1 = +, pad 2 = − |
| Switch / Button | SW-SPDT / TACT-6MM | same | Switch: a 1, com 2, b 3 · Button: 1, 2 |
| ArduinoUno | UNO-SHIELD | UNO-SHIELD | the Uno pin names |
| Mcu `atmega328p` / `attiny85` | DIP-28 / DIP-8 | DIP-28 / SOIC-8 | datasheet numbers; VCC → VCC + AVCC |

There is no footprint for logic primitives (`Clock`, `And`, `DFF`…), VHDL blocks,
`defineComponent` parts, or the ESP32 module and the RP2040 QFN: they are **P803** until you
give a footprint and a pad map, or put them `{ offBoard: true }`.

### Custom footprints

```ts
tb.place('J1', {
  x: 40, y: 10,
  footprint: {
    name: 'JST-PH-2',
    pads: [
      { name: '1', x: -1, y: 0, shape: 'rect', w: 1.2, h: 1.75, drill: 0.75 },
      { name: '2', x: 1, y: 0, shape: 'oval', w: 1.2, h: 1.75, drill: 0.75 },
    ],
    courtyard: [{ x: 0, y: 1.2, w: 6.5, h: 5.0 }],   // optional: default = the pads + 0.25 mm
  },
  pads: { '+': '1', '-': '2' },
});
```

A pad without `drill` is SMD, on the placement side. Custom footprints travel in the circuit
document (`pcb.footprints`), so share links keep them.

## The checks

| Code | |
|------|--|
| P801 | a courtyard sticks out of the outline, a pad is closer than `edgeClearance` to the edge, a board hole is outside |
| P802 | courtyards overlap on one side, a drilled pad is under a part on the other side, a part is on a mounting hole |
| P803 | no footprint |
| P804 | a connected pin has no pad |
| P805 | not placed: the fix is a mechanical `tb.place` patch at a free spot (1.27 mm grid, 0°/90°) near the pads it connects to |
| P806 | (warning) an off-board part reaches the board with no connector on its nets |
| P807 | invalid `pads` map (unknown pin or pad, two nets on one pad) |

Courtyards are the keep-out rectangles of a part: pads and body plus the 0.25 mm IPC-7351
nominal margin. Parts on opposite sides may overlap unless one of them is through-hole (its
pads exist on both layers).

## Ratsnest

For every net, the pads of the placed parts are joined by a **minimum spanning tree**
(straight-line distance). Pads that share a name on one part (the legs of a tactile switch,
the three GND pins of the Uno headers) are one node. The record lists every airwire
(`{ net, from: 'R1.2', to: 'D1.A', length }`) and the total length, a quick figure of merit
for a placement: lower is easier to route.

## RunRecord

```jsonc
"pcb": {
  "verdict": "pass",
  "pcb": {
    "board": { "width": 30, "height": 20, "layers": 2, "thickness": 1.6, "tech": "tht", "area": 600 },
    "placed": [{ "id": "R1", "footprint": "AXIAL-0.4", "tech": "tht", "x": 15, "y": 10, "rot": 0, "side": "top" }, …],
    "offBoard": [],
    "unplaced": [{ "id": "Q1", "footprint": "TO-92", "suggested": { "x": 24.13, "y": 6.35, "rot": 90 } }],
    "ratsnest": [{ "net": "led", "from": "D1.A", "to": "R1.2", "length": 4.97 }, …],
    "stats": { "placed": 3, "offBoard": 0, "unplaced": 0, "pads": 6, "nets": 3, "airwires": 3, "airwireLength": 30.98 }
  }
}
```

The layout is not part of the netlist hash: moving a part changes no simulation.

## Arduino Uno shields

```ts
tb.board({ preset: 'uno-shield' });
tb.place('U1', { x: 34.29, y: 26.67 });   // ArduinoUno → UNO-SHIELD, lined up with the outline
tb.place('V5', { offBoard: true });       // the Uno's own 5 V
```

The UNO-SHIELD pads carry the Uno pin names (`D13`, `A0`, `5V`, `GND`…) at the positions of
Arduino's UNO Rev3 board file, cross-checked against KiCad's `Arduino_UNO_R3` and Adafruit's
`ARDUINOR3` (pads 1.6 mm, drill 1.0 mm, mounting holes 3.2 mm). The courtyard is the four
header strips only, so parts fit between them.

## Viewer

A share link of a bench with a board opens a **PCB** tab: the outline, holes, courtyards
(red on error), pads by layer, silkscreen, reference designators, the ratsnest, and the
suggested spot of every unplaced part as a ghost. Drag to pan, wheel to zoom, double-click
to reset.
