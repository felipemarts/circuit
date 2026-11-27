# CircuitsVibe

**Circuits as code, verified by simulation — built for AI agents.**
[circuitsvibe.com](https://circuitsvibe.com) · [npm](https://www.npmjs.com/package/circuitsvibe) · MIT

CircuitsVibe is "vitest for circuits". You describe a circuit and its spec in a TypeScript
*bench*; the CLI lints the topology, solves it (DC operating point, DC sweep, AC
small-signal, transient), checks the assertions and returns a verdict an LLM agent can branch on: an exit code, diagnostics with a
stable code, a source location and a fix, and **simulation-verified** sizing hints. Pure
TypeScript, zero runtime dependencies, runs in Node and in the browser.

```bash
npx circuitsvibe init led-driver           # led-driver.bench.ts + AGENTS.md
npx circuitsvibe verify led-driver.bench.ts
```

## A bench

```ts
import { bench, VoltageSource, Resistor, LED } from 'circuitsvibe';

export default bench('led-driver', (tb) => {
  const v1 = tb.add('V1', new VoltageSource(5));
  const r1 = tb.add('R1', new Resistor('100'));
  const d1 = tb.add('D1', new LED());
  v1.pin('+').connect(r1.pin('1'));
  r1.pin('2').connect(d1.pin('anode'));
  d1.pin('cathode').connect(tb.gnd);
  v1.pin('-').connect(tb.gnd);

  tb.param('R1', { min: '100', max: '10k', scale: 'log' }); // sizing is the platform's job
  tb.expect.op('D1.i').toBeWithin('8m', '12m');             // spec as a test
});
```

```
$ npx circuitsvibe verify led-driver.bench.ts
bench led-driver  netlist cb4f1e998fc8  (circuitsvibe@0.2.0)

  ✓ lint  pass
  ✗ op    fail
        A301 a1: D1.i within [8m, 12m] — measured 28.039m (outside by 16.039m, 2.34x)
          at led-driver.bench.ts:13
          hint (verified): R1 in [261.016, 316.228] passes all op assertions — try R1 = 261.016

FAIL · 1 problem · first failure: a1 · exit 1

$ npx circuitsvibe verify led-driver.bench.ts --set R1=261.016
...
PASS · exit 0
```

- **Stable codes, locations and fixes** — `F105 D1 is forward-clamped at 5 V by ideal source(s)
  with no series resistance … at led.bench.ts:10`, found by graph lint **before** the solver
  runs. Every code is documented: `npx circuitsvibe explain F105`.
- **Verified hints** — with `tb.param`, a failed op assertion triggers a sweep of the range;
  the hint lists only values that were simulated and pass.
- **Exit codes with meaning** — `0` pass · `1` spec not met (adjust values) · `2` invalid circuit
  (fix the structure) · `3` bench/tooling error.
- **Deterministic** — no timestamps; two runs of the same bench produce byte-identical JSON,
  and matrix unknowns are ordered by component id / net name, so the same netlist gives the
  same numbers whatever the declaration order.
- **History outside the context window** — every run is appended to `.circuitsvibe/runs.jsonl`;
  `circuitsvibe log list` shows what was already tried.

## For AI agents

- [AGENTS.md](AGENTS.md) — the exact loop to follow, API cheat sheet, codes and pitfalls.
  Also printed by `npx circuitsvibe agents` and written by `init`.
- [skills/circuitsvibe/SKILL.md](skills/circuitsvibe/SKILL.md) — the same as a Claude skill.
- [circuitsvibe.com/llms.txt](https://circuitsvibe.com/llms.txt) — entry point for crawlers.
- **Offline sandboxes**: `dist/circuitsvibe-standalone.mjs` (also at
  `https://circuitsvibe.com/circuitsvibe-standalone.mjs`) is the whole CLI in one file with no
  dependencies: `node circuitsvibe-standalone.mjs verify x.bench.ts --json`.

## CLI

The command is `circuitsvibe` (short alias: `cvibe`).

```
circuitsvibe init [name] [--force]        scaffold <name>.bench.ts + AGENTS.md
circuitsvibe verify <bench.ts> [options]  lint → op → dc → ac → tran → pcb (fail-fast)
    --json                full RunRecord on stdout
    --set R1=330,V1=5     override component values without editing the file
    --stage op,dc,ac,tran,pcb  run a subset (lint always runs)
    --no-hints            skip verified sizing hints
    --no-ledger           don't append to .circuitsvibe/runs.jsonl
    --share               add a share link to the result
circuitsvibe verify <x.circuit.json>      same, for a circuit document
    --vcd out.vcd         write the logic-analyzer capture (VCD)
circuitsvibe sweep <bench.ts> --source V1 --from 0 --to 5 [--points 51 | --step 0.1]
    [--probe out,R1.i] [--param R1] [--json]   DC transfer table / JSON
circuitsvibe export <bench.ts> [-o x.circuit.json] [--set …]   circuit document (JSON)
circuitsvibe share <bench.ts | x.circuit.json> [--base-url URL] [--json]   share link
circuitsvibe open <link> [-o x.circuit.json]                      link (?c=<id> or #c=…) → circuit document
circuitsvibe register | login --user U [--password P] [--kind agent] · logout · whoami
circuitsvibe circuits [query] [--sort stars|recent|views] [--mine]   the public wall
circuitsvibe component search [q] | info <user/name> | add <user/name[@v]> | publish <file.ts>
circuitsvibe log list [--json] | log show <runId>
circuitsvibe explain <code>
circuitsvibe catalog [type|part] [--json]   generic types + real parts; one type or part in detail
circuitsvibe catalog footprints [--json]    PCB footprint library; catalog DIP-8: one footprint's pads
circuitsvibe agents
circuitsvibe version
```

Bench files are TypeScript and need nothing installed: the CLI transpiles them itself (pure
JS) and resolves `'circuitsvibe'` to its own engine. Relative imports of other `.ts`/`.js`/`.json`
files work. Bench files are loaded as CommonJS, so top-level `await` and `import.meta` are not
supported. For editor types, `npm i -D circuitsvibe`.

The RunRecord format and the code taxonomy are in [docs/DIAGNOSTICS.md](docs/DIAGNOSTICS.md);
the design rationale is in [docs/VISION.md](docs/VISION.md).

## Circuit documents and share links

A bench can be turned into a **circuit document**: plain JSON (`circuitsvibe-circuit/1`) with
the components, wiring, free parameters and assertions — the language-neutral contract that
other front-ends (a Python library is planned) produce too. Spec, JSON Schema and versioning:
[docs/CIRCUIT-FORMAT.md](docs/CIRCUIT-FORMAT.md), [schema/circuit.schema.json](schema/circuit.schema.json).

```bash
npx circuitsvibe export led-driver.bench.ts -o led-driver.circuit.json
npx circuitsvibe verify led-driver.circuit.json --json   # same RunRecord and exit code as the bench
npx circuitsvibe register --user me              # once: username + password (agents: --kind agent)
npx circuitsvibe share led-driver.bench.ts       # https://circuitsvibe.com/app.html?c=7GjfXLYBFW (private, 24 h)
npx circuitsvibe share led-driver.bench.ts --public --tags led   # on the wall: searchable, stars
npx circuitsvibe share led-driver.bench.ts --link # no account: the whole circuit in the URL (#c=1.…)
npx circuitsvibe verify led-driver.bench.ts --json --share   # RunRecord + "share": { "url", … }
npx circuitsvibe open "https://circuitsvibe.com/app.html?c=7GjfXLYBFW"   # link → document
```

Logged in, `share` stores the document in the **circuit cache** of the CircuitsVibe service
(PHP + SQLite, deployed with the site — [server/README.md](server/README.md)) and prints a short
link: circuits of any size, custom components included. **Private** links (the default) work
for anyone who has them and expire after 24 h; **public** circuits go to the
[wall](https://circuitsvibe.com/wall.html), where people and agents search them and give
stars. Without an account, a link carries the whole compressed document in the URL fragment
(`#c=1.<base64url(deflate-raw(canonical JSON))>`): no server, but long for big circuits.
Either way, opening it at circuitsvibe.com draws the schematic automatically, re-runs the same
engine in the browser (same verdict, exit code and netlist hash as the CLI) and shows
assertions, diagnostics, ratings, scope, Bode, DC-sweep, logic-analyzer and PCB panels.

**Custom components** (`defineComponent`) travel as the source of the module that exports
them, and can be published to a registry with a ranking of the most used ones:
`npx circuitsvibe component search | info | add | publish`. They are code: the CLI runs a
document's components only with `--allow-code` (T019), the viewer only inside its simulation
worker.

## Library

```ts
import { bench, runLadder, renderHuman, toCircuitDoc, benchFromDoc, encodeShareUrl, decodeShareUrl } from 'circuitsvibe';

const record = runLadder(myBench, { stages: ['lint', 'op'], overrides: { R1: 280 } });
console.log(record.exitCode, renderHuman(record));

const doc = toCircuitDoc(myBench);                 // circuit document (plain JSON)
const url = await encodeShareUrl(doc);             // share link
const back = await decodeShareUrl(url);           // validated document
runLadder(benchFromDoc(back));                    // same RunRecord (locations aside)
```

The package is ESM with type declarations. The library entry is browser-safe (no Node APIs).

## Components

Resistor, Capacitor, Inductor, VoltageSource and CurrentSource (DC, SIN, PULSE, PWL, PWM,
AC stimulus), Diode (SPICE level 1: Rs, junction/diffusion charge, breakdown), LED, NPN/PNP
(Gummel-Poon), NMOS/PMOS (Level 1), Switch (SPDT), Button, op-amps (`IdealOpAmp`,
macro-model `OpAmp`) and open-collector `Comparator`, real catalog parts through one
`Part(id)` — logic ICs and the NE555 (`Part('74HC04')`, pins by datasheet name or number),
op-amps and comparators (`Part('LM358')`, docs/OPAMPS.md) and semiconductors
(`Part('2N3904')`, datasheet ratings checked) — generic logic primitives (`Nand`, `DFF`,
`Counter`, `Clock`, …), plus custom components through `defineComponent`:

```ts
const u1 = tb.add('U1', Part('74HC04'));          // logic IC: datasheet pins, levels, drive
const u2 = tb.add('U2', Part('LM358'));           // op-amp: one channel, pins inp/inn/out/v+/v-
const q1 = tb.add('Q1', Part('2N3904'));          // real part: catalog model + datasheet ratings
const m1 = tb.add('M1', new NMOS({ vto: 2, kp: '50m' }));          // generic: free parameters
const d1 = tb.add('D1', Diode.fromModel('.model D1N4148 D(IS=2.52n RS=0.568 N=1.752 CJO=4p TT=20n)'));
tb.ratings({ derate: 0.8 });                     // check real parts against 80 % of their abs-max
```

```ts
new VoltageSource({ pulse: { v1: 0, v2: 5, tr: '1u', tf: '1u', pw: '1m', per: '2m' } });
new VoltageSource({ dc: 2.5, ac: 1 });   // bias + AC stimulus
```

```ts
import { defineComponent } from 'circuitsvibe';

const MyResistor = defineComponent({
  name: 'MyResistor',
  pins: ['a', 'b'],
  params: { R: { default: 1000, unit: 'Ω' } },
  stamp(ctx) {
    ctx.stampResistance('a', 'b', ctx.params.R);
  },
  ac(ctx) {                       // optional small-signal model (needed for AC benches)
    ctx.stampResistance('a', 'b', ctx.params.R);
  },
});
```

`npx circuitsvibe catalog` prints pins, value semantics and DC behavior for each type.

## Visual simulator

[circuitsvibe.com/app.html](https://circuitsvibe.com/app.html) runs the same engine in the
browser. Opened with a share link (`app.html#c=1.…`, from `npx circuitsvibe share x.bench.ts`)
it is the **viewer**: the schematic is laid out automatically (op-amp triangles, Arduino Uno
and MCU boards, VHDL blocks with their ports grouped as buses), the verification ladder re-runs
in a worker (same verdict, exit code and netlist hash as the CLI — MCU firmware is transpiled
from the embedded `sources[]`), and the result is shown as assertion chips on the drawing plus
panels: assertions, diagnostics (a `file:line` into a firmware or `.vhd` file jumps to the
source), datasheet ratings (R40x, R41x, R42x), scope, Bode, DC sweep, logic analyzer, the
microcontrollers' serial console, the embedded sources with syntax highlighting, the board
(PCB tab: pads, courtyards, ratsnest) and the netlist; current flow is animated along the transient. Without a link it is the editor: a
canvas with A* wire routing, probes, an oscilloscope, a multi-file code editor for custom
components, and projects saved in `localStorage`.

## Status and limitations (v0.1)

| Area | Status |
|------|--------|
| DC operating point (MNA + Newton-Raphson, pn-junction limiting) | ✅ |
| Convergence aids | ✅ gmin stepping, then source stepping (reported in `stages.op.solver`); transient step cut on Newton failure |
| Transient | ✅ trapezoidal (BE after t = 0 and every source corner), adaptive LTE-controlled steps, exact breakpoints |
| DC sweep | ✅ source DC value or component value, curve assertions, `circuitsvibe sweep` |
| AC small-signal | ✅ complex MNA around the operating point, gain/phase/bandwidth/unity-gain/phase-margin |
| Sources | ✅ DC, SIN, PULSE, PWL, PWM (voltage and current), AC stimulus |
| Semiconductors | ✅ Diode (Rs, junction/diffusion charge, Zener breakdown), LED, BJT NPN/PNP (Gummel-Poon subset), MOSFET N/P (Level 1, body diode), SPICE `.model` cards · ❌ JFET, MOSFET levels > 1, temperature |
| Op-amps, comparators | ✅ `IdealOpAmp`, `OpAmp` macro model (Aol, GBW, 2nd pole, slew, swing, current limit, Vos/Ib), open-collector `Comparator`; `Part('LM358')`, LM741, TL072, MCP6002, NE5532, LM393, LM311 from datasheet data — [docs/OPAMPS.md](docs/OPAMPS.md) |
| Digital logic, mixed-signal | ✅ event-driven logic co-simulated with the transient: real ICs `Part('74HC00' / '74HC04' / '74HC14' / '74HC74' / '74HC595' / '74HCT04' / 'CD4017' / 'CD4011' / 'NE555')` with datasheet pins, levels, drive and tpd per VCC; generic logic primitives; `tb.expect.logic(...)`; logic capture + `--vcd` |
| Microcontrollers | ✅ `new ArduinoUno({ firmware: './blink.fw.ts' })` / `new Mcu({ profile: 'atmega328p' \| 'attiny85' \| 'esp32' \| 'rp2040', firmware })`: Arduino-style TypeScript firmware (`import … from 'circuitsvibe/arduino'`, `await delay()`) co-simulated in lockstep with the transient — pins as datasheet-derived push-pull stages, pull-ups, VIL/VIH, ADC, PWM edges, interrupts at the analog crossing; `tb.expect.serial(...)`, `stages.tran.serial`, firmware `file:line` in M6xx diagnostics, pin/port/supply current ratings R410–R413, brown-out M622 · ❌ instruction timing, UART timing, I2C/SPI, sleep |
| VHDL | ✅ `new VhdlBlock({ source: importedVhd, generics })`: a synthesizable VHDL subset on the event engine, ports as per-bit pins bridged to analog nets or wired to logic primitives, V7xx diagnostics with `.vhd` locations |
| Noise, distortion, pole-zero analysis | ❌ |
| Real-part catalog with datasheet ratings | ✅ one `Part()` for every simulated family (data in docs/PARTS.md): semiconductors (diodes, LEDs, Zeners, BJTs, MOSFETs) checked after op/dc/tran, mixed-signal transients included (R401–R404); op-amps/comparators checked at the op point (R420–R425); logic ICs / NE555 (row above); `Part('ArduinoUno', { firmware })` with per-pin / port / total current checks (R410–R413) |
| PCB | ✅ `tb.board` / `tb.place`: footprint library (catalog parts keep their datasheet package), pin → pad maps, placement checks P801–P807 with a mechanical placement fix, ratsnest, viewer PCB tab — [docs/PCB.md](docs/PCB.md) · ❌ routing, DRC, Gerber/BOM, 3D (next) |
| SPICE netlist import/export | ❌ |
| Circuit document (JSON) + share-by-URL | ✅ `export` / `verify x.circuit.json` / `share` / `open` (firmware and VHDL files travel in `sources[]`) · web viewer opens links and re-simulates in the browser |
| Determinism | same netlist ⇒ same numbers: unknowns ordered by component id / net name |
| Linear solver | dense LU (sub-second at ~200 nodes, see `npm run perf`); no sparse LU yet |

## Development

Requires Node ≥ 20.

```bash
npm install
npm run dev           # web app at http://localhost:5173
npm test              # vitest
npm run typecheck
npm run cli -- verify bench/led-driver.bench.ts   # CLI from source (no build step)
npm run benches       # every bench in bench/ against its declared expectation
npm run build:lib     # dist/: index.js, types/, circuitsvibe-standalone.mjs
npm run smoke:pack    # npm pack → install in temp dirs → npx init/verify
npm run perf          # solver timings on 50/200/500-node ladders
npm run build:site    # website into dist-site/
```

Seeded-broken benches in [bench/broken/](bench/broken/) show each diagnostic family; their
header comment states the expected code and exit code, which `npm run benches` enforces.

```
src/
├── elab/       bench DSL, units, canonical netlist + hash, source locations
├── doc/        circuit document (circuitsvibe-circuit/1), validation, share links
├── verify/     lint, op, dc, ac, tran stages, measurements, diagnostic registry
├── opamps/     IdealOpAmp, OpAmp, Comparator, real-part mapping, F12x lint, R42x ratings
├── schema/     RunRecord types, version identity
├── report/     human renderer
├── cli/        CLI commands, bench loader, init
├── ledger/     .circuitsvibe/runs.jsonl
├── core/ components/ analysis/ solver/   the MNA engine
├── digital/    event-driven logic engine
├── mixed/      logic ICs, NE555, primitives, analog↔digital bridges, co-simulation
├── parts/      real-parts catalog (datasheet data)
└── ui/         the visual simulator
```

## License

MIT — see [LICENSE](LICENSE).
