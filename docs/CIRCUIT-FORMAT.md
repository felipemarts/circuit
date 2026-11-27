# Circuit document `circuitsvibe-circuit/1` and share links

A **circuit document** is the language-neutral, plain-JSON form of a bench: the components
and their wiring, the free parameters, the assertions with their analysis configs, and
optional metadata, embedded source files and viewer layout. It is the contract between
every producer and consumer of circuits:

- the TypeScript bench DSL writes it (`circuitsvibe export`, `toCircuitDoc`);
- `circuitsvibe verify file.circuit.json` simulates it exactly like the bench it came from;
- share links carry it, compressed, in the URL fragment (`circuitsvibe share`);
- other languages (a Python library is planned) produce the same JSON.

JSON Schema: [`schema/circuit.schema.json`](../schema/circuit.schema.json) (shipped in the npm
package and exported as `circuitsvibe/circuit.schema.json`). The schema covers the structure;
the cross-field rules below (unique ids, references, pins matching the component type) are
checked by `validateCircuitDoc` and reported as T010–T014.

## Example

`circuitsvibe export bench/led-driver.bench.ts --title "LED driver"` (locations omitted):

```json
{
  "assertions": [
    { "check": { "max": 0.015, "min": 0.005, "op": "within" }, "id": "a1", "probe": "D1.i", "stage": "op" },
    { "check": { "max": 2.6, "min": 1.8, "op": "within" }, "id": "a2", "probe": "led", "stage": "op" }
  ],
  "components": [
    { "id": "D1", "params": { "Is": 1e-20, "Vt": 0.02585, "n": 2 }, "pins": { "anode": "led", "cathode": "gnd" }, "type": "LED" },
    { "free": { "max": 10000, "min": 100, "scale": "log" }, "id": "R1", "params": { "r": 330 }, "pins": { "1": "n1", "2": "led" }, "type": "Resistor" },
    { "id": "V1", "params": { "v": 5 }, "pins": { "+": "n1", "-": "gnd" }, "type": "VoltageSource" }
  ],
  "meta": { "title": "LED driver" },
  "name": "led-driver",
  "nets": ["led"],
  "schema": "circuitsvibe-circuit/1"
}
```

Keys appear sorted because the canonical form sorts them (see below); readers must not
depend on key order.

## Fields

All quantities are SI numbers: ohm, F, H, V, A, s, Hz; AC gains in dB, phases in degrees.
No unit strings (`'4.7k'` is a DSL convenience, not part of the document).

| Field | Required | Meaning |
|-------|----------|---------|
| `schema` | yes | the constant `"circuitsvibe-circuit/1"` |
| `name` | yes | bench name; becomes `RunRecord.bench` |
| `meta` | no | `{ title?, description?, author? }` — strings, for humans and the viewer; kept in share links |
| `components` | yes | array of components (canonical order: ascending `id`) |
| `nets` | no | user-named nets, ascending — the names probes may cite |
| `assertions` | yes | array of assertions in declaration order (may be empty) |
| `overrides` | no | `{ id: number }` — `--set` values applied when the document was made |
| `ratings` | no | `{ enabled?, derate?, pd?, ignore? }` — `tb.ratings(...)` settings, only when not the defaults |
| `sources` | no | embedded text files `[{ path, language, text }]`, ascending `path` |
| `definitions` | no | custom components (`defineComponent` code) used by `components[].type`: `[{ type, pins, source, export?, registry? }]`, ascending `type` |
| `layout` | no | viewer placement hints; never affects simulation |
| `pcb` | no | the printed circuit board: `{ board, placements, footprints? }` — lengths in **mm** (see below and docs/PCB.md) |

Unknown fields are **rejected** (T010) everywhere except inside `layout`, so a reader never
silently drops meaning it does not understand.

### `components[]`

Same shape as `RunRecord.netlist.components[]`:

