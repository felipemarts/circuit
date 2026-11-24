/**
 * `Part(id, options?)` — a real part from the catalog, as a simulatable component.
 *
 *   const u1 = tb.add('U1', Part('74HC00'));
 *   u1.pin('1A').connect(...);  u1.pin(14).connect(vcc);   // datasheet names or numbers
 *
 * Dispatch seam (see src/mixed/part.ts): each part family contributes a
 * `<family>Part(id, opts)` that returns undefined for ids it does not handle.
 */
import type { Component } from '../core/Component';
import { icPart, icPartIds } from '../mixed/part';
import type { IcOptions } from '../mixed/device';

export type PartOptions = IcOptions;

export function Part(id: string, opts: PartOptions = {}): Component {
  const ic = icPart(id, opts);
  if (ic) return ic;
  throw new Error(`Part('${id}'): not a simulatable part. Simulatable parts: ${icPartIds().join(', ')} (npx circuitsvibe catalog)`);
}
