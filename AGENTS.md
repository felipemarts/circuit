# CircuitsVibe — agent playbook

CircuitsVibe turns a TypeScript *bench* (circuit + free parameters + assertions) into a
verdict you can branch on: **lint → DC operating point → DC sweep → AC → transient**, with
structured diagnostics, stable codes, source locations and simulation-verified fixes.

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
     misused (also T003/T004: an AC bench without a usable stimulus). Read stderr /
     `diagnostics[]`; fix the bench code or the invocation.
4. **Read diagnostics, not guesses**: each has `code`, `message`, `at`, `note` and
   `fixes[]`. A fix's `confidence` tells you how much to trust it:
   `verified` (simulated, passes — apply it) · `mechanical` (deterministic) ·
   `suggested` (heuristic — reason first). `npx circuitsvibe explain <code>` gives the physics.
5. **Before retrying, check history**: `npx circuitsvibe log list --json` shows every run
   (verdict, exit code, first failure, overrides). Don't repeat a configuration that
   already failed. `npx circuitsvibe log show <runId>` returns the full past RunRecord.
6. Once `--set` values pass, **write them back into the bench** so the file is the truth.
7. **Share the result with the user**: after exit 0, run
   `npx circuitsvibe share <name>.bench.ts` (or add `--share` to the passing `verify --json` and
   read `share.url`) and give the user that link. The whole circuit is in the URL fragment
   (`…/app.html#c=1.…`) — no upload, no server. Opening links in the web app is still being
   built: until it lands, tell the user the link opens with `npx circuitsvibe open "<link>"`.
   Benches with `defineComponent` parts cannot be shared (T013).

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
  tb.expect.dc({ source: 'V1', from: 0, to: 5, points: 51 })   // DC sweep of V1
    .probe('D1.i').toBeMonotonic('increasing')
    .at('3').toBeBelow('5m');
  tb.expect.tran({ tstop: '5m', dt: '10u' })         // transient (adaptive steps)
    .probe('D1.i').toNeverExceed('25m');
});
```

- `tb.add(id, component)` — ids: letter first, then letters/digits/underscore, unique.
  Register with `tb.add` **before** connecting pins.
- `pin.connect(otherPin)` — wires two pins into the same net.
- `tb.name(net, pin)` — `gnd` and `n<digits>` are reserved names.
- `tb.param(id, { min, max, scale: 'lin' | 'log' })` — sweeps the component's main value
  (a source's DC value).

### Components (`npx circuitsvibe catalog` for the full datasheet)

| Type | Construct | Pins | Notes |
|------|-----------|------|-------|
| Resistor | `new Resistor('4.7k')` | `'1'`, `'2'` | ohms |
| Capacitor | `new Capacitor('10u')` | `'1'`, `'2'` | open at DC, jωC in AC |
| Inductor | `new Inductor('10m')` | `'1'`, `'2'` | short (0 V) at DC, jωL in AC |
| VoltageSource | `new VoltageSource(5)` or `new VoltageSource({ ... })` | `'+'`, `'-'` | DC, waveforms, AC stimulus — see Sources |
| CurrentSource | `new CurrentSource('1m')` or `({ ... })` | `'+'`, `'-'` | pushes its current out of `+` into the circuit; same options |
| Diode | `new Diode({ Is: 1e-14, n: 1 })` | `'anode'`, `'cathode'` | Shockley model; AC: junction conductance at the operating point |
| LED | `new LED()` | `'anode'`, `'cathode'` | ~2 V forward drop; always add a series resistor |
| Switch | `new Switch(false)` | `'com'`, `'a'`, `'b'` | SPDT: false → com–a, true → com–b |
| Button | `new Button(false)` | `'1'`, `'2'` | conducts while pressed |
| IdealOpAmp | `new IdealOpAmp()` | `'inp'`, `'inn'`, `'out'`, optional `'v+'`, `'v-'` | VCVS, gain 1e6; both supply pins wired = output clamped to the rails |
| OpAmp | `new OpAmp({ gbw: '1M', sr: '1M' })` or `Part('LM358')` | `'inp'`, `'inn'`, `'out'`, `'v+'`, `'v-'` | macro model; supply pins REQUIRED |
| Comparator | `new Comparator()` or `Part('LM393')` | `'inp'`, `'inn'`, `'out'`, `'v+'`, `'v-'` (+ `'emit'` on LM311) | open collector: add a pull-up resistor on `'out'` |

Custom parts: `defineComponent({ name, pins, params, stamp, ac? })` (see the README). Use
`ctx.stampCapacitance(a, b, C)` for internal capacitors (integrated like built-ins) and
give an `ac(ctx)` stamp if the part is used in an AC analysis (else S204).

### Op-amps and comparators

```ts
import { bench, VoltageSource, Resistor, Part, OpAmp, IdealOpAmp, Comparator } from 'circuitsvibe';

