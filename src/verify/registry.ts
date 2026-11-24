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
];

export function findDiagnosticDoc(code: string): DiagnosticDoc | undefined {
  return DIAGNOSTIC_DOCS.find(d => d.code.toLowerCase() === code.toLowerCase());
}
