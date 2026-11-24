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
| Diode | `new Diode({ Is: 1e-14, n: 1, Rs: 0.5, Cjo: '4p', Tt: '5n', BV: 5.1, IBV: '49m' })` | `'anode'`, `'cathode'` | SPICE level 1: Rs, junction + diffusion charge, breakdown (Zener: BV = Vz at IBV = Izt) |
| LED | `new LED()` | `'anode'`, `'cathode'` | ~2 V forward drop; always add a series resistor; accepts Diode params |
| NPN / PNP | `new NPN({ bf: 100, vaf: 100 })` | `'c'`, `'b'`, `'e'` | Gummel-Poon subset (Ebers-Moll with defaults); drive the base through a resistor |
| NMOS / PMOS | `new NMOS({ vto: 2, kp: '50m', lambda: 0.01 })` | `'d'`, `'g'`, `'s'` (+ `'b'` with `bulkPin: true`) | Level 1; gate needs a DC path; PMOS: `vto < 0` |
| Part | `Part('2N3904')`, `Part('IRLZ44N')`, `Part('1N4733A')`, `Part('74HC04')` | the device's | one factory for every REAL part: semiconductors (catalog model + datasheet ratings checked automatically) and logic ICs / NE555 (see below) |
| Switch | `new Switch(false)` | `'com'`, `'a'`, `'b'` | SPDT: false → com–a, true → com–b |
| Button | `new Button(false)` | `'1'`, `'2'` | conducts while pressed |
| ArduinoUno / Mcu | `new ArduinoUno({ firmware: './app.fw.ts' })`, `new Mcu({ profile: 'attiny85', firmware })` | `'D0'`…`'D13'`, `'A0'`…`'A5'`, `'5V'`/`'VCC'`, `'GND'` | runs TypeScript firmware in the transient — see Microcontrollers |
| VhdlBlock | `new VhdlBlock({ source: importedVhd, generics: { N: 4 } })` | port bits `'clk'`, `'q[0]'`… | a VHDL entity on the logic engine — see VHDL blocks |

### Semiconductors: generic devices vs real parts

Two kinds, never mixed up:

- **Generic / simulated** — `new Diode({...})`, `new NPN({...})`, `new PNP({...})`,
  `new NMOS({...})`, `new PMOS({...})`: free SPICE parameters, **no ratings**. Parameter
  names are case-insensitive (`bf`, `Bf`, `BF`) and accept units (`'50m'`, `'4p'`); a
  misspelled name throws. `npx circuitsvibe catalog NPN` prints every parameter with its
  default and unit. From a SPICE card: `Diode.fromModel('.model D1N4148 D(IS=2.52n RS=0.568 …)')`,
  `NPN.fromModel(…)`, `NMOS.fromModel(card, { W: '10u', L: '1u' })` (LEVEL=1 only).
- **Real catalog parts** — `Part('2N3904')` returns the configured device (NPN here) with the
  catalog's model card **and** its datasheet absolute maximum ratings. `npx circuitsvibe catalog`
  lists every part (published vs ESTIMATED model); `npx circuitsvibe catalog 2N3904` shows
  pins, model card, ignored parameters, ratings with units and citations, and datasheet
  characteristics to compare with.

Device probes: `Q1.ic` `Q1.ib` `Q1.ie` (currents INTO the pins, SPICE convention), `Q1.vbe`
`Q1.vce` `Q1.vbc` `Q1.p` (power) · `M1.id` `M1.vgs` `M1.vds` `M1.p` · `D1.i` `D1.v` `D1.p`.
`.i`/`.v` are the main channel (ic/vce, id/vds).

### Datasheet ratings (real parts)

After op, dc and tran every `Part()` is checked against its absolute maximum ratings —
R401 voltage (Vceo, Vcbo, Vebo, Vds, ±Vgs, VR) · R402 continuous current (IcMax, Id25, IF) ·
R403 pulsed current (IcPeak, IdPulsed, IFP, IFSM; tran) · R404 power (Pd). Results are in
`stages.<stage>.ratings[]`, **separate from your assertions**; a violation is exit **1**
(valid circuit, over-stressed part) with `confidence: "verified"` (simulated) and the
datasheet citation. op = the value, dc = the peak over the sweep, tran = the peak (voltages;
currents without a pulsed rating) or the window average (continuous currents with a pulsed
rating, and Pd). With `tb.param`, the verified hint also keeps ratings in range.
`tb.ratings({ derate: 0.8 })` keeps 20 % margin; `tb.ratings(false)` disables the checks.
Ratings run after mixed-signal transients too: a 74HC04 driving a `Part('2N3904')` reports
`stages.tran.logic[]` and `stages.tran.ratings[]` together; an IC output over its own limit
is D511, not R40x.

