/**
 * The `circuitsvibe/arduino` virtual module as a CommonJS-shaped object, for
 * loaders that map module specifiers (src/cli/load.ts, src/mcu/node/load-firmware.ts).
 *
 * Properties are getters over the ESM namespace, so board constants
 * (LED_BUILTIN, A0…) stay live when the running profile changes.
 */

import * as arduino from './arduino';

export const ARDUINO_SPECIFIER = 'circuitsvibe/arduino';

/** Runtime plumbing that firmware must not see. */
const INTERNAL = new Set(['enterRuntime', 'exitRuntime', 'installLoopGuard', 'loopGuard', 'LOOP_GUARD_GLOBAL', 'useProfileConstants', 'currentMcu']);

let cached: Record<string, unknown> | undefined;

export function arduinoModule(): Record<string, unknown> {
  if (cached) return cached;
  const ns = arduino as unknown as Record<string, unknown>;
  const mod: Record<string, unknown> = {};
  Object.defineProperty(mod, '__esModule', { value: true });
  for (const key of Object.keys(ns)) {
    if (INTERNAL.has(key)) continue;
    Object.defineProperty(mod, key, { enumerable: true, get: () => ns[key] });
  }
  Object.defineProperty(mod, 'default', { enumerable: false, get: () => mod });
  cached = Object.freeze(mod);
  return cached;
}
