/**
 * Microcontroller profiles: ATmega328P, ATtiny85, ESP32-WROOM-32, RP2040.
 * Values verified against the cited documents (accessed 2026-11-23).
 * See ../types.ts for conventions (SI units, estimated values carry a note).
 */
import type { McuProfile } from '../types';

const ACCESSED = '2026-11-23';

// ---------------------------------------------------------------------------
// ATmega328P (Arduino Uno R3)

/** 16 MHz / (64 · 510): Timer1/Timer2 8-bit phase-correct PWM, core prescaler 64. */
const UNO_PWM_PHASE_CORRECT_HZ = 16e6 / (64 * 510); // 490.196…
/** 16 MHz / (64 · 256): Timer0 fast PWM, core prescaler 64. */
const UNO_PWM_FAST_HZ = 16e6 / (64 * 256); // 976.5625

const unoPwmPhaseCorrect = {
  typ: UNO_PWM_PHASE_CORRECT_HZ,
  unit: 'Hz' as const,
  conditions: { fclk: 16e6 },
  estimated: true,
  note:
    'Arduino analogWrite() reference prints "490 Hz" (rounded). Exact value computed: ' +
    'f = fclk/(N·510) (datasheet phase-correct PWM formula) with fclk = 16 MHz and N = 64 ' +
    '(wiring.c init(): Timer1/Timer2 prescaler 64, 8-bit phase-correct) = 490.196 Hz.',
  source: 'arduino-aw',
};

const unoPwmFast = {
  typ: UNO_PWM_FAST_HZ,
  unit: 'Hz' as const,
  conditions: { fclk: 16e6 },
  estimated: true,
  note:
    'Arduino analogWrite() reference prints "980 Hz" (rounded) for pins 5 and 6. Exact value computed: ' +
    'f = fclk/(N·256) (datasheet fast PWM formula) with fclk = 16 MHz and N = 64 ' +
    '(wiring.c init(): Timer0 fast PWM, prescaler 64) = 976.5625 Hz.',
  source: 'arduino-aw',
};

