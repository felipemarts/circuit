# `src/mcu` — microcontroller firmware runtime

Runs Arduino-style firmware written in TypeScript against an abstract pin bus, in
**simulation time owned by the caller**. Pure TS, zero dependencies, browser-safe
(only `node/load-firmware.ts` uses Node). Deterministic: no wall clock, no real timers,
seeded `random()`.

```
firmware (.fw.ts) ──import──▶ circuitsvibe/arduino (arduino.ts, ambient API)
                                     │ dispatches to the running
                                     ▼
                              McuRuntime (runtime.ts) ◀── nextWakeTime() / runUntil(t)
                                     │                     (the transient engine)
                                     ▼
                              McuPinBus (types.ts) ── implemented by the integrator
                                                      (MockPinBus for tests)
```

| File | What |
|------|------|
| `types.ts` | `McuPinBus`, `Firmware`, profile types, `McuDiagnostic`, trace/serial types |
| `runtime.ts` | `McuRuntime`: scheduler, Arduino semantics, diagnostics M601–M621 |
| `arduino.ts` | the firmware API (`circuitsvibe/arduino`) |
| `module.ts` | the same API as a CommonJS-shaped object for module loaders |
| `profiles.ts` | ATmega328P/Uno, ATtiny85, ESP32, RP2040 — plain data with datasheet citations |
| `mock-bus.ts` | `MockPinBus`: records every bus call, scripts inputs |
| `measure.ts` | pure helpers over serial logs and pin traces |
| `lint.ts` | static firmware lint F140–F149 |
| `instrument.ts` | tokenizer + loop-guard instrumentation (busy-loop detection) |
| `random.ts` | avr-libc `random()` (Park–Miller), Arduino `random`/`randomSeed` |
| `node/load-firmware.ts` | Node-only loader: sucrase + vm, line-accurate locations |

## Firmware model

```ts
// blink.fw.ts
import { pinMode, digitalWrite, delay, OUTPUT, HIGH, LOW, LED_BUILTIN } from 'circuitsvibe/arduino';

export async function setup() {
  pinMode(LED_BUILTIN, OUTPUT);
}

export async function loop() {
  digitalWrite(LED_BUILTIN, HIGH);
  await delay(500);
  digitalWrite(LED_BUILTIN, LOW);
  await delay(500);
}
```

**Yield mechanism: `async` + `await delay()`.** `delay()`/`delayMicroseconds()` return a
thenable that the runtime resolves only when `runUntil()` reaches the wake time. Between
two awaits firmware runs in **zero simulated time**. After resuming the firmware the
runtime drains microtasks (JS microtask order is deterministic) until the firmware is
suspended on a simulator timer again. Because the handle is a thenable, the runtime knows
when the firmware *actually* awaited it — that is what makes "delay without await" (M605)
detectable. Async/await was chosen over generators because it is the form LLMs (and
people) already write correctly: nested helpers are plain `async function`s, and the
mistakes (missing `await`, sync polling) are caught statically (F140, F142) and at run
time (M605, M602).

Rules the runtime enforces (each with a diagnostic, none can hang the simulator):

| Situation | Behaviour |
|-----------|-----------|
| `loop()` returns without awaiting | the pass is charged `idleLoopUs` (10 µs) of sim time; M604 once |
| synchronous loop that never yields | API calls + guarded loop iterations counted against `maxOpsPerYield` (1e6) → M602 at the loop line, MCU halts |
| `while (…) await delay(0)` | more than `maxEventsPerInstant` (1e5) events at one instant → M603, halt |
| `delay()` not awaited | M605 at the un-awaited call, halt |
| `await` on a foreign promise | no firmware activity for `maxStallTicks` microtask hops → M606, halt |
| exception | M601 with firmware `file:line` and sim `time`, halt |

A halted MCU stops its software (main thread, ISRs, Timer1); hardware PWM keeps running.
Loops with no API call at all are only caught when the firmware was instrumented
(`instrumentLoops`, done by the Node loader); firmware passed as plain functions relies on
API-call counting.

## Co-simulation contract

The analog/digital simulator owns time. Times are **seconds** at the boundary; the runtime
keeps integer nanoseconds inside, so timer arithmetic never drifts.

