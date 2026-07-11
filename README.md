# Circuit Forge

Forge electronic circuits with code — a visual editor and simulator in the browser.

## Overview

Circuit Forge is a **code-based** circuit simulator: you program your components and circuits through a simple TypeScript API (`defineComponent`) — ideal for generating circuits with AI assistance — and view the result in a schematic editor with a canvas, probes, and an oscilloscope. The numerical engine uses Modified Nodal Analysis + Newton-Raphson and runs 100% in the browser, with no backend.

## Features

**Visual editor**
- Canvas with pan, zoom, grid, and drag-and-drop
- Component rotation (0°, 90°, 180°, 270°)
- Automatic wire routing with A* (routes around obstacles)
- Ground placed as an explicit symbol connected by wires

**Built-in components**
- Resistor, Capacitor, Inductor
- VoltageSource (DC and AC), CurrentSource
- Diode, LED (nonlinear models)

**Simulation**
- DC analysis: Modified Nodal Analysis with an LU solver
- Transient analysis: time-stepping with implicit Euler
- Newton-Raphson for nonlinear components (diode, LED)
- Voltage/current probes with configurable colors
- Oscilloscope overlay with statistics (max, min, RMS, frequency)
- Waveform plots of the transient result

**Custom components**
- Multi-file code editor with syntax highlighting and line numbering
- `defineComponent({ pins, params, stamp, onStep, ... })` API for defining components in code
- Support for internal state (capacitance, inductance, etc.) and a `nonlinear` flag

**Project management**
- Save / open / rename / delete projects in `localStorage`
- Auto-save on changes
- Export and import circuits as JSON

## `forge` — the verification loop for agents (and humans)

circuit-forge is evolving into **the platform where code becomes a circuit and an LLM
agent iterates until it works** — compile → simulate → assert → structured diagnostics, like
the loop of a modern compiler. The full vision is in [docs/VISION.md](docs/VISION.md);
the error taxonomy is in [docs/DIAGNOSTICS.md](docs/DIAGNOSTICS.md).

A *bench* (`.bench.ts`) describes a circuit + spec:

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

  tb.param('R1', { min: '100', max: '10k', scale: 'log' }); // sizing is the platform's job
  tb.expect.op('D1.i').toBeWithin('8m', '12m');             // spec as a test
});
```

```bash
npm run forge -- verify bench/led-driver.bench.ts          # human
npm run forge -- verify bench/led-driver.bench.ts --json   # agent (full RunRecord)
npm run forge -- explain F101                              # physics + fix for each error
npm run forge -- catalog                                   # component "datasheet"
npm run forge -- log list                                  # run history (.forge/)
```

- **Errors with a stable code, source-code location, and a fix** — `F105 D1 is
  forward-clamped directly across V1 … at bench/led.bench.ts:10`, detected by graph lint
  **before** the solver runs.
- **Simulation-verified hints** — on an assertion failure with `tb.param`, the platform
  sweeps the range and returns `hint (verified): R1 in [261, 316]`; apply it with `--set R1=280`.
- **Exit codes with semantics** — `0` passed · `1` spec not met (adjust values) ·
  `2` invalid circuit (fix the topology) · `3` bench error.
- Examples in [bench/](bench/) — including intentionally broken ones in
  [bench/broken/](bench/broken/) to see each diagnostic in action.

## Stack

- TypeScript 5.4 (strict mode)
- Vite 6 (dev server and build)
- Vitest 2 (tests)
- Canvas 2D API (no UI framework, no runtime dependencies)
- No backend — persistence via `localStorage`

## Running it

Prerequisite: Node.js LTS.

```bash
npm install
npm run dev          # http://localhost:5173
npm run build        # production bundle in dist/
npm test             # run the tests once (Vitest)
npm run test:watch   # watch mode
```

## Project structure

```
src/
├── core/         # Abstractions: Circuit, Component, Pin, Node, CustomComponent
├── components/   # Built-in components (Resistor, Capacitor, Inductor,
│                 #   VoltageSource, CurrentSource, Diode, LED)
├── analysis/     # DCAnalysis and TransientAnalysis
├── solver/       # MNAMatrix, LUSolver, NewtonRaphson
├── ui/           # main, renderer, codeEditor, projectManager,
│                 #   projectStore, chartRenderer, scopeOverlay, examples
└── index.ts      # library entry point

tests/
├── core/         # unit tests for Pin and Node
├── solver/       # MNA matrix and LU tests
└── integration/  # end-to-end circuits:
                  #   voltage-divider, diode, led, custom-component
```

Reference files:
- [src/core/Circuit.ts](src/core/Circuit.ts) — analysis orchestration
- [src/analysis/DCAnalysis.ts](src/analysis/DCAnalysis.ts) — DC operating point
- [src/analysis/TransientAnalysis.ts](src/analysis/TransientAnalysis.ts) — time-domain analysis
- [src/solver/MNAMatrix.ts](src/solver/MNAMatrix.ts) — assembly of the `Ax = b` matrix
- [src/solver/NewtonRaphson.ts](src/solver/NewtonRaphson.ts) — iterative solver for nonlinear elements
- [src/core/CustomComponent.ts](src/core/CustomComponent.ts) — extensibility API
- [src/ui/main.ts](src/ui/main.ts) — application state and event loop
- [src/ui/renderer.ts](src/ui/renderer.ts) — canvas drawing and A* routing

## How the simulation works

`MNAMatrix` assembles the linear system `Ax = b` from each component's contributions (`stamp`). For linear circuits, `LUSolver` solves the system directly. For nonlinear components (diode, LED), `NewtonRaphson` rebuilds and solves the system iteratively until it converges. Transient analysis starts from the DC operating point and advances in time in steps of `dt`, updating the state of capacitors and inductors on each iteration.

## Custom components

Components are defined by the `ComponentDef` interface in [src/core/CustomComponent.ts](src/core/CustomComponent.ts):

```ts
import { defineComponent } from './core/CustomComponent';

const MyResistor = defineComponent({
  name: 'MyResistor',
  pins: ['a', 'b'],
  params: { R: { default: 1000, unit: 'Ω' } },
  stamp(ctx) {
    ctx.stampResistance('a', 'b', ctx.params.R);
  },
});
```

The context (`StampContext`) exposes helpers for conductances, voltage/current sources, reading voltages, and direct matrix access for advanced cases. Nonlinear components set `nonlinear: true` and use `voltage(pin)` inside `stamp` to linearize the operating point.

## Tests

Configuration in [vitest.config.ts](vitest.config.ts). The suite covers:
- Core: pins and nodes ([tests/core/](tests/core/))
- Solver: MNA matrix and LU decomposition ([tests/solver/](tests/solver/))
- Integration: voltage divider, diode, LED, and custom component ([tests/integration/](tests/integration/))

```bash
npm test
```

## Status and limitations

- DC and transient analyses only — no AC / frequency domain, no parametric sweep
- No SPICE netlist import or export
- Custom components are created via code only (no visual library yet)
- Optimized for desktop; no dedicated mobile version
