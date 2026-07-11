# Vision: code becomes a circuit, and the agent closes the loop

> **The thesis**: what made "vibecoding" work for software wasn't the model — it was the
> **feedback loop**: compiler, tests, structured errors, terminal. Electronics never
> had that. SPICE spits out `singular matrix` without saying where, why, or how to fix it.
> Whoever builds the feedback loop for electronics defines the standard that LLM agents will use.

## Why now (what the research shows)

A deep survey of the state of the art (2024–2026) pinpoints the gap precisely:

- **tscircuit** (React→PCB, 2.3k stars): compiles code to fabrication, but simulation is
  shallow (ngspice-WASM, no assertions, no pass/fail). The loop doesn't close — the docs tell
  the human to verify manually.
- **atopile** (.ato DSL→KiCad, YC W24): algebraic assertions, but **zero simulation**. The
  founders themselves admit they no longer write .ato by hand — Claude writes it.
- **JITX** (Sequoia, $12M): publicly abandoned its own DSL in 2025 — *"any advantage
  of a custom DSL is completely blown out of the water by modern toolchains; modern AIs are
  really good at writing Python"*.
- **Wokwi**: the only real agent loop (headless CLI, assertions, MCP) — but digital firmware
  only, closed engine, paid cloud.
- **LLM×EDA papers**: SPICEAssistant (Bosch) raised the success rate from 15%→**91%** using
  simulation feedback alone; AnalogCoder proved the staged verification ladder;
  AnalogAgent identified "context attrition" — the agent loses the details of the diagnostics
  over the course of debugging, so the history needs to live **outside** the context. Every
  paper builds throwaway PySpice harnesses. **Nobody has packaged the infrastructure.**

The unclaimed territory, confirmed on every front: **"vitest for circuits"** —
compile → simulate → assert → structured diagnostics, local-first, no cloud token.

## The platform's five contracts

Everything in circuit-forge derives from five contracts, designed so that an LLM agent
converges on a working circuit in ≤5 iterations:

### 1. TypeScript is the source of truth
No custom DSL (the JITX lesson). The circuit is TS code with named pins
(`anode`/`cathode`, `+`/`-` — research shows semantic pins eliminate the most common class of
LLM error). The canvas is a *projection* of the code, never the other way around.

### 2. Every error has a stable code, a location, and a fix
rustc-style: `F101 net n3 has no DC path to ground` + `at bench/led.bench.ts:14` +
a note with the physics + a fix with a **confidence label**:
- `verified` — the platform **simulated** the fix and it passes. Apply directly.
- `mechanical` — deterministic transformation.
- `suggested` — heuristic; reason first.

Hard rule: never emit a fix that references a capability that doesn't exist, never emit a
numeric value that wasn't simulated as if it were certain.

### 3. Lint runs before the solver
`singular matrix` **never** reaches the agent. The topology is analyzed as a graph before the
matrix exists: floating net (F101), disconnected component (F103), loop of ideal sources (F104),
LED clamped across the source (F105). Each one with a name, a culprit, and a fix.

### 4. Exit codes that tell you which loop you're in
- `0` — everything passed.
- `1` — assertion failed: the circuit is valid, the spec wasn't met → **adjust values**
  (use the verified hint) or topology.
- `2` — invalid/unsolvable circuit → **fix the structure first**.
- `3` — tooling/bench error → fix the bench code.

The agent branches without parsing anything.

### 5. The agent doesn't guess numbers
LLMs are good at topology and bad at continuous sizing (consensus across all the
research). `tb.param('R1', {min:'100', max:'10k', scale:'log'})` declares the free
parameter; when an assertion fails, the platform sweeps the range, **simulates** each point,
and returns the passing range — `hint (verified): R1 in [261, 316]`. Determinism: same bench, same
numbers, always; output with no timestamps so two runs diff cleanly.

## The verification ladder (the product)

```
bench/led-driver.bench.ts
        │  elaboration (code → canonical netlist + hash)
        ▼
  L0 lint    pure graph, no solver       F1xx  ──┐
  L1 op      DC operating point          S2xx    │ fail-fast:
             assertions + hints          A301    │ stage failed,
  L3 tran    transient + measurements    A301    │ next ones skip
             (settle/ripple/overshoot)         ──┘
        ▼
  RunRecord (JSON) ── human renderer ── ledger (.forge/runs.jsonl)
```

A bench is the complete artifact: circuit + free parameters + assertions.

