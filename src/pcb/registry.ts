/**
 * Registry entries of the board layout stage (src/pcb): P801–P807. Merged
 * into DIAGNOSTIC_DOCS (src/verify/registry.ts). P81x is reserved for routing
 * and design-rule checks.
 */
import type { DiagnosticDoc } from '../verify/registry';

export const PCB_DIAGNOSTIC_DOCS: DiagnosticDoc[] = [
  {
    code: 'P801',
    slug: 'outside-board',
    title: 'a part (or a mounting hole) is outside the board, or its copper is too close to the edge',
    explanation: `A placed footprint's courtyard is not entirely inside the board outline, a
pad is closer to the edge than rules.edgeClearance (default 0.5 mm), or a
board mounting hole is outside the outline. The fab mills the outline with a
tolerance of a few tenths of a millimetre: copper at the edge gets cut or
exposed, and a courtyard over the edge means the part does not fit.

Positions are the footprint origin (the centre of its pads), in mm from the
board's lower-left corner, y up; rot is degrees counter-clockwise.
Fix: move the part inward, rotate it (a 90° turn often fits a long axial part),
or enlarge the board (tb.board({ width, height })).`,
  },
  {
    code: 'P802',
    slug: 'courtyard-overlap',
    title: 'two parts overlap, or a part sits on a mounting hole',
    explanation: `Two courtyards on the same side of the board overlap (a courtyard is a
part's keep-out: pads, body and the assembly margin, IPC-7351 nominal 0.25 mm),
a through-hole part's pads are under a part on the other side (drilled pads
exist on both layers), or a courtyard comes closer to a mounting hole than its
radius plus the clearance rule (the screw head and washer need that room).
Parts on opposite sides may overlap when neither pierces the other.
Fix: move one part by at least the reported depth, rotate it, put an SMD part
on the other side (side: 'bottom'), or move the hole.`,
  },
  {
    code: 'P803',
    slug: 'no-footprint',
    title: 'a component has no physical footprint',
    explanation: `The component has no land pattern: an abstract part (logic primitives such
as Clock/And/DFF, VHDL blocks, defineComponent parts), a microcontroller
profile whose package has no library footprint yet (ESP32 module, RP2040
QFN), or tb.place named a footprint that is neither in the library nor given
as a custom footprint. Footprint defaults: catalog parts keep their datasheet
package (Part('2N3904') → TO-92; ICs follow the board tech: DIP-n or SOIC-n);
generic parts use the board's tech ('tht': AXIAL-0.4, DISC-5MM/RADIAL-5MM,
DO-35, LED-5MM, TO-92, DIP-8; 'smd': 0805, SOD-123, LED-0805, SOT-23, SOIC-8);
sources become a 2-pin header (HDR-1x2), an ArduinoUno the UNO-SHIELD headers.
Fix: give a footprint and a pad map — tb.place('U1', { x, y, footprint:
'DIP-14', pads: { a: '1', y: '2' } }) or a custom one { name, pads: [{ name,
x, y, w, h, drill? }] } — or keep the part off the board with { offBoard: true }.
\`circuitsvibe catalog footprints\` lists the library.`,
  },
  {
    code: 'P804',
    slug: 'pin-without-pad',
    title: 'a connected pin has no pad on its footprint',
    explanation: `The pin is on a net with other pins, but the footprint's pin → pad map has no
pad for it, so the net would be cut on the board. This happens with an
explicit footprint whose pads do not match the part's pinout (an op-amp on a
footprint without its supply pads, a 3-pin footprint for a 4-terminal
MOSFET with a separate bulk pin). Pins left unconnected (alone on their net)
need no pad. Fix: map the pin with tb.place(id, { pads: { <pin>: '<pad>' } }),
or pick a footprint whose pinout covers every connected pin.`,
  },
  {
    code: 'P805',
    slug: 'not-placed',
    title: 'an on-board part has no position',
    explanation: `The bench declares a board (tb.board) and this component has a footprint,
but no position. Every part is either placed — tb.place(id, { x, y, rot?,
side? }) — or explicitly off the board ({ offBoard: true }).
The fix carries a mechanical patch: a free spot (1.27 mm grid, 0° or 90°)
inside the outline, clear of the other parts and holes, as close as possible to
the pads it connects to. It is a starting point, not an optimized placement;
when no spot fits, enlarge the board.`,
  },
  {
    code: 'P806',
    slug: 'off-board-without-connector',
    title: 'an off-board part is wired to the board with no connector (warning)',
    explanation: `A component marked { offBoard: true } (an external supply, a signal
generator) shares nets with on-board parts, but none of those nets reaches a
connector on the board (a placed source, a pin header HDR-*, a terminal block
TERM-*, the UNO-SHIELD headers). The board as laid out has no way for that
supply or signal to come in. Fix: place the source on the board — its
footprint is a 2-pin header (pad 1 = +) — or add a connector on those nets.`,
  },
  {
    code: 'P807',
    slug: 'bad-pad-map',
    title: 'the pin → pad map is invalid',
    explanation: `tb.place(id, { pads }) maps a pin the component does not have, or a pad the
footprint does not have, or the resulting map puts two pins on different nets
on the same pad (one pad is one electrical node — it would short them).
Pads that share a name are joined inside the part (a tactile switch's legs),
so mapping one pin to both is fine; two nets on one pad is not.
Fix: map every pin to a pad of the chosen footprint (the message lists them).`,
  },
];
