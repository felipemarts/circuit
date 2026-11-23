/**
 * MCU part profiles — plain JSON-serializable data. The runtime reads pin
 * capabilities, PWM frequencies, ADC parameters and core quirks from here;
 * the integration reads `limits` for its rating diagnostics (R41x).
 *
 * Numbers were checked against the primary sources cited in each profile's
 * `sources` (datasheets and the Arduino core sources, latest tags as of
 * 2026-11). Where a source gives a typical value rather than a rating, the
 * profile says so in `notes`.
 */

import type { McuProfile, PinSpec, PinPwmSpec } from './types';

// ─────────────────────────── ATmega328P / Arduino Uno ───────────────────────────
//
// Sources:
//  [DS]   Microchip DS40002061B, ATmega48A/PA/88A/PA/168A/PA/328/P datasheet
//         §29.1 Absolute Maximum Ratings (40 mA per pin, 200 mA VCC/GND),
//         Table 30-1 Common DC characteristics (VOL/VOH at 20 mA, RPU 20–50 kΩ,
//         VIL 0.3·VCC / VIH 0.6·VCC, port-group notes), §24.7 ADC Conversion
//         Result (ADC = Vin·1024/Vref), §24.4 (13 ADC clocks per conversion).
//         https://ww1.microchip.com/downloads/aemDocuments/documents/MCU08/ProductDocuments/DataSheets/ATmega48A-PA-88A-PA-168A-PA-328-P-DS-DS40002061B.pdf
//  [DS2]  Atmel-42735B ATmega328/P datasheet, Table 32-2 (100 mA source-group limit;
//         DS40002061B says 150 mA — the conservative 100 mA is used).
//         https://cdn.sparkfun.com/assets/c/a/8/e/4/Atmel-42735-8-bit-AVR-Microcontroller-ATmega328-328P_Datasheet.pdf
//  [CORE] ArduinoCore-avr: cores/arduino/wiring.c init() — Timer0 fast PWM /64
//         (976.5625 Hz), Timer1 and Timer2 8-bit phase-correct /64 (490.196 Hz),
//         ADC prescaler 128 (125 kHz ⇒ 104 µs per conversion);
//         cores/arduino/wiring_analog.c analogWrite() — 0 ⇒ digitalWrite LOW,
//         255 ⇒ HIGH, non-PWM pin ⇒ digitalWrite(val < 128 ? LOW : HIGH);
//         variants/standard/pins_arduino.h — 3=TIMER2B 5=TIMER0B 6=TIMER0A
//         9=TIMER1A 10=TIMER1B 11=TIMER2A; digitalPinToInterrupt: 2⇒0, 3⇒1.
//         https://github.com/arduino/ArduinoCore-avr

const UNO_PWM_FAST: Omit<PinPwmSpec, 'timer'> = { freqHz: 16e6 / 64 / 256, formula: 'avr-fast' }; // 976.5625 Hz
const UNO_PWM_PHASE: Omit<PinPwmSpec, 'timer'> = { freqHz: 16e6 / 64 / 510, formula: 'avr-phase-correct' }; // 490.196 Hz

