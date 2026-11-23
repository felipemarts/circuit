# CircuitsVibe — agent playbook

CircuitsVibe turns a TypeScript *bench* (circuit + free parameters + assertions) into a
verdict you can branch on: **lint → DC operating point → transient**, with structured
diagnostics, stable codes, source locations and simulation-verified fixes.

Run it with `npx circuitsvibe <command>` (also installed as `cvibe`), or offline with the
single-file build: `node circuitsvibe-standalone.mjs <command>`. Node ≥ 20. No other install.

## The loop (follow exactly)

1. **Write a bench** `<name>.bench.ts` (start from `npx circuitsvibe init <name>`).
2. **Verify**: `npx circuitsvibe verify <name>.bench.ts --json`
3. **Branch on the exit code** — never parse prose to decide:
   - `0` → done. All requested stages passed.
   - `1` → circuit is valid but a spec assertion failed. Look for `hint` on the failed
     assertion (`stages.op.assertions[].hint`). If `hint.kind === "verified-param-range"`,
     apply it **without editing code**: `--set R1=<hint.suggestedValue>` and re-verify.
     If there is no hint, change values or topology.
   - `2` → circuit is invalid or unsolvable. Read `diagnostics[]` (F1xx lint, S1xx/S2xx
     solver). Fix the **structure** at `diagnostics[].at` (file:line) before touching values.
   - `3` → tooling error: the bench file threw, failed to compile, or the command was
     misused. Read stderr; fix the bench code or the invocation.
4. **Read diagnostics, not guesses**: each has `code`, `message`, `at`, `note` and
   `fixes[]`. A fix's `confidence` tells you how much to trust it:
   `verified` (simulated, passes — apply it) · `mechanical` (deterministic) ·
   `suggested` (heuristic — reason first). `npx circuitsvibe explain <code>` gives the physics.
5. **Before retrying, check history**: `npx circuitsvibe log list --json` shows every run
   (verdict, exit code, first failure, overrides). Don't repeat a configuration that
   already failed. `npx circuitsvibe log show <runId>` returns the full past RunRecord.
6. Once `--set` values pass, **write them back into the bench** so the file is the truth.

Never invent numbers for sizing: declare the free parameter with `tb.param(...)` and let
the platform sweep it. A hint marked `verified` was simulated; anything else was not.

## Bench API cheat sheet

```ts
import { bench, VoltageSource, Resistor, Capacitor, LED } from 'circuitsvibe';

export default bench('rc-led', (tb) => {
  const v1 = tb.add('V1', new VoltageSource(5));     // id → stable name in every diagnostic
  const r1 = tb.add('R1', new Resistor('330'));      // always use the RETURNED instance
  const d1 = tb.add('D1', new LED());
  v1.pin('+').connect(r1.pin('1'));
  r1.pin('2').connect(d1.pin('anode'));
  d1.pin('cathode').connect(tb.gnd);                 // tb.gnd is the ground net
  v1.pin('-').connect(tb.gnd);

  tb.name('led', d1.pin('anode'));                   // name a net → probe 'led'
  tb.param('R1', { min: '100', max: '10k', scale: 'log' });  // free parameter for hints

  tb.expect.op('D1.i').toBeWithin('8m', '12m');      // DC operating point
  tb.expect.op('led').toBeWithin(1.8, 2.6);
  tb.expect.tran({ tstop: '5m', dt: '10u' })         // transient (fixed step)
    .probe('D1.i').toNeverExceed('25m');
});
```

- `tb.add(id, component)` — ids: letter first, then letters/digits/underscore, unique.
  Register with `tb.add` **before** connecting pins.
- `pin.connect(otherPin)` — wires two pins into the same net.
- `tb.name(net, pin)` — `gnd` and `n<digits>` are reserved names.
- `tb.param(id, { min, max, scale: 'lin' | 'log' })` — sweeps the component's main value.

### Components (`npx circuitsvibe catalog` for the full datasheet)