const u1 = tb.add('U1', Part('LM358'));            // ONE channel of the dual; one Part() per channel
u1.pin('v+').connect(vcc.pin('+'));               // supply pins are required on OpAmp/Comparator/Part()
u1.pin('v-').connect(tb.gnd);                     // single supply: v- on gnd
vin.pin('+').connect(u1.pin('inp'));              // inputs are 'inp' (+) and 'inn' (−), NOT '+'/'-'
r2.pin('1').connect(u1.pin('inn'));               // feedback goes to 'inn'
r2.pin('2').connect(u1.pin('out'));
tb.expect.op('U1.v').toBeWithin(2.4, 2.6);         // U1.v = V(out); U1.i = output current (+ = sourcing)
```

- Real parts: `Part('LM358' | 'LM741' | 'TL072' | 'MCP6002' | 'NE5532')` (op-amps) and
  `Part('LM393' | 'LM311')` (comparators). Parameters come from the datasheet data;
  `npx circuitsvibe catalog LM358` shows them, the package pin numbers, the assumptions and
  the datasheet. Package pin numbers are documentation: always connect by pin NAME.
- `new OpAmp({ aol, gbw, sr, fp2, vos, ib, ios, swingHigh, swingLow, rout, iscSource,
  iscSink, iq })`: dominant pole, slew rate, output swing relative to the rails (limited by
  the actual supply), output resistance, smooth short-circuit current limit, offset, bias
  currents, quiescent current. Works in op/dc/ac/tran; in AC a saturated output has no gain.
- `new IdealOpAmp({ gain })`: no rails (leave `v+`/`v-` open) or rail-clamped (wire both).
- Comparators: output LOW (sinking) when V(inp) < V(inn); otherwise off, the pull-up sets
  the high level (it may be above the comparator supply). Response time grows as the
  overdrive shrinks (LM393: 1.3 µs at 5 mV, 0.3 µs for a big step). Hysteresis = external
  resistors (Schmitt trigger: feedback resistor from `out` to `inp`). LM311: wire `'emit'`
  (usually to gnd).
- Datasheet checks of `Part()` amplifiers at the operating point land in
  `stages.op.ratings` (R420–R425: supply over max, differential input, output at its current
  limit, input common-mode range, input beyond the rails, supply below minimum); a violation
  fails the op stage, exit 1. docs/OPAMPS.md has the equations and the model-vs-datasheet table.

### Sources

Give a value, or an options object with at most ONE waveform. All values accept units.

```ts
new VoltageSource(5)                                                   // DC
new VoltageSource({ dc: 2.5, ac: 1 })                                  // bias + AC stimulus (1 V, 0°)
new VoltageSource({ ac: { mag: 1, phase: 90 } })                       // AC only (dc 0)
new VoltageSource({ sin: { offset: 0, amplitude: 1, freq: '1k', delay: '1m', damping: 0, phase: 0 } })
new VoltageSource({ pulse: { v1: 0, v2: 5, td: '1m', tr: '1u', tf: '1u', pw: '2m', per: '5m' } })
new VoltageSource({ pwl: { points: [[0, 0], ['1m', 5], ['3m', 5], ['4m', 0]], repeat: false } })
new VoltageSource({ pwm: { low: 0, high: 5, freq: '10k', duty: '25%', rise: '100n', fall: '100n' } })
```

- `dc` (op and DC sweep) defaults to the waveform's value at t = 0.
- PULSE: `v1` → after `td` rises in `tr` to `v2`, holds `pw`, falls in `tf`, repeats every
  `per` (omit `per` for one pulse). `tr`/`tf` 0 = ideal edge. SIN `phase` is in degrees.
- PWM `duty` is the fraction of the period above the 50 % level (0 < duty < 1).
- `ac` is the small-signal stimulus. The legacy `.acAmplitude`/`.frequency` properties are a
  *transient sine* (visual editor), not an AC stimulus.

### Probes (every stage)

- `'<id>.i'` — current through a component (e.g. `'D1.i'`)
- `'<id>.v'` — voltage across a component (e.g. `'R1.v'`)
- `'<net>'` — voltage of a net named with `tb.name`

### Assertions

Scalar matchers: `.toBeWithin(min, max)` · `.toBeCloseTo(value, absTol)` · `.toBeAbove(v)` · `.toBeBelow(v)`

- **op**: `tb.expect.op(probe).<scalar>`
- **dc**: `tb.expect.dc({ source: 'V1' | param: 'R1', from, to, points | step })` then
  `.probe(p)` and `.at(x).<scalar>` (linear interpolation between swept points) ·
  `.slopeAt(x).<scalar>` (d probe / d sweep) · `.toBeMonotonic('increasing' | 'decreasing')` ·
  `.toCross(level).between(a, b)` (first crossing, in sweep units; `.toCross(level)` alone
  asserts it crosses at all). Default 51 points.
- **ac**: `tb.expect.ac({ from: '10', to: '1M', pointsPerDecade: 20 })` then
  `.probe(p)` or `.probe(p, { ref: 'in' })` and `.gainAt(f).<scalar>` (dB) ·
  `.phaseAt(f).<scalar>` (degrees, unwrapped) · `.bandwidth3dB().<scalar>` (Hz) ·
  `.unityGainFrequency().<scalar>` (Hz) · `.phaseMargin().<scalar>` (degrees).
  **Gain definition**: H(f) = probe phasor / stimulus phasor (the single source with `ac`),
  or probe / ref when `ref` is given; gain = 20·log10|H|. `bandwidth3dB` is measured from the
  sweep's peak gain: the upper −3 dB frequency for a low-pass, f_high − f_low for a band-pass.
  `phaseMargin` = 180° + phase(H) at the unity-gain frequency (probe a loop gain).
- **tran**: `tb.expect.tran({ tstop, dt?, maxStep?, minStep?, method?, ic?, reltol? }).probe(p)` then
  `.toSettleWithin({ target, tol /* fraction */, by })` · `.toNeverExceed(v)` ·
  `.toStayAbove(v, { from })` · `.toStayBelow(v, { from })` ·
  `.toRippleBelow(amplitude, { from })` · `.toEndCloseTo(v, absTol)`; chain `.probe(...)`
  to assert on another signal of the same run.
  - `dt` is the initial step **and** the step ceiling; `maxStep` overrides the ceiling (let the
    stepper stride through quiet stretches). Without either: initial tstop/1000, ceiling tstop/50.
  - `method`: `'trap'` (default; Backward Euler right after t = 0 and every source corner) or `'be'`.
  - `ic`: `'zero'` (default — capacitors at 0 V, inductors at 0 A at t = 0: a step response) or
    `'op'` (start from the DC operating point).
  - Steps are adaptive (truncation-error control, `reltol` default 1e-4) and land exactly on
    every PULSE/PWL/PWM corner; samples are non-uniform and every measurement interpolates.

A measurement that cannot be made (no crossing inside the sweep, no −3 dB point) fails with
`note` and no `measured` value — the platform never invents a number.

### Units

Numbers or strings with an engineering suffix: `'4.7k'` `'10m'` `'2u'` `'1M'` `'100n'`
`'1e-6'`. Case matters: `m` = milli, `M` = mega. A trailing unit (`V A F H s Hz ohm Ω`) is
allowed and ignored: `'10uF'`, `'5V'`.

## Commands

```bash
npx circuitsvibe init [name] [--force]       # scaffold <name>.bench.ts (+ AGENTS.md if absent)
npx circuitsvibe verify <bench.ts> --json    # full RunRecord on stdout
    --stage op,dc,ac,tran                    # subset of stages (lint always runs)
    --set R1=280,V1=5                        # override values without editing the file
    --no-hints  --no-ledger