Custom parts: `defineComponent({ name, pins, params, stamp, ac? })` (see the README). Use
`ctx.stampCapacitance(a, b, C)` for internal capacitors (integrated like built-ins) and
give an `ac(ctx)` stamp if the part is used in an AC analysis (else S204).

### Logic ICs, NE555 and logic primitives (mixed-signal)

Real parts come from the catalog with their datasheet pins; generic logic primitives are for
quick digital blocks. Both co-simulate with the analog transient.

```ts
import { bench, Part, VoltageSource, Resistor, LED, Clock } from 'circuitsvibe';

export default bench('blink', (tb) => {
  const vcc = tb.add('VCC', new VoltageSource(5));
  const u1 = tb.add('U1', Part('74HC04'));           // also 74HC00 74HC14 74HC74 74HC595 74HCT04 CD4017 CD4011 NE555
  vcc.pin('-').connect(tb.gnd);
  u1.pin('VCC').connect(vcc.pin('+'));               // pin 14 — supply pins MUST be wired (F135)
  u1.pin(7).connect(tb.gnd);                         // pins by datasheet name OR number
  const clk = tb.add('CLK', new Clock({ freq: '1k' })); // primitive, bridged with 74HC levels at 5 V
  clk.pin('y').connect(u1.pin('1A'));
  const r1 = tb.add('R1', new Resistor('330'));
  const d1 = tb.add('D1', new LED());
  u1.pin('1Y').connect(r1.pin('1'));
  r1.pin('2').connect(d1.pin('anode'));
  d1.pin('cathode').connect(tb.gnd);
  for (const p of ['2A', '3A', '4A', '5A', '6A']) u1.pin(p).connect(tb.gnd); // tie unused inputs (F137)

  const run = tb.expect.tran({ tstop: '5m', maxStep: '20u' });
  run.logic('U1.1Y').toHaveFrequency('1k', 0.01, { from: '1m' }); // logic assertion
  run.probe('D1.i').toNeverExceed('15m');                         // analog, same run
});
```

- **`Part(id, { corner?: 'typ' | 'worst', clamp?: boolean })`** (options are for ICs; a
  semiconductor `Part()` takes none) — `u1.pin('1A')`, `u1.pin(1)`,
  `u1.pin('~OE')`, `u1.pin('CARRY OUT')` (case, spaces, `_` ignored). Active-low pins start
  with `~`. `npx circuitsvibe catalog 74HC14` prints the pinout with numbers, the levels, Rout
  and tpd per VCC, and the datasheet citations.
- Every logic level is referenced to the IC's **own** VCC/GND pins and scales with them:
  74HC at 5 V: VIL 1.5 V, VIH 3.5 V; at 2 V: 0.5 V / 1.5 V. A rising input is recognised at
  VIH, a falling one at VIL; 74HC14 and the CD4017 CLOCK pin use VT+/VT− (Schmitt).
- Outputs are a pull-up/pull-down resistance pair (Rout from the datasheet VOH/VOL rows)
  with a short ramp, so a logic output drives an LED, a transistor base or an RC node;
  delays are the datasheet tpd at the IC's supply (50 pF test load de-embedded).
- **NE555**: comparators at CONT (internal 5k/5k/5k divider, 2/3 VCC) and CONT/2, SR latch,
  discharge transistor (Ron from the datasheet), RESET (active low, tie to VCC), Darlington
  output. Astable f ≈ 1.44/((R1+2R2)·C), monostable T ≈ 1.1·R·C (tests hold them within 2 %).
- **Primitives**: `And Or Nand Nor Xor Xnor Not Buf TriBuf Mux DFF JKFF DLatch Counter
  ShiftRegister Clock Stimulus Const Pull` — options and pins as in the catalog (`delay`
  default 1 ns) plus `{ family: 'HC' | 'HCT' | 'CD4000', vcc: 5 }` for the bridge used where a
  pin touches an analog net. Between primitives (pure-digital nets) only the event engine
  runs; a bench with no analog part at all is simulated by the digital engine alone.

