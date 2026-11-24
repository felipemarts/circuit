---
name: circuitsvibe
description: Design, size and verify electronic circuits by writing TypeScript benches and running the circuitsvibe simulator CLI (lint → DC operating point → DC sweep → AC → transient) until it exits 0. Use when asked to design, check, debug or size an analog circuit (resistors, capacitors, inductors, DC/pulse/sine/PWL/PWM sources, diodes, LEDs, switches), to verify a circuit against a spec (operating point, transfer curve, frequency response, transient), or when a *.bench.ts file is present.
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
```

## Reference on demand

- `npx circuitsvibe agents` — full playbook: API cheat sheet, units, probes, assertions,
  diagnostic codes, pitfalls.
- `npx circuitsvibe catalog --json` — every component with pins and value semantics.
- `npx circuitsvibe explain <code>` — physics and fixes for one diagnostic code.

Supported today: Resistor, Capacitor, Inductor, VoltageSource and CurrentSource (DC, SIN,
PULSE, PWL, PWM, AC stimulus), Diode, LED, Switch (SPDT), Button, custom parts via
`defineComponent`; logic ICs and NE555 via `Part(...)` (74HC00/04/14/74/595, 74HCT04,
CD4017, CD4011, NE555) and generic logic primitives (Nand, DFF, Counter, Clock, …)
co-simulated with the transient; DC operating point (with gmin/source stepping), DC sweep,
AC small-signal, adaptive transient. Not yet: transistors, op-amps, microcontrollers in benches.