function unoPins(): PinSpec[] {
  const ports = ['PD0', 'PD1', 'PD2', 'PD3', 'PD4', 'PD5', 'PD6', 'PD7', 'PB0', 'PB1', 'PB2', 'PB3', 'PB4', 'PB5'];
  const pwm: Record<number, PinPwmSpec> = {
    3: { timer: 'TIMER2B', ...UNO_PWM_PHASE },
    5: { timer: 'TIMER0B', ...UNO_PWM_FAST },
    6: { timer: 'TIMER0A', ...UNO_PWM_FAST },
    9: { timer: 'TIMER1A', ...UNO_PWM_PHASE },
    10: { timer: 'TIMER1B', ...UNO_PWM_PHASE },
    11: { timer: 'TIMER2A', ...UNO_PWM_PHASE },
  };
  const notes: Record<number, string[]> = {
    0: ['RX of Serial (USB bridge) — avoid when Serial is used'],
    1: ['TX of Serial (USB bridge) — avoid when Serial is used'],
    13: ['LED_BUILTIN (on-board LED through a buffer on Uno R3)'],
  };
  const pins: PinSpec[] = ports.map((port, n) => ({
    name: `D${n}`,
    number: n,
    port,
    input: true,
    output: true,
    pullup: true,
    ...(pwm[n] ? { pwm: pwm[n] } : {}),
    ...(n === 2 ? { interrupt: 0 } : n === 3 ? { interrupt: 1 } : {}),
    ...(notes[n] ? { notes: notes[n] } : {}),
  }));
  for (let ch = 0; ch < 6; ch++) {
    pins.push({ name: `A${ch}`, number: 14 + ch, port: `PC${ch}`, input: true, output: true, pullup: true, adc: ch });
  }
  return pins;
}

function numbersOf(pins: PinSpec[]): Record<string, string> {
  return Object.fromEntries(pins.map(p => [String(p.number), p.name]));
}

const unoPinList = unoPins();

export const ATMEGA328P_UNO: McuProfile = {
  id: 'atmega328p',
  part: 'ATmega328P',
  board: 'Arduino Uno R3',
  core: 'ArduinoCore-avr',
  cpuHz: 16e6,
  vcc: 5,
  logic: {
    vilMax: 0.3,
    vihMin: 0.6,
    vohMin: 4.2,
    volMax: 0.9,
    outputTestCurrentMa: 20,
    pullupOhms: [20e3, 50e3],
  },
  pins: unoPinList,
  digitalNumbers: numbersOf(unoPinList),
  analogNumbers: Object.fromEntries(
    [0, 1, 2, 3, 4, 5].flatMap(ch => [
      [String(ch), `A${ch}`],
      [String(14 + ch), `A${ch}`],
    ]),
  ),
  constants: { LED_BUILTIN: 13, A0: 14, A1: 15, A2: 16, A3: 17, A4: 18, A5: 19 },
  adc: {
    bits: 10,
    defaultReadBits: 10,
    adjustableResolution: false,
    references: { DEFAULT: 'vcc', INTERNAL: 1.1, EXTERNAL: { pin: 'AREF' } },
    defaultReference: 'DEFAULT',
    transfer: 'floor',
    conversionTimeUs: 104,
    notes: ['ADC = floor(Vin·1024/Vref) per the datasheet; 0x3FF means Vin ≥ Vref − 1 LSB'],
  },
  pwmRange: 255,
  inputWriteControlsPullup: true,
  microsResolutionUs: 4,
  idleLoopUs: 10,
  limits: {
    pinAbsMaxMa: 40,
    pinRecommendedMa: 20,
    vccGndMaxMa: 200,
    portGroups: [
      { pins: ['A0', 'A1', 'A2', 'A3', 'A4', 'A5'], sinkMaxMa: 100, note: 'IOL sum C0–C5, ADC6, ADC7' },
      { pins: ['D5', 'D6', 'D7', 'D8', 'D9', 'D10', 'D11', 'D12', 'D13'], sinkMaxMa: 100, note: 'IOL sum B0–B5, D5–D7, XTAL1/2' },
      { pins: ['D0', 'D1', 'D2', 'D3', 'D4'], sinkMaxMa: 100, note: 'IOL sum D0–D4, RESET' },
      { pins: ['A0', 'A1', 'A2', 'A3', 'A4', 'A5', 'D0', 'D1', 'D2', 'D3', 'D4'], sourceMaxMa: 100, note: 'IOH sum C0–C5, D0–D4, ADC7, RESET' },
      { pins: ['D5', 'D6', 'D7', 'D8', 'D9', 'D10', 'D11', 'D12', 'D13'], sourceMaxMa: 100, note: 'IOH sum B0–B5, D5–D7, ADC6, XTAL1/2' },
    ],
    notes: [
      '40 mA is the absolute maximum; 20 mA is the VOH/VOL test condition — pins are not ensured to source/sink more',
      'source-group limit is 150 mA in DS40002061B and 100 mA in Atmel-42735B; 100 mA is used',
    ],
  },
  timer1: { conflictsWithPins: ['D9', 'D10'] },
  sources: [
    'https://ww1.microchip.com/downloads/aemDocuments/documents/MCU08/ProductDocuments/DataSheets/ATmega48A-PA-88A-PA-168A-PA-328-P-DS-DS40002061B.pdf',
    'https://cdn.sparkfun.com/assets/c/a/8/e/4/Atmel-42735-8-bit-AVR-Microcontroller-ATmega328-328P_Datasheet.pdf',
    'https://github.com/arduino/ArduinoCore-avr/blob/master/cores/arduino/wiring.c',
    'https://github.com/arduino/ArduinoCore-avr/blob/master/cores/arduino/wiring_analog.c',
    'https://github.com/arduino/ArduinoCore-avr/blob/master/variants/standard/pins_arduino.h',
  ],
};

