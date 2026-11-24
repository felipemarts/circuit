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
| `F130`–`F139` | digital lint (pre-simulation) | digital netlist structure (src/digital) |
| `D501`–`D549` | digital runtime | event-driven logic simulation: contention, timing checks (src/digital) |
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
| `S101` | unsolvable-system | error | singular matrix that lint did not model (rare; please report) |
| `S201` | nr-nonconvergence | error | NR did not converge at the DC point — carries the offending component, ΔV, and oscillation history |
| `S202` | nr-nonconvergence | error | NR did not converge at a transient step |
| `A301` | assertion-failed | fail | assertion failed — carries measured, expected, margin, and a verified hint when `tb.param` is present |
| `T001` | bench-error | error | the bench itself threw an exception during elaboration |
| `T002` | stage-crash | error | a stage (op/tran) crashed after elaboration — platform bug; the RunRecord is still emitted (exit 3) |
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