| Type | Construct | Pins | Notes |
|------|-----------|------|-------|
| Resistor | `new Resistor('4.7k')` | `'1'`, `'2'` | ohms |
| Capacitor | `new Capacitor('10u')` | `'1'`, `'2'` | open at DC |
| Inductor | `new Inductor('10m')` | `'1'`, `'2'` | short (0 V) at DC |
| VoltageSource | `new VoltageSource(5)` | `'+'`, `'-'` | DC; `.acAmplitude` / `.frequency` add a sine in transient |
| CurrentSource | `new CurrentSource('1m')` | `'+'`, `'-'` | current flows into `+` externally |
| Diode | `new Diode({ Is: 1e-14, n: 1 })` | `'anode'`, `'cathode'` | Shockley model |
| LED | `new LED()` | `'anode'`, `'cathode'` | ~2 V forward drop; always add a series resistor |
| Switch | `new Switch(false)` | `'com'`, `'a'`, `'b'` | SPDT: false → com–a, true → com–b |
| Button | `new Button(false)` | `'1'`, `'2'` | conducts while pressed |

Custom parts: `defineComponent({ name, pins, params, stamp })` (see the README).

### Probes

- `'<id>.i'` — current through a component (e.g. `'D1.i'`)
- `'<id>.v'` — voltage across a component (e.g. `'R1.v'`)
- `'<net>'` — voltage of a net named with `tb.name` (op stage only)

### Assertions

- **op**: `.toBeWithin(min, max)` · `.toBeCloseTo(value, absTol)` · `.toBeAbove(v)` · `.toBeBelow(v)`
- **tran**: `tb.expect.tran({ tstop, dt }).probe(p)` then
  `.toSettleWithin({ target, tol /* fraction */, by })` · `.toNeverExceed(v)` ·
  `.toStayAbove(v, { from })` · `.toStayBelow(v, { from })` ·
  `.toRippleBelow(amplitude, { from })` · `.toEndCloseTo(v, absTol)`; chain `.probe(...)`
  to assert on another signal of the same run.

### Units

Numbers or strings with an engineering suffix: `'4.7k'` `'10m'` `'2u'` `'1M'` `'100n'`
`'1e-6'`. Case matters: `m` = milli, `M` = mega. A trailing unit (`V A F H s Hz ohm Ω`) is
allowed and ignored: `'10uF'`, `'5V'`.

## Commands

```bash
npx circuitsvibe init [name] [--force]       # scaffold <name>.bench.ts (+ AGENTS.md if absent)
npx circuitsvibe verify <bench.ts> --json    # full RunRecord on stdout
    --stage op,tran                          # subset of stages (lint always runs)
    --set R1=280,V1=5                        # override values without editing the file
    --no-hints  --no-ledger
npx circuitsvibe log list --json             # run history (.circuitsvibe/runs.jsonl)
npx circuitsvibe log show <runId>
npx circuitsvibe explain F101                # physics + fixes for a code
npx circuitsvibe catalog [type] [--json]     # components, pins, probe/assertion grammar
npx circuitsvibe agents                      # print this playbook
```

## Diagnostic codes

| Code | Meaning | Usual fix |
|------|---------|-----------|
| F101 | net has no DC path to ground | add a bleed resistor to ground or rewire |
| F103 | component not connected to the grounded circuit | wire it in or remove it |
| F104 | ideal voltage source shorted / in a source loop (inductors count at DC) | remove the loop, add series resistance |
| F105 | diode/LED clamped directly across a source | add a series resistor |
| F106 | dangling pin (warning) | connect it or remove the part |
| S101 | singular system lint didn't catch | report it; simplify the topology |
| S201 / S202 | Newton-Raphson did not converge (DC / transient step) — names the culprit | add series resistance, check values |
| A301 | assertion failed (`measured`, `margin`, maybe `hint`) | apply a verified hint or change values |
| T001 / T002 | the bench threw / a stage crashed | fix the bench code (T002: report it) |

## Pitfalls

- An LED or diode straight across a source → F105. Always put a resistor in series.
- A node reached only through capacitors or current sources floats at DC → F101.
- Two voltage sources in parallel, or an inductor directly across one → F104.
- Probing `n1`, `n2`… is not allowed: those are auto-generated; name the net with `tb.name`.
- Named-net probes work in `op` only; in `tran` probe a component (`'C1.v'`, `'R1.i'`).
- `toSettleWithin` tol is a **fraction** of the target; `toBeCloseTo`/`toEndCloseTo` tol is
  **absolute**.
- Bench files are CommonJS under the hood: no top-level `await`, no `import.meta`.
  Relative imports of other `.ts` files work.
- Outputs are deterministic (no timestamps); diff two `--json` runs to see what changed.
- Not implemented yet (don't use): BJTs, MOSFETs, op-amps, digital logic,
  microcontrollers, AC analysis, DC sweep, PULSE/PWL sources.