const ATMEGA328P: McuProfile = {
  id: 'ATmega328P',
  aliases: ['ATMEGA328P', 'ATmega328P-PU', 'megaAVR 328P'],
  category: 'mcu',
  manufacturer: 'Microchip Technology',
  description: '8-bit AVR microcontroller, 32 KB flash, 2 KB SRAM, 1 KB EEPROM, 10-bit ADC (Arduino Uno R3 MCU)',
  package: { name: 'DIP-28', pinCount: 28 },
  pins: [
    { number: 1, name: 'PC6', function: 'RESET / PCINT14' },
    { number: 2, name: 'PD0', function: 'RXD / PCINT16' },
    { number: 3, name: 'PD1', function: 'TXD / PCINT17' },
    { number: 4, name: 'PD2', function: 'INT0 / PCINT18' },
    { number: 5, name: 'PD3', function: 'INT1 / OC2B / PCINT19' },
    { number: 6, name: 'PD4', function: 'XCK / T0 / PCINT20' },
    { number: 7, name: 'VCC', function: 'Digital supply' },
    { number: 8, name: 'GND', function: 'Ground' },
    { number: 9, name: 'PB6', function: 'XTAL1 / TOSC1 / PCINT6' },
    { number: 10, name: 'PB7', function: 'XTAL2 / TOSC2 / PCINT7' },
    { number: 11, name: 'PD5', function: 'OC0B / T1 / PCINT21' },
    { number: 12, name: 'PD6', function: 'OC0A / AIN0 / PCINT22' },
    { number: 13, name: 'PD7', function: 'AIN1 / PCINT23' },
    { number: 14, name: 'PB0', function: 'ICP1 / CLKO / PCINT0' },
    { number: 15, name: 'PB1', function: 'OC1A / PCINT1' },
    { number: 16, name: 'PB2', function: 'SS / OC1B / PCINT2' },
    { number: 17, name: 'PB3', function: 'MOSI / OC2A / PCINT3' },
    { number: 18, name: 'PB4', function: 'MISO / PCINT4' },
    { number: 19, name: 'PB5', function: 'SCK / PCINT5' },
    { number: 20, name: 'AVCC', function: 'ADC / port C supply' },
    { number: 21, name: 'AREF', function: 'ADC analog reference' },
    { number: 22, name: 'GND', function: 'Ground' },
    { number: 23, name: 'PC0', function: 'ADC0 / PCINT8' },
    { number: 24, name: 'PC1', function: 'ADC1 / PCINT9' },
    { number: 25, name: 'PC2', function: 'ADC2 / PCINT10' },
    { number: 26, name: 'PC3', function: 'ADC3 / PCINT11' },
    { number: 27, name: 'PC4', function: 'ADC4 / SDA / PCINT12' },
    { number: 28, name: 'PC5', function: 'ADC5 / SCL / PCINT13' },
  ],
  sources: [
    {
      id: 'ds',
      kind: 'datasheet',
      publisher: 'Microchip Technology',
      title: 'ATmega48A/PA/88A/PA/168A/PA/328/P megaAVR Data Sheet',
      document: 'DS40002061B',
      revision: 'Rev. B, 09/2020',
      url: 'https://ww1.microchip.com/downloads/aemDocuments/documents/MCU08/ProductDocuments/DataSheets/ATmega48A-PA-88A-PA-168A-PA-328-P-DS-DS40002061B.pdf',
      accessed: ACCESSED,
      note:
        'Pinout Fig. 1-1 (28 SPDIP); abs max §29.1; logic levels/pull-up/VOL/VOH from Table 30-1 ' +
        '(Common DC characteristics, TA = -40..105 °C; this revision has no common DC table in the 85 °C chapter 29); ' +
        'ADC Table 29-15; speed grades §29.3 / Features.',
    },
    {
      id: 'arduino-aw',
      kind: 'other',
      publisher: 'Arduino',
      title: 'analogWrite() — Arduino Language Reference',
      url: 'https://docs.arduino.cc/language-reference/en/functions/analog-io/analogWrite/',
      accessed: ACCESSED,
      note:
        'Page is JS-rendered; content verified from its source file ' +
        'github.com/arduino/reference-en Language/Functions/Analog IO/analogWrite.adoc: ' +
        '"UNO (R3 and earlier), Nano, Mini | 3, 5, 6, 9, 10, 11 | 490 Hz (pins 5 and 6: 980 Hz)"; value 0..255.',
    },
    {
      id: 'core-wiring',
      kind: 'library',
      publisher: 'Arduino',
      title: 'ArduinoCore-avr cores/arduino/wiring.c (init(): timer prescaler and PWM modes)',
      url: 'https://github.com/arduino/ArduinoCore-avr/blob/master/cores/arduino/wiring.c',
      accessed: ACCESSED,
    },
    {
      id: 'core-pins',
      kind: 'library',
      publisher: 'Arduino',
      title: 'ArduinoCore-avr variants/standard/pins_arduino.h (Uno pin → port/timer mapping)',
      url: 'https://github.com/arduino/ArduinoCore-avr/blob/master/variants/standard/pins_arduino.h',
      accessed: ACCESSED,
    },
    {
      id: 'uno',
      kind: 'datasheet',
      publisher: 'Arduino',
      title: 'Arduino UNO R3 User Manual',
      document: 'SKU A000066',
      revision: 'Revision 5, 12/11/2026 (Modified 19/11/2026)',
      url: 'https://docs.arduino.cc/resources/datasheets/A000066-datasheet.pdf',
      accessed: ACCESSED,
    },
  ],
  notes: [
    '23 programmable I/O lines; ADC6/ADC7 exist only on TQFP/VQFN packages (not DIP-28).',
    'Voltage on RESET pin abs max -0.5..+13.0 V (other pins -0.5..VCC+0.5 V).',
    'Pins are not ensured to source/sink more than the VOL/VOH test condition (20 mA at 5 V, 10 mA at 3 V).',
  ],
  core: 'AVR 8-bit RISC',
  supply: { min: 1.8, max: 5.5, unit: 'V' },
  nominalVcc: 5,
  clock: {
    max: { max: 20e6, unit: 'Hz', conditions: { VCC: '4.5..5.5 V' } },
    default: {
      typ: 16e6,
      unit: 'Hz',
      conditions: { board: 'Arduino UNO R3' },
      note: 'UNO R3 user manual: "AVR CPU at up to 16 MHz".',
      source: 'uno',
    },
    internalOscillator: {
      typ: 8e6,
      unit: 'Hz',
      conditions: { VCC: 3, TA: 25 },
      note: 'Calibrated internal RC, factory calibration at 3 V / 25 °C (Table 29-9).',
    },
  },
  logic: {
    VIL: { max: 0.3, unit: 'xVCC', conditions: { VCC: '2.4..5.5 V' } },
    VIH: { min: 0.6, unit: 'xVCC', conditions: { VCC: '2.4..5.5 V' } },
    VOL: [
      { max: 0.9, unit: 'V', conditions: { IOL: 0.02, VCC: 5, TA: 85 } },
      { max: 0.6, unit: 'V', conditions: { IOL: 0.01, VCC: 3, TA: 85 } },
    ],
    VOH: [
      { min: 4.2, unit: 'V', conditions: { IOH: -0.02, VCC: 5, TA: 85 } },
      { min: 2.3, unit: 'V', conditions: { IOH: -0.01, VCC: 3, TA: 85 } },
    ],
    fiveVoltTolerant: false,
  },
  currents: {
    perPinAbsMax: { max: 0.04, unit: 'A' },
    perPinRecommended: {
      max: 0.02,
      unit: 'A',
      conditions: { VCC: 5 },
      note: 'VOL/VOH test condition (20 mA at VCC = 5 V, 10 mA at 3 V), not a rating.',
    },
    totalAbsMax: [{ max: 0.2, unit: 'A', conditions: { pins: 'VCC and GND pins (DC current)' } }],
    groupLimits: [
      { max: 0.15, unit: 'A', conditions: { sum: 'IOH', pins: 'C0-C5, D0-D4, ADC7, RESET' } },
      { max: 0.15, unit: 'A', conditions: { sum: 'IOH', pins: 'B0-B5, D5-D7, ADC6, XTAL1, XTAL2' } },
      { max: 0.1, unit: 'A', conditions: { sum: 'IOL', pins: 'C0-C5, ADC7, ADC6' } },
      { max: 0.1, unit: 'A', conditions: { sum: 'IOL', pins: 'B0-B5, D5-D7, XTAL1, XTAL2' } },
      { max: 0.1, unit: 'A', conditions: { sum: 'IOL', pins: 'D0-D4, RESET' } },
    ],
  },
  pullUp: { min: 20e3, max: 50e3, unit: 'Ω' },
  adc: {
    resolution: { typ: 10, unit: 'bit' },
    channels: 6,
    references: [
      { name: 'AVCC', note: 'AVCC with external capacitor at AREF; AVCC must be within VCC ± 0.3 V.' },
      { name: 'Internal 1.1V', voltage: { min: 1.0, typ: 1.1, max: 1.2, unit: 'V' } },
      { name: 'AREF', voltage: { min: 1.0, unit: 'V' }, note: 'External reference; VREF max = AVCC.' },
    ],
    inputRange: {
      min: 0,
      max: 5,
      unit: 'V',
      estimated: true,
      note: 'Datasheet: VIN = GND..VREF. Evaluated with VREF = AVCC = nominal 5 V.',
    },
    sampleRate: {
      max: 15e3,
      unit: 'Hz',
      conditions: { resolution: '10-bit' },
      note: 'Up to 76.9 kSPS at reduced resolution; 13..260 µs conversion time; ADC clock 50..1000 kHz.',
    },
  },
  pwm: {
    resolution: {
      typ: 8,
      unit: 'bit',
      estimated: true,
      note: 'analogWrite() value range 0..255 (printed) = 8 bit.',
      source: 'arduino-aw',
    },
    defaultFrequency: {
      typ: 490,
      unit: 'Hz',
      conditions: { board: 'Arduino UNO R3' },
      source: 'arduino-aw',
    },
    note: 'Arduino core: pins 5/6 (Timer0, fast PWM) ≈ 980 Hz; pins 3/9/10/11 (Timer1/2, phase-correct) ≈ 490 Hz.',
  },
  ratings: {
    vccMax: { max: 6.0, unit: 'V', note: 'Maximum operating voltage (absolute maximum ratings).' },
    pinVoltageMax: {
      max: 5.5,
      unit: 'V',
      estimated: true,
      note: 'Datasheet: VCC + 0.5 V (all pins except RESET); evaluated at VCC = 5 V.',
    },
  },
  boardMapping: {
    board: 'Arduino Uno R3',
    pins: [
      { name: 'D0', port: 'PD0', physicalPin: 2, notes: 'RX' },
      { name: 'D1', port: 'PD1', physicalPin: 3, notes: 'TX' },
      { name: 'D2', port: 'PD2', physicalPin: 4 },
      { name: 'D3', port: 'PD3', physicalPin: 5, pwm: { timer: 'Timer2', channel: 'OC2B', frequency: unoPwmPhaseCorrect } },
      { name: 'D4', port: 'PD4', physicalPin: 6 },
      { name: 'D5', port: 'PD5', physicalPin: 11, pwm: { timer: 'Timer0', channel: 'OC0B', frequency: unoPwmFast } },
      { name: 'D6', port: 'PD6', physicalPin: 12, pwm: { timer: 'Timer0', channel: 'OC0A', frequency: unoPwmFast } },
      { name: 'D7', port: 'PD7', physicalPin: 13 },
      { name: 'D8', port: 'PB0', physicalPin: 14 },
      { name: 'D9', port: 'PB1', physicalPin: 15, pwm: { timer: 'Timer1', channel: 'OC1A', frequency: unoPwmPhaseCorrect } },
      { name: 'D10', port: 'PB2', physicalPin: 16, pwm: { timer: 'Timer1', channel: 'OC1B', frequency: unoPwmPhaseCorrect } },
      { name: 'D11', port: 'PB3', physicalPin: 17, pwm: { timer: 'Timer2', channel: 'OC2A', frequency: unoPwmPhaseCorrect } },
      { name: 'D12', port: 'PB4', physicalPin: 18 },
      { name: 'D13', port: 'PB5', physicalPin: 19, notes: 'On-board LED (LED_BUILTIN)' },
      { name: 'A0', port: 'PC0', physicalPin: 23, adcChannel: 0 },
      { name: 'A1', port: 'PC1', physicalPin: 24, adcChannel: 1 },
      { name: 'A2', port: 'PC2', physicalPin: 25, adcChannel: 2 },
      { name: 'A3', port: 'PC3', physicalPin: 26, adcChannel: 3 },
      { name: 'A4', port: 'PC4', physicalPin: 27, adcChannel: 4, notes: 'SDA' },
      { name: 'A5', port: 'PC5', physicalPin: 28, adcChannel: 5, notes: 'SCL' },
    ],
  },
};

