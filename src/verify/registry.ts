/**
 * Diagnostic registry — the stable code taxonomy and its long-form
 * explanations (`circuitsvibe explain <code>`). Codes are permanent: parsers and
 * agents may key on them, so they are never renumbered or reworded away.
 *
 *   F1xx  structural lint (pre-solve topology)
 *   S1xx  linear solver
 *   S2xx  nonlinear solver (Newton-Raphson), transient stepping, AC models
 *   A3xx  assertion outcomes
 *   T0xx  tooling / bench authoring
 *   D5xx  digital runtime (D501–D507 engine, D508–D549 mixed-signal bridges)
 *   F13x  digital lint (F130–F134 engine, F135–F139 bench level)
 *   M6xx  MCU / firmware runtime (M601–M649)
 *   F14x  firmware lint (F140–F149)
 */

export interface DiagnosticDoc {
  code: string;
  slug: string;
  title: string;
  explanation: string;
}

export const DIAGNOSTIC_DOCS: DiagnosticDoc[] = [
  {
    code: 'F101',
    slug: 'floating-net',
    title: 'net has no DC path to ground',
    explanation: `Every net needs a DC-conductive path (resistor, source, inductor, diode,
switch) down to ground, or its operating-point voltage is mathematically
undefined — the MNA matrix becomes singular. Capacitors block DC and current
sources do not fix node voltages, so a net reachable only through them floats.

Typical causes: a coupling capacitor feeding an otherwise unconnected stage,
or a current source driving a node with no resistive return.

Fixes: give the net a DC path — a bleed resistor (100k–10M) to ground is the
classic remedy — or rewire the net to one that already has a path.`,
  },
  {
    code: 'F103',
    slug: 'unreached-component',
    title: 'component not connected to the grounded circuit',
    explanation: `The simulator solves the connected subgraph that contains ground. A
component (or island of components) with no connection to that subgraph
cannot be simulated — and silently ignoring it would hand back confidently
wrong numbers (its voltages would read 0 V). It is therefore a hard error.

Fixes: wire the component into the circuit, connect the circuit's return
path to tb.gnd, or remove the component.`,
  },
  {
    code: 'F104',
    slug: 'voltage-source-loop',
    title: 'ideal voltage source shorted or looped',
    explanation: `An ideal voltage source demands a fixed potential difference across zero
impedance. Shorting one (both terminals on the same net), or connecting two
in parallel (directly or through other sources), over-constrains the system:
the MNA matrix is singular even when the values happen to agree.

At the DC operating point an inductor is a 0 V ideal source, so an inductor
directly across a voltage source triggers this too.

Fixes: rewire so no source loop exists; if the parallel connection is
intentional, add a small series resistance (e.g. 10m ohm) in one branch.`,
  },
  {
    code: 'F105',
    slug: 'source-clamped-diode',
    title: 'diode/LED forward-clamped directly across an ideal source',
    explanation: `An ideal voltage source fixes the voltage across anything in parallel with
it. A forward-biased diode or LED clamped this way has its exponential I-V
curve evaluated at the full source voltage — the current is astronomically
large (e.g. ~1e22 A for an LED at 5 V) and Newton-Raphson diverges or the
matrix goes singular. Real diodes would simply burn.

Fix: always insert a series resistor between the source and the diode.
Size it as R = (Vsource - Vf) / Itarget; for an LED at 5 V and 10 mA,
around 270–330 ohm.

A reverse-biased diode across a source is fine (current ~ 0) and does not
trigger this error.`,
  },
  {
    code: 'F106',
    slug: 'dangling-pin',
    title: 'pin not connected to anything',
    explanation: `A pin whose net contains only itself carries no current. Sometimes that is
intentional (an unused switch throw); usually it means a forgotten wire.
This is a warning — it never blocks simulation.`,
  },
  {
    code: 'S101',
    slug: 'unsolvable-system',
    title: 'solver could not solve the circuit',
    explanation: `The linear system could not be solved (singular matrix) for a reason the
lint stage did not model. This should be rare: F101/F103/F104 catch the
common causes before the solver runs. If you see S101, inspect the most
recently changed components and nets, and report the netlist — this may be
a platform gap.`,
  },
  {
    code: 'S201',
    slug: 'nr-nonconvergence',
    title: 'Newton-Raphson did not converge (DC operating point)',
    explanation: `The nonlinear iteration did not settle. The diagnostic names the worst
component (largest voltage delta on the final iteration) and its recent
voltage history; an a-b-a-b oscillation pattern is typical of a stiff
exponential branch — a diode or LED driven hard with no series resistance.

Before reporting S201 the solver has already tried, in order: plain Newton
with SPICE pn-junction voltage limiting, gmin stepping (a shunt conductance
from every node to ground, relaxed decade by decade from 10 mS to 0) and
source stepping (every independent source ramped from 0 to its value). The
diagnostic's evidence.attempts lists each strategy with its iteration count.
When one of the aids rescues the solve there is no diagnostic: the op stage
telemetry (stages.op.solver.aids) says which one was needed.

In the dc stage S201 means one sweep point failed; evidence.sweep names the
swept component and value.

Fixes: add series resistance in the offending branch (even 1–10 ohm helps);
check source polarity and magnitude.`,
  },
  {
    code: 'S202',
    slug: 'nr-nonconvergence',
    title: 'Newton-Raphson did not converge (transient step)',
    explanation: `Same failure mode as S201, but during a transient timestep. On a Newton
failure the stepper cuts the step by 8 and retries with Backward Euler;
S202 is reported only once the step would fall below the minimum step
(maxStep·1e-9). The message and evidence carry the simulation time and the
last step tried, plus the worst device.

Besides the S201 fixes: give abrupt source edges a finite rise/fall time
(tr/tf), since an ideal edge into a stiff nonlinear branch is the usual cause.`,
  },
  {
    code: 'S203',
    slug: 'timestep-too-small',
    title: 'transient timestep collapsed below the minimum',
    explanation: `The adaptive stepper controls the local truncation error of every
capacitor charge and inductor flux; a step whose error estimate exceeds the
tolerance is rejected and retried with a smaller step. S203 means the step
had to shrink below the minimum (maxStep·1e-9), or the step budget ran out,
while Newton itself converged. The diagnostic names the reactive element
whose truncation error forced the cuts and the simulation time.

Typical causes: a time constant many orders of magnitude below the
simulated window (a capacitor charged through a near-zero resistance), or
an oscillation much faster than the window.

Fixes: add realistic series resistance; shorten tstop; give the bench a
smaller maxStep (the minimum step scales with it) if the fast dynamics are
real.`,
  },
  {
    code: 'S204',
    slug: 'no-ac-model',
    title: 'component has no AC small-signal model',
    explanation: `AC analysis linearizes every component around the DC operating point.
Built-in components all have small-signal models (a diode becomes its
junction conductance at the operating point). A defineComponent part needs an
ac(ctx) stamp — ctx.stampConductance / stampCapacitance / stampAdmittance /
stampTransconductance, with ctx.voltage(pin) returning operating-point
voltages — or the AC stage refuses to guess and reports S204, naming the
components.`,
  },
  {
    code: 'A301',
    slug: 'assertion-failed',
    title: 'assertion failed',
    explanation: `The circuit simulated fine but did not meet the spec. The result carries
the measured value, the expected check, the margin, and — when the bench
declares a free parameter via tb.param — a verified hint: a parameter range
that was actually simulated and passes ALL op assertions.

Trust contract: hints marked 'verified' were simulated; apply them directly.
If no hint is present, the topology itself likely cannot meet the spec.`,
  },
  {
    code: 'T002',
    slug: 'stage-crash',
    title: 'a verification stage crashed',
    explanation: `A stage runner (op/tran) threw an unexpected error after successful
elaboration. This is a platform bug, not a statement about your circuit —
the RunRecord is still emitted so nothing is lost. Please report the bench
file that triggered it.`,
  },
  {
    code: 'T003',
    slug: 'no-ac-stimulus',
    title: 'AC assertions but no AC stimulus',
    explanation: `AC analysis is driven only by sources given an AC magnitude:
new VoltageSource({ dc: 2.5, ac: 1 }) or { ac: { mag: 1, phase: 0 } }. A DC
value only sets the operating point. With no stimulus every small-signal
quantity is 0, so the bench is rejected (exit 3) instead of reporting -inf dB.
Fix: give the input source an ac value.`,
  },
  {
    code: 'T004',
    slug: 'ambiguous-ac-reference',
    title: 'several AC stimuli and no explicit reference',
    explanation: `gainAt/phaseAt/bandwidth3dB/... measure H = probe / reference. By default
the reference is THE stimulus phasor, which is only defined with exactly one
AC source. With several, name the reference probe:
tb.expect.ac({...}).probe('out', { ref: 'in' }) measures V(out)/V(in).`,
  },
  {
    code: 'T001',
    slug: 'bench-error',
    title: 'bench code threw during elaboration',
    explanation: `The bench build function itself raised an error (bad probe name, duplicate
id, invalid unit string, ...). This is an authoring error in the bench file,
not an electrical result. The message pinpoints what to fix; correct the
bench code and re-run.`,
  },

  // ── digital engine (src/digital): F13x digital lint, D5xx digital runtime/timing ──
  {
    code: 'F130',
    slug: 'floating-input',
    title: 'digital input pin on a net with no driver',
    explanation: `A logic input whose net is driven by nothing — no output, no Const/Pull,
no declared external input. A floating CMOS input picks up noise and sits
mid-rail; the simulator reads it as Z, which every gate treats as X, so
everything downstream becomes unknown.

Fixes: connect it to the output that should drive it; tie it to a level with
a Const (or a Pull for a default level); or, if it is driven from outside
(testbench or an analog bridge), declare it with c.input(net).`,
  },
  {
    code: 'F131',
    slug: 'multiple-drivers',
    title: 'push-pull output shares a net with other drivers',
    explanation: `A push-pull output (gate, flip-flop, Const, Clock, Stimulus) always drives a
hard 0 or 1. Any other non-weak driver on the same net — another output, a
tri-state, or an external input — fights it whenever their values differ:
the level is undefined (X) and real parts conduct a large shoot-through
current.

Fixes: shared buses need TriBuf outputs with mutually exclusive enables
(plus a Pull for the idle level); otherwise merge the signals with a gate
or a Mux instead of wiring outputs together.`,
  },
  {
    code: 'F132',
    slug: 'output-short',
    title: 'outputs of the same part shorted together',
    explanation: `Two outputs of one part are on the same net — typically q tied to qn, or
two bits of a counter. They normally carry different values, so the net is
in contention most of the time.

Fix: keep only one of the outputs on the net.`,
  },
  {
    code: 'F133',
    slug: 'zero-delay-loop',
    title: 'combinational loop with zero total delay',
    explanation: `A feedback loop through combinational elements (gates, buffers, muxes,
transparent latches, async set/reset paths) whose delays are all zero. The
whole loop is evaluated in delta cycles at a single instant: an inverting
loop oscillates forever (the runtime stops it with D504), a non-inverting
one latches to an arbitrary value. Edge-triggered flip-flops break loops
and are not reported.

Fixes: give an element of the loop a real propagation delay (an intended
ring oscillator or SR latch then simulates physically), or break the loop
with a flip-flop if the feedback is meant to be synchronous.`,
  },
  {
    code: 'F134',
    slug: 'unconnected-clock',
    title: 'clock input not driven',
    explanation: `The clock pin of an edge-triggered element (DFF, JKFF, Counter,
ShiftRegister) is on a net nothing drives. The element can never see an
edge, so it holds its power-on state forever — almost certainly a missing
wire.

Fix: drive it from a Clock or from the design's clock net.`,
  },
  {
    code: 'D501',
    slug: 'drive-contention',
    title: 'strong 0 and strong 1 drive the same net',
    explanation: `During simulation two strong drivers put opposite values on one net at the
same time (two push-pull outputs, or two tri-states enabled together). The
net resolves to X and the diagnostic names who drove 0 and who drove 1, and
when. Real hardware would short the supply through both output stages.

Fixes: make tri-state enables mutually exclusive (check the timing of the
enable logic — overlap of even one gate delay is contention), or replace the
wired connection with a gate or Mux.`,
  },
  {
    code: 'D502',
    slug: 'setup-violation',
    title: 'setup time violated at a clock edge',
    explanation: `A data input of a sequential element (flip-flop, latch closing edge,
counter/shift-register control) changed less than the configured setup time
before the active edge. Real flip-flops may go metastable; the simulator
drives X on the outputs (onViolation: 'x', the default) or captures
normally and only reports (onViolation: 'keep').

The diagnostic carries the element, pin, edge time, measured interval and
margin (measured - required, negative).

Fixes: make the data arrive earlier (shorter logic path, lower clock
frequency, shifted stimulus), or move the clock edge.`,
  },
  {
    code: 'D503',
    slug: 'hold-violation',
    title: 'hold time violated after a clock edge',
    explanation: `A data input changed less than the configured hold time after the active
edge, corrupting the value being captured. Common in shift chains whose
clock-to-q delay is shorter than the hold time, or with clock skew.

Fixes: add delay on the data path (or reduce skew) so the data stays stable
for the hold time after the edge.`,
  },
  {
    code: 'D504',
    slug: 'delta-cycle-limit',
    title: 'zero-delay activity did not settle',
    explanation: `At one time point the zero-delay elements kept re-triggering each other for
more delta cycles than allowed (maxDeltaCycles, default 1000) — the runtime
form of a zero-delay loop (see F133), e.g. an inverting loop enabled at that
instant. The remaining events of that time point are dropped so the
simulation can continue; the diagnostic names the elements still switching.

Fix: give an element of the loop a non-zero delay, or break it with a
flip-flop.`,
  },
  {
    code: 'D505',
    slug: 'drive-in-past',
    title: 'external drive scheduled before the current time',
    explanation: `drive(net, value, t) was called with t earlier than the simulator's
current time. An event kernel cannot change the past (those changes were
already processed and reported), so the value is applied at the current
time instead. In a co-simulation loop this means the analog side advanced
the digital engine past a threshold crossing before reporting it.

Fix: call drive() before advanceTo() moves past that time — shorten the
analog step to the crossing first, then advance the digital side.`,
  },
  {
    code: 'D506',
    slug: 'unknown-control',
    title: 'clock or asynchronous control is X/Z',
    explanation: `A clock pin made a transition through X/Z (0 -> X, X -> 1, ...) or an
asynchronous set/reset or latch enable is X/Z, and acting on it would
change the stored state. Since it is unknown whether the edge or control
happened, the outputs go to X. Usually caused by an undriven or contended
control net, or a stimulus that starts at X.

Fix: make the control net a defined 0/1 (initialize it, add a Pull, or fix
the contention upstream).`,
  },
  {
    code: 'D507',
    slug: 'weak-contention',
    title: 'pull-up and pull-down on the same net',
    explanation: `Two weak drivers of opposite value (a pull-up and a pull-down) are the only
active drivers of a net, so it sits at the divider midpoint — neither 0 nor
1 — and resolves to X. A strong driver on the net would override both.
This is a warning.

Fix: keep a single Pull per net.`,
  },
  // ── mixed-signal (src/mixed): F135–F139 bench-level digital lint, D508–D549 bridge runtime ──
  {
    code: 'F135',
    slug: 'ic-supply-unconnected',
    title: 'IC supply pin (VCC/GND) unconnected or shorted to the other',
    explanation: `A real IC (Part('74HC00'), Part('NE555'), ...) is powered only through its
supply pins: every input threshold, output level and drive current is
referenced to V(VCC) - V(GND). An IC whose VCC (VDD) or GND (VSS) pin is
not connected — or whose VCC and GND sit on the same net — has no supply,
so the bench is structurally wrong before any solve.

Fix (mechanical): connect the VCC pin to the supply's + terminal and the
GND pin to tb.gnd: u1.pin('VCC').connect(v1.pin('+')); u1.pin('GND').connect(tb.gnd).`,
  },
  {
    code: 'F136',
    slug: 'outputs-tied',
    title: 'two push-pull logic outputs on one analog net',
    explanation: `Two logic outputs (IC pins or bridged primitives) drive the same analog
net and at least one is push-pull. Whenever they disagree the supply is
shorted through both output stages — contention through the analog net —
and the level is set by the ratio of their output resistances. (The
digital-only counterpart on pure-digital nets is F131.)

Fixes: keep one driver per net; combine the signals with a gate; for a
shared bus use tri-state outputs (74HC595 QA–QH, TriBuf) with mutually
exclusive enables.`,
  },
  {
    code: 'F137',
    slug: 'floating-logic-input',
    title: 'logic input with nothing that sets its voltage',
    explanation: `A logic input pin (IC input, NE555 TRIG/THRES/RESET, or a bridged primitive
input) is on an analog net where nothing defines the voltage: no output, no
resistor/source/diode/switch path, only other inputs or capacitors. A
floating CMOS input drifts to an undefined level — the logic value is
unknown, the input can oscillate and draw shoot-through current.

Severity: error, except for inputs of an UNUSED section of a multi-gate IC
(e.g. gates 2–4 of a 74HC00 whose outputs are also open), which is a warning:
the simulator holds them low, but the datasheet still requires tying them.

Fixes: drive the input from an output, or tie it to a rail directly or
through a pull-up/pull-down resistor (mechanical for unused sections: tie
them to tb.gnd).`,
  },
  {
    code: 'F138',
    slug: 'output-on-rail',
    title: 'logic output tied to ground or to an ideal source',
    explanation: `A logic output pin is wired to ground, to an IC supply rail or to the
terminal of an ideal voltage source. Whenever it drives the opposite level
the current is limited only by its output resistance (tens of ohms) — far
above the absolute maximum, and the source wins the level anyway.

Fix: disconnect the output. To tie off an unused gate, tie its INPUTS to a
rail and leave its output open.`,
  },
  {
    code: 'D508',
    slug: 'input-forbidden-zone',
    title: 'logic input between VIL and VIH for too long',
    explanation: `A non-Schmitt logic input sat between the datasheet VIL(max) and VIH(min)
of its family at its actual supply (e.g. 74HC at 5 V: 1.5 V and 3.5 V):
  - at the operating point (static: the input is stuck there), or
  - in the transient, for longer than the datasheet's maximum input
    transition time at that supply (74HC: 1000/500/400 ns at 2/4.5/6 V,
    interpolated; 74HCT: 500 ns). Parts without a stated limit (CD4011)
    are checked only at the operating point.
In that zone both input transistors conduct: the level is undefined, the
gate can oscillate on a slow edge and draws shoot-through current.

Model: a rising input is recognised at VIH, a falling one at VIL (the
guaranteed levels); between them the previous value is held.

Fixes: drive the pin to a valid level (check the divider or pull resistor);
speed up the edge; or square up slow signals with a Schmitt-trigger input
(Part('74HC14'); the CD4017 CLOCK pin is a Schmitt input too).`,
  },
  {
    code: 'D509',
    slug: 'supply-out-of-range',
    title: 'IC supply outside its operating range',
    explanation: `V(VCC) - V(GND) of an IC is outside the datasheet's recommended operating
range (74HC 2–6 V, 74HCT 4.5–5.5 V, CD4000B 3–18 V, NE555 4.5–16 V):
  - warning when it is still below the absolute maximum: thresholds, drive
    and delays are extrapolated from the datasheet points and not guaranteed;
  - error above the absolute maximum (74HC 7 V, CD4000B 20 V, NE555 18 V) or
    below -0.5 V (reversed supply): the part would be damaged.
Checked at the operating point and at every accepted transient step
(reported once per IC, with time).

Fix: power the IC from its recommended range (use 74HC instead of 74HCT
below 4.5 V).`,
  },
  {
    code: 'D510',
    slug: 'ic-unpowered',
    title: 'IC unpowered (supply below half the minimum operating voltage)',
    explanation: `The IC's supply is below half its minimum recommended operating voltage
(74HC: 1 V, CD4000B: 1.5 V, NE555: 2.25 V — a model threshold). Below that
the outputs are modeled high-Z and the IC does nothing useful.
  - op stage: warning (the operating point is computed with the outputs off;
    a power-up ramp from 0 V legitimately starts there);
  - tran stage: error when the IC was never powered during the run, or lost
    its supply after being powered (brown-out, with the time).

Fixes: connect VCC to a stiff supply; do not feed an IC through a large
series resistor; reduce the load on its outputs.`,
  },
  {
    code: 'D511',
    slug: 'output-overcurrent',
    title: 'logic output current above the absolute maximum (overload or contention)',
    explanation: `An output pin sources or sinks more than the datasheet absolute maximum
(74HC/74HCT: 25 mA per pin, 74HC595: 35 mA, NE555: 225 mA; CD4000B: more
than its 100 mW per output transistor). Measured from the output-stage
model (Rout from the datasheet VOH/VOL rows) at the operating point and at
every accepted transient step.

When another output on the same analog net drives the opposite level the
message names both: that is contention through the analog net.

Fixes: add a series resistor (an LED needs one even on a logic output);
buffer high loads with a transistor; never tie push-pull outputs together.`,
  },
  {
    code: 'D512',
    slug: 'unknown-output',
    title: 'an X (unknown) logic value drives an analog net',
    explanation: `An IC or bridged primitive output pin connected to an analog net carries X
(unknown). The output stage is modeled half-on — a mid-rail level — which a
real part could resolve either way. X comes from undefined inputs
(floating, contention), setup/hold violations (D502/D503) or an
uninitialized feedback loop. Warning; look for the upstream cause.`,
  },
  {
    code: 'D513',
    slug: 'input-clamp-overcurrent',
    title: 'input protection-diode current above the absolute maximum',
    explanation: `A CMOS input is driven beyond its rails (above VCC or below GND) and its
ESD protection diode conducts more than the datasheet |IIK| absolute
maximum (74HC: 20 mA). Inputs are modeled with clamp diodes to VCC and GND
(Part(id, { clamp: false }) removes them). Large clamp currents cause
latch-up and can back-power an unpowered IC through its input.

Fixes: add a series resistor (e.g. 10k) in front of the input; keep the
driving signal within 0..VCC; power the IC before driving its inputs.`,
  },
  {
    code: 'D514',
    slug: 'no-static-logic-state',
    title: 'no consistent DC logic state (the circuit oscillates)',
    explanation: `At a DC point (operating point, DC sweep, transient t = 0) the logic
outputs are held at fixed levels consistent with the analog solution:
solve, re-classify every input, power the logic on with those inputs,
update the outputs, repeat. If the outputs keep changing the inputs that set
them (an RC oscillator around an inverter, a 555 astable — capacitors are
open at DC) there is no such state. Warning: the reported operating-point
values use the outputs of the last pass.

Fix: assert on oscillators in the transient (tb.expect.tran / tb.expect.logic,
with ic: 'zero'), not at the operating point.`,
  },
  // ── M6xx: MCU / firmware runtime ──
  {
    code: 'M601',
    slug: 'firmware-exception',
    title: 'firmware threw an exception',
    explanation: `The firmware (setup, loop, an interrupt handler or a timer callback) threw
an uncaught exception. The diagnostic carries the firmware file:line of the
throw (at), the simulation time it happened (time) and the firmware-only
stack (evidence.stack). The MCU halts: outputs keep their last state and
hardware PWM keeps running, as a hung chip would.

Fix the code at the reported line. Common causes: reading a property of
undefined, an out-of-range array index, or an explicit throw on a timeout.`,
  },
  {
    code: 'M602',
    slug: 'busy-loop',
    title: 'firmware ran too long without yielding',
    explanation: `Simulated time only advances when the firmware awaits delay() /
delayMicroseconds() or loop() returns. A synchronous loop that waits for an
input or for millis() to change — while (digitalRead(2) == LOW) {} — can
never finish: nothing changes while it runs. The runtime counts API calls and
loop iterations between yields (budget maxOpsPerYield, default 1e6) and
halts the MCU at the loop's line instead of hanging the simulator.

Fix: put \`await delay(1)\` (or delayMicroseconds) inside the loop, or react to
the input with attachInterrupt().`,
  },
  {
    code: 'M603',
    slug: 'zero-time-loop',
    title: 'firmware keeps yielding without letting time advance',
    explanation: `More than maxEventsPerInstant (default 1e5) firmware events were processed
at one simulation instant — typically \`while (…) await delay(0)\`, or an input
edge storm reported by the circuit at a single time point. Time cannot move
forward, so the MCU is halted.

Fix: wait a real amount of time inside the loop (\`await delay(1)\`).`,
  },
  {
    code: 'M604',
    slug: 'idle-loop',
    title: 'loop() returns without awaiting a delay',
    explanation: `Firmware executes in zero simulated time between yields. A loop() pass that
never waits is charged a fixed cost (the profile's idleLoopUs, 10 µs by
default) so polling code still observes inputs changing — but every pass is a
simulator breakpoint, which is slow for the analog engine. Warning only.

Fix (if the loop only polls): add \`await delay(1)\` at the end of loop(), or
use attachInterrupt() for the input.`,
  },
  {
    code: 'M605',
    slug: 'delay-not-awaited',
    title: 'delay() called without await',
    explanation: `delay() and delayMicroseconds() return a promise; the wait only happens when
the firmware awaits it. Without await the next statement runs immediately
and a later delay overlaps the first. The runtime detects a delay left
pending (a second delay while one is outstanding, or setup()/loop()
returning) and halts at the un-awaited call.

Fix (mechanical): write \`await delay(ms)\`, make the enclosing function async,
and await that function where it is called.`,
  },
  {
    code: 'M606',
    slug: 'foreign-await',
    title: 'firmware awaited something that is not a simulator timer',
    explanation: `The firmware is suspended on a promise the simulator does not control (a
never-resolved Promise, setTimeout wrappers, I/O). It would resolve in
wall-clock time or never, so simulated time cannot advance deterministically.
Firmware may only await delay()/delayMicroseconds(), directly or through
async helpers that do.`,
  },
  {
    code: 'M607',
    slug: 'delay-in-interrupt',
    title: 'delay() inside an interrupt or timer callback',
    explanation: `Interrupt handlers (attachInterrupt, Timer1) run synchronously and must
return quickly; on hardware millis() does not advance inside an ISR, so
delay() there hangs or returns at once. The call is ignored.

Fix: set a flag (a variable) in the handler and do the slow work in loop().`,
  },
  {
    code: 'M608',
    slug: 'firmware-load-error',
    title: 'firmware failed to load',
    explanation: `The firmware file could not be loaded: not found, a syntax/type-strip
error (at = the offending line), an import other than 'circuitsvibe/arduino'
or a relative file, or module top-level code that threw (for example an
Arduino API call outside setup()/loop()). \`await\` requires the enclosing
function to be async: declare \`export async function loop()\`.`,
  },
  {
    code: 'M609',
    slug: 'missing-entry-points',
    title: 'firmware exports neither setup() nor loop()',
    explanation: `The runtime calls the exported setup() once at t = 0 and then the exported
loop() forever. A firmware module exporting neither does nothing.

Fix: \`export async function setup() { … }\` and \`export async function loop() { … }\`.`,
  },
  {
    code: 'M610',
    slug: 'unknown-pin',
    title: 'pin does not exist on this part',
    explanation: `A pin number or name passed to an Arduino API does not exist on the selected
MCU profile (numbers follow that core's numbering: on the Uno 0–13 are
D0–D13 and 14–19 are A0–A5; on the ESP32 numbers are GPIO numbers). The call
is ignored (reads return 0). The note lists the valid pins.`,
  },
  {
    code: 'M611',
    slug: 'pin-not-output-capable',
    title: 'pin cannot be an output',
    explanation: `The pin is input-only on this part (ESP32 GPIO34–39, ATtiny85 PB5/RESET
without the RSTDISBL fuse), so it cannot be driven. Use an output-capable pin.`,
  },
  {
    code: 'M612',
    slug: 'no-pwm-on-pin',
    title: 'analogWrite() on a pin without PWM',
    explanation: `Only pins wired to a timer compare output can generate PWM (Uno: D3, D5,
D6, D9, D10, D11). On any other pin the Arduino core falls back to
digitalWrite: LOW for values below 128, HIGH otherwise — the simulator does
the same, so a "dimmed" LED is simply on or off.

Fix: move the load to a PWM pin and update the pin number in the firmware.`,
  },
  {
    code: 'M613',
    slug: 'no-adc-on-pin',
    title: 'analogRead() on a pin without an ADC channel',
    explanation: `The pin is not connected to the ADC multiplexer (Uno: only A0–A5). The call
returns 0. Connect the signal to an analog input and read that pin.`,
  },
  {
    code: 'M614',
    slug: 'not-an-interrupt',
    title: 'attachInterrupt() with an invalid interrupt number',
    explanation: `attachInterrupt() takes an INTERRUPT number, not a pin number. On the Uno
interrupt 0 is D2 and interrupt 1 is D3, so attachInterrupt(2, …) refers to a
non-existent interrupt. Always write attachInterrupt(digitalPinToInterrupt(pin), …);
NOT_AN_INTERRUPT (-1) means the pin cannot raise external interrupts.`,
  },
  {
    code: 'M615',
    slug: 'write-to-non-output',
    title: 'digitalWrite() on a pin not configured as OUTPUT',
    explanation: `Pins start as INPUT. On AVR, digitalWrite() to an INPUT pin switches its
internal pull-up (20–50 kΩ) instead of driving it — an LED glows faintly and
nothing real can be driven; the simulator models exactly that. On ESP32 and
RP2040 the write is latched but the pin stays high-impedance.

Fix (mechanical): pinMode(pin, OUTPUT) in setup() before writing.`,
  },
  {
    code: 'M616',
    slug: 'adc-input-clamped',
    title: 'ADC input outside 0..Vref — reading saturated',
    explanation: `The ADC transfer is code = floor(Vin · 2^bits / Vref), clamped to
0..2^bits − 1 (AVR datasheet "ADC Conversion Result"). An input above Vref
reads full scale and a negative one reads 0, so the firmware cannot tell
values apart there. Scale the signal into range with a divider or select a
larger reference. (Pin overvoltage itself is an electrical rating issue.)`,
  },
  {
    code: 'M617',
    slug: 'serial-not-begun',
    title: 'Serial used before Serial.begin()',
    explanation: `The UART is disabled until Serial.begin(baud): real hardware transmits
nothing. The simulator still records the text so it can be inspected.
Fix: call Serial.begin(9600) (or 115200) at the start of setup().`,
  },
  {
    code: 'M618',
    slug: 'unsupported-api',
    title: 'API or mode not supported on this part or by the simulator',
    explanation: `The call exists in some Arduino cores but not for this part or not in the
simulator: e.g. INPUT_PULLDOWN on AVR, INPUT_PULLUP on ESP32 input-only
pins, analogReadResolution() on AVR, an unknown analogReference(), or a
level-triggered (LOW) interrupt. The message names the alternative.`,
  },
  {
    code: 'M619',
    slug: 'invalid-argument',
    title: 'invalid argument to an Arduino API call',
    explanation: `An argument is out of its domain: a negative or non-numeric delay, an unknown
pinMode mode, a non-function interrupt handler, a non-positive tone frequency
or timer period. The call is ignored or uses a safe value, as stated in the
message.`,
  },
  {
    code: 'M620',
    slug: 'value-clamped',
    title: 'value out of range — clamped',
    explanation: `A value was outside the API's range and was clamped or truncated: an
analogWrite() duty outside 0..255 (AVR hardware would keep only the low
byte), or a fractional delay() argument (the argument is an unsigned
integer, so delay(0.5) is delay(0) — use delayMicroseconds(500)).`,
  },
  {
    code: 'M621',
    slug: 'timer-pwm-conflict',
    title: 'hardware timer shared with PWM pins',
    explanation: `The Timer1 API reprograms the same hardware timer that generates PWM on
some pins (Uno: D9, D10). On hardware their PWM frequency changes or stops;
the simulator keeps the default frequency, so results on those pins are
optimistic. Use PWM pins on another timer.`,
  },
  // ── F14x: firmware lint ──
  {
    code: 'F140',
    slug: 'delay-not-awaited',
    title: 'delay() call without await',
    explanation: `Static twin of M605: a delay()/delayMicroseconds() call that is not awaited
(nor returned). Without await it does not wait. Fix (mechanical): \`await
delay(ms)\` inside an async function.`,
  },
  {
    code: 'F141',
    slug: 'missing-entry-points',
    title: 'firmware does not export setup()/loop()',
    explanation: `The runtime calls the exported setup() once and the exported loop() forever.
Error when neither is exported, warning when only one is.`,
  },
  {
    code: 'F142',
    slug: 'sync-busy-wait',
    title: 'polling loop without await can never see time or inputs change',
    explanation: `A while loop whose condition reads digitalRead/analogRead/millis/micros/
Serial.available but whose body never awaits. Firmware runs in zero
simulated time between awaits, so the condition can never change (runtime
diagnostic M602). Fix: add \`await delay(1)\` inside the loop, or use
attachInterrupt().`,
  },
  {
    code: 'F143',
    slug: 'no-pwm-on-pin',
    title: 'analogWrite() on a pin without PWM',
    explanation: `Static twin of M612 for literal pins and simple constants: the pin has no
timer output on the selected profile, so the core falls back to
digitalWrite. Move the load to a PWM pin.`,
  },
  {
    code: 'F144',
    slug: 'pin-capability',
    title: 'pin does not exist on this part or lacks the required function',
    explanation: `Static check of literal pins and simple constants against the selected
profile: the pin does not exist, analogRead() targets a pin without ADC,
or an input-only pin is used as an output.`,
  },
  {
    code: 'F145',
    slug: 'not-an-interrupt',
    title: 'attachInterrupt() given a pin number instead of an interrupt number',
    explanation: `Static twin of M614: attachInterrupt(2, …) on the Uno means interrupt 2, which
does not exist. Fix (mechanical): attachInterrupt(digitalPinToInterrupt(2), …).
Also flags digitalPinToInterrupt() of a pin that cannot raise interrupts.`,
  },
  {
    code: 'F146',
    slug: 'unsupported-api',
    title: 'Arduino API not supported by the simulator',
    explanation: `The firmware uses an API the MCU runtime does not provide yet (pulseIn,
shiftOut/shiftIn, Wire, SPI, EEPROM, Serial1, analogWriteFrequency, …). The
fix names the closest supported alternative.`,
  },
  {
    code: 'F147',
    slug: 'host-api',
    title: 'wall-clock or host API in firmware',
    explanation: `Date, performance.now, setTimeout/setInterval, Math.random, process or
fetch in firmware. Firmware time is simulation time: host clocks, timers and
unseeded randomness make runs irreproducible and are never synchronized with
the circuit. Use millis()/micros(), await delay(), Timer1 and random().`,
  },
  {
    code: 'F148',
    slug: 'serial-not-begun',
    title: 'Serial used but Serial.begin() never called',
    explanation: `Static twin of M617: Serial output without any Serial.begin(baud). Real
hardware transmits nothing. Add Serial.begin(9600) in setup().`,
  },
  {
    code: 'F149',
    slug: 'write-without-pinmode',
    title: 'digitalWrite() to a pin never set to OUTPUT',
    explanation: `Static twin of M615: no pinMode(pin, OUTPUT) (or analogWrite/tone) for a
pin that is written. Pins start as INPUT; on AVR the write only toggles the
pull-up. Add pinMode(pin, OUTPUT) in setup().`,
  },
];

export function findDiagnosticDoc(code: string): DiagnosticDoc | undefined {
  return DIAGNOSTIC_DOCS.find(d => d.code.toLowerCase() === code.toLowerCase());
}
