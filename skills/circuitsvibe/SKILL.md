---
name: circuitsvibe
description: Design, size and verify electronic circuits ("vibe hardware") by writing TypeScript benches and running the circuitsvibe simulator CLI (lint → DC operating point → DC sweep → AC → transient) until it exits 0, then sharing a link to the verified circuit. Use when asked to design, check, debug or size a circuit (resistors, capacitors, inductors, DC/pulse/sine/PWL/PWM sources, diodes, Zeners, LEDs, BJTs, MOSFETs, op-amps and comparators, real catalog parts such as 2N3904/2N7000/1N4148/LM358/74HC04, switches, logic ICs and the NE555, Arduino-style microcontroller firmware on an Uno/ATtiny85/ESP32/RP2040, VHDL blocks), to verify a circuit against a spec (operating point, transfer curve, frequency response, transient), or when a *.bench.ts file is present.
---

# CircuitsVibe — circuits as code, verified by simulation

You write a *bench* (`<name>.bench.ts`): the circuit, its free parameters and its spec as
assertions. The CLI simulates it and returns a verdict with an exit code, structured
diagnostics (stable code + file:line + fix) and simulation-verified sizing hints.

Run with `npx circuitsvibe <command>` (Node ≥ 20, nothing to install). Offline: if you
were given `circuitsvibe-standalone.mjs`, use `node circuitsvibe-standalone.mjs <command>`
— same commands, zero dependencies.

## Workflow

1. `npx circuitsvibe init <name>` → creates `<name>.bench.ts` (passing LED example) and
   `AGENTS.md`. Edit the bench into the circuit you need.
2. `npx circuitsvibe verify <name>.bench.ts --json` and branch on the **exit code**:
   - `0` pass → done.
   - `1` spec failed, circuit valid → if the failed assertion has
     `hint.kind === "verified-param-range"`, re-run with `--set <id>=<hint.suggestedValue>`;
     otherwise adjust values/topology.
   - `2` circuit invalid/unsolvable → fix the structure at `diagnostics[].at` first
     (`npx circuitsvibe explain <code>` explains each code).
   - `3` the bench threw or the command was wrong → fix code/invocation from stderr.
3. Before each retry run `npx circuitsvibe log list --json` — never repeat a failed
   configuration.
4. When `--set` values pass, write them into the bench file.
5. Give the user a link: `npx circuitsvibe share <name>.bench.ts`, or use `verify … --json
   --share` and read `share.url`. Logged in, it is a short link to the circuit cache (private,
   24 h; `--public` for the wall); otherwise the whole circuit is in the URL. The link opens at
   circuitsvibe.com with the schematic, a browser re-run of the simulation and all results.
   Links you receive: `npx circuitsvibe open "<link>"` gives the document;
   `npx circuitsvibe verify "<link>" --json` re-runs it.

Never guess component values: declare `tb.param('R1', { min: '100', max: '10k', scale: 'log' })`
and let the simulator find the passing range. Only `verified` fixes were simulated.