// ---------------------------------------------------------------------------
// ATtiny85

const ATTINY85: McuProfile = {
  id: 'ATtiny85',
  aliases: ['ATTINY85', 'ATtiny85-20PU', 'ATtiny85V'],
  category: 'mcu',
  manufacturer: 'Microchip Technology (Atmel)',
  description: '8-bit AVR microcontroller, 8 KB flash, 512 B SRAM/EEPROM, 6 I/O, 10-bit ADC',
  package: { name: 'DIP-8', pinCount: 8 },
  pins: [
    { number: 1, name: 'PB5', function: 'RESET / ADC0 / dW / PCINT5' },
    { number: 2, name: 'PB3', function: 'XTAL1 / CLKI / OC1B (inverted) / ADC3 / PCINT3' },
    { number: 3, name: 'PB4', function: 'XTAL2 / CLKO / OC1B / ADC2 / PCINT4' },
    { number: 4, name: 'GND', function: 'Ground' },
    { number: 5, name: 'PB0', function: 'MOSI / DI / SDA / AIN0 / OC0A / OC1A (inverted) / AREF / PCINT0' },
    { number: 6, name: 'PB1', function: 'MISO / DO / AIN1 / OC0B / OC1A / PCINT1' },
    { number: 7, name: 'PB2', function: 'SCK / USCK / SCL / ADC1 / T0 / INT0 / PCINT2' },
    { number: 8, name: 'VCC', function: 'Supply' },
  ],
  sources: [
    {
      id: 'ds',
      kind: 'datasheet',
      publisher: 'Microchip Technology (Atmel)',
      title: 'ATtiny25/V / ATtiny45/V / ATtiny85/V Datasheet',
      document: '2586Q–AVR–08/2013',
      revision: 'Rev. 2586Q, 08/2013',
      url: 'https://ww1.microchip.com/downloads/en/devicedoc/atmel-2586-avr-8-bit-microcontroller-attiny25-attiny45-attiny85_datasheet.pdf',
      accessed: ACCESSED,
      note: 'Pinout Fig. 1-1; abs max §21.1; DC Table 21-1; ADC Table 21-8; speed grades in Features.',
    },
    {
      id: 'attinycore',
      kind: 'library',
      publisher: 'Spence Konde (ATTinyCore)',
      title: 'ATTinyCore 2.0.0-dev — ATtiny 25/45/85 part documentation (ATtiny_x5.md, "PWM frequency")',
      url: 'https://github.com/SpenceKonde/ATTinyCore/blob/v2.0.0-devThis-is-the-head-submit-PRs-against-this/avr/extras/ATtiny_x5.md',
      accessed: ACCESSED,
    },
  ],
  notes: [
    'Supply 2.7..5.5 V for ATtiny85 (1.8..5.5 V for ATtiny85V; max 4 MHz @ 1.8 V, 10 MHz @ 2.7 V).',
    'Voltage on RESET pin abs max -0.5..+13.0 V; RESET pin has weak drive when used as I/O.',
    'On-chip PLL (nominal 64 MHz) can clock Timer1 or provide a 16 MHz system clock.',
    'Arduino PWM frequency depends on the core and F_CPU; ATTinyCore 2.0.0: 488 Hz at 1 or 8 MHz, 977 Hz at 16 MHz (TC0 and TC1).',
  ],
  core: 'AVR 8-bit RISC',
  supply: { min: 2.7, max: 5.5, unit: 'V' },
  nominalVcc: 5,
  clock: {
    max: { max: 20e6, unit: 'Hz', conditions: { VCC: '4.5..5.5 V' } },
    default: {
      typ: 1e6,
      unit: 'Hz',
      estimated: true,
      note: 'Shipped with internal 8.0 MHz RC and CKDIV8 fuse programmed: 8 MHz / 8 = 1 MHz.',
    },
    internalOscillator: {
      typ: 8e6,
      unit: 'Hz',
      conditions: { VCC: 3, TA: 25 },
      note: 'Calibrated internal RC, factory calibration at 3 V / 25 °C (Table 21-2).',
    },
  },
  logic: {
    VIL: { max: 0.3, unit: 'xVCC', conditions: { VCC: '2.4..5.5 V' } },
    VIH: { min: 0.6, unit: 'xVCC', conditions: { VCC: '2.4..5.5 V' } },
    VOL: [
      { max: 0.6, unit: 'V', conditions: { IOL: 0.01, VCC: 5 } },
      { max: 0.5, unit: 'V', conditions: { IOL: 0.005, VCC: 3 } },
    ],
    VOH: [
      { min: 4.3, unit: 'V', conditions: { IOH: -0.01, VCC: 5 } },
      { min: 2.5, unit: 'V', conditions: { IOH: -0.005, VCC: 3 } },
    ],
    fiveVoltTolerant: false,
  },
  currents: {
    perPinAbsMax: { max: 0.04, unit: 'A' },
    perPinRecommended: {
      max: 0.01,
      unit: 'A',
      conditions: { VCC: 5 },
      note: 'VOL/VOH test condition (10 mA at VCC = 5 V, 5 mA at 3 V), not a rating.',
    },
    totalAbsMax: [{ max: 0.2, unit: 'A', conditions: { pins: 'VCC and GND pins (DC current)' } }],
    groupLimits: [
      { max: 0.06, unit: 'A', conditions: { sum: 'IOL', pins: 'all ports' } },
      { max: 0.06, unit: 'A', conditions: { sum: 'IOH', pins: 'all ports' } },
    ],
  },
  pullUp: { min: 20e3, max: 50e3, unit: 'Ω', conditions: { VCC: 5.5, input: 'low' } },
  adc: {
    resolution: { typ: 10, unit: 'bit' },
    channels: 4,
    references: [
      { name: 'VCC' },
      { name: 'Internal 1.1V', voltage: { min: 1.0, typ: 1.1, max: 1.2, unit: 'V' } },
      {
        name: 'Internal 2.56V',
        voltage: { min: 2.3, typ: 2.56, max: 2.8, unit: 'V', conditions: { VCC: '> 3.0 V' } },
        note: 'Values are guidelines only; optional bypass capacitor on AREF (PB0).',
      },
      { name: 'AREF', voltage: { min: 2.0, unit: 'V' }, note: 'External reference on PB0; max VCC (single-ended).' },
    ],
    inputRange: {
      min: 0,
      max: 5,
      unit: 'V',
      estimated: true,
      note: 'Datasheet: VIN = GND..VREF. Evaluated with VREF = VCC = nominal 5 V.',
    },
    sampleRate: {
      max: 15e3,
      unit: 'Hz',
      conditions: { resolution: '10-bit' },
      note: '14..280 µs conversion time; ADC clock 50..1000 kHz.',
    },
  },
  pwm: {
    defaultFrequency: {
      typ: 488,
      unit: 'Hz',
      conditions: { core: 'ATTinyCore 2.0.0', F_CPU: 8e6 },
      source: 'attinycore',
    },
    note:
      'Hardware: Timer0 OC0A (PB0) / OC0B (PB1); Timer1 OC1A (PB1) / OC1B (PB4) plus inverted outputs on PB0/PB3. ' +
      'Frequency is core-dependent; only the ATTinyCore 2.0.0 table is cited (16 MHz → 977 Hz).',
  },
  ratings: {
    vccMax: { max: 6.0, unit: 'V', note: 'Maximum operating voltage (absolute maximum ratings).' },
    pinVoltageMax: {
      max: 5.5,
      unit: 'V',
      estimated: true,
      note: 'Datasheet: VCC + 0.5 V (all pins except RESET); evaluated at VCC = 5 V.',
    },
  },
};