### Logic assertions

```ts
tb.expect.logic('q', { tstop: '20u' })      // window given, else the last tb.expect.tran/logic one
  .toBe(1).at('2u')                          // value at a time (toBe alone = at tstop)
tb.expect.logic('U1.1Y').toToggle({ count: 10, within: ['0', '10u'] })  // or min/max, edge: 'rising'
tb.expect.logic('U1.pin3').toHaveFrequency('500k', 0.01, { from: '1u' }) // tol = FRACTION
tb.expect.logic('out').toHaveDutyCycle(0.5, 0.02)                        // tol = ABSOLUTE duty
tb.expect.logic('U1.QA').toBeStable('4u', '8u', { value: 0 })
tb.expect.tran({ tstop: '1m' }).logic('q')   // same run as the analog probes
```

Logic probes: a `tb.name`d net (pure-digital, or analog with a logic pin on it), an IC pin
`'U1.1Y'` / `'U1.pin3'`, a primitive pin `'G1.q'`. Analog probes on IC pins work in op/tran:
`tb.expect.op('U1.1Y')` is that pin's voltage. The RunRecord carries the logic-analyzer data
in `stages.tran.logic[]` (value-change lists of every probed and named logic signal);
`circuitsvibe verify x.bench.ts --vcd out.vcd` writes it as VCD.

### Microcontrollers (Arduino-style TypeScript firmware)

The firmware is a TypeScript file next to the bench; it runs **in lockstep with the
transient** (firmware time = simulation time) and drives / reads real analog nodes.

```ts
// blink.fw.ts
import { pinMode, digitalWrite, delay, Serial, OUTPUT, HIGH, LOW, LED_BUILTIN } from 'circuitsvibe/arduino';

export async function setup() {
  Serial.begin(9600);
  pinMode(LED_BUILTIN, OUTPUT);
  Serial.println('ready');
}

export async function loop() {
  digitalWrite(LED_BUILTIN, HIGH);
  await delay(500);
  digitalWrite(LED_BUILTIN, LOW);
  await delay(500);
}
```

```ts
// uno-blink.bench.ts
import { bench, ArduinoUno, VoltageSource, Resistor, LED } from 'circuitsvibe';

export default bench('uno-blink', (tb) => {
  const v5 = tb.add('V5', new VoltageSource(5));
  const u1 = tb.add('U1', new ArduinoUno({ firmware: './blink.fw.ts' })); // path relative to the bench file
  const r1 = tb.add('R1', new Resistor('330'));
  const d1 = tb.add('D1', new LED());
  v5.pin('-').connect(tb.gnd);
  u1.pin('5V').connect(v5.pin('+'));                 // supply pins MUST be wired (F139)
  u1.pin('GND').connect(tb.gnd);
  u1.pin('D13').connect(r1.pin('1'));                // pins: 'D0'…'D13', 'A0'…'A5', 'AREF', or 13
  r1.pin('2').connect(d1.pin('anode'));
  d1.pin('cathode').connect(tb.gnd);

  const run = tb.expect.tran({ tstop: '2.2', maxStep: '10m' });
  run.logic('U1.D13').toHaveFrequency(1, 1e-6, { from: '0.1' }); // pin logic (driven level)
  run.probe('D1.i').toNeverExceed('10m');                          // analog, same run
  run.serial('U1').toContain('ready', { by: '1m' });               // Serial output
});
```