## Minimal bench

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

  tb.param('R1', { min: '100', max: '10k', scale: 'log' });
  tb.expect.op('D1.i').toBeWithin('8m', '12m');
  tb.expect.tran({ tstop: '5m', dt: '10u' }).probe('D1.i').toNeverExceed('25m');
});
```

Other stages, same pattern (details: `npx circuitsvibe agents`):

```ts
tb.expect.dc({ source: 'V1', from: 0, to: 5, points: 51 }).probe('out').toBeMonotonic('increasing');
tb.expect.ac({ from: '10', to: '1M' }).probe('out').gainAt('1k').toBeWithin(-3.1, -2.9); // needs a source with ac: 1
new VoltageSource({ pulse: { v1: 0, v2: 5, tr: '1u', tf: '1u', pw: '1m', per: '2m' } });  // also sin, pwl, pwm
const u1 = tb.add('U1', Part('74HC04'));   // logic IC: wire VCC/GND, tie unused inputs; pins by name or number
tb.expect.logic('U1.1Y', { tstop: '1m' }).toHaveFrequency('10k', 0.01);   // logic assertions (tran stage)
const u2 = tb.add('U2', new ArduinoUno({ firmware: './blink.fw.ts' }));    // firmware next to the bench; wire 5V/GND
tb.expect.serial('U2', { tstop: '1' }).toContain('ready');                 // what the firmware printed
```

Firmware (`blink.fw.ts`): `import { pinMode, digitalWrite, delay, … } from 'circuitsvibe/arduino'`,
`export async function setup()` / `loop()`, and every wait is `await delay(ms)` — code between
awaits takes zero simulated time. The MCU is in reset at the operating point: assert it in
tran / logic / serial. Details: `npx circuitsvibe agents` (Microcontrollers, VHDL blocks).

## Reference on demand

- `npx circuitsvibe agents` — full playbook: API cheat sheet, units, probes, assertions,
  diagnostic codes, pitfalls.
- `npx circuitsvibe catalog --json` — every component with pins and value semantics.
- `npx circuitsvibe explain <code>` — physics and fixes for one diagnostic code.
- `npx circuitsvibe export <bench.ts>` — the language-neutral circuit document (JSON);
  `verify x.circuit.json` simulates it exactly like the bench.
- `npx circuitsvibe share <bench.ts>` — the link to give the user. Logged in
  (`npx circuitsvibe register --user <name> --kind agent` once) it is a short link, private for
  24 h (`--public`: the wall at circuitsvibe.com/wall.html); otherwise the circuit is in the URL.
- `npx circuitsvibe component search | info | add` — shared custom components (ranked by use).
  They are code: read `component info` before `add`; `verify <link>` of a circuit carrying
  custom components needs `--allow-code` (T019).

Supported today: Resistor, Capacitor, Inductor, VoltageSource and CurrentSource (DC, SIN,
PULSE, PWL, PWM, AC stimulus), Diode (Rs, capacitance, Zener breakdown), LED, NPN/PNP
(Gummel-Poon), NMOS/PMOS (Level 1), `.model` cards via `Diode/NPN/NMOS.fromModel`, Switch
(SPDT), Button, op-amps (`IdealOpAmp`, macro-model `OpAmp`), open-collector `Comparator`,
custom parts via `defineComponent`; logic ICs and NE555 via `Part(...)` (74HC00/04/14/74/595,
74HCT04, CD4017, CD4011, NE555) and generic logic primitives (Nand, DFF, Counter, Clock, …)
co-simulated with the transient; microcontrollers running Arduino-style TypeScript firmware
(`new ArduinoUno({ firmware: './blink.fw.ts' })`, `Mcu` profiles atmega328p / attiny85 /
esp32 / rp2040; firmware imports from `'circuitsvibe/arduino'` and waits with
`await delay(ms)`; `tb.expect.serial('U1')`); VHDL blocks (`new VhdlBlock({ source:
importedVhd })`, pins = port bits); DC operating point (with gmin/source stepping), DC sweep,
AC small-signal, adaptive transient; a PCB stage (`tb.board` + `tb.place`: footprints, pin → pad
maps, placement checks P801–P807 with a mechanical placement fix, ratsnest — `catalog
footprints`, docs/PCB.md). Not yet: noise analysis, PCB routing / Gerber.

Real parts: one `Part(id)` covers logic ICs (`Part('74HC04')`), op-amps / comparators
(`Part('LM358')`/LM741/TL072/MCP6002/NE5532/LM393/LM311) and catalog semiconductors.
`tb.add('Q1', Part('2N3904'))` uses the catalog model AND checks the datasheet absolute
maximum ratings after op/dc/tran (mixed-signal transients included) — violations are
R401–R404 in `stages.<stage>.ratings` (exit 1, separate from your assertions); an IC output
over its limit stays D511. Generic `new NPN({ bf: 100 })` has no ratings.
`npx circuitsvibe catalog 2N3904` shows pins, model (published or ESTIMATED), ratings and
citations. Probes: `Q1.ic`, `Q1.vce`, `M1.id`, `M1.vgs`, `D1.p`…

Op-amp pins are `'inp'`, `'inn'`, `'out'`, `'v+'`, `'v-'` (supply REQUIRED except on
IdealOpAmp); comparators are open collector — add a pull-up. `Part()` amplifiers are
checked against their datasheet ratings at the operating point (`stages.op.ratings`,
R420–R425, exit 1).