// ─────────────────────────── ATtiny85 (ATTinyCore, 8 MHz internal) ───────────────────────────
//
// Sources:
//  [DS]   Atmel-2586 ATtiny25/45/85 datasheet §21.1 Absolute Maximum Ratings
//         (40 mA per pin, 200 mA VCC/GND), Table 21-1 DC characteristics
//         (ΣIOL and ΣIOH ≤ 60 mA; VOL 0.6 V / VOH 4.3 V at 10 mA, 5 V; RPU 20–50 kΩ).
//         https://ww1.microchip.com/downloads/en/DeviceDoc/Atmel-2586-AVR-8-bit-Microcontroller-ATtiny25-ATtiny45-ATtiny85_Datasheet.pdf
//  [CORE] SpenceKonde/ATTinyCore 1.5.2: avr/boards.txt (8 MHz internal default),
//         avr/variants/tinyX5/pins_arduino.h (PWM on PB0=OC0A, PB1=OC1A, PB4=OC1B;
//         digitalPinToInterrupt: only PB2 ⇒ INT0; A0=PB5 A1=PB2 A2=PB4 A3=PB3),
//         avr/cores/tiny/wiring.c (Timer0 fast PWM /64, Timer1 CK/64 with OCR1C=0xFF:
//         8 MHz/64/256 ≈ 488 Hz on all three PWM pins), wiring_analog.c (≤0 ⇒ LOW, ≥255 ⇒ HIGH).
//         https://github.com/SpenceKonde/ATTinyCore/tree/1.5.2

const TINY_PWM: Omit<PinPwmSpec, 'timer'> = { freqHz: 8e6 / 64 / 256, formula: 'avr-fast' }; // 488.28125 Hz

const tinyPinList: PinSpec[] = [
  { name: 'PB0', number: 0, port: 'PB0', input: true, output: true, pullup: true, pwm: { timer: 'TIMER0A', ...TINY_PWM }, notes: ['AREF when analogReference(EXTERNAL)', 'MOSI/SDA'] },
  { name: 'PB1', number: 1, port: 'PB1', input: true, output: true, pullup: true, pwm: { timer: 'TIMER1A', ...TINY_PWM }, notes: ['LED_BUILTIN in ATTinyCore', 'MISO'] },
  { name: 'PB2', number: 2, port: 'PB2', input: true, output: true, pullup: true, adc: 1, interrupt: 0, notes: ['INT0', 'SCK/SCL'] },
  { name: 'PB3', number: 3, port: 'PB3', input: true, output: true, pullup: true, adc: 3, notes: ['XTAL1 when an external crystal is used'] },
  { name: 'PB4', number: 4, port: 'PB4', input: true, output: true, pullup: true, adc: 2, pwm: { timer: 'TIMER1B', ...TINY_PWM }, notes: ['XTAL2 when an external crystal is used'] },
  { name: 'PB5', number: 5, port: 'PB5', input: true, output: false, pullup: true, adc: 0, notes: ['RESET — usable as an output only with the RSTDISBL fuse (which disables ISP); modelled as input/ADC only'] },
];

