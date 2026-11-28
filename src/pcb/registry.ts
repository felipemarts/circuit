/**
 * Registry entries of the board stage (src/pcb): P801–P808 placement and
 * board options, P810–P813 routing, design rules and trace current. Merged
 * into DIAGNOSTIC_DOCS (src/verify/registry.ts).
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
  {
    code: 'P808',
    slug: 'unknown-net',
    title: 'tb.board({ nets }) names a net the circuit does not have',
    explanation: `Per-net trace widths are keyed by net name — tb.board({ nets: { vcc: { width:
0.8 } } }) — and the name is not a net of the circuit. Only named nets can be
addressed: auto-generated names (n1, n2…) change when the circuit changes.
Fix: name the net with tb.name('vcc', <a pin on it>), or correct the key.`,
  },
  {
    code: 'P810',
    slug: 'unrouted',
    title: 'the autorouter could not make a connection',
    explanation: `After placement the pcb stage routes every net on a grid (rules.grid, default
0.25 mm): A* with 45° moves, a bend penalty and vias between the two layers,
each move checked on the real copper shapes so the trace (its width) keeps
rules.clearance from every other net, rules.edgeClearance from the edge and
the clearance from drilled holes. Nets go shortest-first; failed nets are
retried first in up to four passes. A connection that still finds no path is
reported here with the airwires left (stages.pcb.pcb.routing.unrouted).
Usual causes: a pad boxed in by other nets' pads (rotate or move the part so
the pads that connect face each other), a single-layer board with crossing
nets (layers: 2), a wide trace (a big simulated current or a nets override)
that fits no gap, or simply a board too small for the parts.`,
  },
  {
    code: 'P811',
    slug: 'clearance',
    title: 'copper breaks a design rule (clearance, hole or edge)',
    explanation: `The design-rule check measures the final copper — tracks, vias and pads as
real shapes — independently of the router: two nets closer than
rules.clearance on the same layer (they can short when the board is etched),
copper closer than the clearance to a non-plated hole, or a track/via closer
than rules.edgeClearance to the board edge (the fab's routing tool cuts it).
Pad-to-pad spacing inside one footprint is the footprint's own and is not
checked here. The router keeps these rules by construction, so a P811 is
unexpected: move the parts around the reported spot apart and report the bench.`,
  },
  {
    code: 'P812',
    slug: 'trace-current',
    title: 'a trace is too narrow for the current it carries (rating, exit 1)',
    explanation: `Each net's current is taken from the simulation — half the sum of its pins'
current magnitudes (no copper segment of the net carries more; pins whose
current the models do not report, such as ICs, MCUs and custom parts, get
their share by KCL), at the operating point and as the RMS over the second
half of each transient run (start-up inrush left out), the larger of the two —
and compared with what the trace width carries per IPC-2221B §6.2:
  I = 0.048 · ΔT^0.44 · A^0.725   (A in mil², outer layer)
with ΔT = rules.tempRise (default 10 °C) and the copper of rules.copper
(default 1 oz = 35 µm). The stage sizes every trace itself (the minimum rule
rules.trace, widened in 0.05 mm steps when the current needs it), so this
fails only when tb.board({ nets: { <net>: { width } } }) forces a narrower
trace. Like a datasheet rating it is a verified simulated stress: exit 1, in
stages.pcb.ratings (tb.ratings({ derate }) applies). Fix: widen the override
or drop it.`,
  },
  {
    code: 'P813',
    slug: 'widths-not-current-checked',
    title: 'trace widths were not sized from the circuit currents (warning)',
    explanation: `The run routed the board without simulating it (--stage pcb, or a bench with
no analog operating point), so every trace has rules.trace or its nets
override and nothing was rated against the current. Verify with the
simulation stages (the default) before making the board.`,
  },
];