```ts
const mcu = new McuRuntime({ id: 'U1', profile: 'atmega328p', firmware, bus, pwm: 'edges' });

await mcu.runUntil(0);                       // setup() runs up to its first yield
let t = 0;
while (t < tstop) {
  const tNext = Math.min(t + dtMax, mcu.nextWakeTime(), tstop);  // MCU wake = breakpoint
  solver.advanceTo(tNext);                   // MCU outputs are constant on (t, tNext)
  // input crossings on subscribed pins inside (t, tNext]: locate tc, solve to tc,
  // call the onEdge callback cb(level, tc), then use tNext = tc
  await mcu.runUntil(tNext);                 // may call bus.drive/setDirection/setPwm at tNext
  t = tNext;
}
```

- `nextWakeTime(): number` — earliest pending firmware event: delay/idle-loop expiry,
  PWM/tone edge (`pwm: 'edges'`), Timer1 tick, queued input edge. `Infinity` when nothing
  is pending; the start time before the first `runUntil`. Re-query it after reporting edges.
- `runUntil(t): Promise<void>` — processes every event with time ≤ t in time order (ties:
  input edges, timers, PWM, then the main thread), then sets `now = t`. The bus is queried
  at each event's own time, so a solver-backed bus must never be asked to run past
  `nextWakeTime()`. Must be awaited before the next call — on any runtime (the Arduino API
  is ambient; concurrent `runUntil` calls throw). Calling with t earlier than `now` throws.
- Inputs: `digitalRead`/`analogRead` call `bus.readDigital/readVoltage(pin, now)`.
  Interrupts: `attachInterrupt` calls `bus.onEdge(pin, cb)`; the bus calls `cb(level, t)` on
  each logic-level change with `t ≥ now` (future edges are queued; past edges throw).
  Handlers run synchronously at the edge time. An edge reported *while* firmware runs
  (e.g. an output looped back to an input) is handled right after the current firmware
  slice yields, at the same timestamp.
- Outputs: `setDirection(pin, 'input'|'input_pullup'|'input_pulldown'|'output', t)`,
  `drive(pin, 0|1, t)` (only on changes), and in `pwm: 'descriptor'` mode
  `setPwm(pin, { freqHz, duty, periodStart } | null, t)` instead of PWM edges. All pins
  start as `'input'` at t = 0; nothing is called for them until the firmware changes them.
- Results: `serialLog()`, `pinTrace()` (dir/level/pwm events), `diagnostics()`, `state`,
  `now`. `serialInput(text, t)` feeds `Serial.read()`.

Pin names on the bus are the profile's canonical names: `D0…D13, A0…A5` (Uno),
`PB0…PB5` (ATtiny85), `GPIOn` (ESP32), `GPn` (RP2040). `analogReference(EXTERNAL)` reads
the voltage of the bus pin `AREF` (Uno) / `PB0` (ATtiny85).

### What the bus is expected to model

`readDigital` applies the profile's `logic.vilMax/vihMin` (fractions of VCC unless
`absolute`); `drive` is push-pull at VOH/VOL with the pin's current limited by the circuit;
`input_pullup` is the profile's `logic.pullupOhms` to VCC. `profile.limits` (per-pin abs max /
recommended, VCC/GND total, port groups) is data for the integration's R41x rating checks —
the runtime never evaluates currents.

## Arduino API (`circuitsvibe/arduino`)