- **Parts**: `new ArduinoUno({ firmware })` (= `Part('ArduinoUno', { firmware })`, pins `D0–D13`,
  `A0–A5`, `AREF`, `5V`, `GND`) or `new Mcu({ profile, firmware })` with profile
  `'atmega328p'` (default), `'attiny85'` (`PB0–PB5`), `'esp32'` (`GPIOn`, 3.3 V), `'rp2040'`
  (`GPn`, 3.3 V) — pins `VCC` and `GND` plus the profile's names. `npx circuitsvibe catalog
  ArduinoUno` (or `ATtiny85`, `ESP32`, `RP2040`) lists pins, ADC, PWM pins and frequencies,
  current limits and citations. The Uno board model is the MCU pins only: no 5 V / 3.3 V
  regulator (VIN, 3V3), no USB bridge, no on-board LED — power `5V` and wire your own LED.
- **Firmware rules** (the lint and the runtime enforce each one):
  - `export async function setup()` and `export async function loop()`; import only from
    `'circuitsvibe/arduino'` and relative files.
  - **Every wait is `await delay(ms)` / `await delayMicroseconds(us)`.** Code between two awaits
    takes zero simulated time. A `delay()` without `await` is F140 / M605; a polling loop that
    never awaits is F142 / M602; `Date`, `setTimeout`, `Math.random` are F147 (use `millis()`,
    `random()`). A helper that waits must be `async` and awaited.
  - Interrupts: `attachInterrupt(digitalPinToInterrupt(2), onPress, FALLING)` (Uno: D2, D3);
    the handler is a plain (sync) function; `delay()` inside it is M607.
  - API: `pinMode` (INPUT, OUTPUT, INPUT_PULLUP), `digitalWrite/Read`, `analogRead` (10-bit on
    AVR: `floor(Vin·1024/Vref)`, Vref = the simulated VCC, or `analogReference(INTERNAL)` 1.1 V /
    `EXTERNAL` = AREF), `analogWrite` (Uno D3 D9 D10 D11 at 490.196 Hz, D5 D6 at 976.5625 Hz),
    `tone/noTone`, `millis/micros`, `Serial.begin/print/println`, `Timer1`, `random`, `map`,
    `constrain`. Not available: `pulseIn`, `shiftOut`, Wire/I2C, SPI, EEPROM, Wi-Fi (F146).
- **Pin model**: OUTPUT = push-pull stage from the MCU's own VCC/GND pins with Rout from the
  datasheet VOH/VOL rows (Uno at 5 V: 40 Ω high, 45 Ω low — guaranteed worst case), 10 ns
  edges; INPUT_PULLUP = the internal resistor (Uno 35 kΩ nominal); inputs switch at VIH rising /
  VIL falling (0.6/0.3·VCC on AVR); ESD clamp diodes to the rails. PWM is real edges by default
  (`{ pwm: 'average' }`: the duty-cycle average, no edges — faster for RC filters).
- **Co-simulation**: every firmware wake time (delay end, PWM edge, Timer1 tick) is a
  transient breakpoint; an `attachInterrupt` pin cuts the step at its threshold crossing (edge
  time within 1 ns); the firmware reads the accepted solution at its own time.
- **Power**: at the operating point the MCU is in reset (all pins high-Z) — assert MCU
  behaviour in `tran`/`logic`/`serial`, not `op`. It must be powered at t = 0 (else M622, it
  never starts); a supply that later falls below the reset threshold (Uno brown-out 2.7 V)
  latches it in reset (M622, restart not modelled); outside 4.5–5.5 V (Uno at 16 MHz) M623
  (warning; error above the 6 V absolute maximum).
- **Ratings** (in `stages.tran.ratings[]`, exit 1 like R40x): R410 a pin over its absolute
  maximum (Uno 40 mA — an LED without resistor draws ≈ 70 mA), R412 a port group (Uno: D5–D13
  source/sink 100 mA together), R413 VCC/GND or total current; R411 (warning) a pin over the
  20 mA VOH/VOL test current. `tb.ratings({ derate, ignore: ['U1'] })` applies.
- **Logic probes on MCU pins** (`'U1.D13'`): the driven level while the pin is an OUTPUT, the
  input-buffer level otherwise; voltage probes `'U1.D9'` are the pin voltage.
- **Serial assertions**: `tb.expect.serial('U1', { tstop })` or `run.serial('U1')`, then
  `.toContain(text, { by? })`, `.toNotContain(text)`, `.toMatch(/re/flags)`, `.toHaveLines(n |
  { min, max })`. The output is the concatenated text (`println` ends lines with `\r\n`);
  `stages.tran.serial[]` holds `{ config, mcu, lines: [[t, text], …], partial? }` per MCU.
- **Diagnostics**: M601 (exception) … M623 carry the **firmware** `file:line` in `at`
  (e.g. `bench/mcu/blink.fw.ts:12`) and the simulation `time`; F14x and M608 (load/compile
  errors) come from the lint stage, before anything is simulated.
- **Share links**: the firmware file and its relative imports travel in the circuit document
  (`sources[]`), so `share`, `open` and `verify x.circuit.json` reproduce the run. Inline
  `{ setup, loop }` functions (library tests) cannot be exported (T013).
- **Library use**: MCU firmware is `async`, so call `await runLadderAsync(bench)` (the CLI
  does); `runLadder` throws `AsyncAnalysisError` for benches with an MCU.
- **Not modelled**: instruction timing (zero time between awaits), ISRs preempting a running
  slice, UART timing, ADC conversion time, sleep modes / watchdog, the core's supply current,
  delayed power-up and restart after brown-out.

### VHDL blocks

```ts
import { bench, VhdlBlock, VoltageSource, Resistor, LED } from 'circuitsvibe';
import counter from './counter.vhd';                 // the CLI loads the text (also .vhdl)