// ATTinyCore encodes analog channels as 0x80 | channel; both forms are accepted.
const TINY_ADC_PINS = ['PB5', 'PB2', 'PB4', 'PB3'];

export const ATTINY85: McuProfile = {
  id: 'attiny85',
  part: 'ATtiny85',
  board: 'ATtiny85 (bare, 8 MHz internal oscillator)',
  core: 'ATTinyCore 1.5.2',
  cpuHz: 8e6,
  vcc: 5,
  logic: {
    vilMax: 0.3,
    vihMin: 0.6,
    vohMin: 4.3,
    volMax: 0.6,
    outputTestCurrentMa: 10,
    pullupOhms: [20e3, 50e3],
  },
  pins: tinyPinList,
  digitalNumbers: {
    ...numbersOf(tinyPinList),
    ...Object.fromEntries(TINY_ADC_PINS.map((p, ch) => [String(0x80 | ch), p])),
  },
  analogNumbers: Object.fromEntries(
    TINY_ADC_PINS.flatMap((p, ch) => [
      [String(ch), p],
      [String(0x80 | ch), p],
    ]),
  ),
  constants: { LED_BUILTIN: 1, A0: 0x80, A1: 0x81, A2: 0x82, A3: 0x83 },
  adc: {
    bits: 10,
    defaultReadBits: 10,
    adjustableResolution: false,
    references: {
      DEFAULT: 'vcc',
      INTERNAL: 1.1,
      INTERNAL1V1: 1.1,
      INTERNAL2V56: 2.56,
      EXTERNAL: { pin: 'PB0' },
    },
    defaultReference: 'DEFAULT',
    transfer: 'floor',
    conversionTimeUs: 13 * (64 / 8), // 13 ADC clocks at 8 MHz / 64 = 125 kHz
    notes: ['analogRead(n) with n = 0..3 reads ADC channel n (ATTinyCore), not digital pin n'],
  },
  pwmRange: 255,
  inputWriteControlsPullup: true,
  microsResolutionUs: 8, // Timer0 /64 at 8 MHz
  idleLoopUs: 10,
  limits: {
    pinAbsMaxMa: 40,
    pinRecommendedMa: 10,
    vccGndMaxMa: 200,
    totalSinkMaxMa: 60,
    totalSourceMaxMa: 60,
    notes: ['10 mA at 5 V is the VOH/VOL test condition; ΣIOL and ΣIOH over all pins are each limited to 60 mA'],
  },
  sources: [
    'https://ww1.microchip.com/downloads/en/DeviceDoc/Atmel-2586-AVR-8-bit-Microcontroller-ATtiny25-ATtiny45-ATtiny85_Datasheet.pdf',
    'https://github.com/SpenceKonde/ATTinyCore/blob/1.5.2/avr/variants/tinyX5/pins_arduino.h',
    'https://github.com/SpenceKonde/ATTinyCore/blob/1.5.2/avr/cores/tiny/wiring.c',
  ],
  notes: ['Timer1 PWM duty is modelled with the fast-PWM formula (v+1)/256 (OCR1C = 255)'],
};

