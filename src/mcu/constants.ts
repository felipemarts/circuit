/** Arduino constants (ArduinoCore-avr numeric values; HIGH === CHANGE as on AVR). */

export const INPUT = 0x0;
export const OUTPUT = 0x1;
export const INPUT_PULLUP = 0x2;
/** ESP32 / RP2040 only. */
export const INPUT_PULLDOWN = 0x3;

export const LOW = 0x0;
export const HIGH = 0x1;

export const CHANGE = 1;
export const FALLING = 2;
export const RISING = 3;
export const NOT_AN_INTERRUPT = -1;

// Serial.print() number bases.
export const BIN = 2;
export const OCT = 8;
export const DEC = 10;
export const HEX = 16;

// shiftOut-style bit orders (bitRead helpers accept them for completeness).
export const LSBFIRST = 0;
export const MSBFIRST = 1;

// analogReference() keys (names in McuProfile.adc.references).
export const DEFAULT = 'DEFAULT';
export const INTERNAL = 'INTERNAL';
export const INTERNAL1V1 = 'INTERNAL1V1';
export const INTERNAL2V56 = 'INTERNAL2V56';
export const EXTERNAL = 'EXTERNAL';