```ts
import { bench, VoltageSource, Resistor, LED } from 'circuit-forge';

export default bench('led-driver', (tb) => {
  const v1 = tb.add('V1', new VoltageSource(5));
  const r1 = tb.add('R1', new Resistor('330'));
  const d1 = tb.add('D1', new LED());

  v1.pin('+').connect(r1.pin('1'));
  r1.pin('2').connect(d1.pin('anode'));
  d1.pin('cathode').connect(tb.gnd);
  v1.pin('-').connect(tb.gnd);

  tb.param('R1', { min: '100', max: '10k', scale: 'log' });   // sizing is the platform's job
  tb.expect.op('D1.i').toBeWithin('8m', '12m');               // spec as a test
  tb.expect.tran({ tstop: '5m', dt: '10u' })
    .probe('D1.i').toNeverExceed('25m');
});
```

```
$ forge verify bench/led-driver.bench.ts        # human
$ forge verify bench/led-driver.bench.ts --json # agent (full RunRecord)
$ forge verify ... --set R1=280                 # applies the hint without editing code
$ forge log list                                # what has already been tried (anti context-attrition)
$ forge explain F101                            # physics + fix for each code
$ forge catalog                                 # component datasheet for the agent
```

## Current state (v0.1 — the loop exists)

- ✅ Correct MNA engine (DC + Backward-Euler transient, Newton-Raphson) — validated against
  analytical solutions; 91 tests.
- ✅ `bench()` DSL with units (`'4.7k'`), named pins, canonical netlist with hash,
  per-component/per-assertion source location ("circuit sourcemaps").
- ✅ Structural lint F101/F103/F104/F105/F106 before the solver.
- ✅ DC stage with probes (`D1.i`, `R1.v`, named nets), assertions, **simulation-verified**
  hints, and non-convergence telemetry (offending component + oscillation).
- ✅ Transient stage with a measurement kernel (settle, neverExceed, stayAbove/Below,
  ripple, final value) + a waveform excerpt at the first violation.
- ✅ `forge` CLI (verify/log/explain/catalog), exit codes 0/1/2/3, `--json`, `--set`,
  JSONL ledger.
- ✅ The existing canvas UI keeps working (the engine is the same).

## Roadmap

| Phase | Deliverable | Why |
|------|---------|-----|
| v0.2 | L2 stage (sweep/transfer curves), `forge sweep`, `forge probe` over the ledger | completes the AnalogCoder ladder |
| v0.3 | Token-budget report (failures-only + drill-down pointers), `--watch` with a hard solve timeout | sub-second iteration; never block the agent's tool call |
| v0.4 | **MCP server** (`forge mcp`): verify/sweep/probe/history/catalog/explain with the SAME schema as the CLI | the agent uses it as a native tool |
| v0.5 | `forge optimize` (Nelder-Mead over the ladder as an objective function), gmin/source stepping in NR | the agent never picks a resistor by hand again |
| v0.6 | UI = RunRecord viewer: assertion chips on the schematic, bands on the oscilloscope, ledger timeline | human and agent see the same artifact |
| v0.7 | Strong determinism (ordering by ref in the matrix), SPICE export + ngspice cross-check in CI with a tolerance table | public numerical credibility |
| v0.8 | Level-1 MOSFET, Ebers-Moll BJT, behavioral sources; op-amp macro-model | unlocks real specs |
| v1.0 | **CircuitBench**: public eval of "iterations-to-green" per model, tasks with hidden assertions; freeze of the `forge-run/1.0` schema | the standard wins because agents provably converge on it |

Sequencing rules (from the architecture-panel judges): the terminal loop stands on its own
**before** MCP and UI; the spec is extracted from the working tool, never published before it;
no benchmark claim beyond what the component library covers.

## Recorded decisions

- **No monorepo for now** — a single package until the schemas stabilize (v0.7).
- **Component identity by `kind` tag**, never `instanceof` — the CLI and the bench may load
  distinct copies of the classes (two bundles); structural identity is the contract.
- **Determinism v0.1 = same source, same numbers** (JS Sets iterate in insertion order).
  Same hash ⇒ same results requires the ordering-by-ref patch (v0.7); until then the claim is
  scoped honestly.
- **The batch path is the agent's contract** — the UI's "live" path stretches `dt` under load
  (machine-dependent) and must never feed assertions.
- **`.forge/` in `.gitignore`** — the ledger is a local artifact, not source.
