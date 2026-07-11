# Diagnostics — code taxonomy and RunRecord format

Codes are **permanent**: parsers and agents can depend on them; they are never renumbered.
`forge explain <code>` gives the long explanation of each one.

## Ranges

| Range | Phase | Meaning |
|-------|------|-------------|
| `F1xx` | lint (pre-solver) | structural topology |
| `S1xx` | linear solver | unsolvable system |
| `S2xx` | nonlinear solver | Newton-Raphson |
| `A3xx` | assertions | spec not met |
| `T0xx` | tooling | bench authoring error |

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

## RunRecord (`forge verify --json`)

```jsonc
{
  "runId": "cb4f1e998fc8-001",        // present when recorded in the ledger
  "schema": "forge-run/0.1",
  "bench": "led-overcurrent",
  "engine": "circuit-forge@0.1.0",
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