export default bench('vhdl-counter', (tb) => {
  const clk = tb.add('CLK', new VoltageSource({ pulse: { v1: 0, v2: 5, td: '0.5m', tr: '100n', tf: '100n', pw: '0.5m', per: '1m' } }));
  const u2 = tb.add('U2', new VhdlBlock({ source: counter, entity: 'counter', generics: { N: 4 }, family: 'HC', vcc: 5 }));
  clk.pin('-').connect(tb.gnd);
  clk.pin('+').connect(u2.pin('clk'));               // pins = port bits: 'clk', 'rst', 'q[0]'…'q[3]'
  u2.pin('rst').connect(tb.gnd);                     // an input left open keeps its VHDL default (en := '1')
  const r0 = tb.add('R0', new Resistor('470'));
  const d0 = tb.add('D0', new LED());
  u2.pin('q[0]').connect(r0.pin('1'));
  r0.pin('2').connect(d0.pin('anode'));
  d0.pin('cathode').connect(tb.gnd);
  tb.expect.logic('U2.q[0]', { tstop: '20m', maxStep: '50u' }).toHaveFrequency(500, 1e-6, { from: '1m' });
});
```

- A VHDL block behaves like a logic primitive: on pure-digital nets (to `Clock`, `Not`, `DFF`,
  other VHDL blocks…) it runs on the event engine alone; a pin on an analog net is bridged with
  the levels of `family` (`'HC'` default, `'HCT'`, `'CD4000'`) at an ideal `vcc` (default 5 V)
  vs ground — no supply pins. Outputs are 3-state (`'Z'` releases the pin); `inout` ports only
  on pure-digital nets. VHDL processes have zero delay unless you write `after`.
- Pins: `std_logic` ports by name; vectors `'q[i]'` per VHDL index (`'q(0)'` works too);
  integer/enum ports `'n[k]'` per encoding bit, LSB 0.
- Diagnostics V701–V749 (syntax, types, unsupported constructs) come out of the **lint stage**
  with the `.vhd` `file:line:col` (inline text: `<bench line> (vhdl line:col)`); V750–V755 at run
  time with the time and the VHDL line. The `.vhd` text travels in the circuit document.

VHDL cheat sheet (synthesizable subset; anything else is a clear V703/V708):

| | Supported |
|---|---|
| Header | `library ieee; use ieee.std_logic_1164.all; use ieee.numeric_std.all;` (required when used, V707) |
| Units | several entities/architectures per file; `generic (N : positive := 4)`; ports `in`/`out`/`inout`/`buffer` |
| Types | `std_logic`, `std_logic_vector`/`unsigned`/`signed (N-1 downto 0)`, `integer range a to b`, `natural`, `positive`, `boolean`, `type state is (A, B)`, `subtype` |
| Concurrent | `y <= a and b;` · `y <= a when s = '1' else b;` · `with s select y <= …;` · `process (clk)` / `process (all)` / leading `wait until rising_edge(clk);` · `for … generate`, `if … generate` · entity/component instances |
| Sequential | `if/elsif/else`, `case … when … | others`, `for i in 0 to N-1 loop`, `exit`/`next`, variables `:=`, signals `<=` (last assignment wins), `after 5 ns` (inertial), `assert … report … severity` |
| Expressions | logic ops, reductions `and v`, comparisons, `+ - * / mod rem` (integer and numeric_std), `&`, shifts `sll srl rol ror`, `shift_left/right`, `resize`, `to_unsigned`, `to_signed`, `to_integer`, `rising_edge`, `falling_edge`, `'event`, `'length`/`'range`/`'high`/`'low`, aggregates `(others => '0')`, `x"FF"`, `b"1010"` |
| **Not supported** | `wait for`, `wait on`, `while` loops, functions/procedures, packages (`use work.pkg`), records, arrays/memories, `real`, `bit`/`bit_vector`, `textio`, `std_logic_arith`/`std_logic_unsigned` |

