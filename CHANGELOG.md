# Changelog

All notable changes to `circuitsvibe`. The diagnostic codes are permanent (see
[docs/DIAGNOSTICS.md](docs/DIAGNOSTICS.md)); RunRecords stay `circuitsvibe-run/0.1` with
additive fields only.

## 0.2.0

First publishable release under the `circuitsvibe` name (formerly "Circuit Forge").

### Packaging and agents
- npm package `circuitsvibe` with a prebuilt `dist/` (ESM library + `.d.ts`, `circuitsvibe/arduino`
  firmware types) and zero runtime dependencies. CLI `circuitsvibe` (alias `cvibe`; the old
  `forge` bin collided with the npm `forge` package and Foundry).
- `dist/circuitsvibe-standalone.mjs`: the whole CLI in one file for offline sandboxes.
- Bench files load without a native toolchain (bundled sucrase, line numbers preserved);
  source locations are cwd-relative with forward slashes on every OS.
- `init`, `agents`, `version`, `sweep`, `export`, `share`, `open` commands; `verify --share`,
  `--vcd`, `verify x.circuit.json`.
- AGENTS.md playbook, a Claude skill (`skills/circuitsvibe/SKILL.md`), `llms.txt`.
- CI on pull requests: typecheck, tests, every bench against its declared exit/diagnostic code
  (twice, byte-identical), document round trip, and an `npm pack` install smoke test.

### Numerical core
- Deterministic ordering of matrix unknowns (same netlist ⇒ same numbers).
- Convergence aids: junction/FET voltage limiting, gmin stepping, source stepping (reported in
  telemetry); transient step cutting on Newton failure.
- Trapezoidal integration with Backward-Euler restarts, LTE-adaptive timestep, exact
  breakpoints at source corners. Sources: DC, SIN, PULSE, PWL, PWM, AC stimulus.
- DC sweep (`tb.expect.dc`, `circuitsvibe sweep`) and AC small-signal analysis (gain, phase,
  −3 dB bandwidth, unity-gain frequency, phase margin). New stages: lint → op → dc → ac → tran.

### Components
- Diode with Rs, junction/diffusion capacitance and Zener breakdown; BJT (Gummel-Poon subset);
  MOSFET (Level 1, gate capacitances, body diode); SPICE `.model` parser.
- Op-amps (`IdealOpAmp`, macro-model `OpAmp`: Aol, GBW, second pole, slew, swing, current limit,
  offset/bias) and open-collector comparators.
- Logic primitives on an event-driven digital engine co-simulated with the analog transient;
  bridges with datasheet thresholds, output resistance and delays.
- VHDL blocks: a synthesizable subset compiled onto the digital engine.
- Microcontrollers running Arduino-style TypeScript firmware in lockstep with the transient
  (ATmega328P / Arduino Uno, ATtiny85, ESP32, RP2040): GPIO, ADC, PWM, interrupts, timers, Serial.

### Real parts and ratings
- One `Part(id)` for catalog parts with datasheet citations: diodes/LEDs/Zeners, BJTs, MOSFETs,
  op-amps/comparators, 74HC/74HCT/CD4000 logic, NE555, Arduino Uno (docs/PARTS.md).
- Datasheet absolute-maximum checks in `stages.<stage>.ratings[]`, separate from assertions
  (R401–R404 semiconductors, R410–R413 MCU pins/ports, R420–R425 amplifiers); exit 1.

### Sharing
- Language-neutral circuit document `circuitsvibe-circuit/1` (JSON Schema in
  `schema/circuit.schema.json`, spec in docs/CIRCUIT-FORMAT.md); every bench round-trips to a
  byte-identical RunRecord, firmware and VHDL sources included.
- Share links carry the whole circuit in the URL fragment (`app.html#c=1.…`, no backend).
  The web viewer draws the schematic automatically, re-runs the same engine in the browser and
  shows assertions, diagnostics, ratings, scope, Bode, DC sweep, logic analyzer and serial output.

### Website
- Redesigned landing, documentation and simulator at circuitsvibe.com (EN/PT).

## 0.1.0

- The verification loop: `bench()` DSL, lint before the solver (F101–F106), DC operating point
  with simulation-verified sizing hints, fixed-step transient with measurements, exit codes
  0/1/2/3, JSON RunRecords, run ledger, `explain` and `catalog`.