npx circuitsvibe sweep <bench.ts> --source V1 --from 0 --to 5 --points 51 --probe out,R1.i [--json]
    # DC transfer table (or --param R1 to sweep a component value, --step instead of --points)
npx circuitsvibe log list --json             # run history (.circuitsvibe/runs.jsonl)
npx circuitsvibe share <bench.ts> [--json]   # share link (circuit in the URL); --json: { url, bytes, warnings }
npx circuitsvibe verify <bench.ts> --json --share   # RunRecord + "share": { "url", … }
npx circuitsvibe open "<link>"                # a link the user sent you → circuit document (JSON)
npx circuitsvibe export <bench.ts> -o x.circuit.json   # language-neutral circuit document
npx circuitsvibe verify x.circuit.json --json # a document verifies exactly like its bench
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
| F120 | op-amp/comparator supply pin open (IdealOpAmp: only one of two) | wire `v+` and `v-` (single supply: `v-` to gnd) |
| F121 | op-amp/comparator input with no DC path | bias resistor from the input to gnd/reference, or close the feedback |
| F122 | op-amp feedback only to `inp` (warning) | move the feedback to `inn`; for a Schmitt trigger use a Comparator |
| F123 | IdealOpAmp output on gnd / across an ideal source | remove the short or use OpAmp (current limit) |
| F124 | comparator output with no pull-up (warning) | pull-up resistor from `out` to the logic supply |
| R420–R425 | `Part()` amplifier outside its datasheet ratings at the op point (`stages.op.ratings`, exit 1) | lower the supply, limit inputs/load, or pick another part |
| S101 | singular system lint didn't catch | report it; simplify the topology |
| S201 | Newton-Raphson did not converge at DC (after gmin and source stepping) — names the culprit | add series resistance, check values |
| S202 | Newton-Raphson did not converge at a transient step, even after cutting the step — culprit + time | soften the edge (tr/tf), add series resistance |
| S203 | transient step collapsed below the minimum step — reactive culprit + time | check time constants, shorten tstop or lower maxStep/minStep |
| S204 | a component has no AC small-signal model | add `ac(ctx)` to its `defineComponent` |
| A301 | assertion failed (`measured`, `margin`, maybe `hint` or `note`) | apply a verified hint or change values |
| T001 / T002 | the bench threw / a stage crashed | fix the bench code (T002: report it) |
| T003 / T004 | AC assertions without an `ac` stimulus / with several stimuli and no `ref` | add `ac: 1` to the input source / pass `{ ref }` |
| T010–T014 | invalid circuit document (structure, schema version, unknown type, custom part, bad component) | re-export with `circuitsvibe export`; T013: custom parts cannot be shared |
| T015–T018 | share link too large / malformed / unknown encoding / long (warning) | send the `.circuit.json` instead; re-copy the full link |