// ---------------------------------------------------------------------------
// ESP32-WROOM-32

const ESP32_WROOM_32: McuProfile = {
  id: 'ESP32-WROOM-32',
  aliases: ['ESP32', 'ESP-WROOM-32', 'ESP32-D0WDQ6'],
  category: 'mcu',
  manufacturer: 'Espressif Systems',
  description: 'Wi-Fi + Bluetooth module with ESP32-D0WDQ6 dual-core Xtensa LX6, 4 MB flash, 40 MHz crystal (NRND)',
  package: { name: 'Module-38', pinCount: 38 },
  pins: [
    { number: 1, name: 'GND', function: 'Ground' },
    { number: 2, name: '3V3', function: 'Power supply' },
    { number: 3, name: 'EN', function: 'Module enable, active high' },
    { number: 4, name: 'SENSOR_VP', function: 'GPIO36, ADC1_CH0, RTC_GPIO0 (input only)' },
    { number: 5, name: 'SENSOR_VN', function: 'GPIO39, ADC1_CH3, RTC_GPIO3 (input only)' },
    { number: 6, name: 'IO34', function: 'GPIO34, ADC1_CH6, RTC_GPIO4 (input only)' },
    { number: 7, name: 'IO35', function: 'GPIO35, ADC1_CH7, RTC_GPIO5 (input only)' },
    { number: 8, name: 'IO32', function: 'GPIO32, XTAL_32K_P, ADC1_CH4, TOUCH9, RTC_GPIO9' },
    { number: 9, name: 'IO33', function: 'GPIO33, XTAL_32K_N, ADC1_CH5, TOUCH8, RTC_GPIO8' },
    { number: 10, name: 'IO25', function: 'GPIO25, DAC_1, ADC2_CH8, RTC_GPIO6, EMAC_RXD0' },
    { number: 11, name: 'IO26', function: 'GPIO26, DAC_2, ADC2_CH9, RTC_GPIO7, EMAC_RXD1' },
    { number: 12, name: 'IO27', function: 'GPIO27, ADC2_CH7, TOUCH7, RTC_GPIO17, EMAC_RX_DV' },
    { number: 13, name: 'IO14', function: 'GPIO14, ADC2_CH6, TOUCH6, RTC_GPIO16, MTMS, HSPICLK' },
    { number: 14, name: 'IO12', function: 'GPIO12, ADC2_CH5, TOUCH5, RTC_GPIO15, MTDI, HSPIQ' },
    { number: 15, name: 'GND', function: 'Ground' },
    { number: 16, name: 'IO13', function: 'GPIO13, ADC2_CH4, TOUCH4, RTC_GPIO14, MTCK, HSPID' },
    { number: 17, name: 'SHD/SD2', function: 'GPIO9, SD_DATA2, SPIHD (internal flash)' },
    { number: 18, name: 'SWP/SD3', function: 'GPIO10, SD_DATA3, SPIWP (internal flash)' },
    { number: 19, name: 'SCS/CMD', function: 'GPIO11, SD_CMD, SPICS0 (internal flash)' },
    { number: 20, name: 'SCK/CLK', function: 'GPIO6, SD_CLK, SPICLK (internal flash)' },
    { number: 21, name: 'SDO/SD0', function: 'GPIO7, SD_DATA0, SPIQ (internal flash)' },
    { number: 22, name: 'SDI/SD1', function: 'GPIO8, SD_DATA1, SPID (internal flash)' },
    { number: 23, name: 'IO15', function: 'GPIO15, ADC2_CH3, TOUCH3, MTDO, HSPICS0, RTC_GPIO13' },
    { number: 24, name: 'IO2', function: 'GPIO2, ADC2_CH2, TOUCH2, RTC_GPIO12, HSPIWP (strapping)' },
    { number: 25, name: 'IO0', function: 'GPIO0, ADC2_CH1, TOUCH1, RTC_GPIO11, CLK_OUT1 (strapping)' },
    { number: 26, name: 'IO4', function: 'GPIO4, ADC2_CH0, TOUCH0, RTC_GPIO10, HSPIHD' },
    { number: 27, name: 'IO16', function: 'GPIO16, HS1_DATA4, U2RXD' },
    { number: 28, name: 'IO17', function: 'GPIO17, HS1_DATA5, U2TXD' },
    { number: 29, name: 'IO5', function: 'GPIO5, VSPICS0, HS1_DATA6' },
    { number: 30, name: 'IO18', function: 'GPIO18, VSPICLK, HS1_DATA7' },
    { number: 31, name: 'IO19', function: 'GPIO19, VSPIQ, U0CTS' },
    { number: 32, name: 'NC', function: 'Not connected' },
    { number: 33, name: 'IO21', function: 'GPIO21, VSPIHD, EMAC_TX_EN' },
    { number: 34, name: 'RXD0', function: 'GPIO3, U0RXD, CLK_OUT2' },
    { number: 35, name: 'TXD0', function: 'GPIO1, U0TXD, CLK_OUT3' },
    { number: 36, name: 'IO22', function: 'GPIO22, VSPIWP, U0RTS' },
    { number: 37, name: 'IO23', function: 'GPIO23, VSPID, HS1_STROBE' },
    { number: 38, name: 'GND', function: 'Ground' },
  ],
  sources: [
    {
      id: 'ds',
      kind: 'datasheet',
      publisher: 'Espressif Systems',
      title: 'ESP32-WROOM-32 Datasheet',
      revision: 'v3.8, 2026-09-16',
      url: 'https://www.espressif.com/sites/default/files/documentation/esp32-wroom-32_datasheet_en.pdf',
      accessed: ACCESSED,
      note: 'Pin definitions Table 2; abs max Table 12; operating conditions Table 13; DC Table 14; ADC Tables 9/10.',
    },
    {
      id: 'esp32',
      kind: 'datasheet',
      publisher: 'Espressif Systems',
      title: 'ESP32 Series Datasheet',
      revision: 'v5.3, 2026.07',
      url: 'https://www.espressif.com/sites/default/files/documentation/esp32_datasheet_en.pdf',
      accessed: ACCESSED,
    },
    {
      id: 'arduino-esp32-docs',
      kind: 'library',
      publisher: 'Espressif Systems',
      title: 'Arduino-ESP32 API — LEDC (analogWrite)',
      url: 'https://docs.espressif.com/projects/arduino-esp32/en/latest/api/ledc.html',
      accessed: ACCESSED,
      note: 'Verified from source docs/en/api/ledc.rst: "Default resolution is 8 bits, so 0 to 255."',
    },
    {
      id: 'arduino-esp32-src',
      kind: 'library',
      publisher: 'Espressif Systems',
      title: 'arduino-esp32 cores/esp32/esp32-hal-ledc.c (analogWrite defaults)',
      url: 'https://github.com/espressif/arduino-esp32/blob/master/cores/esp32/esp32-hal-ledc.c',
      accessed: ACCESSED,
      note: 'static int analog_frequency = 1000; static uint8_t analog_resolution = 8; (master branch at access date).',
    },
  ],
  notes: [
    'Not Recommended For New Designs (NRND) per the module datasheet.',
    'Module has 38 pins; the central exposed pad (labelled 39 GND in Fig. 1) is not listed here.',
    'GPIO6..GPIO11 (pins 17..22) are connected to the integrated SPI flash; not recommended for other uses.',
    'GPIO34..39 are input only. Strapping pins: GPIO0, GPIO2, GPIO5, GPIO12 (MTDI), GPIO15 (MTDO).',
    'Per-pin source current in VDD3P3_CPU/RTC domains falls from ~40 mA to ~29 mA as more pins source (ESP32 Series DS Table 5-3 note 2).',
    'ADC: 16 ADC-capable pads on this module (ADC1_CH0, CH3..CH7; ADC2_CH0..CH9).',
    'ADC sampling rate: RTC controller 200 ksps max, DIG controller 2 Msps max.',
  ],
  core: 'Xtensa dual-core 32-bit LX6 (ESP32-D0WDQ6)',
  supply: { min: 3.0, typ: 3.3, max: 3.6, unit: 'V' },
  nominalVcc: 3.3,
  clock: {
    max: { max: 240e6, unit: 'Hz' },
    internalOscillator: { typ: 8e6, unit: 'Hz', source: 'esp32', note: 'Internal 8 MHz oscillator with calibration.' },
  },
  logic: {
    VIL: { max: 0.25, unit: 'xVCC', conditions: { VDD: 3.3, TA: 25 } },
    VIH: { min: 0.75, unit: 'xVCC', conditions: { VDD: 3.3, TA: 25 } },
    VOL: [
      { max: 0.1, unit: 'xVCC', conditions: { VDD: 3.3, TA: 25 } },
      {
        max: 0.495,
        unit: 'V',
        conditions: { VDD: 3.3, IOL: 0.028, drive: 'max' },
        note: 'IOL typ 28 mA at VOL = 0.495 V, output drive strength set to maximum.',
      },
    ],
    VOH: [
      { min: 0.8, unit: 'xVCC', conditions: { VDD: 3.3, TA: 25 } },
      {
        min: 2.64,
        unit: 'V',
        conditions: { VDD: 3.3, IOH: -0.04, domain: 'VDD3P3_CPU / VDD3P3_RTC', drive: 'max' },
        note: 'IOH typ 40 mA at VOH >= 2.64 V (20 mA in VDD_SDIO domain), drive strength set to maximum.',
      },
    ],
    fiveVoltTolerant: false, // VIH max = VDD + 0.3 V
  },
  currents: {
    totalAbsMax: [
      { max: 1.1, unit: 'A', conditions: { sum: 'cumulative IO output current (module)' } },
      { max: 1.2, unit: 'A', conditions: { sum: 'cumulative IO output current (chip)' }, source: 'esp32' },
    ],
  },
  pullUp: { typ: 45e3, unit: 'Ω', conditions: { VDD: 3.3, TA: 25 } },
  pullDown: { typ: 45e3, unit: 'Ω', conditions: { VDD: 3.3, TA: 25 } },
  adc: {
    resolution: { typ: 12, unit: 'bit', note: 'Two 12-bit SAR ADCs (ADC1, ADC2).' },
    channels: 16,
    references: [
      {
        name: 'atten 0',
        voltage: { min: 0.1, max: 0.95, unit: 'V' },
        note: 'Effective measurement range, total error ±23 mV after eFuse Vref calibration (ADC1).',
      },
      {
        name: 'atten 1',
        voltage: { min: 0.1, max: 1.25, unit: 'V' },
        note: 'Effective measurement range, total error ±30 mV after calibration (ADC1).',
      },
      {
        name: 'atten 2',
        voltage: { min: 0.15, max: 1.75, unit: 'V' },
        note: 'Effective measurement range, total error ±40 mV after calibration (ADC1).',
      },
      {
        name: 'atten 3',
        voltage: { min: 0.15, max: 2.45, unit: 'V' },
        note: 'Effective measurement range, total error ±60 mV after calibration (ADC1); accuracy worse above ~2450 mV.',
      },
    ],
    sampleRate: { max: 2e6, unit: 'Hz', conditions: { controller: 'DIG' } },
  },
  pwm: {
    resolution: { typ: 8, unit: 'bit', source: 'arduino-esp32-docs', note: 'Arduino analogWrite() default; LEDC hardware up to 20 bit.' },
    defaultFrequency: { typ: 1000, unit: 'Hz', source: 'arduino-esp32-src', note: 'Arduino analogWrite() default.' },
    note: 'LEDC: 16 independent PWM generators, 8 timers, routable to any GPIO via the GPIO matrix.',
  },
  ratings: {
    vccMax: { max: 3.6, unit: 'V' },
  },
};

