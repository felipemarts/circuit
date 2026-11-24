/**
 * `Part(id, options?)` — a real part from the catalog, as a simulatable component.
 *
 *   const u1 = tb.add('U1', Part('74HC00'));               // logic IC / timer (src/mixed)
 *   u1.pin('1A').connect(...);  u1.pin(14).connect(vcc);   // datasheet names or numbers
 *   const q1 = tb.add('Q1', Part('2N3904'));               // semiconductor (src/components/Part.ts)
 *   q1.pin('b').connect(...);                              // generic device pins, datasheet ratings checked
 *
 * One entry point, a chain of family resolvers. Each resolver returns the
 * component for ids it handles, `undefined` for ids it does not know (the
 * next resolver is tried), and throws only for an id it owns but cannot
 * simulate (e.g. a Darlington with no single-transistor model). When no
 * resolver takes the id, the error lists every simulatable id per family.
 *
 * ADDING A FAMILY (e.g. the op-amp branch's `opampPart(id)`): import it and
 * add ONE line to PART_RESOLVERS below —
 *
 *   { family: 'op-amps', resolve: opampPart, ids: opampPartIds },
 *
 * Order matters only for ids two families could both claim (none today);
 * keep the most specific family first. The rebuild side is unaffected:
 * `buildComponent` rebuilds ICs by their catalog-id type and semiconductors
 * by their `part` param, so a new family registers its own rebuild there.
 */
import type { Component } from '../core/Component';
import { icPart, icPartIds } from '../mixed/part';
import type { IcOptions } from '../mixed/device';
import { semiPart, semiPartIds, partUnsupportedReason } from '../components/Part';
import { findPart } from '../parts';

/**
 * Options of `Part()`. Logic ICs / timers take `{ corner, clamp }`;
 * semiconductor parts take none (their model card and ratings come from the catalog).
 */
export type PartOptions = IcOptions;

/** One part family of the `Part()` dispatch chain. */
export interface PartResolver {
  /** Family name, used in the "known ids" error. */
  family: string;
  /** The component for an id of this family, or undefined when the id is not this family's. */
  resolve: (id: string, opts: PartOptions) => Component | undefined;
  /** Canonical ids this family simulates (aliases are accepted too). */
  ids: () => string[];
}

const noOptions = (id: string, opts: PartOptions, dev: Component | undefined): Component | undefined => {
  const keys = Object.keys(opts ?? {});
  if (dev && keys.length > 0) {
    throw new Error(`Part('${id}'): options { ${keys.join(', ')} } apply to logic ICs only; a semiconductor part takes no options (its model card and ratings come from the catalog)`);
  }
  return dev;
};

/** The dispatch chain — add a family with one line here. */
export const PART_RESOLVERS: readonly PartResolver[] = [
  { family: 'logic ICs / timers', resolve: icPart, ids: icPartIds },
  { family: 'semiconductors', resolve: (id, opts) => noOptions(id, opts, semiPart(id)), ids: semiPartIds },
];

export function Part(id: string, opts: PartOptions = {}): Component {
  if (typeof id !== 'string' || id.trim() === '') {
    throw new Error(`Part(id): expected a catalog part id such as '2N3904' or '74HC04'`);
  }
  for (const r of PART_RESOLVERS) {
    const comp = r.resolve(id, opts);
    if (comp) return comp;
  }
  const known = PART_RESOLVERS.map(r => `${r.family}: ${r.ids().join(', ')}`).join('; ');
  const entry = findPart(id);
  const reason = entry ? (partUnsupportedReason(entry) ?? `${entry.id} (${entry.category}) has no simulation model yet`) : 'unknown part';
  throw new Error(`Part('${id}'): ${reason}. Simulatable catalog parts: ${known} (circuitsvibe catalog lists them all)`);
}

/** Every id `Part()` simulates, per family. */
export function partIds(): { family: string; ids: string[] }[] {
  return PART_RESOLVERS.map(r => ({ family: r.family, ids: r.ids() }));
}