| Field | Meaning |
|-------|---------|
| `id` | `/^[A-Za-z][A-Za-z0-9_]*$/`, unique; the name in every diagnostic, probe and override |
| `type` | a built-in type (`circuitsvibe catalog`: `Resistor`, `Capacitor`, `Inductor`, `VoltageSource`, `CurrentSource`, `Diode`, `LED`, `NPN`, `PNP`, `NMOS`, `PMOS`, `Switch`, `Button`, `IdealOpAmp`, `OpAmp`, `Comparator`, a logic IC / NE555 catalog id such as `74HC04`, a logic primitive such as `Nand`) or the name of a custom definition supplied by the reader (T012 otherwise) |
| `type` | a built-in type (`circuitsvibe catalog`: `Resistor`, `Capacitor`, `Inductor`, `VoltageSource`, `CurrentSource`, `Diode`, `LED`, `NPN`, `PNP`, `NMOS`, `PMOS`, `Switch`, `Button`, a logic IC / NE555 catalog id such as `74HC04`, a logic primitive such as `Nand`, `Mcu`, `ArduinoUno`, `VhdlBlock`) or the name of a custom definition supplied by the reader (T012 otherwise) |
| `params` | the component configuration, exactly as in the RunRecord netlist (see below) |
| `pins` | `{ pinName: netName }` with **every** canonical pin of the type, and only those (T014) |
| `free` | optional `{ min, max, scale: "lin" \| "log" }` — a `tb.param` sweep range (verified hints) |
| `modelCard` | optional verbatim SPICE `.model` card of a `Diode` / `LED` / `NPN` / `PNP` / `NMOS` / `PMOS` built with `<Type>.fromModel(card)` (see below) |
| `at` | optional origin `file:line` of the `tb.add` call; informational, dropped from share links |

`params` per type:

| Type | Params | Pins |
|------|--------|------|
| `Resistor` | `{ r }` | `1`, `2` |
| `Capacitor` | `{ c }` | `1`, `2` |
| `Inductor` | `{ l }` | `1`, `2` |
| `VoltageSource` | `{ v, sin? \| pulse? \| pwl? \| pwm?, ac?: { mag, phase } }` | `+`, `-` |
| `CurrentSource` | `{ i, …same waveform/ac keys }` | `+`, `-` |
| `Diode` | `{ Is, n, Vt, …every SPICE parameter that differs from its default (Rs, Cjo, Vj, M, Tt, BV, IBV…), model?, part? }` | `anode`, `cathode` |
| `LED` | same as `Diode` (LED defaults `Is` = 1e-20, `n` = 2) | `anode`, `cathode` |
| `NPN` / `PNP` | `{ …Gummel-Poon parameters that differ from their defaults (bf, vaf, ikf, rb, cje, tf…), model?, part? }` | `c`, `b`, `e` |
| `NMOS` / `PMOS` | `{ …Level-1 parameters that differ from their defaults (vto, kp, lambda, rd, cgso…, bulkPin, bodyDiode), model?, part? }` | `d`, `g`, `s` (+ `b` with `bulkPin: true`) |
| `74HC04`, `NE555`, … | the IC options that differ from the defaults (`corner`, `clamp`); the type is the catalog id | datasheet pin names (`1A`, `1Y`, `VCC`, `GND`, …) |
| `Nand`, `DFF`, `Clock`, … | the primitive's options (`inputs`, `delay`, `family`, `vcc`, …) | as in the bench DSL (`a`, `b`, `y`, `clk`, `q`, …) |
| `Mcu` | `{ profile, firmware: "<entry path in sources>", pwm?: "average", randomSeed? }` | the profile's pin names (`D0`…`D13`, `A0`…`A5`, `AREF` / `PB0`… / `GPIOn` / `GPn`), `VCC`, `GND` |
| `ArduinoUno` | `{ firmware, pwm?, randomSeed? }` | `D0`…`D13`, `A0`…`A5`, `AREF`, `5V`, `GND` |
| `VhdlBlock` | `{ source: "<path>" \| ["<path>", …] \| text: "<vhdl>", entity, architecture?, generics?, family, vcc }` | one per port bit: `clk`, `q[0]`, … |
| `Switch` | `{ closed }` (boolean) | `com`, `a`, `b` |
| `Button` | `{ pressed }` (boolean) | `1`, `2` |
| `IdealOpAmp` | `{ gain }` | `inp`, `inn`, `out`, `v+`, `v-` (supply pins may sit alone on `n<digits>` nets = unused) |
| `OpAmp` | `{ aol, gbw, sr, fp2, vos, ib, ios, swingHigh, swingLow, rout, iscSource, iscSink, iq, part? }` — `part` (string) names the catalog part of a `Part()` device | `inp`, `inn`, `out`, `v+`, `v-` |
| `Comparator` | `{ avd, vos, ib, ios, tpdHL, tpdLH, overdrive, tpdFast, vol, iol, isink, gleak, iq, emitterPin?, part? }` | `inp`, `inn`, `out`, `v+`, `v-` (+ `emit` when `emitterPin: true`) |

