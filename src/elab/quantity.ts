/**
 * Component probe quantities: '<id>.i' / '<id>.v' for every component, plus
 * device quantities exposed by the semiconductor models ('Q1.ic', 'Q1.vbe',
 * 'M1.vgs', 'D1.p'…). Identification is structural (methods on the
 * instance), never instanceof — the CLI and the bench may load separate
 * copies of the classes.
 */
import type { Component } from '../core/Component';
import type { MNAMatrix } from '../solver/MNAMatrix';
import type { Phasor } from '../analysis/context';

/** '<id>.<quantity>' (quantity: lowercase letters/digits). */
export const COMPONENT_PROBE_RE = /^([A-Za-z][A-Za-z0-9_]*)\.([a-z][a-z0-9]*)$/;

interface QuantityDevice {
  probeQuantities(): string[];
  quantity(name: string): number | undefined;
  readQuantity(name: string, x: ArrayLike<number>, matrix: MNAMatrix): number | undefined;
  acQuantity?(name: string, re: ArrayLike<number>, im: ArrayLike<number>, omega: number): Phasor | undefined;
}

export function asQuantityDevice(comp: Component): QuantityDevice | null {
  const c = comp as unknown as Partial<QuantityDevice>;
  return typeof c.probeQuantities === 'function' && typeof c.readQuantity === 'function' && typeof c.quantity === 'function'
    ? (c as QuantityDevice)
    : null;
}

/** Quantities a component exposes to probes. */
export function probeQuantitiesOf(comp: Component): string[] {
  const dev = asQuantityDevice(comp);
  if (dev) return dev.probeQuantities();
  const c = comp as unknown as Record<string, unknown>;
  return [...(typeof c.current === 'number' ? ['i'] : []), ...(typeof c.voltage === 'number' ? ['v'] : [])];
}

/** Whether `.i`/`.v` (legacy readout) or a device quantity. */
export function isLegacyQuantity(q: string): q is 'i' | 'v' {
  return q === 'i' || q === 'v';
}
