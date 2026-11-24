/**
 * Diagnostic and rating codes of op-amps and comparators:
 * F120–F124 (lint, before the solver) and R420–R425 (datasheet checks of
 * real parts at the operating point, in stages.op.ratings).
 */
import type { DiagnosticDoc } from '../verify/registry';

export const AMPLIFIER_DIAGNOSTIC_DOCS: DiagnosticDoc[] = [
  {
    code: 'F120',
    slug: 'opamp-supply-unconnected',
    title: 'op-amp/comparator supply pins not connected',
    explanation: `OpAmp, Comparator and every Part() amplifier are macro models of real
parts: the output lives inside a window set by the supply rails ('v+' and
'v-'), the output current and the quiescent current flow through them. A
supply pin left open (or both pins on the same net) leaves the model without
an output window, so the result would be meaningless.

IdealOpAmp is different: its supply pins are optional. Leave BOTH open for an
unclamped ideal VCVS, or connect both to clamp the output to the rails; one
connected and one open is F120.

Fix: connect 'v+' to the positive supply and 'v-' to the negative supply, or
to gnd for a single-supply circuit (LM358, MCP6002, LM393 on 5 V).`,
  },
  {
    code: 'F121',
    slug: 'opamp-input-no-dc-path',
    title: 'op-amp/comparator input has no DC path',
    explanation: `An amplifier input draws (almost) no current, so it cannot fix its own
voltage: the input net needs a DC path through resistors, sources or the
feedback network. A net reached only through a coupling capacitor, a current
source or the input itself is floating — a real part drifts into a rail (its
bias current charges the capacitor), and the simulator would face a singular
matrix. F121 replaces the generic F101 for such nets and names the input.

Typical cause: an AC-coupled input (series capacitor) with no bias resistor,
or an integrator/comparator input fed only by a capacitor.

Fix: add a bias resistor from the input net to gnd or a mid-supply reference
(100k–1M), or close the DC feedback loop.`,
  },
  {
    code: 'F122',
    slug: 'opamp-positive-feedback',
    title: 'op-amp output feeds back only to the non-inverting input',
    explanation: `Following the passive network (resistors, capacitors, inductors, diodes,
closed switches) from an op-amp's output, the non-inverting input 'inp' is
reached but the inverting input 'inn' is not (the walk stops at gnd, at ideal
voltage sources and at other amplifier outputs). The loop gain is positive:
no linear operating point is stable and the output latches to a rail — the
circuit is a Schmitt trigger or a latch, not an amplifier.

This is a warning: positive feedback is sometimes intended. For a Schmitt
trigger use a Comparator (no warning); for an amplifier move the feedback to
'inn' (swap the inputs).`,
  },
  {
    code: 'F123',
    slug: 'ideal-opamp-output-forced',
    title: 'IdealOpAmp output shorted or in parallel with an ideal source',
    explanation: `The IdealOpAmp output is an ideal voltage source to ground (zero output
resistance). Wiring it to gnd, across an ideal voltage source (directly or
through other sources/inductors), or to another IdealOpAmp output
over-constrains the node: the MNA matrix is singular, like F104.

Fix: remove the short or the parallel source, add a series resistor at the
output, or use OpAmp — its finite output resistance and short-circuit current
limit simulate a shorted output (R422 then reports the current limit for a
Part()).`,
  },
  {
    code: 'F124',
    slug: 'open-collector-no-pullup',
    title: 'open-collector comparator output with no pull-up',
    explanation: `Comparator outputs (LM393, LM311) are open-collector: the output transistor
can only pull the output low. The high level comes from an external pull-up
resistor to a supply. Following DC paths from the output net (not through gnd
and not through the comparator itself) reaches no voltage source, current
source or op-amp output, so nothing can drive the output high: its "high"
value would just be the leakage settling point.

Fix: add a pull-up resistor (typically 1k–10k) from the output to the logic
supply. An unused output left completely open is only F106.`,
  },
  {
    code: 'R420',
    slug: 'opamp-supply-over-max',
    title: 'op-amp/comparator supply above its absolute maximum',
    explanation: `At the DC operating point V(v+) − V(v-) of a Part() op-amp or comparator
exceeds the datasheet absolute maximum supply voltage (catalog
ratings.supplyMax, total across the rails). The real part would be damaged;
the macro model has no breakdown and would keep simulating as if nothing
happened. The op stage fails (exit 1, like an assertion): the circuit is
valid, the part is over-stressed.

Fix: lower the supply (e.g. ±15 V instead of ±18 V for a 32 V part), or pick
a part with a higher supply rating (circuitsvibe catalog lists them).`,
  },
  {
    code: 'R421',
    slug: 'opamp-differential-input-over-max',
    title: 'differential input voltage above its absolute maximum',
    explanation: `|V(inp) − V(inn)| at the operating point exceeds the datasheet absolute
maximum differential input voltage (ratings.differentialInputMax). Large
differential inputs break down the input transistors' junctions or the
internal clamp diodes conduct heavily — neither is in the macro model.

Fix: limit the input swing (series resistors with clamp diodes), or choose a
part rated for the differential voltage (comparators often allow the full
supply).`,
  },
  {
    code: 'R422',
    slug: 'opamp-output-current-limit',
    title: 'op-amp output at its short-circuit current limit',
    explanation: `The output current of a Part() op-amp is at 90 % or more of the
short-circuit current the model takes from the datasheet: the output is
shorted or overloaded, the feedback has lost control of the output voltage,
and the part dissipates (V+ − Vout)·Iout (sourcing) or (Vout − V−)·Iout. The
limit itself is modelled (smoothly), so the simulated numbers show a
current-limited output — but that is almost never the intended operating
point.

Fix: raise the load resistance, add a buffer/transistor stage for heavy
loads, or remove the short.`,
  },
  {
    code: 'R423',
    slug: 'opamp-input-common-mode',
    title: 'input outside the input common-mode range',
    explanation: `An op-amp input sits outside the datasheet input common-mode range
(inputCommonModeLow/High, relative to the rails; typical values when
printed). Outside it a real op-amp loses gain, its offset grows and some
parts show phase reversal — the macro model does NOT simulate any of that, so
its output is not trustworthy there. For a comparator only one input needs to
be inside the range (LM393, LM311 datasheets), so R423 fires when both are
outside.

The result reports value/limit as distances: an input above the range is
V(in) − V(v-) against the allowed top, below it V(v+) − V(in) against the
allowed bottom.

Fix: shift the input bias into the range, widen the supply, or use a
rail-to-rail-input part (MCP6002).`,
  },
  {
    code: 'R424',
    slug: 'opamp-input-over-max',
    title: 'input voltage beyond its absolute maximum',
    explanation: `An input is driven beyond the datasheet absolute maximum input voltage
(ratings.inputVoltageMin/Max relative to a rail): e.g. an LM358 input more
than 0.3 V below V-, a TL072 input more than 0.5 V beyond a rail. The input
protection/substrate diodes conduct and the part can latch up or be
damaged. Only rail-relative ratings are checked (parts whose limits are
printed as absolute ±15 V, like LM741/NE5532/LM311, are not).

Fix: clamp the input with a series resistor and diodes to the rails, or keep
the input within the supply.`,
  },
  {
    code: 'R425',
    slug: 'opamp-supply-below-min',
    title: 'supply below the recommended operating minimum',
    explanation: `V(v+) − V(v-) is below the minimum recommended supply of the part
(characteristics.supply.single.min — e.g. 20 V total for an LM741C, 3 V for an
LM358). Datasheet characteristics, and therefore the macro model built from
them, are only specified inside the operating range: the simulated gain,
swing and speed are not valid there. The result reports the required minimum
as value and the actual supply as limit (passes when required ≤ actual).

Fix: raise the supply, or choose a low-voltage part (MCP6002 runs from 1.8 V).`,
  },
];
