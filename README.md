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
bench led-driver  netlist cb4f1e998fc8  (circuitsvibe@0.1.0)

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
circuitsvibe verify <bench.ts> [options]  lint → op → dc → ac → tran (fail-fast)
    --json                full RunRecord on stdout
    --set R1=330,V1=5     override component values without editing the file
    --stage op,dc,ac,tran run a subset (lint always runs)
    --no-hints            skip verified sizing hints
    --no-ledger           don't append to .circuitsvibe/runs.jsonl
    --share               add a share link to the result
circuitsvibe verify <x.circuit.json>      same, for a circuit document
circuitsvibe sweep <bench.ts> --source V1 --from 0 --to 5 [--points 51 | --step 0.1]
    [--probe out,R1.i] [--param R1] [--json]   DC transfer table / JSON
circuitsvibe export <bench.ts> [-o x.circuit.json] [--set …]   circuit document (JSON)
circuitsvibe share <bench.ts | x.circuit.json> [--base-url URL] [--json]   share link
circuitsvibe open <link> [-o x.circuit.json]                      link → circuit document
circuitsvibe log list [--json] | log show <runId>
circuitsvibe explain <code>
circuitsvibe catalog [type] [--json]
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
npx circuitsvibe share led-driver.bench.ts               # https://circuitsvibe.com/app.html#c=1.dZDNTs…
npx circuitsvibe verify led-driver.bench.ts --json --share   # RunRecord + "share": { "url", … }
npx circuitsvibe open "https://circuitsvibe.com/app.html#c=1.…"   # link → document
```

A share link carries the whole compressed document in the URL fragment —
`#c=1.<base64url(deflate-raw(canonical JSON))>` — so there is no backend and nothing is
uploaded. The benches in `bench/` give links of about 340–560 characters. **Opening links in
the web app is in progress** (the viewer phase); until then `circuitsvibe open` decodes them.
`defineComponent` parts are code and cannot be shared (T013).

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
AC stimulus), Diode (Shockley, pn-junction limiting), LED, Switch (SPDT), Button, op-amps
(`IdealOpAmp`, macro-model `OpAmp`) and open-collector `Comparator`, real op-amps and
comparators through `Part('LM358')` (docs/OPAMPS.md), plus custom components through
`defineComponent`:

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

[circuitsvibe.com/app.html](https://circuitsvibe.com/app.html) is a browser editor on the same
engine: a canvas with A* wire routing, probes, an oscilloscope, animated current flow, a
multi-file code editor for custom components, and projects saved in `localStorage`.

## Status and limitations (v0.1)

| Area | Status |
|------|--------|
| DC operating point (MNA + Newton-Raphson, pn-junction limiting) | ✅ |
| Convergence aids | ✅ gmin stepping, then source stepping (reported in `stages.op.solver`); transient step cut on Newton failure |
| Transient | ✅ trapezoidal (BE after t = 0 and every source corner), adaptive LTE-controlled steps, exact breakpoints |
| DC sweep | ✅ source DC value or component value, curve assertions, `circuitsvibe sweep` |
| AC small-signal | ✅ complex MNA around the operating point, gain/phase/bandwidth/unity-gain/phase-margin |
| Sources | ✅ DC, SIN, PULSE, PWL, PWM (voltage and current), AC stimulus |
| Semiconductors | ✅ Diode, LED · ❌ BJT, MOSFET, JFET |
| Op-amps, comparators | ✅ `IdealOpAmp`, `OpAmp` macro model (Aol, GBW, 2nd pole, slew, swing, current limit, Vos/Ib), open-collector `Comparator`; `Part('LM358')`, LM741, TL072, MCP6002, NE5532, LM393, LM311 from datasheet data — [docs/OPAMPS.md](docs/OPAMPS.md) |
| Digital logic, mixed-signal | ❌ |
| Microcontrollers | ❌ |
| Noise, distortion, pole-zero analysis | ❌ |
| Real-part catalog with datasheet ratings | data for every family (docs/PARTS.md); op-amp/comparator ratings checked at the op point (R420–R425) |
| SPICE netlist import/export | ❌ |
| Circuit document (JSON) + share-by-URL | ✅ `export` / `verify x.circuit.json` / `share` / `open` · web viewer support in progress |
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
└── ui/         the visual simulator
```

## License

MIT — see [LICENSE](LICENSE).
