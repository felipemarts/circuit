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
| `T0xx` | tooling | bench authoring error |
| `F130`–`F139` | digital lint (pre-simulation) | digital netlist structure (F130–F134, src/digital) and bench-level mixed-signal structure (F135–F139, src/mixed) |
| `D501`–`D549` | digital runtime | event-driven logic simulation: contention, timing checks (D501–D507, src/digital); analog↔digital bridges: levels, supplies, drive (D508–D549, src/mixed) |
| `F14x` | firmware lint (pre-simulation) | MCU firmware source mistakes (F140–F149) |
| `M6xx` | MCU runtime | firmware execution on a simulated microcontroller (M601–M649) |

## Active codes

| Code | Slug | Severity | When it fires |
|--------|------|-----------|----------------|
| `F101` | floating-net | error | net with no DC path to ground (isolated by a capacitor/current source) |
| `F103` | unreached-component | error | component (or island) with no connection to the grounded circuit — would be silently ignored by the solver |
| `F104` | voltage-source-short / voltage-source-loop | error | ideal source shorted, or a loop of ideal sources (an inductor counts as a 0 V source in DC) |
| `F105` | source-clamped-diode | error | forward-biased diode/LED clamped directly across an ideal source with no series resistance |
| `F106` | dangling-pin | warning | pin with no connection at all |
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
| `F135` | ic-supply-unconnected | error | an IC's VCC (VDD) or GND (VSS) pin is unconnected, or both are on the same net |
| `F136` | outputs-tied | error | two logic outputs (at least one push-pull) on one analog net — contention through the analog net |
| `F137` | floating-logic-input | error / warning | logic input on an analog net with nothing that sets its voltage (only inputs/capacitors); warning for inputs of an unused section (its outputs open) |
| `F138` | output-on-rail | error | logic output tied to ground, an IC supply rail or an ideal voltage source |
| `D508` | input-forbidden-zone | error | non-Schmitt input between VIL and VIH (at its supply): at the operating point, or in the transient longer than the datasheet max input transition time — carries `vil`, `vih`, `supply`, dwell and `time` |
| `D509` | supply-out-of-range | error / warning | IC supply outside the recommended range (warning) or beyond the absolute maximum / reversed (error) — carries `supply`, `recommended`, `time` |
| `D510` | ic-unpowered | error / warning | supply below half the minimum operating voltage: warning at the operating point; error when never powered during the transient or browned out (with `time`) |
| `D511` | output-overcurrent | error | output pin current above the absolute maximum (or CD4000B 100 mW/output); names the opposing driver when two outputs fight on one net — carries `current`, `limit`, `time` |
| `D512` | unknown-output | warning | an X logic value drives an analog net (output stage modeled half-on, mid-rail) |
| `D513` | input-clamp-overcurrent | error | input driven beyond its rails: protection-diode current above \|IIK\| max |
| `D514` | no-static-logic-state | warning | no consistent DC logic state (oscillator): the op is reported with the outputs of the last settle pass |

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

Mixed-signal notes:
- D5xx diagnostics from the digital engine (D501–D507) and the bridges (D508–D514) carry `time`
  (seconds) when they happen in the transient and `at` = the `tb.add` location of the IC or
  primitive; internal names are rewritten to bench names (`U1.1Y`, `U1:clr` for an IC's
  internal net). Setup/hold violations (D502/D503) of a real flip-flop (74HC74: tsu 20 ns)
  therefore point at the IC.
- Codes D515–D549 are reserved for the mixed-signal runtime, F139 for bench-level digital lint.

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
| tran | `method` (`trap` / `be`), `iterations`, `acceptedSteps`, `rejectedSteps`, `minStep`, `runs[]` (per configuration: `config`, `newtonFailures`, `lteRejections`, `maxStepTaken`, `breakpoints`, mixed-signal `eventCuts`/`digitalEvents`, ...) |

Assertion results may also carry `note` (why a measurement is missing or how it was made),
`xFirstViolation` (dc: sweep value of the first violation) and `ref` (AC reference probe).
Transient final values in `stages.tran.probes` are keyed `<probe>@tstop=…s,dt=…s[,maxStep=…]`.

Logic analyzer (benches with logic ICs / primitives): `stages.tran.logic[]`, one entry per
transient configuration:

```jsonc
"logic": [{
  "config": "tstop=0.003s,dt=0.000003s,maxStep=0.00006s",
  "tEnd": 0.003,
  "signals": {                      // every logic-probed signal + every tb.name'd net with a logic meaning
    "out": [[0, 1], [0.000153, 0], [0.000222, 1]],   // [t (s), value 0 | 1 | 'X' | 'Z'], t = 0 is power-on
    "U1.DISCH": [[0, 0], [0.000153, 1]]
  },
  "truncated": ["clk"],             // only when a signal exceeded 5000 changes
  "events": 1234                    // digital events processed
}]
```

`circuitsvibe verify x.bench.ts --vcd out.vcd` writes the same capture as a VCD file
(`out.2.vcd`, … for further configurations). Logic assertion results carry `measured`
(the value as a number: 0/1, an edge count, a frequency, a duty cycle) and `measuredLogic`
when the logic value is X/Z; `tFirstViolation` for `toBeStable`. The tran run telemetry adds
`eventCuts` (steps cut back to a threshold crossing) and `digitalEvents`.

Netlist `params` are plain JSON and complete enough to rebuild the component
(`buildComponent(type, params)`): sources carry their waveform and AC stimulus, e.g.
`{ "v": 0, "pulse": { "v1": 0, "v2": 5, "td": 0, "tr": 1e-6, "tf": 1e-6, "pw": 0.001, "per": 0.002 }, "ac": { "mag": 1, "phase": 0 } }`.

Determinism: the output contains no timestamps (only the ledger adds `at` on write); two
identical runs produce byte-identical records — the diff between agent iterations stays
trivial. Matrix unknowns are ordered by component id and net name, so the same netlist
declared in a different order produces the same numbers (only `at` locations differ).

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
'<id>.<pin>'  voltage of an IC pin ('U1.1Y', 'U1.~1Q', 'U1.pin6') or of a bridged primitive pin (op, tran)
```

Logic probes (`tb.expect.logic(probe)`):

```
'<net>'        a tb.name'd net: a pure-digital net, or an analog net carrying a logic pin
               (its output pin's value if it has one, else its first input pin's)
'U1.<pin>'     an IC pin by datasheet name ('1Y', '~OE', "QH'", 'CARRY OUT'; case, spaces and _ ignored)
'U1.pin<N>'    an IC pin by number
'G1.<pin>'     a primitive pin ('q', 'y', 'clk')
```

An IC input pin's logic value is what its bridge recognised (VIH/VIL, VT+/VT−, comparator);
an output pin's is the internal logic value driving its output stage.

AC probes are phasors; assertions measure H = probe / stimulus (the single source with
`ac`), or probe / ref with `.probe(p, { ref })`.

Automatic nets (`n1`, `n2`, …) are deliberately not addressable — name them with
`tb.name('out', pin)` to guarantee stability across edits.
