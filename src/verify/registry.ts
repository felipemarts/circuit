/**
 * Diagnostic registry — the stable code taxonomy and its long-form
 * explanations (`circuitsvibe explain <code>`). Codes are permanent: parsers and
 * agents may key on them, so they are never renumbered or reworded away.
 *
 *   F1xx  structural lint (pre-solve topology)
 *   S1xx  linear solver
 *   S2xx  nonlinear solver (Newton-Raphson)
 *   A3xx  assertion outcomes
 *   T0xx  tooling / bench authoring
 *   M6xx  MCU / firmware runtime (M601–M649)
 *   F14x  firmware lint (F140–F149)
 */

export interface DiagnosticDoc {
  code: string;
  slug: string;
  title: string;
  explanation: string;
}

export const DIAGNOSTIC_DOCS: DiagnosticDoc[] = [
  {
    code: 'F101',
    slug: 'floating-net',
    title: 'net has no DC path to ground',
    explanation: `Every net needs a DC-conductive path (resistor, source, inductor, diode,
switch) down to ground, or its operating-point voltage is mathematically
undefined — the MNA matrix becomes singular. Capacitors block DC and current
sources do not fix node voltages, so a net reachable only through them floats.

Typical causes: a coupling capacitor feeding an otherwise unconnected stage,
or a current source driving a node with no resistive return.

Fixes: give the net a DC path — a bleed resistor (100k–10M) to ground is the
classic remedy — or rewire the net to one that already has a path.`,
  },
  {
    code: 'F103',
    slug: 'unreached-component',
    title: 'component not connected to the grounded circuit',
    explanation: `The simulator solves the connected subgraph that contains ground. A
component (or island of components) with no connection to that subgraph
cannot be simulated — and silently ignoring it would hand back confidently
wrong numbers (its voltages would read 0 V). It is therefore a hard error.

Fixes: wire the component into the circuit, connect the circuit's return
path to tb.gnd, or remove the component.`,
  },
  {
    code: 'F104',
    slug: 'voltage-source-loop',
    title: 'ideal voltage source shorted or looped',
    explanation: `An ideal voltage source demands a fixed potential difference across zero
impedance. Shorting one (both terminals on the same net), or connecting two
in parallel (directly or through other sources), over-constrains the system:
the MNA matrix is singular even when the values happen to agree.

At the DC operating point an inductor is a 0 V ideal source, so an inductor
directly across a voltage source triggers this too.

Fixes: rewire so no source loop exists; if the parallel connection is
intentional, add a small series resistance (e.g. 10m ohm) in one branch.`,
  },
  {
    code: 'F105',
    slug: 'source-clamped-diode',
    title: 'diode/LED forward-clamped directly across an ideal source',
    explanation: `An ideal voltage source fixes the voltage across anything in parallel with
it. A forward-biased diode or LED clamped this way has its exponential I-V
curve evaluated at the full source voltage — the current is astronomically
large (e.g. ~1e22 A for an LED at 5 V) and Newton-Raphson diverges or the
matrix goes singular. Real diodes would simply burn.

Fix: always insert a series resistor between the source and the diode.
Size it as R = (Vsource - Vf) / Itarget; for an LED at 5 V and 10 mA,
around 270–330 ohm.

A reverse-biased diode across a source is fine (current ~ 0) and does not
trigger this error.`,
  },
  {
    code: 'F106',
    slug: 'dangling-pin',
    title: 'pin not connected to anything',
    explanation: `A pin whose net contains only itself carries no current. Sometimes that is
intentional (an unused switch throw); usually it means a forgotten wire.
This is a warning — it never blocks simulation.`,
  },
  {
    code: 'S101',
    slug: 'unsolvable-system',
    title: 'solver could not solve the circuit',
    explanation: `The linear system could not be solved (singular matrix) for a reason the
lint stage did not model. This should be rare: F101/F103/F104 catch the
common causes before the solver runs. If you see S101, inspect the most
recently changed components and nets, and report the netlist — this may be
a platform gap.`,
  },
  {
    code: 'S201',
    slug: 'nr-nonconvergence',
    title: 'Newton-Raphson did not converge (DC operating point)',
    explanation: `The nonlinear iteration did not settle. The diagnostic names the worst
component (largest voltage delta on the final iteration) and its recent
voltage history; an a-b-a-b oscillation pattern is typical of a stiff
exponential branch — a diode or LED driven hard with no series resistance.

Fixes: add series resistance in the offending branch (even 1–10 ohm helps);
check source polarity and magnitude. Continuation strategies (gmin/source
stepping) are on the roadmap and will be applied automatically.`,
  },
  {
    code: 'S202',
    slug: 'nr-nonconvergence',
    title: 'Newton-Raphson did not converge (transient step)',
    explanation: `Same failure mode as S201, but during a transient timestep. Besides the
S201 fixes, a smaller dt often helps because the previous timestep's
solution is then a better starting guess.`,
  },
  {
    code: 'A301',
    slug: 'assertion-failed',
    title: 'assertion failed',
    explanation: `The circuit simulated fine but did not meet the spec. The result carries
the measured value, the expected check, the margin, and — when the bench
declares a free parameter via tb.param — a verified hint: a parameter range
that was actually simulated and passes ALL op assertions.

Trust contract: hints marked 'verified' were simulated; apply them directly.
If no hint is present, the topology itself likely cannot meet the spec.`,
  },
  {
    code: 'T002',
    slug: 'stage-crash',
    title: 'a verification stage crashed',
    explanation: `A stage runner (op/tran) threw an unexpected error after successful
elaboration. This is a platform bug, not a statement about your circuit —
the RunRecord is still emitted so nothing is lost. Please report the bench
file that triggered it.`,
  },
  {
    code: 'T001',
    slug: 'bench-error',
    title: 'bench code threw during elaboration',
    explanation: `The bench build function itself raised an error (bad probe name, duplicate
id, invalid unit string, ...). This is an authoring error in the bench file,
not an electrical result. The message pinpoints what to fix; correct the
bench code and re-run.`,
  },
  // ── M6xx: MCU / firmware runtime ──
  {
    code: 'M601',
    slug: 'firmware-exception',
    title: 'firmware threw an exception',
    explanation: `The firmware (setup, loop, an interrupt handler or a timer callback) threw
an uncaught exception. The diagnostic carries the firmware file:line of the
throw (at), the simulation time it happened (time) and the firmware-only
stack (evidence.stack). The MCU halts: outputs keep their last state and
hardware PWM keeps running, as a hung chip would.

Fix the code at the reported line. Common causes: reading a property of
undefined, an out-of-range array index, or an explicit throw on a timeout.`,
  },
  {
    code: 'M602',
    slug: 'busy-loop',
    title: 'firmware ran too long without yielding',
    explanation: `Simulated time only advances when the firmware awaits delay() /
delayMicroseconds() or loop() returns. A synchronous loop that waits for an
input or for millis() to change — while (digitalRead(2) == LOW) {} — can
never finish: nothing changes while it runs. The runtime counts API calls and
loop iterations between yields (budget maxOpsPerYield, default 1e6) and
halts the MCU at the loop's line instead of hanging the simulator.

Fix: put \`await delay(1)\` (or delayMicroseconds) inside the loop, or react to
the input with attachInterrupt().`,
  },
  {
    code: 'M603',
    slug: 'zero-time-loop',
    title: 'firmware keeps yielding without letting time advance',
    explanation: `More than maxEventsPerInstant (default 1e5) firmware events were processed
at one simulation instant — typically \`while (…) await delay(0)\`, or an input
edge storm reported by the circuit at a single time point. Time cannot move
forward, so the MCU is halted.

Fix: wait a real amount of time inside the loop (\`await delay(1)\`).`,
  },
  {
    code: 'M604',
    slug: 'idle-loop',
    title: 'loop() returns without awaiting a delay',
    explanation: `Firmware executes in zero simulated time between yields. A loop() pass that
never waits is charged a fixed cost (the profile's idleLoopUs, 10 µs by
default) so polling code still observes inputs changing — but every pass is a
simulator breakpoint, which is slow for the analog engine. Warning only.

Fix (if the loop only polls): add \`await delay(1)\` at the end of loop(), or
use attachInterrupt() for the input.`,
  },
  {
    code: 'M605',
    slug: 'delay-not-awaited',
    title: 'delay() called without await',
    explanation: `delay() and delayMicroseconds() return a promise; the wait only happens when
the firmware awaits it. Without await the next statement runs immediately
and a later delay overlaps the first. The runtime detects a delay left
pending (a second delay while one is outstanding, or setup()/loop()
returning) and halts at the un-awaited call.

Fix (mechanical): write \`await delay(ms)\`, make the enclosing function async,
and await that function where it is called.`,
  },
  {
    code: 'M606',
    slug: 'foreign-await',
    title: 'firmware awaited something that is not a simulator timer',
    explanation: `The firmware is suspended on a promise the simulator does not control (a
never-resolved Promise, setTimeout wrappers, I/O). It would resolve in
wall-clock time or never, so simulated time cannot advance deterministically.
Firmware may only await delay()/delayMicroseconds(), directly or through
async helpers that do.`,
  },
  {
    code: 'M607',
    slug: 'delay-in-interrupt',
    title: 'delay() inside an interrupt or timer callback',
    explanation: `Interrupt handlers (attachInterrupt, Timer1) run synchronously and must
return quickly; on hardware millis() does not advance inside an ISR, so
delay() there hangs or returns at once. The call is ignored.

Fix: set a flag (a variable) in the handler and do the slow work in loop().`,
  },
  {
    code: 'M608',
    slug: 'firmware-load-error',
    title: 'firmware failed to load',
    explanation: `The firmware file could not be loaded: not found, a syntax/type-strip
error (at = the offending line), an import other than 'circuitsvibe/arduino'
or a relative file, or module top-level code that threw (for example an
Arduino API call outside setup()/loop()). \`await\` requires the enclosing
function to be async: declare \`export async function loop()\`.`,
  },
  {
    code: 'M609',
    slug: 'missing-entry-points',
    title: 'firmware exports neither setup() nor loop()',
    explanation: `The runtime calls the exported setup() once at t = 0 and then the exported
loop() forever. A firmware module exporting neither does nothing.

Fix: \`export async function setup() { … }\` and \`export async function loop() { … }\`.`,
  },
  {
    code: 'M610',
    slug: 'unknown-pin',
    title: 'pin does not exist on this part',
    explanation: `A pin number or name passed to an Arduino API does not exist on the selected
MCU profile (numbers follow that core's numbering: on the Uno 0–13 are
D0–D13 and 14–19 are A0–A5; on the ESP32 numbers are GPIO numbers). The call
is ignored (reads return 0). The note lists the valid pins.`,
  },
  {
    code: 'M611',
    slug: 'pin-not-output-capable',
    title: 'pin cannot be an output',
    explanation: `The pin is input-only on this part (ESP32 GPIO34–39, ATtiny85 PB5/RESET
without the RSTDISBL fuse), so it cannot be driven. Use an output-capable pin.`,
  },
  {
    code: 'M612',
    slug: 'no-pwm-on-pin',
    title: 'analogWrite() on a pin without PWM',
    explanation: `Only pins wired to a timer compare output can generate PWM (Uno: D3, D5,
D6, D9, D10, D11). On any other pin the Arduino core falls back to
digitalWrite: LOW for values below 128, HIGH otherwise — the simulator does
the same, so a "dimmed" LED is simply on or off.

Fix: move the load to a PWM pin and update the pin number in the firmware.`,
  },
  {
    code: 'M613',
    slug: 'no-adc-on-pin',
    title: 'analogRead() on a pin without an ADC channel',
    explanation: `The pin is not connected to the ADC multiplexer (Uno: only A0–A5). The call
returns 0. Connect the signal to an analog input and read that pin.`,
  },
  {
    code: 'M614',
    slug: 'not-an-interrupt',
    title: 'attachInterrupt() with an invalid interrupt number',
    explanation: `attachInterrupt() takes an INTERRUPT number, not a pin number. On the Uno
interrupt 0 is D2 and interrupt 1 is D3, so attachInterrupt(2, …) refers to a
non-existent interrupt. Always write attachInterrupt(digitalPinToInterrupt(pin), …);
NOT_AN_INTERRUPT (-1) means the pin cannot raise external interrupts.`,
  },
  {
    code: 'M615',
    slug: 'write-to-non-output',
    title: 'digitalWrite() on a pin not configured as OUTPUT',
    explanation: `Pins start as INPUT. On AVR, digitalWrite() to an INPUT pin switches its
internal pull-up (20–50 kΩ) instead of driving it — an LED glows faintly and
nothing real can be driven; the simulator models exactly that. On ESP32 and
RP2040 the write is latched but the pin stays high-impedance.

Fix (mechanical): pinMode(pin, OUTPUT) in setup() before writing.`,
  },
  {
    code: 'M616',
    slug: 'adc-input-clamped',
    title: 'ADC input outside 0..Vref — reading saturated',
    explanation: `The ADC transfer is code = floor(Vin · 2^bits / Vref), clamped to
0..2^bits − 1 (AVR datasheet "ADC Conversion Result"). An input above Vref
reads full scale and a negative one reads 0, so the firmware cannot tell
values apart there. Scale the signal into range with a divider or select a
larger reference. (Pin overvoltage itself is an electrical rating issue.)`,
  },
  {
    code: 'M617',
    slug: 'serial-not-begun',
    title: 'Serial used before Serial.begin()',
    explanation: `The UART is disabled until Serial.begin(baud): real hardware transmits
nothing. The simulator still records the text so it can be inspected.
Fix: call Serial.begin(9600) (or 115200) at the start of setup().`,
  },
  {
    code: 'M618',
    slug: 'unsupported-api',
    title: 'API or mode not supported on this part or by the simulator',
    explanation: `The call exists in some Arduino cores but not for this part or not in the
simulator: e.g. INPUT_PULLDOWN on AVR, INPUT_PULLUP on ESP32 input-only
pins, analogReadResolution() on AVR, an unknown analogReference(), or a
level-triggered (LOW) interrupt. The message names the alternative.`,
  },
  {
    code: 'M619',
    slug: 'invalid-argument',
    title: 'invalid argument to an Arduino API call',
    explanation: `An argument is out of its domain: a negative or non-numeric delay, an unknown
pinMode mode, a non-function interrupt handler, a non-positive tone frequency
or timer period. The call is ignored or uses a safe value, as stated in the
message.`,
  },
  {
    code: 'M620',
    slug: 'value-clamped',
    title: 'value out of range — clamped',
    explanation: `A value was outside the API's range and was clamped or truncated: an
analogWrite() duty outside 0..255 (AVR hardware would keep only the low
byte), or a fractional delay() argument (the argument is an unsigned
integer, so delay(0.5) is delay(0) — use delayMicroseconds(500)).`,
  },
  {
    code: 'M621',
    slug: 'timer-pwm-conflict',
    title: 'hardware timer shared with PWM pins',
    explanation: `The Timer1 API reprograms the same hardware timer that generates PWM on
some pins (Uno: D9, D10). On hardware their PWM frequency changes or stops;
the simulator keeps the default frequency, so results on those pins are
optimistic. Use PWM pins on another timer.`,
  },
  // ── F14x: firmware lint ──
  {
    code: 'F140',
    slug: 'delay-not-awaited',
    title: 'delay() call without await',
    explanation: `Static twin of M605: a delay()/delayMicroseconds() call that is not awaited
(nor returned). Without await it does not wait. Fix (mechanical): \`await
delay(ms)\` inside an async function.`,
  },
  {
    code: 'F141',
    slug: 'missing-entry-points',
    title: 'firmware does not export setup()/loop()',
    explanation: `The runtime calls the exported setup() once and the exported loop() forever.
Error when neither is exported, warning when only one is.`,
  },
  {
    code: 'F142',
    slug: 'sync-busy-wait',
    title: 'polling loop without await can never see time or inputs change',
    explanation: `A while loop whose condition reads digitalRead/analogRead/millis/micros/
Serial.available but whose body never awaits. Firmware runs in zero
simulated time between awaits, so the condition can never change (runtime
diagnostic M602). Fix: add \`await delay(1)\` inside the loop, or use
attachInterrupt().`,
  },
  {
    code: 'F143',
    slug: 'no-pwm-on-pin',
    title: 'analogWrite() on a pin without PWM',
    explanation: `Static twin of M612 for literal pins and simple constants: the pin has no
timer output on the selected profile, so the core falls back to
digitalWrite. Move the load to a PWM pin.`,
  },
  {
    code: 'F144',
    slug: 'pin-capability',
    title: 'pin does not exist on this part or lacks the required function',
    explanation: `Static check of literal pins and simple constants against the selected
profile: the pin does not exist, analogRead() targets a pin without ADC,
or an input-only pin is used as an output.`,
  },
  {
    code: 'F145',
    slug: 'not-an-interrupt',
    title: 'attachInterrupt() given a pin number instead of an interrupt number',
    explanation: `Static twin of M614: attachInterrupt(2, …) on the Uno means interrupt 2, which
does not exist. Fix (mechanical): attachInterrupt(digitalPinToInterrupt(2), …).
Also flags digitalPinToInterrupt() of a pin that cannot raise interrupts.`,
  },
  {
    code: 'F146',
    slug: 'unsupported-api',
    title: 'Arduino API not supported by the simulator',
    explanation: `The firmware uses an API the MCU runtime does not provide yet (pulseIn,
shiftOut/shiftIn, Wire, SPI, EEPROM, Serial1, analogWriteFrequency, …). The
fix names the closest supported alternative.`,
  },
  {
    code: 'F147',
    slug: 'host-api',
    title: 'wall-clock or host API in firmware',
    explanation: `Date, performance.now, setTimeout/setInterval, Math.random, process or
fetch in firmware. Firmware time is simulation time: host clocks, timers and
unseeded randomness make runs irreproducible and are never synchronized with
the circuit. Use millis()/micros(), await delay(), Timer1 and random().`,
  },
  {
    code: 'F148',
    slug: 'serial-not-begun',
    title: 'Serial used but Serial.begin() never called',
    explanation: `Static twin of M617: Serial output without any Serial.begin(baud). Real
hardware transmits nothing. Add Serial.begin(9600) in setup().`,
  },
  {
    code: 'F149',
    slug: 'write-without-pinmode',
    title: 'digitalWrite() to a pin never set to OUTPUT',
    explanation: `Static twin of M615: no pinMode(pin, OUTPUT) (or analogWrite/tone) for a
pin that is written. Pins start as INPUT; on AVR the write only toggles the
pull-up. Add pinMode(pin, OUTPUT) in setup().`,
  },
];

export function findDiagnosticDoc(code: string): DiagnosticDoc | undefined {
  return DIAGNOSTIC_DOCS.find(d => d.code.toLowerCase() === code.toLowerCase());
}
