# Diagnostics — code taxonomy and RunRecord format

Codes are **permanent**: parsers and agents can depend on them; they are never renumbered.
`circuitsvibe explain <code>` gives the long explanation of each one.

## Ranges

| Range | Phase | Meaning |
|-------|------|-------------|
| `F1xx` | lint (pre-solver) | structural topology |
| `S1xx` | linear solver | unsolvable system |
| `S2xx` | nonlinear solver, transient stepping, AC models | Newton-Raphson, timestep control, small-signal models |
| `A3xx` | assertions | spec not met |
| `T0xx` | tooling | bench authoring error (T001–T009), circuit documents and share links (T010–T029) |
| `F120`–`F129` | op-amp / comparator lint (pre-solver) | amplifier wiring: supply, input bias paths, feedback polarity, ideal output, pull-ups (src/opamps) |
| `R420`–`R429` | op-amp / comparator ratings (op stage) | datasheet checks of `Part()` amplifiers at the operating point, in `stages.op.ratings` (src/opamps) |
| `F130`–`F139` | digital lint (pre-simulation) | digital netlist structure (src/digital) |
| `D501`–`D549` | digital runtime | event-driven logic simulation: contention, timing checks (src/digital) |
| `F14x` | firmware lint (pre-simulation) | MCU firmware source mistakes (F140–F149) |
| `M6xx` | MCU runtime | firmware execution on a simulated microcontroller (M601–M649) |
| `V701`–`V749` | VHDL compile / elaboration (pre-simulation) | syntax, unsupported constructs, types, hierarchy (src/vhdl) |
| `V750`–`V799` | VHDL runtime | errors raised by compiled VHDL processes while simulating (src/vhdl) |

## Active codes

