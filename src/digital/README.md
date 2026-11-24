# src/digital — event-driven digital engine

Self-contained 4-valued logic simulator for CircuitsVibe: pure TypeScript, zero
dependencies, browser-safe (no Node APIs), deterministic. It is **not yet wired into
the bench DSL, the ladder or `src/forge.ts`**; this document is the contract for the
integration step that will co-simulate it with the analog transient.

```
logic.ts        Logic = 0 | 1 | 'X' | 'Z', operator tables, multi-driver resolution
units.ts        1 ps integer timebase, time/frequency parsing
diagnostics.ts  DigitalDiagnostic + DIGITAL_CODES (D501–D507, F130–F134)
parts.ts        part catalog: JSON params, pin layouts, delays, comb paths, model factories
models.ts       behavioral models (gates, tri-state, mux, DFF, JK, latch, counter, shift reg, sources)
model.ts        model ↔ kernel contract, setup/hold checker, edge classification
netlist.ts      canonical plain-JSON netlist + validation
sim.ts          event kernel + DigitalSim (co-simulation API, recording, listeners)
circuit.ts      DigitalCircuit builder + part classes
lint.ts         lintDigital (F130–F134)
measure.ts      pure measurements over recorded traces
vcd.ts          VCD export
index.ts        public surface
```

## Building a circuit

```ts
import { DigitalCircuit, Clock, DFF, Not, Counter, Stimulus, frequency } from './digital';

const c = new DigitalCircuit();
c.add('CLK', new Clock({ freq: '10M' }), { y: 'clk' });
c.add('FF1', new DFF({ delay: '2n', setup: '1n', hold: '0.5n', reset: true }),
      { d: 'NQ', clk: 'clk', reset: 'RST', q: 'Q' });
c.add('N1', new Not({ delay: '1n' }), { a: 'Q', y: 'NQ' });       // FF1 toggles: Q = clk / 2
c.add('SR', new Stimulus({ initial: 1, changes: [['50n', 0]] }), { y: 'RST' });
c.input('EN', { initial: 0 });                                    // driven from outside

c.lint();                        // DigitalDiagnostic[] (F13x) — [] for this circuit
const sim = c.build();           // powered on and settled at t = 0
sim.advanceTo('2u');
sim.value('Q');                  // 0 | 1 | 'X' | 'Z'
frequency(sim.trace('Q'));       // 5e6
```

- `c.add(id, part, wiring?)` — ids like the analog bench (`/^[A-Za-z][A-Za-z0-9_]*$/`, unique).
  `wiring` maps pin → net name (or → another `DigitalPin`). Returns the part.
- `part.pin('q').connect(otherPin | 'NET')`, `c.connect(a, b, …)`, `c.name('NET', pin)`.
- Net names: `/^[A-Za-z_][A-Za-z0-9_[\]]*$/` (brackets allowed for bus bits: `'Q[3]'`).
  A net with no user name is named after its first output pin (`'U1.y'`), else its first
  pin — never after build order. Two user names on one net is an authoring error.
- Every lookup (`value`, `trace`, `drive`, …) accepts a net name or a pin ref `'U1.y'`.
- Authoring errors (bad id, unknown pin/option, bad unit string) throw `Error` with an
  actionable message — they map to the platform's T001.

### Primitives (pins in order; all options are plain JSON)

Common timing options: `delay` (seconds or `'5n'`, or `{ rise, fall }`; default **1 ns**),
`delayMode: 'inertial' | 'transport'` (default inertial). Sequential parts add
`setup`, `hold` (default 0 = unchecked), `onViolation: 'x' | 'keep'` (default `'x'`),
`init` (power-on state, default 0).

