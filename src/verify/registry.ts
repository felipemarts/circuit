/**
 * Diagnostic registry — the stable code taxonomy and its long-form
 * explanations (`circuitsvibe explain <code>`). Codes are permanent: parsers and
 * agents may key on them, so they are never renumbered or reworded away.
 *
 *   F1xx  structural lint (pre-solve topology)
 *   S1xx  linear solver
 *   S2xx  nonlinear solver (Newton-Raphson)
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

Fixes: add series resistance in the offending branch (even 1–10 ohm helps);
check source polarity and magnitude. Continuation strategies (gmin/source
stepping) are on the roadmap and will be applied automatically.`,
  },
  {
    code: 'S202',
    slug: 'nr-nonconvergence',
    title: 'Newton-Raphson did not converge (transient step)',
    explanation: `Same failure mode as S201, but during a transient timestep. Besides the
S201 fixes, a smaller dt often helps because the previous timestep's
solution is then a better starting guess.`,
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

  // ── VHDL front end (src/vhdl): V701–V749 compile/elaboration, V750–V799 runtime ──
  {
    code: 'V701',
    slug: 'vhdl-syntax-error',
    title: 'VHDL syntax error',
    explanation: `The VHDL text does not follow the grammar at the reported line:col: a
missing ';', an 'end if' written as 'endif', 'elseif' instead of 'elsif',
mixing 'and' and 'or' without parentheses (VHDL gives them the same
precedence and forbids mixing), a trailing ';' before ')' in a port list,
',' instead of ';' between port declarations, and so on. The message says
what was expected and what was found; the location is exact.

The parser reports the first error of each design unit and resumes at the
next entity/architecture, so independent units still report their own
errors. Fix the first error first: later ones may be consequences.`,
  },
  {
    code: 'V702',
    slug: 'vhdl-lexical-error',
    title: 'invalid character, literal or comment in VHDL source',
    explanation: `A character or literal that VHDL cannot tokenize: an unterminated string
or bit-string literal, a number glued to its unit ('10ns' instead of
'10 ns'), an invalid based literal (16#FG#), an identifier with '__' or a
trailing '_', an extended identifier (\\name\\), or a character VHDL does not
use (for example '{', '$' or a backtick from Verilog or template text).

Fix the literal at the reported line:col.`,
  },
  {
    code: 'V703',
    slug: 'vhdl-unsupported',
    title: 'VHDL construct outside the supported subset',
    explanation: `The construct is valid VHDL but outside the synthesizable subset that
CircuitsVibe simulates. It is reported instead of being ignored, so a design
never mis-simulates silently. The message names the construct and lists what
is supported: library/use of ieee.std_logic_1164 and ieee.numeric_std,
entities with generics and ports, architectures with signals, constants,
enumeration types, subtypes and components, processes with a sensitivity list
(or process(all), or one leading 'wait until'), concurrent / conditional /
selected assignments, if/case/for, variables, entity/component
instantiation, for/if-generate and assert/report.

Typical cases and rewrites: 'wait for 10 ns' in a process (testbench timing:
drive inputs from the bench with Clock/Stimulus/sim.drive, or use 'after'),
file I/O and textio (testbench only), records and array types (use separate
signals / vectors), functions and procedures (inline them), packages (put the
declarations in the architecture or pass generics), while loops (use a for
loop with static bounds), transport delays, multi-element waveforms.`,
  },
  {
    code: 'V704',
    slug: 'vhdl-undeclared',
    title: 'name is not declared',
    explanation: `An identifier is used without a declaration in scope. VHDL names are
case-insensitive; the diagnostic suggests the closest declared name when one
is near. Signals and constants are declared in the architecture before
'begin', variables in the process before 'begin', ports and generics in the
entity. A component instantiated by name (u1: foo port map …) needs a
component declaration — or write 'u1: entity work.foo port map …'.`,
  },
  {
    code: 'V705',
    slug: 'vhdl-type-mismatch',
    title: 'operand or value has the wrong type',
    explanation: `VHDL is strongly typed and this subset follows it: std_logic_vector,
unsigned and signed are distinct types (convert with unsigned(x),
std_logic_vector(x)); integers and vectors convert with to_unsigned(n, width)
and to_integer(x); std_logic is not boolean (write a = '1'); arithmetic is not
defined on std_logic_vector (ieee.std_logic_unsigned is not supported — use
unsigned); a one-bit value is '1' and a vector is "0101". The fix in the
diagnostic is usually the exact conversion to write.`,
  },
  {
    code: 'V706',
    slug: 'vhdl-length-mismatch',
    title: 'vector lengths differ',
    explanation: `An assignment, logical operator or comparison combines vectors of different
lengths. VHDL assigns arrays element by element from the left, so both sides
must have the same number of elements. The evidence carries both lengths.
Fixes: resize(x, n) for unsigned/signed, a slice x(7 downto 0), or a
concatenation to extend. Comparing std_logic_vectors of different lengths is
legal but always unequal, so it is reported as a warning.`,
  },
  {
    code: 'V707',
    slug: 'vhdl-missing-use',
    title: 'IEEE package used without its library/use clause',
    explanation: `std_logic, std_logic_vector, rising_edge (ieee.std_logic_1164) or unsigned,
signed, to_unsigned, to_integer, resize (ieee.numeric_std) are used, but the
design unit does not make them visible, or a 'use ieee.…' clause has no
'library ieee;' before it. Add before the entity:

  library ieee;
  use ieee.std_logic_1164.all;
  use ieee.numeric_std.all;`,
  },
  {
    code: 'V708',
    slug: 'vhdl-unsupported-library',
    title: 'library or package outside the supported set',
    explanation: `Only ieee.std_logic_1164, ieee.numeric_std and std.standard are available,
and every compiled unit is in library work. The non-standard Synopsys
packages ieee.std_logic_arith / std_logic_unsigned / std_logic_signed are
rejected (their names, like conv_integer, too): use ieee.numeric_std with
unsigned/signed. std.textio and other file-I/O packages, math_real and
user packages (use work.pkg.all) are not supported.`,
  },
  {
    code: 'V709',
    slug: 'vhdl-unknown-entity',
    title: 'entity not found in the compiled sources',
    explanation: `An instantiation, architecture or instantiateVhdl() call names an entity
that is not in the sources compiled together. All entities of a hierarchy
must be compiled in one call: compileVhdl([top, sub1, sub2]) or one text
with several entities. Also reported when no entity exists at all, or when
an architecture name in entity work.foo(arch) does not exist.`,
  },
  {
    code: 'V710',
    slug: 'vhdl-port-map',
    title: 'invalid port map / port association',
    explanation: `A port map associates a formal that does not exist, associates a port
twice, leaves an input without a default unconnected, connects a port to a
signal of another type or length (integer ports need the same range on both
sides because they are carried on nets), or lets an output drive an input
port of the enclosing entity. Connect every input to a signal (or give it a
default), and match types exactly.`,
  },
  {
    code: 'V711',
    slug: 'vhdl-generic',
    title: 'invalid generic value or generic map',
    explanation: `A generic has no value (no default and none given), the value has the
wrong type, is outside the generic's subtype range, or the generic map names
a generic the entity does not have. Generic values must be static: literals,
constants, or generics of the enclosing entity.`,
  },
  {
    code: 'V712',
    slug: 'vhdl-illegal-target',
    title: 'assignment to something that cannot be assigned',
    explanation: `The target of an assignment is an input port, a constant, a generic or a
for-loop parameter, or the assignment operator does not match the target:
signals are assigned with '<=' (the value appears after the process
suspends — next delta cycle), variables with ':=' (immediately).`,
  },
  {
    code: 'V713',
    slug: 'vhdl-not-static',
    title: 'expression must be static (known at elaboration)',
    explanation: `Vector widths, slice bounds, loop and generate bounds, generic values,
initial values, case choices and port-map constants are fixed when the design
is elaborated, so they cannot depend on signals or variables. Use literals,
constants, generics, loop/generate parameters or attributes like x'length.`,
  },
  {
    code: 'V714',
    slug: 'vhdl-unresolved-drivers',
    title: 'unresolved signal driven by more than one process',
    explanation: `Every process (and concurrent assignment) that assigns a signal is a driver
of it. Only resolved types — std_logic, std_logic_vector, unsigned, signed —
combine several drivers (with std_logic resolution: 'Z' yields, 0 vs 1 is X
and the digital engine reports D501). integer, boolean, enumeration and
std_ulogic signals have no resolution function, so VHDL rejects several
drivers. Assign the signal from one process, or use separate signals.`,
  },
  {
    code: 'V715',
    slug: 'vhdl-duplicate',
    title: 'name declared twice in the same scope',
    explanation: `Two declarations in one scope have the same name — remember that VHDL is
case-insensitive (Count and count clash). Also reported for an entity or an
architecture declared twice in the compiled sources. Rename one of them.`,
  },
  {
    code: 'V716',
    slug: 'vhdl-no-sensitivity',
    title: 'process has neither a sensitivity list nor a wait',
    explanation: `A VHDL process runs until it suspends. Without a sensitivity list and
without a wait statement it never suspends, so the simulation would hang at
time 0. Add a sensitivity list: process(clk) (or process(clk, rst) with an
asynchronous reset) for clocked logic, process(all) for combinational logic.`,
  },
  {
    code: 'V717',
    slug: 'vhdl-incomplete-sensitivity',
    title: 'combinational process reads a signal missing from its sensitivity list',
    explanation: `A process reads a signal outside any clock-edge branch, but the signal is
not in its sensitivity list. The process does not wake up when that signal
changes, so simulation shows stale values while synthesized hardware would
react immediately — a classic simulation/synthesis mismatch. This is a
warning; the simulation follows VHDL semantics exactly. Add the signals to the
list or use process(all).`,
  },
  {
    code: 'V718',
    slug: 'vhdl-case-choices',
    title: 'case/select choices are incomplete, duplicated or not static',
    explanation: `VHDL requires a case statement or selected assignment to cover every value
of the selector exactly once. Enumerations can be covered by listing every
literal; std_logic and vector selectors have nine values per bit (U, X, 0, 1,
Z, W, L, H, -), so they need 'when others'. Choices must be static and appear
once; 'others' must be last. Aggregates must give each index exactly once.`,
  },
  {
    code: 'V719',
    slug: 'vhdl-static-range',
    title: 'static index, slice or value outside its range',
    explanation: `An index, slice, aggregate choice, constant value or subtype range known at
elaboration falls outside its declared range, a slice has the wrong
direction (x(0 to 3) of a downto vector), or a static expression fails
(division by zero, to_unsigned overflow — the latter as a warning). Correct
the bounds; slices must use the vector's own direction.`,
  },
  {
    code: 'V720',
    slug: 'vhdl-invalid-literal',
    title: 'literal is not a valid value of its type',
    explanation: `A character or string literal is not made of std_logic values. std_logic
literals are case-sensitive: 'U', 'X', '0', '1', 'Z', 'W', 'L', 'H', '-' — so
'x' or 'z' (lowercase) are not std_logic values. For hexadecimal constants
use x"FF"; for numbers use to_unsigned(n, width).`,
  },
  {
    code: 'V721',
    slug: 'vhdl-instance',
    title: 'invalid instantiateVhdl() arguments',
    explanation: `The JavaScript call that instantiates a VHDL entity is wrong: an invalid
instance id, an entity, port or generic that does not exist, a generic value
of the wrong JS type, a port mapped to the wrong number of nets or to an
invalid net name, several top-level entities without { entity }, or an id
that collides with a part already in the circuit. The message lists the valid
names.`,
  },
  {
    code: 'V722',
    slug: 'vhdl-recursive-instance',
    title: 'entity instantiates itself',
    explanation: `The hierarchy contains a cycle (an entity instantiates itself directly or
through other entities). Elaboration would never end. Use a for-generate
with a static count to replicate structure instead.`,
  },
  {
    code: 'V723',
    slug: 'vhdl-no-architecture',
    title: 'entity has no architecture',
    explanation: `An entity only declares an interface; its behavior is in an architecture
body ('architecture rtl of name is … begin … end architecture;'). Compile the
architecture together with the entity.`,
  },
  {
    code: 'V750',
    slug: 'vhdl-index-out-of-range',
    title: 'index out of range at runtime',
    explanation: `While simulating, a process indexed a vector with a value outside its range
(e.g. q(i) with i from a counter that went too far). VHDL would stop the
simulation; here a read returns 'X' and a write is skipped, the simulation
continues, and the diagnostic carries the process, the index and the time.
Keep the index inside the range (check counter widths and loop bounds).`,
  },
  {
    code: 'V751',
    slug: 'vhdl-range-violation',
    title: 'value outside the target subtype range at runtime',
    explanation: `A value assigned to an integer subtype (integer range 0 to 9, natural, an
enumeration via 'val) left its range — for example a counter declared
'integer range 0 to 15' incremented past 15 (integers do not wrap in VHDL;
unsigned vectors do). VHDL would stop the simulation; here the assignment is
skipped and the target keeps its old value. Widen the range or wrap
explicitly. Also reported (as a warning) when to_unsigned/to_signed truncate
a value that does not fit in the requested width.`,
  },
  {
    code: 'V752',
    slug: 'vhdl-assertion',
    title: 'VHDL assert/report fired',
    explanation: `An assert statement in the design found its condition false, or a report
statement ran. The message is the VHDL report text; the severity follows
VHDL (note and warning give a warning, error and failure an error). Assert
statements document what the author expected — read the message.`,
  },
  {
    code: 'V753',
    slug: 'vhdl-metavalue',
    title: 'numeric_std operation on X/U/Z/W/- bits',
    explanation: `An arithmetic operation, comparison or to_integer saw a vector with unknown
bits. Following ieee.numeric_std, arithmetic returns all 'X', comparisons
return false and to_integer returns 0 — the same warning real simulators
print. Usually a register without reset or an undriven input. Warnings during
the power-on settle (time 0) are suppressed. Give the operand a defined
value: a reset branch, an initial value, or a driven input.`,
  },
  {
    code: 'V754',
    slug: 'vhdl-division-by-zero',
    title: 'division or mod/rem by zero at runtime',
    explanation: `A '/', 'mod' or 'rem' had a zero divisor while simulating. VHDL would stop;
here the integer result is 0 (vector result all 'X') and the simulation
continues. Guard the operation with if divisor /= 0.`,
  },
  {
    code: 'V755',
    slug: 'vhdl-encoded-unknown',
    title: 'integer/enum/boolean signal read X/Z bits from its nets',
    explanation: `Integer, enumeration and boolean signals are carried on nets as binary
encodings (integer range 0 to 9 on 4 nets, LSB first). When one of those nets
is X or Z — typically an integer input port that the testbench does not drive
on every bit, or contention — the value cannot be represented and reads as
the subtype's lowest value / the first literal / false. Drive every bit.`,
  },
];

export function findDiagnosticDoc(code: string): DiagnosticDoc | undefined {
  return DIAGNOSTIC_DOCS.find(d => d.code.toLowerCase() === code.toLowerCase());
}