// ─────────────────────────── ESP32 (generic WROOM-32 DevKit, arduino-esp32 3.x) ───────────────────────────
//
// Sources:
//  [DS]   ESP32 Series datasheet v5.3, Table 5-1 (cumulative IO output current
//         1200 mA; the WROOM-32 module datasheet v3.8 Table 12 says 1100 mA),
//         Table 5-3 DC characteristics (IOH ≈ 40 mA typ. VDD3P3_CPU/RTC at max
//         drive, IOL ≈ 28 mA typ., RPU/RPD ≈ 45 kΩ, VIH 0.75·VDD, VIL 0.25·VDD),
//         GPIO34–39 input only without pull-ups; GPIO6–11 wired to the module flash.
//         https://www.espressif.com/sites/default/files/documentation/esp32_datasheet_en.pdf
//  [CORE] espressif/arduino-esp32 3.3.x: cores/esp32/esp32-hal-ledc.c
//         (analogWrite: 1000 Hz, 8-bit; duty = v/256 with v ≥ 255 ⇒ full on),
//         cores/esp32/esp32-hal-adc.c (12-bit default, ADC_11db default attenuation),
//         docs/en/api/adc.rst (measurable range ≈150–3100 mV at 11 dB).
//         https://github.com/espressif/arduino-esp32/tree/3.3.13

const ESP32_GPIOS = [0, 1, 2, 3, 4, 5, 12, 13, 14, 15, 16, 17, 18, 19, 21, 22, 23, 25, 26, 27, 32, 33, 34, 35, 36, 39];
const ESP32_ADC: Record<number, [unit: 1 | 2, ch: number]> = {
  36: [1, 0], 39: [1, 3], 32: [1, 4], 33: [1, 5], 34: [1, 6], 35: [1, 7],
  4: [2, 0], 0: [2, 1], 2: [2, 2], 15: [2, 3], 13: [2, 4], 12: [2, 5], 14: [2, 6], 27: [2, 7], 25: [2, 8], 26: [2, 9],
};
const ESP32_NOTES: Record<number, string[]> = {
  0: ['strapping pin (boot mode) — keep high at reset'],
  1: ['TX0 of Serial'],
  2: ['strapping pin; on-board LED on many DevKits'],
  3: ['RX0 of Serial'],
  5: ['strapping pin'],
  12: ['strapping pin (flash voltage) — must be low at reset'],
  15: ['strapping pin'],
};

const esp32PinList: PinSpec[] = ESP32_GPIOS.map(n => {
  const inputOnly = n >= 34;
  const adc = ESP32_ADC[n];
  const notes = [...(ESP32_NOTES[n] ?? [])];
  if (inputOnly) notes.push('input only, no internal pull-up/pull-down');
  if (adc) notes.push(`ADC${adc[0]}_CH${adc[1]}${adc[0] === 2 ? ' (unavailable while Wi-Fi is on)' : ''}`);
  return {
    name: `GPIO${n}`,
    number: n,
    input: true,
    output: !inputOnly,
    pullup: !inputOnly,
    pulldown: !inputOnly,
    ...(adc ? { adc: adc[1] } : {}),
    ...(!inputOnly ? { pwm: { timer: 'LEDC', freqHz: 1000, formula: 'esp32-ledc' as const } } : {}),
    interrupt: n,
    ...(notes.length ? { notes } : {}),
  };
});