Semiconductors: `part: "<id>"` marks a catalog part (`Part('2N3904')`); the reader rebuilds
it from its own catalog and the other params must match what that part describes (T014
otherwise). `model: "<name>"` names the `.model` card a device was built from; such a
component also carries `modelCard`, the verbatim card text. The reader re-reads the card
only to reproduce its lint diagnostics (T005–T008, e.g. an unknown parameter or an
unsupported LEVEL); the electrical values are those of `params` (which already hold the
card's values and any instance overrides such as `W`/`L`). `modelCard` must name the same
model as `params.model` and is refused on catalog parts and other types.

Waveforms: `sin: { offset, amplitude, freq, delay, damping, phase }`,
`pulse: { v1, v2, td, tr, tf, pw, per }`, `pwl: { points: [[t, v], …], repeat }`,
`pwm: { low, high, freq, duty, rise, fall }` (duty as a fraction). Exported documents
always contain every key; a producer may omit keys that have defaults, but every value it
does give must survive the rebuild unchanged — otherwise the component is refused (T014)
rather than silently changed.

### Nets

A net exists because component pins name it. Three kinds of names:

- `gnd` — the ground net;
- `n<digits>` — anonymous nets. Readers renumber them canonically (from their sorted pin
  refs), so any `n…` names a producer picks are fine; they cannot be probed;
- any other name must be listed in `nets` — a user-named net that probes may cite (same
  rules as `tb.name`). A declared net no pin uses is an error.

A pin alone on its own `n…` net is unconnected (lint reports F106 as usual).

### `assertions[]`

Exactly `AssertionSpec` from the RunRecord (`docs/DIAGNOSTICS.md`):
`{ id, stage, probe, check, ref?, tran?, dc?, ac?, at? }`.

- `stage`: `op`, `dc`, `ac` or `tran`; the matching config is required (`dc`, `ac`, `tran`)
  and the others are forbidden. `ref` only on `ac`.
- `probe` / `ref`: `'<id>.i'`, `'<id>.v'`, a semiconductor device quantity `'<id>.<q>'`
  (`'Q1.ic'`, `'Q1.vbe'`, `'M1.vgs'`, `'D1.p'`… — the quantity must be one the rebuilt device
  exposes, T010 otherwise), a logic IC / primitive / VHDL-block / MCU pin `'<id>.<pin>'`
  (`'U1.1Y'`, `'U2.q[0]'`, `'U1.D13'`, checked at elaboration), a name listed in `nets`, or
  `gnd`. Serial checks take the MCU's id as `probe` (`"U1"`).
- `check` by stage — op: `within {min,max}`, `closeTo {value,tol}`, `above {value}`,
  `below {value}`; dc: `at {x,check}`, `slopeAt {x,check}`, `monotonic {direction}`,
  `crosses {level, min?, max?}`; ac: `gainAt {f,check}`, `phaseAt {f,check}`,
  `bandwidth3dB {check}`, `unityGainFrequency {check}`, `phaseMargin {check}` (`check` is a
  scalar check); tran: `settleWithin {target,tol,by}`, `neverExceed {value}`,
  `stayAbove {value,from?}`, `stayBelow {value,from?}`, `rippleBelow {amplitude,from?}`,
  `finalCloseTo {value,tol}`, and the logic checks `logicAt {t,value}`,
  `logicEdges {edge,from?,to?,count?,min?,max?}`, `logicFrequency {value,tol,from?,to?}`,
  `logicDutyCycle {value,tol,from?,to?}`, `logicStable {from,to,value?}` (value: 0, 1, "X", "Z"),
  and the serial checks `serialContains {text,by?}`, `serialNotContains {text}`,
  `serialMatches {pattern,flags?}` (a RegExp source and flags from `imsuy`),
  `serialLines {count}` or `{min?,max?}`.
- configs — `tran: { tstop, dt, maxStep?, minStep?, method?: "trap"|"be", ic?: "zero"|"op", reltol? }`,
  `dc: { source | param, from, to, points }`, `ac: { from, to, pointsPerDecade }`.

Assertions are replayed through the bench DSL when a document is loaded, so the DSL's own
rules apply (e.g. `settleWithin.by` within `tstop`); a violation is reported like a bench
error (T001, exit 3). Ids are kept as given (`a1`, `a2`, … from the DSL).

### `overrides`

Component `params` **already contain** the overridden values; `overrides` only records
which values were set, so `verify file.circuit.json` reports the same `overrides` as
`verify bench.ts --set …` did. Re-applying them is idempotent. `--set` on a document merges
over them.

### `ratings`

The bench's `tb.ratings(...)` settings for the datasheet absolute-maximum checks of
`Part()` semiconductors (R401–R404), written only when they differ from the defaults and
with only the non-default keys: `enabled: false` (`tb.ratings(false)`), `derate` (0 < d ≤ 1),
`pd: "peak"`, `ignore: [ids]` (ascending, unique, existing component ids). Absent = defaults
(`{ enabled: true, derate: 1, pd: "average", ignore: [] }`). Replayed as `tb.ratings(...)`, so
the document's RunRecord — `stages.<stage>.ratings[]` included — is byte-identical to the
bench's.

```json
"ratings": { "derate": 0.8, "ignore": ["D1"] }
```

### `sources[]`

`{ path, language, text }` — embedded text files. `path` is a relative POSIX path (no
`.`/`..` segments, no `\`, no `:`, no leading `/`), unique; `language` a lowercase tag
(`vhdl`, `typescript`, `javascript`, `json`, `text`, …).

Two component types reference sources by path, so a document (and a share link) carries
everything needed to reproduce the run — no file system:

- **Microcontrollers** (`Mcu`, `ArduinoUno`): `params.firmware` is the firmware entry path;
  the entry and every file it imports relatively (`import { f } from './util'`, resolved with
  the `.ts`/`.js`/`index` rules) are in `sources` with `language: "typescript"` (or
  `"javascript"`, `"json"`). Example: `{ "type": "ArduinoUno", "params": { "firmware":
  "bench/mcu/blink.fw.ts" } }` + `{ "path": "bench/mcu/blink.fw.ts", "language":
  "typescript", "text": "import { pinMode, … } from 'circuitsvibe/arduino'; …" }`. Readers
  transpile and run the firmware (`circuitsvibe/arduino` is the only bare import allowed);
  firmware diagnostics point at `<path>:<line>`. Other params: `profile` (`Mcu` only:
  `atmega328p` | `attiny85` | `esp32` | `rp2040`), `pwm: "average"`, `randomSeed`.
- **VHDL blocks** (`VhdlBlock`): `params.source` is the `.vhd` path (or an array of paths
  compiled together; `language: "vhdl"`), or `params.text` holds inline VHDL; plus `entity`,
  `architecture?`, `generics?` (keys sorted), `family`, `vcc`. Pins are the port bits
  (`"clk"`, `"q[0]"`).

The TypeScript writer uses cwd-relative paths (what diagnostics print, e.g.
`bench/vhdl/counter.vhd:12:5`); files outside the working directory become `external/<name>`.
A component whose source is missing from `sources` is T014. Sources no component references
are carried verbatim. A share link keeps `sources` (only `at` lines are dropped), so firmware
and VHDL locations survive in its RunRecords.

### `layout` (viewer-only)

```json
{ "components": { "R1": { "x": 120, "y": 40, "rotation": 90, "flip": false } },
  "wires": [{ "from": "R1.2", "to": "D1.anode", "points": [[160, 40], [160, 80]] }] }
```

`x`, `y` and `points` are in the viewer's canvas coordinates; `rotation` is 0/90/180/270
degrees clockwise; a wire joins two pin refs on the **same** net. Extra viewer-owned fields
are allowed at every level of `layout`. Benches carry no layout today, so exported
documents have none; a document that has one keeps it through `benchFromDoc` → `toCircuitDoc`.

### `pcb` (board, placements, footprints)

```json
{ "board": { "width": 30, "height": 20, "layers": 2, "thickness": 1.6, "tech": "tht",
             "rules": { "trace": 0.25, "clearance": 0.2, "via": { "drill": 0.3, "diameter": 0.6 }, "edgeClearance": 0.5 },
             "holes": [{ "x": 3, "y": 3, "d": 3.2 }] },
  "placements": { "R1": { "x": 15, "y": 10, "at": "bench/pcb/x.bench.ts:24" },
                  "D1": { "x": 25, "y": 8, "rot": 90, "footprint": "LED-5MM" },
                  "V1": { "offBoard": true } },
  "footprints": { "MY-R": { "name": "MY-R", "description": "custom footprint", "tech": "tht",
                            "pads": [{ "name": "1", "x": -2, "y": 0, "shape": "rect", "w": 1.2, "h": 1.2, "drill": 0.6 }, …],
                            "courtyard": [{ "x": 0, "y": 0, "w": 5.7, "h": 1.7 }] } } }
```

The exception to the SI rule: PCB lengths are **millimetres** (the EDA convention), angles are
degrees counter-clockwise, the origin is the lower-left corner of a rectangular board, y up.
`board` is either `{ width, height, cornerRadius? }`, `{ outline: [[x, y], …] }` or
`{ preset: "uno-shield" }`; the writer fills every default (`layers` 2, `thickness` 1.6, `tech`
`"tht"`, the rules above, `holes` []), a reader accepts them omitted. Values are numbers: a
unit string (`"30mm"`) is T010. `placements` is keyed by component id; a placement without `x`/`y`
only chooses a footprint (the part is unplaced, P805). `footprint` names a library footprint
(`circuitsvibe catalog footprints`) or a key of `footprints`; `pads` maps pin names to pad
names (`"1"` or `["8", "22"]`). `at` is the `tb.place` location: informational, dropped from
share links like `components[].at`. The board never changes simulation results or the
netlist hash; it drives the `pcb` stage.

## Guarantees

- **Round trip**: for every bench, `runLadderAsync(bench)` and
  `runLadderAsync(benchFromDoc(toCircuitDoc(bench)))` produce byte-identical RunRecords — the
  document carries the `at` locations and the firmware / VHDL sources. `npm test`
  (tests/share) and `npm run benches` enforce it for every file in `bench/`, MCU and VHDL
  benches included. Through a share link (no bench locations), records are identical once
  `at` fields are removed.
- **Determinism**: the same bench gives a byte-identical document and the same share URL.
- **Inline firmware**: an MCU given `{ setup, loop }` functions (not a file) cannot be
  serialized either (T013); give it a firmware file.
- **Custom components**: a `defineComponent` part is code; the document carries it as the
  **source of the module that exports it** (see `definitions` below). A definition written
  inside the bench file, or not exported, has no such module: the CLI refuses with T013. The
  library also accepts an in-memory registry (`toCircuitDoc(bench, overrides, { definitions })`,
  `benchFromDoc(doc, { definitions })`), in which case every reader needs the same definitions.

### `definitions` (custom components)

```json
"definitions": [{ "type": "Ntc", "pins": ["1", "2"], "source": "components/ntc.part.ts",
                  "registry": { "ref": "alice/ntc@3", "hash": "sha256:2faf…" } }],
"sources": [{ "path": "components/ntc.part.ts", "language": "typescript", "text": "import { defineComponent } from 'circuitsvibe'; export default defineComponent({ … })" }]
```

- `type` is the ComponentDef `name` used by `components[].type`; `pins` its pin names in order;
  `source` the module in `sources` that exports it (`export`: the export name, default the
  default export). The module may import `'circuitsvibe'` and relative files of `sources`.
- **Reading** a document needs only the declaration: validation checks every component of a
  declared type against `pins`, without running anything.
- **Simulating** evaluates the modules (`loadDocDefinitions(doc, platform)` →
  `benchFromDoc(doc, { definitions })`); the code must export a definition with the declared
  name and pins (T014 otherwise). `benchFromDoc` without the code is **T019**. The CLI evaluates
  it only with `--allow-code`; the web viewer only inside its simulation worker (no DOM, no
  storage, no login token).
- `registry` (optional) is the provenance of a part installed with `circuitsvibe component add`:
  the published ref and the SHA-256 of its source. The CLI writes it only while the installed
  file is unmodified; the service counts it in the component ranking.

## Canonical form

Canonical JSON = keys sorted at every level (ascending UTF-16 code units, JavaScript's
default sort), arrays in order, no whitespace, numbers as ECMAScript `Number#toString`
writes them (`JSON.stringify`), `components` sorted by `id`, `nets` sorted, `sources`
sorted by `path`. `assertions` keep their order (it defines the ids and the reporting
order). `circuitsvibe export` writes the canonical form indented by two spaces.

Equality of circuits is equality of the canonical text. Two producers whose number
formatting differs (Python writes `1e-05` and `5.0` where JavaScript writes `0.00001` and `5`)
produce **equal documents** but different text, hence different share URLs; both decode
and verify identically.

## Producing a document from another language

1. Build the object above with SI numbers and the canonical pin names of each type
   (`circuitsvibe catalog` / the table above). List every pin; name anonymous nets
   `n1`, `n2`, …; list every other net name in `nets`.
2. Write assertions as plain `AssertionSpec` objects, ids `a1`, `a2`, … in order, with the
   full analysis config for `dc`/`ac`/`tran` assertions.
3. Serialize. For byte-identical output with the TypeScript writer (optional), sort keys
   and format numbers like ECMAScript; in Python:
   `json.dumps(doc, sort_keys=True, separators=(",", ":"), ensure_ascii=False)` comes close;
   the known difference is number formatting (use integers where the value is integral and avoid
   exponent forms that differ).
4. Check it: `npx circuitsvibe verify my.circuit.json --json` (exit 3 + T010–T014 with a
   JSON-pointer `evidence.path` if anything is off), or validate against
   `schema/circuit.schema.json`.
5. Share link (optional): `base64url(deflate_raw(utf8(canonical_json)))`, no padding,
   prefixed `#c=1.` — in Python `zlib.compressobj(wbits=-15)` and
   `base64.urlsafe_b64encode(...).rstrip(b"=")`. Or run `npx circuitsvibe share my.circuit.json`.

## Share links

Two forms. **Short links** (`https://circuitsvibe.com/app.html?c=<id>`) point at the circuit
cache of the CircuitsVibe service (server/README.md): `circuitsvibe share` uses them when you
are logged in — any document size, private for 24 h by default, `--public` to list it on the
wall. **Fragment links** carry the whole document and need no account or server:

```
<baseUrl>#c=1.<base64url(deflate-raw(utf8(canonical JSON)))>
```

- `baseUrl` defaults to `https://circuitsvibe.com/app.html` (`--base-url` to change; any
  existing fragment is replaced). The document lives in the **fragment**, which browsers
  never send to a server: there is no backend and nothing is stored anywhere.
- `1.` versions the payload **encoding** (independent of the document `schema` inside).
  Readers refuse other versions with T017.
- Before encoding, the document is validated, canonicalized and stripped of `at`
  locations; `meta`, `overrides`, `sources` and `layout` are kept.
- base64url is RFC 4648 §5 without padding (alphabet `A–Z a–z 0–9 - _`). Compression is
  raw DEFLATE (RFC 1951) through the platform `CompressionStream('deflate-raw')` — browsers
  and Node (tested on Node 22), no dependencies. Any valid raw DEFLATE stream decodes; byte-identical
  URLs are only guaranteed for the same compressor.
- Size: the benches in `bench/` give links of about 340–560 characters (`npm run benches` prints
  them). Above 8 KiB the link still works but `share` warns (T018: some chat apps truncate
  long links). Above 2 MiB (2,097,152 characters — Chromium's URL limit) it fails (T015).
  Decoding refuses payloads that inflate above 16 MiB (T015, deflate-bomb guard).
- Decoding accepts a full URL, a `#c=…` fragment, `c=…`, or the bare `1.…` payload;
  surrounding whitespace and `<…>` are ignored, other `&`-separated fragment parameters
  are skipped. Malformed input is T016.

## Library API (browser-safe)

```ts
import { toCircuitDoc, benchFromDoc, validateCircuitDoc, encodeShareUrl, decodeShareUrl,
         createShareLink, canonicalJson, runLadder } from 'circuitsvibe';

const doc = toCircuitDoc(myBench, { R1: 270 }, { meta: { title: 'LED driver' } });
const url = await encodeShareUrl(doc);                       // string
const { bytes, warnings } = await createShareLink(doc);      // + size report (T018 warnings)
const back = await decodeShareUrl(url);                      // validated CircuitDoc
const record = runLadder(benchFromDoc(back), { overrides: back.overrides });
const check = validateCircuitDoc(JSON.parse(text));          // { ok, doc } | { ok: false, diagnostics }
```

Errors are thrown as `CircuitDocError` (`code`, `diagnostics[]` — platform `Diagnostic`
objects with T0xx codes; `isCircuitDocError(err)` checks structurally).

## CLI

```bash
npx circuitsvibe export x.bench.ts -o x.circuit.json [--set R1=270] [--title …]
npx circuitsvibe verify x.circuit.json --json          # same RunRecord and exit code as the bench
npx circuitsvibe share x.bench.ts                      # prints the link (also accepts x.circuit.json)
npx circuitsvibe share x.bench.ts --json               # { "url", "bytes", "warnings" }
npx circuitsvibe verify x.bench.ts --json --share      # RunRecord + "share": { "url", "bytes", "warnings" }
npx circuitsvibe open "<link>" [-o x.circuit.json]     # link → document
```

`--title`, `--description`, `--author` set `meta` on `export`, `share` and `verify --share`.
An invalid document given to `verify` still yields a RunRecord (T010–T014, exit 3). Under
`verify --share` a document that cannot be shared (T013) gives
`"share": { "error": { "code", "message" } }` and leaves the verify exit code unchanged.

## Opening a link in the browser

Opening a share link at circuitsvibe.com (`app.html#c=1.…`) draws the schematic (auto-layout),
re-runs the same verification ladder in the browser (`runLadderAsync(benchFromDoc(doc), { overrides:
doc.overrides })` — identical verdict, exit code and netlist hash as the CLI) and shows the
assertions, diagnostics, ratings, scope / Bode / DC-sweep plots, the logic analyzer, the serial
console of microcontrollers and the embedded firmware / VHDL sources. `circuitsvibe open <link>`
decodes a link without a browser. A third-party viewer implements the same thing by calling
`decodeShareUrl(location.hash)` and rendering the returned document (`components`, `pins` →
nets, `nets`, `meta`, `sources`, optional `layout`).

## Versioning policy

- `schema` names the document format version: `circuitsvibe-circuit/<major>`.
- Within major 1, changes are **additive only**: new optional fields or new component
  types; existing fields never change meaning or units and are never removed. Because
  readers reject unknown fields (outside `layout`), an older reader meeting a newer field
  fails loudly (T010 "a newer circuitsvibe may be needed") instead of misreading it.
- An incompatible change bumps the major (`circuitsvibe-circuit/2`); readers refuse majors
  they do not know with T011.
- The share-link encoding is versioned separately by its prefix (`1.`); a new encoding gets
  a new prefix and readers refuse unknown prefixes with T017.
