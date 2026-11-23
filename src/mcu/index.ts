/**
 * CircuitsVibe MCU runtime — public surface (browser-safe; the Node-only
 * firmware loader lives in ./node/load-firmware).
 *
 * Firmware imports its API from `circuitsvibe/arduino` (./arduino); the
 * integrator drives McuRuntime through the co-simulation contract described
 * in ./README.md.
 */

export { McuRuntime, McuBusyLoopError, pwmDuty } from './runtime';
export type { McuRuntimeOptions } from './runtime';
export { MockPinBus } from './mock-bus';
export type { BusCall, MockPinBusOptions } from './mock-bus';
export { MCU_PROFILES, ATMEGA328P_UNO, ATTINY85, ESP32_GENERIC, RP2040_GENERIC, getMcuProfile, findPin } from './profiles';
export { MCU_CODES, mcuDiagnostic, firmwareLocFromStack, firmwareFrames } from './diagnostics';
export type { McuCode, McuCodeInfo } from './diagnostics';
export { lintFirmware } from './lint';
export type { FirmwareLintOptions } from './lint';
export { instrumentLoops, tokenize, LOOP_GUARD_CALL } from './instrument';
export { arduinoModule, ARDUINO_SPECIFIER } from './module';
export { installLoopGuard, useProfileConstants, currentMcu, formatPrint } from './arduino';
export { ArduinoRandom, RANDOM_MAX } from './random';
export * as measure from './measure';
export * from './types';