export const ESP32_GENERIC: McuProfile = {
  id: 'esp32',
  part: 'ESP32 (ESP32-D0WD, WROOM-32 module)',
  board: 'ESP32 DevKit (generic, 3.3 V)',
  core: 'arduino-esp32 3.3',
  cpuHz: 240e6,
  vcc: 3.3,
  logic: {
    vilMax: 0.25,
    vihMin: 0.75,
    vohMin: 0.8 * 3.3,
    volMax: 0.1 * 3.3,
    pullupOhms: [45e3, 45e3],
    pulldownOhms: [45e3, 45e3],
  },
  pins: esp32PinList,
  digitalNumbers: numbersOf(esp32PinList),
  analogNumbers: Object.fromEntries(Object.keys(ESP32_ADC).map(n => [n, `GPIO${n}`])),
  constants: {
    LED_BUILTIN: 2,
    A0: 36, A3: 39, A4: 32, A5: 33, A6: 34, A7: 35,
    A10: 4, A11: 0, A12: 2, A13: 15, A14: 13, A15: 12, A16: 14, A17: 27, A18: 25, A19: 26,
  },
  adc: {
    bits: 12,
    defaultReadBits: 12,
    adjustableResolution: true,
    references: { DEFAULT: 'vcc' },
    defaultReference: 'DEFAULT',
    transfer: 'floor',
    notes: [
      'modelled as an ideal linear converter over 0..VDD (3.3 V); the real ESP32 ADC at 11 dB is nonlinear and only measures ≈0.15–3.1 V',
    ],
  },
  pwmRange: 255,
  inputWriteControlsPullup: false,
  microsResolutionUs: 1,
  idleLoopUs: 10,
  limits: {
    pinAbsMaxMa: 40,
    pinRecommendedMa: 20,
    totalSourceMaxMa: 1200,
    notes: [
      'Espressif gives no per-pin absolute maximum current: 40 mA is the typical IOH at maximum drive strength (VDD3P3_CPU/RTC), IOL is 28 mA typical',
      'pinRecommendedMa = 20 mA: default drive strength (GPIO_DRIVE_CAP_2); GPIOs on VDD_SDIO source ≈20 mA max',
      'cumulative IO output current: 1200 mA (ESP32 chip datasheet v5.3) / 1100 mA (WROOM-32 datasheet v3.8)',
    ],
  },
  sources: [
    'https://www.espressif.com/sites/default/files/documentation/esp32_datasheet_en.pdf',
    'https://www.espressif.com/sites/default/files/documentation/esp32-wroom-32e_esp32-wroom-32ue_datasheet_en.pdf',
    'https://github.com/espressif/arduino-esp32/blob/3.3.13/cores/esp32/esp32-hal-ledc.c',
    'https://github.com/espressif/arduino-esp32/blob/3.3.13/cores/esp32/esp32-hal-adc.c',
    'https://github.com/espressif/arduino-esp32/blob/3.3.13/docs/en/api/adc.rst',
  ],
  notes: ['GPIO6–11 (module flash) and GPIO20/24/28–31/37/38 are not exposed'],
};

// ─────────────────────────── RP2040 (generic Pico, arduino-pico) ───────────────────────────
//
// Sources:
//  [DS]   RP2040 datasheet §2.19.6.3 pad control (drive 2/4/8/12 mA, reset 4 mA),
//         §5.5.3 IO electrical characteristics (IIOVDD_MAX = IIOVSS_MAX = 50 mA total,
//         VIH 2.0 V / VIL 0.8 V at IOVDD 3.3 V, RPU/RPD 50–80 kΩ), §4.9 ADC
//         (12-bit, ADC0–3 on GP26–29). No per-pin absolute-maximum current is given.
//         https://datasheets.raspberrypi.com/rp2040/rp2040-datasheet.pdf
//  [PICO] Pico datasheet (ADC_VREF filtered from 3V3; GP23/24/25/29 used on-board).
//         https://datasheets.raspberrypi.com/pico/pico-datasheet.pdf
//  [CORE] earlephilhower/arduino-pico 6.4.0: cores/rp2040/wiring_analog.cpp
//         (analogRead default 10 bits, analogWrite 1000 Hz with range 255, duty = v/255),
//         Arduino.h (digitalPinToInterrupt(p) = p — every GPIO).
//         https://github.com/earlephilhower/arduino-pico/tree/6.4.0

const PICO_NOTES: Record<number, string[]> = {
  23: ['Pico: SMPS power-save control (not on the header)'],
  24: ['Pico: VBUS sense (not on the header)'],
  25: ['Pico: on-board LED (LED_BUILTIN)'],
  29: ['Pico: VSYS/3 divider on ADC3 (not on the header)'],
};

