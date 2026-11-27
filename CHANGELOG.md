# Changelog

All notable changes to `circuitsvibe`. The diagnostic codes are permanent (see
[docs/DIAGNOSTICS.md](docs/DIAGNOSTICS.md)); RunRecords stay `circuitsvibe-run/0.1` with
additive fields only.

## Unreleased

### Circuit service: short links, the wall, the component registry
- PHP 8.1 + SQLite API deployed with the site (`server/api` → `/api`, see server/README.md):
  username + password accounts for people and agents (bearer tokens, no cookies); a **circuit
  cache** behind short links `app.html?c=<id>` — any size, private links expire after 24 h,
  public ones go to the **wall** (`wall.html`: search, sort, tags, stars); a **component
  registry** of `defineComponent` modules with immutable SHA-256-identified versions and a
  ranking by distinct users.
- CLI: `register`, `login`, `logout`, `whoami`; `share` uploads when logged in (`--public`,
  `--title`, `--tags`; `--link` keeps the fragment link); `open` / `verify` accept `?c=` links;
  `circuits` lists the wall; `component search | info | add | publish`.
- Custom components travel in circuit documents as the source of the module that exports them
  (`definitions[]` + `sources[]`, with registry provenance). Running that code needs
  `--allow-code` in the CLI (**T019**); the viewer runs it only in its simulation worker.
  New codes T019 (custom code not allowed) and T020 (service error); T013 now means "the
  definition is not in its own exported module".
- Viewer: opens `?c=` links, shows author / visibility / expiry / views, stars, publish and
  short-link actions, a notice when the circuit runs custom code, and a login dialog.

### Schematic layout
- Op-amp feedback parts sit over / under their amplifier instead of looping around it; stacks
  hanging from an IC or MCU are ordered to avoid crossings and aligned in rows; rail and
  ground buses get separate columns when they overlap. Across the 88 benches: wire detours
  4520 → 2040 px, overlapping nets 5 → 0.

### PCB, phase 1: board, footprints and placement
- `tb.board({ width, height | outline | preset: 'uno-shield', layers, thickness, tech, holes,
  rules })` and `tb.place(id, { x, y, rot, side, footprint, pads } | { offBoard: true })`. Lengths
  in mm (unit strings accepted in the DSL), origin lower-left, y up, rotation CCW.
- New last rung of the ladder, the **pcb** stage (`--stage pcb`): footprint and pin → pad map for
  every component, placement checks **P801–P807** (outside the board / edge clearance,
  overlapping courtyards and mounting holes, no footprint, pin without pad, not placed — with a
  mechanical `tb.place` patch at a free spot —, off-board part without a connector, bad pad
  map), and the ratsnest (MST airwires per net) in `stages.pcb.pcb`.
- Parametric footprint library following the KiCad libraries: axial, DO-35/41, disc and radial
  capacitors, 3/5 mm and chip LEDs, 0402–1210, SOD-123, SMA, TO-92, TO-220, TO-126, SOT-23,
  DIP-n, SOIC-8/14/16, pin headers, screw terminals, tactile and slide switches, and the Arduino
  Uno R3 shield headers (`UNO-SHIELD`). Catalog parts keep their datasheet package and pin
  numbers; ICs follow the board tech (DIP ↔ SOIC); generic parts use the `tech` default.
  Custom footprints as data. `circuitsvibe catalog footprints` / `catalog <footprint>`.
- Circuit document field `pcb` (schema + `validateCircuitDoc`), carried by share links; the
  viewer has a **PCB** tab (board, pads by layer, courtyards, silkscreen, ratsnest, ghosts at the
  suggested spot of unplaced parts). docs/PCB.md.
- Next: autorouter and DRC (P81x), current-aware trace widths from the simulation, Gerber /
  Excellon / BOM / pick-and-place output, 3D view.

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