| Class | Inputs → outputs | Options |
|-------|------------------|---------|
| `Buf`, `Not` | `a` → `y` | timing |
| `And`, `Or`, `Nand`, `Nor`, `Xor`, `Xnor` | `a`, `b`, `c`, … → `y` | `inputs` (1–26, default 2) |
| `TriBuf` | `a`, `en` → `y` (Z when disabled) | `activeLow` |
| `Mux` | `s0..s(k-1)` (s0 = LSB), `d0..d(2^k-1)` → `y` | `select` = k (default 1) |
| `DFF` | `d`, `clk` [, `set`, `reset`] → `q`, `qn` | `set`, `reset` (async, active high), `init` |
| `JKFF` | `j`, `k`, `clk` [, `set`, `reset`] → `q`, `qn` | same as DFF |
| `DLatch` | `d`, `en` → `q`, `qn` (transparent while en = 1) | `init`; setup/hold vs. the closing edge |
| `Counter` | `clk` [, `en`, `reset`, `up`] → `q0..q(N-1)` | `bits` (default 4), `enable`, `reset`, `resetMode: 'async'\|'sync'`, `upDown`, `init` |
| `ShiftRegister` | SIPO: `si`, `clk` [, `reset`] → `q0..q(N-1)`, `so`; PISO: `load`, `p0..p(N-1)`, `clk` [, `si`, `reset`] → `so` | `bits` (default 8), `mode`, `serialIn` (PISO), `reset`, `init` |
| `Clock` | → `y` | `freq` or `period`, `duty` (0.5), `start` (first rising edge, 0), `stop` |
| `Const` | → `y` | `new Const(0 \| 1 \| 'X' \| 'Z')` |
| `Pull` | → `y` (weak) | `new Pull(1)` pull-up, `new Pull(0)` pull-down |
| `Stimulus` | → `y` | `initial`, `changes: [[t, v], …]`, or `pattern: '0110', step, from` |

Shift direction: `q0 ← si`, `q(i) ← q(i-1)`, `so = q(N-1)`. PISO with `load = 1` at the
edge loads `p0..p(N-1)`; otherwise it shifts (in `si`, or 0). Counters wrap modulo 2^N.

`PART_DEFS` holds the catalog metadata (`summary`, `pins(params)`, `driver`, `delay`,
`combPaths`) for a future `circuitsvibe catalog`.

## Values, strength and resolution

`Logic = 0 | 1 | 'X' | 'Z'`. Drivers have a strength: **strong** (every output, `Const`,
`Clock`, `Stimulus`, external inputs by default), **weak** (`Pull`, or
`drive(..., { strength: 'weak' })`), or none (Z). Per net: the strongest active strength
wins; unanimous → that value; any X → X; 0 vs 1 → X plus **D501** (strong) or **D507**
(weak). No active driver → Z. Gate inputs read Z as X. Operator tables (also exported as
`logicAnd`, `logicOr`, `logicXor`, `logicNot`, …): controlling values dominate
(`AND(0, X) = 0`, `OR(1, X) = 1`), XOR has none (any X → X).

Sequential X semantics: an edge through X (`0→X`, `X→1`) or an unknown async
control/latch enable yields X **only if acting on it would change the state** (D506).
JK and Mux resolve unknown inputs by enumerating the possibilities (known if all agree).

## Time, delays and event order

- Internal time is **integer picoseconds** in a JS number (exact to ~9007 s). The API
  speaks seconds; `toTicks(s) = round(s · 1e12)`, and `toTicks(fromTicks(k)) === k`, so a
  time read from `nextEventTime()` and passed back to `advanceTo()` is exact.
  Clocks compute edge n from its index (never by accumulation): no drift.
- **Inertial** delay (default): one pending transaction per output; a new value cancels
  the pending one, so pulses strictly shorter than the delay are swallowed
  (`stats().glitchesSuppressed`). A pulse at least as long as the delay passes.
  **Transport**: every pulse passes; a new transaction removes pending ones at or after
  its time (VHDL rule). `{ rise, fall }` selects by the target value (X/Z: the smaller).
