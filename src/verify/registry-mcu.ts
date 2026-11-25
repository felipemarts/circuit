/**
 * Registry entries of the MCU / VHDL bench integration (src/mixed/mcu*.ts):
 * F139 (MCU supply lint), M622–M623 (MCU power), R410–R413 (MCU pin-current
 * ratings). Merged into DIAGNOSTIC_DOCS (src/verify/registry.ts).
 */
import type { DiagnosticDoc } from './registry';

export const MCU_INTEGRATION_DOCS: DiagnosticDoc[] = [
  {
    code: 'F139',
    slug: 'mcu-supply-unconnected',
    title: 'MCU supply pin (VCC/GND) unconnected or shorted to the other',
    explanation: `A microcontroller component (new Mcu(...), new ArduinoUno(...)) is powered
only through its supply pins — VCC (the Uno's '5V') and GND. Its output stages
pull up to VCC and down to GND, its input thresholds and ADC reference scale
with VCC − GND, and below the brown-out threshold the firmware never starts.
F139 fires when VCC or GND is connected to nothing, or both are on one net.

Fix: u1.pin('5V').connect(v5.pin('+')) (or 'VCC') and u1.pin('GND').connect(tb.gnd).`,
  },
  {
    code: 'M622',
    slug: 'mcu-reset-unpowered',
    title: 'MCU held in reset: supply below the brown-out / power-on threshold',
    explanation: `VCC − GND of the microcontroller was below its reset threshold — the
ATmega328P brown-out level of the Arduino Uno fuses (VBOT = 2.7 V), the ESP32
default brown-out (≈ 2.43 V), or the minimum supply of parts without a BOD
(ATtiny85 1.8 V, RP2040 1.62 V; a model choice). In reset every pin is high-Z
(only the ESD clamps and leakage remain) and the firmware does not run.

At t = 0 (the transient's first point) the MCU must already be powered: a
delayed power-up is not modelled, so an unpowered start keeps the MCU in reset
for the whole run. A brown-out during the run (a supply fed through a resistor
that sags under load) latches the MCU in reset from that time on — restart is
not modelled either. Carries the supply voltage, the threshold and the time.

Fix: power VCC from a stiff source; check for series resistance or a load that
collapses the supply.`,
  },
  {
    code: 'M623',
    slug: 'mcu-supply-out-of-range',
    title: 'MCU supply outside its recommended range (error above the absolute maximum)',
    explanation: `The microcontroller's supply left its recommended operating range for the
modelled clock (ATmega328P at 16 MHz: 4.5–5.5 V by the speed grade; ATtiny85 at
8 MHz: 2.7–5.5 V; ESP32: 3.0–3.6 V; RP2040 IOVDD: 1.62–3.63 V) — a warning: the
model keeps running the firmware and extrapolates drive and thresholds, a real
part may misbehave. Above the absolute maximum (6.0 V for the AVRs, 3.6 V ESP32,
3.63 V RP2040) it is an error: the part would be damaged.`,
  },
  {
    code: 'R410',
    slug: 'mcu-pin-current-exceeded',
    title: 'MCU I/O pin current above its absolute maximum',
    explanation: `The current through one microcontroller I/O pin (output stage, internal
pull-up and ESD clamp diodes together; sourcing or sinking) exceeded the
datasheet's absolute maximum per pin — 40 mA on the ATmega328P / ATtiny85,
40 mA (max-drive IOH) on the ESP32, 12 mA (strongest drive) on the RP2040. The
classic cause is an LED straight on a pin: the only limit is the output
resistance (≈ 40 Ω at 5 V from the ATmega328P VOH/VOL rows), so it draws
70 mA or more. Listed in stages.tran.ratings[] (exit 1, like R401–R404) with
the peak, its time and the first violation; passing pins with current are
listed too. tb.ratings({ derate, ignore }) applies.

Fix: a series resistor (an LED from 5 V at 20 mA needs ≥ 150 Ω), or switch the
load with a transistor.`,
  },
  {
    code: 'R411',
    slug: 'mcu-pin-current-above-recommended',
    title: 'MCU pin current above the datasheet test condition (warning)',
    explanation: `A pin carried more current than the datasheet specifies its output levels at
(ATmega328P: 20 mA, the VOH/VOL test condition; ATtiny85 10 mA; ESP32 20 mA
default drive; RP2040 4 mA default drive) but stayed under the absolute
maximum. VOH/VOL are no longer guaranteed and the part heats up. A warning in
diagnostics[] (it does not change the exit code).`,
  },
  {
    code: 'R412',
    slug: 'mcu-port-current-exceeded',
    title: 'sum of the pin currents of an MCU port group above its limit',
    explanation: `The ATmega328P limits the summed sink (IOL) and source (IOH) currents of pin
groups (datasheet notes to the DC characteristics): e.g. 100 mA for B0–B5 +
D5–D7 (Uno D5–D13) — several pins at their individual maximum together exceed
it. Listed in stages.tran.ratings[] with the peak sum (exit 1 when exceeded).

Fix: spread the loads over other port groups, or drive them with transistors.`,
  },
  {
    code: 'R413',
    slug: 'mcu-supply-current-exceeded',
    title: 'MCU total VCC/GND or total I/O current above its limit',
    explanation: `The current through the VCC / GND pins (ATmega328P / ATtiny85: 200 mA) or the
sum of all sink / source currents (ATtiny85: 60 mA each; ESP32: 1200 mA
cumulative source; RP2040: 50 mA IOVDD/IOVSS) exceeded the datasheet limit.
Only the I/O load currents are modelled — the core's own supply current is not —
so the real total is somewhat higher. Listed in stages.tran.ratings[] (exit 1).`,
  },
];