Integers do not wrap (leaving a range is V751, the assignment is skipped) — use `unsigned` for
counters that roll over.

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
- `'<id>.<q>'` — a semiconductor device quantity (`'Q1.ic'`, `'Q1.vce'`, `'M1.vgs'`, `'D1.p'`;
  see Device probes above)
- `'<id>.<pin>'` — voltage of a logic IC / primitive / VHDL-block / MCU pin (`'U1.1Y'`, `'U1.pin6'`,
  `'U2.q[0]'`, `'U1.D9'`); the same refs are logic probes in `tb.expect.logic(...)`
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
    --vcd out.vcd                            # logic-analyzer capture of the transient (VCD)
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
npx circuitsvibe catalog [type|part] [--json] # components, logic ICs (pins, levels per VCC), real parts (catalog 2N3904: pins, model, ratings), MCUs (catalog ArduinoUno), VhdlBlock, grammar
npx circuitsvibe agents                      # print this playbook
```

## Diagnostic codes

| Code | Meaning | Usual fix |
|------|---------|-----------|
| A301 | assertion failed (`measured`, `margin`, maybe `hint` or `note`) | apply a verified hint or change values |
| D501–D507 | digital runtime: contention, setup/hold (D502/D503 with `time`), delta limit, X controls | fix timing / drivers |
| D508 | input between VIL and VIH (op, or longer than the max input transition time) | valid level, faster edge, Schmitt input (74HC14) |
| D509 | supply outside the recommended range (error above the absolute max) | power within range |
| D510 | IC unpowered / browned out | stiff supply on VCC |
| D511 | output current above the absolute maximum (overload, contention) | series resistor, buffer |
| D512 (warning) | X logic value driving an analog net | fix the upstream X |
| D513 | input clamp diode overcurrent (input beyond the rails) | series resistor |
| D514 (warning) | no DC logic state (oscillator) | assert in tran, not op |
| F101 | net has no DC path to ground | add a bleed resistor to ground or rewire |
| F103 | component not connected to the grounded circuit | wire it in or remove it |
| F104 | ideal voltage source shorted / in a source loop (inductors count at DC) | remove the loop, add series resistance |
| F105 | diode/LED clamped directly across a source | add a series resistor |
| F106 | dangling pin (warning) | connect it or remove the part |
| F107 | BJT base with no DC bias (warning) | add a base divider / base resistor |
| F108 | MOSFET gate with no DC path (only a capacitor, or open) | gate-source pull-down or a resistor from the driver |
| F109 | BJT junction clamped by an ideal source (no base resistor) | add a base resistor |
| F110 | P-type at the lowest / N-type at the highest rail (warning) | move it to the other rail or use the complementary device |
| F130–F134 | digital lint: floating input, multiple drivers, shorted outputs, zero-delay loop, undriven clock | wire / drive the pin, use a TriBuf or a gate |
| F135 | IC VCC/GND pin unconnected | wire the supply pins |
| F136 | two logic outputs on one analog net | one driver per net, or tri-states |
| F137 | logic input floating at the analog level (warning: unused gate) | drive it or tie it to a rail |
| F138 | logic output tied to ground / a source / a rail | disconnect it (tie unused INPUTS) |
| F139 | MCU VCC (Uno `5V`) / GND pin unconnected | wire the supply pins |
| F140–F149 | firmware lint: delay not awaited, missing setup/loop, busy-wait, pin without PWM/ADC, pin number passed to attachInterrupt, unsupported API, host API (Date/setTimeout), Serial without begin, write without pinMode | fix the firmware at `at` (firmware file:line) |
| M601–M621 | firmware runtime: exception (M601, with firmware file:line + time), busy loop, zero-time loop, delay not awaited, foreign await, load error (M608), unknown pin, … | fix the firmware at `at` |
| M622 | MCU held in reset: unpowered at t = 0 or browned out (supply below the reset threshold) | stiff supply on VCC |
| M623 | MCU supply outside the recommended range (error above the absolute maximum) | power within range |
| R410 / R412 / R413 | MCU pin / port group / VCC-GND or total current over the datasheet limit (exit 1) | series resistor, spread loads, transistor driver |
| R411 (warning) | MCU pin over the VOH/VOL test current (Uno 20 mA) | larger series resistor |
| V701–V755 | VHDL compile (lint, `.vhd` file:line:col) and runtime errors | fix the VHDL at `at` |
| R401–R404 | a `Part()` exceeds a datasheet voltage / current / pulsed-current / power rating (exit 1) | apply the verified fix, reduce the stress or pick a stronger part |
| S101 | singular system lint didn't catch | report it; simplify the topology |
| S201 | Newton-Raphson did not converge at DC (after gmin and source stepping) — names the culprit | add series resistance, check values |
| S202 | Newton-Raphson did not converge at a transient step, even after cutting the step — culprit + time | soften the edge (tr/tf), add series resistance |
| S203 | transient step collapsed below the minimum step — reactive culprit + time | check time constants, shorten tstop or lower maxStep/minStep |
| S204 | a component has no AC small-signal model | add `ac(ctx)` to its `defineComponent` |
| T001 / T002 | the bench threw / a stage crashed | fix the bench code (T002: report it) |
| T003 / T004 | AC assertions without an `ac` stimulus / with several stimuli and no `ref` | add `ac: 1` to the input source / pass `{ ref }` |
| T005 / T008 | `.model` param unknown / known but not modeled (warnings) | fix the spelling; expect differences |
| T006 / T007 | `.model` unsupported type or LEVEL / malformed (exit 3) | use a supported card or a `Part()` |
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
- Logic ICs need their **supply pins wired** (F135) and **unused inputs tied** to a rail (F137);
  an LED on a logic output still needs its resistor (D511: 74HC is 25 mA absolute max).
- A slow RC edge into a plain 74HC input is D508 (forbidden zone): use a 74HC14.
- 74HCT is specified for 4.5–5.5 V only (D509 at 3.3 V); 74HC runs 2–6 V; CD4000B 3–18 V.
- Oscillators (RC + Schmitt, NE555 astable) have no DC state: the op stage reports D514
  (warning). Assert on them with `tb.expect.logic(...)` / `tb.expect.tran(...)`.
- `toHaveFrequency` tol is a **fraction**; `toHaveDutyCycle` tol is **absolute**. Measure
  frequencies with `{ from }` past the start-up (the first 555 period is longer).
- The NE555 period also depends on the discharge transistor: with a small R1 the
  discharge node sits at VCC·Ron/(R1+Ron) (≈ 90 mV at 1 kΩ, 5 V) and the period grows a few %.
- Always drive a BJT base through a resistor (F109) and give every MOSFET gate a DC path
  (F108). PNP/PMOS go on the high side (emitter/source to the positive rail), NPN/NMOS on
  the low side.
- `Q1.ie` is the current INTO the emitter: negative for an NPN that is on.
- Generic `new NPN({...})` has no ratings — only `Part('…')` devices are checked against a
  datasheet. A catalog model marked ESTIMATED (`circuitsvibe catalog <id>`) is a fit: its
  numbers can be off (e.g. 2N7000 Rds(on) at 4.5 V: 3.0 Ω vs 1.8 Ω typical).
- Pd of TO-220 parts (IRLZ44N 110 W) is rated with the case at 25 °C (ideal heatsink); free
  air is far lower — derate with `tb.ratings({ derate })` when there is no heatsink.
- Not modeled: temperature, junction self-heating, BJT base-resistance modulation and
  excess phase, MOSFET Meyer intrinsic capacitances (Level-1 lumped gate capacitances only),
  MOSFET levels above 1, JFETs, Darlingtons as catalog parts.
- MCU firmware: every wait is `await delay(...)`; the MCU is in reset at the operating point
  (assert in tran / logic / serial); power it at t = 0; LEDs on MCU pins need a resistor
  (R410: an LED alone draws ≈ 70 mA from an Uno pin, 40 mA absolute max).
- VHDL integers do not wrap (V751): count with `unsigned` vectors.
- Not implemented yet (don't use): op-amps, noise analysis.