- **Delta cycles**: zero-delay activity at time T runs in deltas T.0, T.1, … Each batch:
  apply all driver updates → resolve affected nets → evaluate every affected component
  once. `maxDeltaCycles` (default 1000) bounds it → **D504** and that time point's
  remaining events are dropped (the simulation continues).
- **Event key = (tick, delta, seq)**. Nets, components and drivers are indexed by
  **sorted name**, components are evaluated in ascending id order, and `seq` is
  assigned in that evaluation order — so the event order does not depend on the order
  the circuit was built in, and resolution is order-independent anyway. Same netlist +
  same `drive()` calls ⇒ byte-identical waveforms (`toVCD`) and diagnostics.
- **Power-on (t = 0)**: models put their initial state on the outputs, then the circuit
  is settled to a zero-delay fixpoint of its level-sensitive behavior (like a DC operating
  point; no edges, no timing checks). Source transitions at exactly t = 0 are part of that
  state: a `Clock` with `start: 0` starts **high** with no edge at 0 (first rising edge at
  one period), and `Stimulus` changes at t = 0 fold into its initial value. A `drive()`
  at t = 0 is an ordinary event applied by the first `advanceTo` (the recording then
  shows only the resulting value at t = 0).

## Co-simulation contract (for the analog integrator)

```ts
sim.now                      // seconds, current digital time
sim.nextEventTime()          // number | undefined — earliest pending event (an analog breakpoint)
sim.advanceTo(t)             // process every event with time ≤ t (all deltas), then now = t
sim.drive(net, v, t?, opts?) // external value at t ≥ now (A→D bridge); 'Z' releases; last call wins
sim.release(net, t?)
sim.onChange(cb, { nets? })  // settled changes { t, net, value, previous } (D→A bridge)
```

Suggested loop (fixed-step analog shown; adaptive steps work the same):

```ts
let t = 0;
while (t < tstop) {
  let tn = Math.min(t + dtAnalog, dsim.nextEventTime() ?? Infinity, tstop);
  solveAnalogStep(t, tn);                     // D→A sources hold their latest values
  for (const b of adBridges) {                // threshold crossing inside (t, tn]?
    const tc = b.crossing(t, tn);
    if (tc !== undefined) { tn = tc; resolveAnalogStepTo(tc); dsim.drive(b.net, b.level, tc); }
  }
  dsim.advanceTo(tn);                         // onChange fires for D→A bridges, t ≤ tn
  t = tn;
}
```

Rules:
1. **Never advance the digital side past a time the analog side has not accepted.**
   `drive(t)` with t < now is D505 and is applied at now.
2. **Cut the analog step at a threshold crossing** before calling `advanceTo`, so the
   digital response (scheduled after its propagation delay) becomes the next breakpoint
   via `nextEventTime()` instead of landing inside an already-accepted step.
3. `onChange` reports each net **once per time point, after its delta cycles settle**
   (zero-delay hazards inside one instant are never reported), in net-name order, with
   exact grid timestamps. A `drive()` at the current time followed by another
   `advanceTo(now)` can report a second change at the same t.
4. A D→A bridge should treat each reported change as a source breakpoint at `t`
   (e.g. a PWL edge with a rise time, or a step). Values are `0 | 1 | 'X' | 'Z'`; the
   bridge decides the analog meaning of X (mid-rail, or flag) and Z (high impedance).
5. `nextEventTime()` may return a time equal to `now` (pending zero-delay work after a
   `drive(now)`); `advanceTo(now)` processes it.
6. The digital engine is cheap to step to every breakpoint; it never asks the analog
   side to go back in time.

## Waveforms and measurements

- `sim.trace(net)` → `NetTrace { net, t: number[], v: Logic[] }` (t[0] = 0 is the power-on
  value; one entry per settled change). `sim.recording()` → all recorded nets + `tEnd`.
  `record: false | string[]` limits recording. `toVCD(recording)` exports IEEE VCD
  (1 ps timescale, deterministic, opens in GTKWave).