| Code | Slug | Severity | When it fires |
|--------|------|-----------|----------------|
| `F101` | floating-net | error | net with no DC path to ground (isolated by a capacitor/current source) |
| `F103` | unreached-component | error | component (or island) with no connection to the grounded circuit — would be silently ignored by the solver |
| `F104` | voltage-source-short / voltage-source-loop | error | ideal source shorted, or a loop of ideal sources (an inductor counts as a 0 V source in DC) |
| `F105` | source-clamped-diode | error | forward-biased diode/LED clamped directly across an ideal source with no series resistance |
| `F106` | dangling-pin | warning | pin with no connection at all |
| `F120` | opamp-supply-unconnected | error | `OpAmp`/`Comparator`/`Part()` supply pin `v+` or `v-` open, or both on one net; an `IdealOpAmp` with only one of the two connected |
| `F121` | opamp-input-no-dc-path | error | an op-amp/comparator input on a net with no DC path (replaces F101 for that island; e.g. AC-coupled input without a bias resistor) |
| `F122` | opamp-positive-feedback | warning | the passive network from an op-amp output reaches `inp` but not `inn` (positive feedback only; the DC solution is the unstable equilibrium) |
| `F123` | ideal-opamp-output-forced | error | an `IdealOpAmp` output on gnd, across an ideal voltage source (through sources/inductors) or tied to another ideal output |
| `F124` | open-collector-no-pullup | warning | a comparator output whose DC network (not through gnd or the comparator) reaches no source or op-amp output — nothing pulls it high |
| `S101` | unsolvable-system | error | singular matrix that lint did not model (rare; please report) |
| `S201` | nr-nonconvergence | error | NR did not converge at the DC point (op, a DC-sweep point, or the AC operating point) after plain Newton, gmin stepping and source stepping — carries the offending component, ΔV, oscillation history, `attempts`, and the sweep point when in the dc stage |
| `S202` | nr-nonconvergence | error | NR did not converge at a transient step even after cutting the step (by 8, retried with BE) below the minimum — carries the culprit, `time` and the last `step` |
| `S203` | timestep-too-small | error | the truncation-error control had to shrink the transient step below `minStep` (default maxStep·1e-9) or exhausted the step budget — carries the reactive culprit (capacitor/inductor) and `time` |
| `S204` | no-ac-model | error | the AC stage found a component without a small-signal model (a `defineComponent` part with no `ac(ctx)`) — names the components |
| `A301` | assertion-failed | fail | assertion failed — carries measured, expected, margin, and a verified hint when `tb.param` is present |
| `T001` | bench-error | error | the bench itself threw an exception during elaboration |
| `T002` | stage-crash | error | a stage (op/dc/ac/tran) crashed after elaboration — platform bug; the RunRecord is still emitted (exit 3) |
| `T003` | no-ac-stimulus | error | AC assertions but no source has an `ac` stimulus (exit 3) |
| `T004` | ambiguous-ac-reference | error | several sources have an `ac` stimulus and an AC probe has no `ref` (exit 3) |
| `T010` | invalid-circuit-document | error | a circuit document (`.circuit.json` or share-link payload) is not JSON, misses/mistypes a field, has an unknown field, or has a dangling reference — `evidence.path` is the JSON pointer (exit 3) |
| `T011` | unsupported-circuit-schema | error | the document's `schema` is a `circuitsvibe-circuit` version this release does not read (exit 3) |
| `T012` | unknown-component-type | error | a document component type is not built-in and no definition was supplied (exit 3) |
| `T013` | custom-component-not-serializable | error | `export` / `share` / `verify --share` on a bench with `defineComponent` parts (names them; no registry in the CLI) — exit 3, or `share.error` under `verify --share` |
| `T014` | invalid-component | error | a document component's params do not build its type, a param would be ignored, or its pins are not exactly the type's canonical pins (exit 3) |
| `T015` | share-payload-too-large | error | share link above 2 MiB (Chromium's URL limit), or a payload inflating above 16 MiB on decode (exit 3) |
| `T016` | malformed-share-link | error | no `#c=` payload, not `<version>.<base64url>`, bad base64url, not deflate-raw, not UTF-8 JSON (exit 3) |
| `T017` | unsupported-share-encoding | error | share payload encoding version other than `1` (exit 3) |
| `T018` | long-share-link | warning | share link longer than 8 KiB — valid, but some chat apps truncate long links (`warnings[]` of `share --json`) |
| `F130` | floating-input | error | digital input pin on a net with no driver (no output, Const/Pull, or declared input) — simulates as X |
| `F131` | multiple-drivers | error | push-pull digital output shares its net with another non-weak driver (output, tri-state, external input) |
| `F132` | output-short | error | two outputs of the same digital part on one net (e.g. q tied to qn) |
| `F133` | zero-delay-loop | error | combinational feedback loop whose elements all have zero delay — carries the loop path |
| `F134` | unconnected-clock | error | clock pin of an edge-triggered element on an undriven net |
| `D501` | drive-contention | error | strong 0 and strong 1 on one net at runtime — net is X; carries the drivers on each side and the time |
| `D502` | setup-violation | error | data changed less than the setup time before the active edge — carries element, pin, time, measured and margin; outputs X (configurable) |
| `D503` | hold-violation | error | data changed less than the hold time after the active edge — same evidence as D502 |
| `D504` | delta-cycle-limit | error | zero-delay activity did not settle within maxDeltaCycles at one time point; that time point's remaining events are dropped |
| `D505` | drive-in-past | error | external drive() scheduled before the current time — applied at the current time instead |
| `D506` | unknown-control | warning | clock edge through X/Z or unknown async set/reset/latch enable that would change state — outputs X |
| `D507` | weak-contention | warning | pull-up and pull-down are the only drivers of a net — net is X |
| `V701` | vhdl-syntax-error | error | VHDL text does not follow the grammar — exact line:col, what was expected and found; first error per design unit |
| `V702` | vhdl-lexical-error | error | invalid character, unterminated string, number glued to its unit (`10ns`), bad based literal or identifier |
| `V703` | vhdl-unsupported | error | valid VHDL outside the supported subset (`wait for`, file I/O, records, functions, packages, while loops, …) — names the construct and lists what is supported |
| `V704` | vhdl-undeclared | error | name not declared (with a did-you-mean suggestion) |
| `V705` | vhdl-type-mismatch | error | wrong type (std_logic_vector vs unsigned, integer vs vector, std_logic vs boolean, arithmetic on std_logic_vector) — fix gives the conversion |
| `V706` | vhdl-length-mismatch | error | vector lengths differ in an assignment/operator (warning for an always-false comparison); evidence has both lengths |
| `V707` | vhdl-missing-use | error | std_logic / unsigned … used without `library ieee; use ieee.std_logic_1164.all;` / `use ieee.numeric_std.all;` |
| `V708` | vhdl-unsupported-library | error | library/package outside ieee.std_logic_1164, ieee.numeric_std, std.standard (e.g. std_logic_arith, textio, work packages) |
| `V709` | vhdl-unknown-entity | error | entity (or architecture) not in the compiled sources |
| `V710` | vhdl-port-map | error | bad port association: unknown/duplicate formal, unconnected input, type/length mismatch, output driving an input port |
| `V711` | vhdl-generic | error | generic without value, wrong type, out of range, or unknown in a generic map |
| `V712` | vhdl-illegal-target | error | assignment to an input port, constant, generic or loop parameter, or `<=`/`:=` used on the wrong kind of object |
| `V713` | vhdl-not-static | error | width, bound, generic, initial value or case choice depends on a signal/variable |
| `V714` | vhdl-unresolved-drivers | error | integer/boolean/enum/std_ulogic signal assigned by more than one process |
| `V715` | vhdl-duplicate | error | name (case-insensitive), entity or architecture declared twice |
| `V716` | vhdl-no-sensitivity | error | process with neither a sensitivity list nor a wait (would hang at time 0) |
| `V717` | vhdl-incomplete-sensitivity | warning | process reads a signal outside a clock edge that is missing from its sensitivity list (simulation/synthesis mismatch) |
| `V718` | vhdl-case-choices | error | case/select not covering every value (std_logic/vector selectors need `others`), duplicate or misplaced choices, incomplete aggregate |
| `V719` | vhdl-static-range | error | static index/slice/value outside its range, wrong slice direction, failing static expression |
| `V720` | vhdl-invalid-literal | error | literal that is not a std_logic value (e.g. lowercase `'x'`) |
| `V721` | vhdl-instance | error | invalid `instantiateVhdl()` arguments (unknown entity/port/generic, wrong net count, bad id) |
| `V722` | vhdl-recursive-instance | error | entity instantiates itself |
| `V723` | vhdl-no-architecture | error | entity without architecture |
| `V750` | vhdl-index-out-of-range | error | runtime index outside a vector's range — read gives X, write skipped; carries process, index, time |
| `V751` | vhdl-range-violation | error | runtime value outside an integer subtype (assignment skipped); warning when to_unsigned/to_signed truncate |
| `V752` | vhdl-assertion | error | VHDL assert/report fired (severity note/warning → warning, error/failure → error) |
| `V753` | vhdl-metavalue | warning | numeric_std arithmetic/comparison/to_integer on X/U/Z/W/- bits (result X / false / 0); suppressed at power-on |
| `V754` | vhdl-division-by-zero | error | runtime `/`, `mod` or `rem` by zero |
| `V755` | vhdl-encoded-unknown | warning | integer/enum/boolean signal read X/Z bits from its nets (e.g. undriven integer input port) |

Op-amp / comparator ratings (`stages.op.ratings[]`, `RatingResult`: `value`, `limit`,
`utilization`, `margin`, citation; a failing one fails the op stage → exit 1). Checked for
`Part()` amplifiers at the DC operating point only:

| Code | Slug | When it fails |
|--------|------|----------------|
| `R420` | opamp-supply-over-max | V(v+) − V(v-) above `ratings.supplyMax` |
| `R421` | opamp-differential-input-over-max | \|V(inp) − V(inn)\| above `ratings.differentialInputMax` |
| `R422` | opamp-output-current-limit | op-amp output current ≥ 90 % of the model's short-circuit current (shorted/overloaded output) |
| `R423` | opamp-input-common-mode | an input outside the input common-mode range (comparators: both inputs); `value`/`limit` are distances from the opposite rail |
| `R424` | opamp-input-over-max | an input beyond the rail-relative absolute-maximum input voltage |
| `R425` | opamp-supply-below-min | supply below `characteristics.supply.single.min` (`value` = required minimum, `limit` = actual supply) |

Semantic notes:
- Lint **always runs** (even with `--stage op`): solving a circuit that lint would reject
  would mean silently discarding components and reporting fabricated numbers.
- A `settleWithin` that never settles reports `measured` = end of the window (finite) — never
  `Infinity`, which would become `null` in JSON.
- Convergence aids are not diagnostics: when gmin or source stepping rescues the operating
  point, the op stage passes and `stages.op.solver.aids` / `attempts` say what was needed.
- A DC/AC measurement that cannot be made (no crossing inside the sweep, no −3 dB point,
  no unity-gain crossing) fails the assertion with `note` and **no** `measured` value.
- `hint.passingRange` covers only the **longest contiguous run** of passing samples
  (each sample passes lint AND all op assertions); the exact simulated values
  are in `passingSamples`.

## MCU codes (firmware runtime and firmware lint)

Emitted by the microcontroller runtime (`src/mcu/`). Payloads are plain data: `code`, `slug`,
`severity`, `stage` (`mcu` | `lint`), `message`, `subject` (`mcu`, `pins`, `api`), `time`
(simulation seconds, runtime codes), `at` (**firmware** `file:line`), `note`, `evidence`
(`occurrences` when a site repeats) and `fixes[]` with the usual confidence contract.

| Code | Slug | Severity | When it fires |
|--------|------|-----------|----------------|
| `M601` | firmware-exception | error | firmware (setup/loop/ISR/timer callback) threw — `at` is the throwing firmware line, `time` the sim time; MCU halts |
| `M602` | busy-loop | error | more than `maxOpsPerYield` API calls / loop iterations without yielding (synchronous polling loop); MCU halts |
| `M603` | zero-time-loop | error | more than `maxEventsPerInstant` events at one instant (`await delay(0)` loop, edge storm); MCU halts |
| `M604` | idle-loop | warning | `loop()` returned without awaiting a delay; each pass is charged `idleLoopUs` |
| `M605` | delay-not-awaited | error | `delay()`/`delayMicroseconds()` left pending without `await`; MCU halts |
| `M606` | foreign-await | error | firmware suspended on a promise that is not a simulator timer; MCU halts |
| `M607` | delay-in-interrupt | error | `delay()` inside an interrupt/timer callback (ignored) |
| `M608` | firmware-load-error | error | firmware file missing, failed to compile, imported a host module, or threw at load |
| `M609` | missing-entry-points | error | firmware exports neither `setup()` nor `loop()` |
| `M610` | unknown-pin | error | pin number/name does not exist on the profile (call ignored) |
| `M611` | pin-not-output-capable | error | output use of an input-only pin |
| `M612` | no-pwm-on-pin | error | `analogWrite()` on a pin without PWM (core fallback: digitalWrite at ≥ 128) |
| `M613` | no-adc-on-pin | error | `analogRead()` on a pin without an ADC channel (returns 0) |
| `M614` | not-an-interrupt | error | `attachInterrupt()` with an invalid interrupt number (pin number passed?) |
| `M615` | write-to-non-output | warning | `digitalWrite()` on a pin not set to OUTPUT (AVR: toggles the pull-up) |
| `M616` | adc-input-clamped | warning | ADC input outside 0..Vref; reading saturated |
| `M617` | serial-not-begun | warning | Serial output before `Serial.begin()` |
| `M618` | unsupported-api | error | API or mode not available on this part / in the simulator |
| `M619` | invalid-argument | error | argument out of domain (negative delay, unknown mode, non-function handler…) |
| `M620` | value-clamped | warning | value clamped/truncated (`analogWrite` outside 0..255, fractional `delay`) |
| `M621` | timer-pwm-conflict | warning | Timer1 API used together with PWM on its pins (Uno D9/D10) |
| `F140` | delay-not-awaited | error | `delay()` call not awaited (static) |
| `F141` | missing-entry-points | error / warning | `setup()`/`loop()` not exported (error if neither) |
| `F142` | sync-busy-wait | error | `while` polling an input/millis without any `await` |
| `F143` | no-pwm-on-pin | error | `analogWrite()` on a literal non-PWM pin |
| `F144` | pin-capability | error | literal pin missing on the part, without ADC, or input-only used as output |
| `F145` | not-an-interrupt | error | `attachInterrupt(<pin number>, …)` instead of `digitalPinToInterrupt(pin)` |
| `F146` | unsupported-api | error | Arduino API the simulator does not provide (pulseIn, Wire, SPI, EEPROM…) |
| `F147` | host-api | error | wall-clock/host APIs in firmware (Date, setTimeout, Math.random…) |
| `F148` | serial-not-begun | warning | Serial output but no `Serial.begin()` anywhere |
| `F149` | write-without-pinmode | warning | `digitalWrite()` to a pin never set to OUTPUT |

Codes M622–M649 are reserved for the MCU runtime. Pin current ratings (R41x) belong to the
integration and use the limits exposed in the MCU profiles.

## Fix confidence contract

Every fix carries a `confidence`:

- **`verified`** — the platform **simulated** the fix and it passes all of the stage's
  assertions. The agent should apply it directly.
- **`mechanical`** — deterministic transformation (not simulated, but no judgment required).
- **`suggested`** — heuristic; the agent should reason before applying.

Invariants (enforced in code review): never emit a fix that references a flag/capability that
does not exist; never emit an unsimulated number without a `suggested` label.

## Exit codes

| Code | Meaning | Agent action |
|--------|-------------|----------------|
| `0` | all requested stages passed | done |
| `1` | assertion failed (valid circuit) | adjust values (hint!) or topology |
| `2` | invalid/unsolvable circuit (F/S with error severity) | fix the structure first |
| `3` | tooling error (misuse, bench threw) | fix the bench/invocation |

## RunRecord (`circuitsvibe verify --json`)

```jsonc
{
  "runId": "cb4f1e998fc8-001",        // present when recorded in the ledger
  "schema": "circuitsvibe-run/0.1",
  "bench": "led-overcurrent",
  "engine": "circuitsvibe@0.1.0",
  "netlist": {
    "hash": "cb4f1e998fc8…",          // FNV-1a 64 of the canonical netlist (identity)
    "components": [
      { "id": "D1", "type": "LED", "params": { "Is": 1e-20, "n": 2, "Vt": 0.02585 },
        "pins": { "anode": "n2", "cathode": "gnd" }, "at": "bench/….bench.ts:14" },
      { "id": "R1", "type": "Resistor", "params": { "r": 100 },
        "pins": { "1": "n1", "2": "n2" },
        "free": { "min": 100, "max": 10000, "scale": "log" } }
    ],
    "nets": { "gnd": ["D1.cathode", "V1.-"], "n1": ["R1.1", "V1.+"], "n2": ["D1.anode", "R1.2"] }
  },
  "overrides": { "R1": 280 },          // when --set / micro-sweep
  "stages": {
    "lint": { "verdict": "pass" },
    "op": {
      "verdict": "fail",
      "probes": { "D1.i": 0.028039 },
      "solver": { "method": "newton-raphson", "iterations": 6 },
      // when plain Newton failed: "aids": ["gmin-stepping"],
      //   "attempts": [{ "strategy": "newton", "iterations": 100, "converged": false },
      //                { "strategy": "gmin-stepping", "iterations": 98, "converged": true, "steps": 12 }]
      "assertions": [{
        "id": "a1", "stage": "op", "probe": "D1.i",
        "check": { "op": "within", "min": 0.008, "max": 0.012 },
        "verdict": "fail", "measured": 0.028039,
        "margin": { "outsideBy": 0.016039, "ratio": 2.34 },
        "at": "bench/broken/led-overcurrent.bench.ts:22",
        "hint": {
          "kind": "verified-param-range", "param": "R1",
          "passingRange": [261.016, 316.228], "suggestedValue": 261.016,
          "passingSamples": [261, 316.2],
          "note": "25-point log sweep …; every listed value passes ALL op assertions (simulated)"
        }
      }]
    },
    "dc": { "verdict": "skipped", "reason": "op assertions failed" },   // only when asserted
    "ac": { "verdict": "skipped", "reason": "op assertions failed" },   // only when asserted
    "tran": { "verdict": "skipped", "reason": "op assertions failed" }
  },
  "diagnostics": [],                    // Diagnostic objects (code/subject/note/fixes/at)
  "verdict": "fail",
  "firstFailure": "a1",
  "exitCode": 1
}
```

Stage telemetry (`stages.<stage>.solver`):

| Stage | Fields |
|-------|--------|
| op | `method` (`linear` / `newton-raphson`), `iterations`, `aids?`, `attempts?` |
| dc | `method`, `iterations` (all points), `points`, `aidedPoints?` |
| ac | `method: "complex-lu"`, `iterations` (operating point), `points` (sweep frequencies), `aids?` |
| tran | `method` (`trap` / `be`), `iterations`, `acceptedSteps`, `rejectedSteps`, `minStep`, `runs[]` (per configuration: `config`, `newtonFailures`, `lteRejections`, `maxStepTaken`, `breakpoints`, ...) |

Assertion results may also carry `note` (why a measurement is missing or how it was made),
`xFirstViolation` (dc: sweep value of the first violation) and `ref` (AC reference probe).
Transient final values in `stages.tran.probes` are keyed `<probe>@tstop=…s,dt=…s[,maxStep=…]`.

Netlist `params` are plain JSON and complete enough to rebuild the component
(`buildComponent(type, params)`): sources carry their waveform and AC stimulus, e.g.
`{ "v": 0, "pulse": { "v1": 0, "v2": 5, "td": 0, "tr": 1e-6, "tf": 1e-6, "pw": 0.001, "per": 0.002 }, "ac": { "mag": 1, "phase": 0 } }`.

Determinism: the output contains no timestamps (only the ledger adds `at` on write); two
identical runs produce byte-identical records — the diff between agent iterations stays
trivial. Matrix unknowns are ordered by component id and net name, so the same netlist
declared in a different order produces the same numbers (only `at` locations differ).

## Share links (`verify --share`, `share --json`)

`circuitsvibe verify … --json --share` adds one field to the RunRecord (the rest is unchanged,
and the ledger entry never contains it):

```jsonc
"share": { "url": "https://circuitsvibe.com/app.html#c=1.dZDNTs…", "bytes": 426, "warnings": [] }
// or, when the bench cannot be shared (exit code unchanged):
"share": { "error": { "code": "T013", "message": "U1 (Chatter) is a defineComponent part: …" } }
```

`circuitsvibe share <file> --json` prints `{ "url", "bytes", "warnings" }` (exit 0) or
`{ "diagnostics": [...], "exitCode": 3 }`. `warnings` holds T018 when the link exceeds 8 KiB.
Format and encoding: [CIRCUIT-FORMAT.md](CIRCUIT-FORMAT.md).

## `circuitsvibe sweep --json`

```jsonc
{
  "schema": "circuitsvibe-sweep/0.1",
  "bench": "divider-dc-sweep", "engine": "circuitsvibe@0.1.0", "netlist": "9daed3db…",
  "sweep": { "source": "V1", "from": 0, "to": 10, "points": 6 },
  "x": [0, 2, 4, 6, 8, 10],
  "probes": { "out": [0, 1, 2, 3, 4, 5] },
  "solver": { "method": "linear", "iterations": 6 },
  "diagnostics": [],
  "exitCode": 0                       // 0 ok · 2 lint/solver error · 3 misuse
}
```

## Probe grammar

```
'<id>.i'    current through the component  e.g.: 'D1.i'
'<id>.v'    voltage across the component   e.g.: 'R1.v'
'<net>'     voltage of a net named via tb.name(...)   (every stage)
```

AC probes are phasors; assertions measure H = probe / stimulus (the single source with
`ac`), or probe / ref with `.probe(p, { ref })`.

Automatic nets (`n1`, `n2`, …) are deliberately not addressable — name them with
`tb.name('out', pin)` to guarantee stability across edits.