const rp2040PinList: PinSpec[] = Array.from({ length: 30 }, (_, n) => ({
  name: `GP${n}`,
  number: n,
  input: true,
  output: true,
  pullup: true,
  pulldown: true,
  ...(n >= 26 ? { adc: n - 26 } : {}),
  pwm: { timer: `PWM${(n >> 1) & 7}${n & 1 ? 'B' : 'A'}`, freqHz: 1000, formula: 'ratio' as const },
  interrupt: n,
  ...(PICO_NOTES[n] ? { notes: PICO_NOTES[n] } : {}),
}));

export const RP2040_GENERIC: McuProfile = {
  id: 'rp2040',
  part: 'RP2040',
  board: 'Raspberry Pi Pico (generic, 3.3 V)',
  core: 'arduino-pico 6.4',
  cpuHz: 133e6,
  vcc: 3.3,
  logic: {
    vilMax: 0.8,
    vihMin: 2.0,
    absolute: true,
    pullupOhms: [50e3, 80e3],
    pulldownOhms: [50e3, 80e3],
  },
  pins: rp2040PinList,
  digitalNumbers: numbersOf(rp2040PinList),
  analogNumbers: { 26: 'GP26', 27: 'GP27', 28: 'GP28', 29: 'GP29' },
  constants: { LED_BUILTIN: 25, A0: 26, A1: 27, A2: 28, A3: 29 },
  adc: {
    bits: 12,
    defaultReadBits: 10,
    adjustableResolution: true,
    references: { DEFAULT: 'vcc' },
    defaultReference: 'DEFAULT',
    transfer: 'floor',
    notes: ['Vref = ADC_VREF (3.3 V on the Pico); analogRead defaults to 10 bits in arduino-pico (native 12)'],
  },
  pwmRange: 255,
  inputWriteControlsPullup: false,
  microsResolutionUs: 1,
  idleLoopUs: 10,
  limits: {
    pinAbsMaxMa: 12,
    pinRecommendedMa: 4,
    totalSourceMaxMa: 50,
    totalSinkMaxMa: 50,
    notes: [
      'the RP2040 datasheet gives no per-pin absolute maximum current; 12 mA is the strongest drive setting and 4 mA the default (pinMode OUTPUT = OUTPUT_4MA)',
      'IIOVDD_MAX / IIOVSS_MAX = 50 mA total over all GPIO and QSPI pins',
    ],
  },
  sources: [
    'https://datasheets.raspberrypi.com/rp2040/rp2040-datasheet.pdf',
    'https://datasheets.raspberrypi.com/pico/pico-datasheet.pdf',
    'https://github.com/earlephilhower/arduino-pico/blob/6.4.0/cores/rp2040/wiring_analog.cpp',
  ],
};

export const MCU_PROFILES: Record<string, McuProfile> = {
  [ATMEGA328P_UNO.id]: ATMEGA328P_UNO,
  [ATTINY85.id]: ATTINY85,
  [ESP32_GENERIC.id]: ESP32_GENERIC,
  [RP2040_GENERIC.id]: RP2040_GENERIC,
};

/** Profile by id ('atmega328p' | 'attiny85' | 'esp32' | 'rp2040'), or aliases 'uno', 'pico'. */
export function getMcuProfile(id: string): McuProfile {
  const key = id.toLowerCase();
  const alias: Record<string, string> = { uno: 'atmega328p', 'arduino-uno': 'atmega328p', pico: 'rp2040', 'esp32-generic': 'esp32', 'rp2040-generic': 'rp2040' };
  const profile = MCU_PROFILES[alias[key] ?? key];
  if (!profile) {
    throw new Error(`unknown MCU profile '${id}'. Known: ${Object.keys(MCU_PROFILES).join(', ')}`);
  }
  return profile;
}

/** Canonical pin spec by name ('D13', 'GPIO2'), or undefined. */
export function findPin(profile: McuProfile, name: string): PinSpec | undefined {
  return profile.pins.find(p => p.name === name);
}