`pinMode` (INPUT, OUTPUT, INPUT_PULLUP, INPUT_PULLDOWN on ESP32/RP2040) · `digitalWrite` ·
`digitalRead` · `analogRead` (code = floor(Vin·2^bits/Vref), clamped; 10-bit on AVR, so
2.5 V at Vref 5 V reads **512**) · `analogReference` (DEFAULT, INTERNAL 1.1 V, EXTERNAL;
INTERNAL2V56 on ATtiny85) · `analogReadResolution` (ESP32/RP2040) · `analogWrite` (0..255
at each pin's real timer frequency: Uno 490.196 Hz phase-correct `v/255`, D5/D6 976.5625 Hz
fast PWM `(v+1)/256`; 0 and 255 are constant levels; non-PWM pin ⇒ M612 + core fallback) ·
`tone`/`noTone` · `millis`/`micros` (micros at the core's granularity: 4 µs on the Uno) ·
`await delay`/`await delayMicroseconds` · `digitalPinToInterrupt`, `attachInterrupt`
(RISING/FALLING/CHANGE), `detachInterrupt`, `noInterrupts`/`interrupts` · `Timer1`
(TimerOne style: `initialize(us)`, `attachInterrupt(fn, us?)`, `setPeriod`, `start`, `stop`,
`resume`, `detachInterrupt`) · `Serial.begin/end/print/println/write/available/read/peek/flush`
(Arduino Print formatting: floats with 2 decimals, `print(n, HEX)`, booleans as 1/0;
`println` appends `\r\n`) · `random`/`randomSeed` (avr-libc generator, initial state 1 or
`randomSeed` option) · `map` (integer, truncating) · `constrain`, `min`, `max`, `abs`, `sq`,
`bit*`, `lowByte`, `highByte` · constants `HIGH/LOW`, `BIN/OCT/DEC/HEX`, `LED_BUILTIN`,
`A0…` (live bindings to the running profile).

## What the integrator must add

1. **Bench loader (`src/cli/load.ts`)** — map the virtual module and instrument firmware:

   ```ts
   import { arduinoModule, ARDUINO_SPECIFIER, instrumentLoops } from '../mcu';
   // in localRequire:
   if (specifier === ARDUINO_SPECIFIER) return arduinoModule();
   // after the sucrase transform, for modules that import it:
   if (code.includes(ARDUINO_SPECIFIER)) code = instrumentLoops(code);
   ```

   Preferred: benches reference firmware **by path** (`firmware: './blink.fw.ts'`) and the
   CLI loads it with `loadFirmwareFile(path, { profile })` from `src/mcu/node/load-firmware`
   — one fresh module graph per MCU instance (independent globals), constants evaluated for
   the right profile, M608 on load errors. A firmware module imported directly by the bench
   is shared by every MCU that uses it.
2. **Types for user firmware**: `tsconfig.json` `paths` `"circuitsvibe/arduino":
   ["src/mcu/arduino.ts"]`, and a `"./arduino"` entry in `package.json#exports` with a
   matching `dist` build (e.g. an extra esbuild entry for `src/mcu/arduino.ts`, or export
   `src/mcu` from `src/forge.ts`).
3. **Lint stage**: run `lintFirmware(source, { file, profile })` with the circuit lint;
   F14x errors should block simulation like F1xx.
4. **Bridge**: an `McuPinBus` over the analog engine (pin = voltage source with output
   resistance when `output`, pull-up resistor when `input_pullup`, threshold detection with
   edge location for subscribed pins), the transient loop above, and `McuDiagnostic` →
   RunRecord mapping (`stage: 'mcu'` diagnostics carry `time`; `at` is the firmware line).
5. **Assertions**: `tb.expect.serial('U1').toContain(...)`, `tb.expect.pin('U1.D9')…` on top
   of `measure.ts` (`serialContains`, `serialMatches`, `serialLineCount`, `serialFirstTime`,
   `levelsOf`, `toggleCount`, `frequency`, `dutyCycle`, `pwmStats`).

## Known gaps

- No instruction timing: code between yields takes zero time (except the idle-loop cost);
  `analogRead` is instantaneous (the profile records the real conversion time).
- ISRs cannot preempt a running firmware slice; they run at the next yield point (same
  timestamp). Level-triggered interrupts and pin-change interrupts are not modelled.
- PWM periods are timer-aligned from t = 0 with the pulse at the start of each period
  (phase-correct centring is not modelled); duty changes apply at the next period.
  `analogWriteFrequency/Resolution`, LEDC channels and Timer1-driven PWM are not modelled.
- Serial has no UART timing (timestamps are the print call); only `Serial`; no `printf`.
  Arduino cannot tell `1.0` from `1` in JS: integral floats print as integers.
- No `pulseIn`, `shiftOut/shiftIn`, Wire/I2C, SPI, EEPROM, sleep modes, watchdog, Wi-Fi.
- ESP32 ADC is modelled ideal-linear over 0..3.3 V (real: nonlinear, ≈0.15–3.1 V at 11 dB).
- `millis()` is exact (`floor(t/1 ms)`), without AVR's 1.024 ms tick jitter.
- `random()` uses the avr-libc generator on every profile (ESP32/RP2040 cores use hardware RNGs).
