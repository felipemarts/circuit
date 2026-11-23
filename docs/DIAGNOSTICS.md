# Diagnostics — code taxonomy and RunRecord format

Codes are **permanent**: parsers and agents can depend on them; they are never renumbered.
`circuitsvibe explain <code>` gives the long explanation of each one.

## Ranges

| Range | Phase | Meaning |
|-------|------|-------------|
| `F1xx` | lint (pre-solver) | structural topology |
| `S1xx` | linear solver | unsolvable system |
| `S2xx` | nonlinear solver | Newton-Raphson |
| `A3xx` | assertions | spec not met |
| `T0xx` | tooling | bench authoring error |
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
| `S201` | nr-nonconvergence | error | NR did not converge at the DC point — carries the offending component, ΔV, and oscillation history |
| `S202` | nr-nonconvergence | error | NR did not converge at a transient step |
| `A301` | assertion-failed | fail | assertion failed — carries measured, expected, margin, and a verified hint when `tb.param` is present |
| `T001` | bench-error | error | the bench itself threw an exception during elaboration |
| `T002` | stage-crash | error | a stage (op/tran) crashed after elaboration — platform bug; the RunRecord is still emitted (exit 3) |

Semantic notes:
- Lint **always runs** (even with `--stage op`): solving a circuit that lint would reject
  would mean silently discarding components and reporting fabricated numbers.
- A `settleWithin` that never settles reports `measured` = end of the window (finite) — never
  `Infinity`, which would become `null` in JSON.
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
      "solver": { "method": "newton-raphson" },
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
    "tran": { "verdict": "skipped", "reason": "op assertions failed" }
  },
  "diagnostics": [],                    // Diagnostic objects (code/subject/note/fixes/at)
  "verdict": "fail",
  "firstFailure": "a1",
  "exitCode": 1
}
```

Determinism: the output contains no timestamps (only the ledger adds `at` on write); two
identical runs produce byte-identical records — the diff between agent iterations stays
trivial.

## Probe grammar

```
'<id>.i'    current through the component  e.g.: 'D1.i'
'<id>.v'    voltage across the component   e.g.: 'R1.v'
'<net>'     voltage of a net named via tb.name(...)   (op stage only)
```

Automatic nets (`n1`, `n2`, …) are deliberately not addressable — name them with
`tb.name('out', pin)` to guarantee stability across edits.