When plain Newton fails at DC, the solver retries with gmin stepping and then source
stepping; when an aid rescues the solve, `stages.op.solver.aids` says which one.

## Pitfalls

- An LED or diode straight across a source → F105. Always put a resistor in series.
- A node reached only through capacitors or current sources floats at DC → F101.
- Two voltage sources in parallel, or an inductor directly across one → F104.
- Probing `n1`, `n2`… is not allowed: those are auto-generated; name the net with `tb.name`.
- Transient starts from the **zero state** unless `ic: 'op'`: a DC source acts as a step at
  t = 0. Use `ic: 'op'` to start from the operating point (e.g. ripple around a bias).
- AC needs a source with `ac` (T003 otherwise); a DC value only sets the operating point.
- `toSettleWithin` tol is a **fraction** of the target; `toBeCloseTo`/`toEndCloseTo` tol is
  **absolute**. AC gains are in **dB**, phases in **degrees**, frequencies in **Hz**.
- `dt` is the step ceiling: a coarse `dt` on a fast circuit is fine (the stepper shrinks
  near edges), but output samples are only as dense as the steps actually taken.
- Bench files are CommonJS under the hood: no top-level `await`, no `import.meta`.
  Relative imports of other `.ts` files work.
- Outputs are deterministic (no timestamps); diff two `--json` runs to see what changed.
- Op-amp inputs are `'inp'`/`'inn'`; `'+'`/`'-'` are source pins. A macro-model op-amp
  or comparator without `v+`/`v-` wired is F120; its output can never pass the rails minus
  the part's swing (an LM358 on 5 V tops out near 3.5 V — use MCP6002 for rail-to-rail).
- An AC-coupled op-amp input needs a bias resistor (F121); an LM358 input must stay below
  V+ − 1.5 V (R423); big feedback resistors turn bias current into offset (Ib·R).
- Comparators are open collector: no pull-up, no high level (F124). Positive feedback on an
  OpAmp (F122) makes the DC solver land on the unstable equilibrium — check it in tran.
- Not implemented yet (don't use): BJTs, MOSFETs, digital logic,
  microcontrollers, noise analysis.