// ---------------------------------------------------------------------------
// RP2040

const RP2040: McuProfile = {
  id: 'RP2040',
  aliases: ['RP2040-B2', 'Raspberry Pi RP2040'],
  category: 'mcu',
  manufacturer: 'Raspberry Pi Ltd',
  description: 'Dual Cortex-M0+ microcontroller, 264 kB SRAM, external QSPI flash, 30 GPIO, 4-channel 12-bit ADC',
  package: { name: 'QFN-56', pinCount: 57 },
  pins: [
    { number: 1, name: 'IOVDD', function: 'IO supply' },
    { number: 2, name: 'GPIO0', function: 'User IO' },
    { number: 3, name: 'GPIO1', function: 'User IO' },
    { number: 4, name: 'GPIO2', function: 'User IO' },
    { number: 5, name: 'GPIO3', function: 'User IO' },
    { number: 6, name: 'GPIO4', function: 'User IO' },
    { number: 7, name: 'GPIO5', function: 'User IO' },
    { number: 8, name: 'GPIO6', function: 'User IO' },
    { number: 9, name: 'GPIO7', function: 'User IO' },
    { number: 10, name: 'IOVDD', function: 'IO supply' },
    { number: 11, name: 'GPIO8', function: 'User IO' },
    { number: 12, name: 'GPIO9', function: 'User IO' },
    { number: 13, name: 'GPIO10', function: 'User IO' },
    { number: 14, name: 'GPIO11', function: 'User IO' },
    { number: 15, name: 'GPIO12', function: 'User IO' },
    { number: 16, name: 'GPIO13', function: 'User IO' },
    { number: 17, name: 'GPIO14', function: 'User IO' },
    { number: 18, name: 'GPIO15', function: 'User IO' },
    { number: 19, name: 'TESTEN', function: 'Test enable (connect to GND)' },
    { number: 20, name: 'XIN', function: 'Crystal oscillator input (or square-wave clock in)' },
    { number: 21, name: 'XOUT', function: 'Crystal oscillator output' },
    { number: 22, name: 'IOVDD', function: 'IO supply' },
    { number: 23, name: 'DVDD', function: 'Core supply (1.1 V)' },
    { number: 24, name: 'SWCLK', function: 'Serial wire debug clock' },
    { number: 25, name: 'SWD', function: 'Serial wire debug data' },
    { number: 26, name: 'RUN', function: 'Chip enable / reset (active low reset)' },
    { number: 27, name: 'GPIO16', function: 'User IO' },
    { number: 28, name: 'GPIO17', function: 'User IO' },
    { number: 29, name: 'GPIO18', function: 'User IO' },
    { number: 30, name: 'GPIO19', function: 'User IO' },
    { number: 31, name: 'GPIO20', function: 'User IO' },
    { number: 32, name: 'GPIO21', function: 'User IO' },
    { number: 33, name: 'IOVDD', function: 'IO supply' },
    { number: 34, name: 'GPIO22', function: 'User IO' },
    { number: 35, name: 'GPIO23', function: 'User IO' },
    { number: 36, name: 'GPIO24', function: 'User IO' },
    { number: 37, name: 'GPIO25', function: 'User IO' },
    { number: 38, name: 'GPIO26/ADC0', function: 'User IO or ADC input 0' },
    { number: 39, name: 'GPIO27/ADC1', function: 'User IO or ADC input 1' },
    { number: 40, name: 'GPIO28/ADC2', function: 'User IO or ADC input 2' },
    { number: 41, name: 'GPIO29/ADC3', function: 'User IO or ADC input 3' },
    { number: 42, name: 'IOVDD', function: 'IO supply' },
    { number: 43, name: 'ADC_AVDD', function: 'ADC supply' },
    { number: 44, name: 'VREG_VIN', function: 'Voltage regulator input supply' },
    { number: 45, name: 'VREG_VOUT', function: 'Voltage regulator output (1.1 V nominal, 100 mA max)' },
    { number: 46, name: 'USB_DM', function: 'USB data − (27 Ω series resistor required)' },
    { number: 47, name: 'USB_DP', function: 'USB data + (27 Ω series resistor required)' },
    { number: 48, name: 'USB_VDD', function: 'USB PHY supply' },
    { number: 49, name: 'IOVDD', function: 'IO supply' },
    { number: 50, name: 'DVDD', function: 'Core supply (1.1 V)' },
    { number: 51, name: 'QSPI_SD3', function: 'QSPI data' },
    { number: 52, name: 'QSPI_SCLK', function: 'QSPI clock' },
    { number: 53, name: 'QSPI_SD0', function: 'QSPI data' },
    { number: 54, name: 'QSPI_SD2', function: 'QSPI data' },
    { number: 55, name: 'QSPI_SD1', function: 'QSPI data' },
    { number: 56, name: 'QSPI_CSn', function: 'QSPI chip select' },
    { number: 57, name: 'GND', function: 'Common ground via central exposed pad' },
  ],
  sources: [
    {
      id: 'ds',
      kind: 'datasheet',
      publisher: 'Raspberry Pi Ltd',
      title: 'RP2040 Datasheet',
      revision: 'Release 13, build date 19/11/2026 (build version 4c5ccacb2c2f)',
      url: 'https://datasheets.raspberrypi.com/rp2040/rp2040-datasheet.pdf',
      accessed: ACCESSED,
      note: 'Pin list Tables 636–642; abs max Table 643; IO characteristics Table 646; ADC Table 648 and §4.9; supplies Table 655.',
    },
    {
      id: 'pico',
      kind: 'datasheet',
      publisher: 'Raspberry Pi Ltd',
      title: 'Raspberry Pi Pico Datasheet',
      revision: 'Release 22, build date 19/11/2026 (build version d9d02bdfeecd)',
      url: 'https://datasheets.raspberrypi.com/pico/pico-datasheet.pdf',
      accessed: ACCESSED,
    },
  ],
  notes: [
    'Pin 57 is the central exposed pad: the only GND connection (Table 642).',
    'Default drive strength 4 mA; programmable 2/4/8/12 mA (nominal, not hard limits). Programmable pull-up/down, slew, Schmitt.',
    'Fault-tolerant (FT) GPIO: very little current flows below 3.63 V while IOVDD = 0 V; not 5 V tolerant.',
    'Input hysteresis (Schmitt enabled): 0.1×IOVDD min @ 1.8 V, 0.2 V min @ 2.5 V and 3.3 V.',
    'clk_sys 133 MHz max at default core voltage (200 MHz possible with DVDD = 1.15 V).',
    'ADC input must not exceed IOVDD even if ADC_AVDD is higher; ADC performance compromised below ADC_AVDD = 2.97 V.',
    'PWM: 8 slices × 2 channels = 16 outputs on GPIO0..15, repeated on GPIO16..29; 16-bit counter, 8.4 fractional divider.',
  ],
  core: 'Dual Arm Cortex-M0+',
  supply: { min: 1.62, typ: 3.3, max: 3.63, unit: 'V', conditions: { rail: 'IOVDD' }, note: 'Typ 1.8 V or 3.3 V.' },
  nominalVcc: 3.3,
  clock: {
    max: { max: 133e6, unit: 'Hz', conditions: { DVDD: 1.1 } },
    internalOscillator: {
      min: 1.8e6,
      typ: 6.5e6,
      max: 12e6,
      unit: 'Hz',
      note: 'Ring oscillator (ROSC) at boot: nominal 6.5 MHz, guaranteed 1.8..12 MHz; varies with PVT.',
    },
  },
  logic: {
    VIL: { min: -0.3, max: 0.8, unit: 'V', conditions: { IOVDD: 3.3 } },
    VIH: { min: 2, unit: 'V', conditions: { IOVDD: 3.3 }, note: 'Max IOVDD + 0.3 V. 1.7 V @ IOVDD 2.5 V; 0.65×IOVDD @ 1.8 V.' },
    VOL: [
      { min: 0, max: 0.5, unit: 'V', conditions: { IOVDD: 3.3, IOL: 'drive setting (2/4/8/12 mA)' } },
      { min: 0, max: 0.4, unit: 'V', conditions: { IOVDD: 2.5, IOL: 'drive setting (2/4/8/12 mA)' } },
      { min: 0, max: 0.3, unit: 'V', conditions: { IOVDD: 1.8, IOL: 'drive setting (2/4/8/12 mA)' } },
    ],
    VOH: [
      { min: 2.62, unit: 'V', conditions: { IOVDD: 3.3, IOH: 'drive setting (2/4/8/12 mA)' } },
      { min: 1.78, unit: 'V', conditions: { IOVDD: 2.5, IOH: 'drive setting (2/4/8/12 mA)' } },
      { min: 1.24, unit: 'V', conditions: { IOVDD: 1.8, IOH: 'drive setting (2/4/8/12 mA)' } },
    ],
    fiveVoltTolerant: false,
  },
  currents: {
    perPinRecommended: {
      max: 0.012,
      unit: 'A',
      note: 'Highest programmable drive-strength setting (2/4/8/12 mA; default 4 mA); nominal, not a hard limit.',
    },
    totalAbsMax: [
      { max: 0.05, unit: 'A', conditions: { sum: 'IIOVDD_MAX: current sourced by GPIO and QSPI pins' } },
      { max: 0.05, unit: 'A', conditions: { sum: 'IIOVSS_MAX: current sunk into GPIO and QSPI pins' } },
    ],
  },
  pullUp: { min: 50e3, max: 80e3, unit: 'Ω' },
  pullDown: { min: 50e3, max: 80e3, unit: 'Ω' },
  adc: {
    resolution: { typ: 12, unit: 'bit', note: 'ENOB 8.7 min (Table 648).' },
    channels: 4,
    references: [
      {
        name: 'ADC_AVDD',
        voltage: { min: 1.62, typ: 3.3, max: 3.63, unit: 'V' },
        note: 'No on-chip reference: the ADC uses its own supply as reference (Pico datasheet; ADC_VREF on Pico).',
      },
    ],
    inputRange: {
      min: 0,
      max: 3.3,
      unit: 'V',
      estimated: true,
      note: 'Datasheet: VPIN_ADC = 0..ADC_AVDD (and ≤ IOVDD). Evaluated at ADC_AVDD = IOVDD = 3.3 V.',
    },
    sampleRate: { max: 500e3, unit: 'Hz', conditions: { clk_adc: 48e6 }, note: '96 clk_adc cycles per sample = 2 µs.' },
  },
  pwm: {
    resolution: { max: 16, unit: 'bit', note: '16-bit counter per slice (hardware, not an SDK default).' },
    note: '8 slices / 16 channels; no default frequency stated in the datasheet.',
  },
  ratings: {
    vccMax: { max: 3.63, unit: 'V', conditions: { rail: 'IOVDD' } },
    pinVoltageMax: {
      max: 3.8,
      unit: 'V',
      estimated: true,
      note: 'Datasheet: VPIN max = IOVDD + 0.5 V; evaluated at IOVDD = 3.3 V.',
    },
    TjMax: { max: 125, unit: '°C' },
  },
};

export const MCUS: McuProfile[] = [ATMEGA328P, ATTINY85, ESP32_WROOM_32, RP2040];
