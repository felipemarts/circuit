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

Everything in circuitsvibe derives from five contracts, designed so that an LLM agent
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
  L1 op      DC operating point          S2xx    │
             assertions + hints          A301    │ fail-fast:
  L2 dc      DC sweep, curve checks      A301    │ stage failed,
  L2 ac      small-signal sweep          S204    │ next ones skip
             gain/phase/bandwidth/PM     A301    │
  L3 tran    transient + measurements    S202/3  │
             (settle/ripple/overshoot)   A301  ──┘
        ▼
  RunRecord (JSON) ── human renderer ── ledger (.circuitsvibe/runs.jsonl)
```

A bench is the complete artifact: circuit + free parameters + assertions.

```ts
import { bench, VoltageSource, Resistor, LED } from 'circuitsvibe';

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
$ circuitsvibe verify bench/led-driver.bench.ts        # human
$ circuitsvibe verify bench/led-driver.bench.ts --json # agent (full RunRecord)
$ circuitsvibe verify ... --set R1=280                 # applies the hint without editing code
$ circuitsvibe log list                                # what has already been tried (anti context-attrition)
$ circuitsvibe explain F101                            # physics + fix for each code
$ circuitsvibe catalog                                 # component datasheet for the agent
```

## Current state (v0.1 + numerical core)

- ✅ MNA engine validated against analytical solutions (RC/RL/RLC transients, AC RC and RLC
  responses, diode DC sweep vs the implicit Shockley solution):
  - DC operating point: Newton-Raphson with SPICE pn-junction limiting (the limiting hook is
    part of the device protocol, `fetlim`/`limvds` ready for FET models), then gmin
    stepping, then source stepping — the telemetry names the aid that was needed, and a
    total failure still names the culprit device;
  - transient: trapezoidal with Backward-Euler restarts after t = 0 and every source corner,
    local-truncation-error step control, exact landing on PULSE/PWL/PWM corners, step cuts
    on Newton failure (S202) and a minimum-step floor (S203);
  - DC sweep of a source or a component value (warm-started points);
  - AC small-signal: complex MNA linearized at the operating point; custom components
    provide an optional `ac(ctx)` stamp (S204 otherwise);
  - sources: DC, SIN, PULSE, PWL, PWM, AC stimulus — plain JSON in the netlist params.
- ✅ `bench()` DSL with units (`'4.7k'`), named pins, canonical netlist with hash,
  per-component/per-assertion source location ("circuit sourcemaps").
- ✅ Structural lint F101/F103/F104/F105/F106 before the solver.
- ✅ DC stage with probes (`D1.i`, `R1.v`, named nets), assertions, **simulation-verified**
  hints, and non-convergence telemetry (offending component + oscillation).
- ✅ Transient stage with a measurement kernel (settle, neverExceed, stayAbove/Below,
  ripple, final value) that interpolates the non-uniform adaptive samples, plus a waveform
  excerpt at the first violation.
- ✅ DC-sweep stage (`at`, `slopeAt`, monotonic, crossing) and AC stage (`gainAt`, `phaseAt`,
  `bandwidth3dB`, `unityGainFrequency`, `phaseMargin`); `circuitsvibe sweep`.
- ✅ `circuitsvibe` CLI (init/verify/log/explain/catalog/agents), exit codes 0/1/2/3,
  `--json`, `--set`, JSONL ledger.
- ✅ Publishable: prebuilt `dist/` (ESM + .d.ts), zero runtime dependencies,
  `npx circuitsvibe` works in an empty folder, and a single-file
  `circuitsvibe-standalone.mjs` for offline agents. AGENTS.md, a Claude skill and llms.txt.
- ✅ Circuit document `circuitsvibe-circuit/1` (docs/CIRCUIT-FORMAT.md + JSON Schema): the
  language-neutral form of a bench; every bench round-trips to an identical RunRecord.
  `export`, `verify x.circuit.json`, and share links that carry the whole circuit in the URL
  fragment (`share`, `verify --share`, `open`) — no backend. Opening links in the web app is
  the viewer phase (in progress).
- ✅ Mixed-signal: the event-driven digital engine co-simulates with the adaptive transient
  (digital events and output ramps are breakpoints, steps are cut back to threshold
  crossings, the digital side never runs past accepted analog time); real logic ICs and the
  NE555 from the parts catalog (pins, VIL/VIH or VT+/VT−, Rout, tpd per supply, ratings →
  D508–D514), generic logic primitives, `tb.expect.logic`, bench-level digital lint
  F130–F138, logic capture in the RunRecord and `--vcd`.
- ✅ The existing canvas UI keeps working (the engine is the same).

## Roadmap

| Phase | Deliverable | Why |
|------|---------|-----|
| v0.2 | ~~L2 stage (sweep/transfer curves), `circuitsvibe sweep`~~ (done), `circuitsvibe probe` over the ledger | completes the AnalogCoder ladder |
| v0.3 | Token-budget report (failures-only + drill-down pointers), `--watch` with a hard solve timeout | sub-second iteration; never block the agent's tool call |
| v0.4 | **MCP server** (`circuitsvibe mcp`): verify/sweep/probe/history/catalog/explain with the SAME schema as the CLI | the agent uses it as a native tool |
| v0.5 | `circuitsvibe optimize` (Nelder-Mead over the ladder as an objective function) — gmin/source stepping already shipped | the agent never picks a resistor by hand again |
| v0.6 | UI = RunRecord viewer: assertion chips on the schematic, bands on the oscilloscope, ledger timeline | human and agent see the same artifact |
| v0.7 | SPICE export + ngspice cross-check in CI with a tolerance table (ordering by ref in the matrix already shipped); sparse LU once benches pass ~500 nodes | public numerical credibility |
| v0.8 | Level-1 MOSFET, Ebers-Moll BJT, behavioral sources; op-amp macro-model | unlocks real specs |
| v1.0 | **CircuitBench**: public eval of "iterations-to-green" per model, tasks with hidden assertions; freeze of the `circuitsvibe-run/1.0` schema | the standard wins because agents provably converge on it |

Sequencing rules (from the architecture-panel judges): the terminal loop stands on its own
**before** MCP and UI; the spec is extracted from the working tool, never published before it;
no benchmark claim beyond what the component library covers.

## Recorded decisions

- **No monorepo for now** — a single package until the schemas stabilize (v0.7).
- **Component identity by `kind` tag**, never `instanceof` — the CLI and the bench may load
  distinct copies of the classes (two bundles); structural identity is the contract.
- **Determinism = same netlist, same numbers.** Bench elaboration orders the matrix
  unknowns by component id and net name (auto-named nets are themselves named from their
  sorted pin refs), so the same netlist hash yields the same matrix, the same pivot order
  and byte-identical RunRecords whatever the declaration order (only `at` locations differ;
  a test enforces it). Circuits built without a bench (the visual editor) fall back to
  discovery order.
- **Transient defaults favour accuracy over speed**: truncation-error reltol 1e-4 (≈ 0.01 % of
  the signal per step), and `dt` stays a step ceiling for backward compatibility; `maxStep`
  opts into long strides. The default initial state stays the zero state (a DC source is a
  step at t = 0); `ic: 'op'` starts from the operating point.
- **Dense LU stays for now** (measured with `npm run perf`): at ~200 nodes a 1000-step
  transient takes ~0.2–0.5 s and an adaptive one ~0.07–0.15 s; LU is ~60 % of that, the rest
  is O(n²) dense assembly. A sparse LU only pays off together with sparse assembly, at
  ~500+ nodes.
- **The batch path is the agent's contract** — the UI's "live" path stretches `dt` under load
  (machine-dependent) and must never feed assertions.
- **`.circuitsvibe/` in `.gitignore`** — the ledger is a local artifact, not source.
- **Name: `circuitsvibe`, CLI `circuitsvibe` (alias `cvibe`)** — the old `forge` bin collides
  with the npm package `forge` and with Foundry's widely installed `forge`. The RunRecord schema
  and ledger directory follow the package name (`circuitsvibe-run/0.1`, `.circuitsvibe/`).
- **Bench files load without a native toolchain** — the CLI transpiles them with sucrase
  (pure JS, bundled into the CLI; line numbers preserved) and evaluates them as CommonJS under
  their real filename, so `at` locations point at the source. Consequence: no top-level
  `await` or `import.meta` in bench files. `import ... from 'circuitsvibe'` resolves to the
  running CLI, so a bench needs no local install.
- **The circuit document is the contract, TypeScript is one front-end** — documents are plain
  SI-unit JSON mirroring the RunRecord netlist, so a Python library (or any language) can
  produce them; readers reject unknown fields instead of ignoring them; custom
  `defineComponent` parts are code and are refused (T013) rather than half-serialized.
- **Share links live in the URL fragment** (`#c=1.` + base64url of deflate-raw canonical JSON),
  like excalidraw: no server sees or stores a circuit. Warn above 8 KiB, refuse above 2 MiB.
- **Locations are cwd-relative with forward slashes** — RunRecords are identical across
  machines and operating systems.
- **Mixed-signal = one MNA system + one event kernel, coupled through a hook** —
  `circuit._cosim` (src/mixed) is consulted by the engine at DC solves (static power-on
  settle), breakpoints, step acceptance and threshold location. IC pins are always analog
  nodes (supply-referenced levels, drive, contention are physical); nets that touch only
  logic primitives stay purely digital. Datasheet numbers come from src/parts; the few
  model constants that are not datasheet values (output ramp, unpowered threshold, NE555
  latch delay, clamp-diode Is) are named in src/mixed/families.ts and printed by the catalog.
- **Logic inputs use the guaranteed levels** (rising at VIH, falling at VIL): the latest
  moment a real part is guaranteed to have switched, plus D508 when an input lingers in
  between — rather than an invented "typical" switching point.