- Pure functions on traces (times on the 1 ps grid, windows inclusive, right-continuous
  values, results are numbers or `undefined` — never NaN/Infinity):
  `valueAt(tr, t)`, `edgeTimes(tr, 'rising'|'falling'|'both', {from,to})`, `edgeCount`,
  `period`, `frequency`, `dutyCycle` (over whole periods between the first and last
  rising edge), `firstTime(tr, value, {from,to})`. Edges are strict 0↔1 transitions;
  transitions through X/Z are not edges.
- Verdict-shaped checks for the future `tb.expect.logic(...)`:
  `checkValueAt(tr, expected, t)` and `checkStable(tr, expected, {from,to})` return plain
  `{ pass, measured, expected, t }` (t = sample time or first violation).

## Diagnostics

`DigitalDiagnostic` is structurally a platform `Diagnostic` (`code`, `slug`, `severity`,
`stage` = `'lint'` for F13x / `'tran'` for D5xx, `message`, `subject`, `note`,
`evidence`, `fixes[]` with `confidence`, `at`) plus `time` (seconds) and
`subject.nets`; a compile-time check in diagnostics.ts keeps it assignable to
`Diagnostic`. Every code is in `src/verify/registry.ts` (`circuitsvibe explain`) and
docs/DIAGNOSTICS.md.

| Code | Severity | When |
|------|----------|------|
| F130 floating-input | error | input pin on an undriven net |
| F131 multiple-drivers | error | push-pull output shares a net with another non-weak driver |
| F132 output-short | error | two outputs of one part on one net |
| F133 zero-delay-loop | error | combinational loop with zero delay (message shows the loop path) |
| F134 unconnected-clock | error | clock pin on an undriven net |
| D501 drive-contention | error | strong 0 vs strong 1 at runtime (evidence: who drives 0 / 1) |
| D502 setup-violation | error | evidence: pin, edgeTime, dataTime, measured, required, margin |
| D503 hold-violation | error | same evidence as D502 |
| D504 delta-cycle-limit | error | zero-delay activity did not settle at one time point |
| D505 drive-in-past | error | `drive()` before `now` |
| D506 unknown-control | warning | clock edge through X / unknown async control changes state |
| D507 weak-contention | warning | pull-up vs pull-down |

Runtime diagnostics are capped per (code, subject) at `maxDiagnosticsPerSubject`
(default 10); the overflow is counted in `stats().suppressedDiagnostics`. Lint
diagnostics carry `at` when the circuit was built with `new DigitalCircuit({ locate })`
(pass the bench's `captureLoc`).

## Serialization

`c.netlist()` is the canonical plain-JSON form (`schema: 'circuitsvibe-digital/0.1'`):
components sorted by id with `{ id, type, params, pins }` (params fully normalized, times
in seconds), `inputs`, and the derived `nets` map. `new DigitalSim(json)` and
`DigitalCircuit.fromJSON(json)` rebuild it exactly; `normalize` is idempotent, so
hand-written JSON (`{ type: 'And', params: { inputs: 3, delay: '2n' } }`) is accepted too.

## Integration notes / known gaps

- Not yet exported from `src/forge.ts`; no `tb.digital` / `tb.expect.logic` yet.
- `units.ts` duplicates the small engineering-suffix parser of `src/core/units` to keep
  this module independent; dedupe on integration.
- A `drive()` at t = 0 is an event, not part of the power-on settle (see above).
- Sequential parts are evaluated on both clock edges (cheap early-out); no per-pin
  sensitivity lists yet. ~1 M events/s on a 1000-FF chain (tests/digital/perf.test.ts).
- No bus/vector type: buses are individual nets (`Q0..Q3` or `'Q[0]'`).
- Not modeled: recovery/removal timing of async controls, pulse-width checks, clock
  skew, metastability resolution time, drive strengths beyond strong/weak, wired-AND/OR.
- A ring oscillator only starts from defined values (power-on settles a pure inverter
  loop to X); gate it with an enable as in the tests.
