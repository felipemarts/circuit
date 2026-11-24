/**
 * Real-parts catalog: datasheet ratings, characteristics and SPICE-style model cards for
 * common discrete parts, ICs and microcontroller profiles. Pure data — browser-safe, no
 * Node APIs, no simulation code. See docs/PARTS.md for sources and estimated values.
 */
import type { PartCategory, PartEntry } from './types';
import { DIODES } from './data/diodes';
import { BJTS } from './data/bjts';
import { MOSFETS } from './data/mosfets';
import { AMPLIFIERS } from './data/amplifiers';
import { TIMERS } from './data/timers';
import { LOGIC } from './data/logic';
import { MCUS } from './data/mcus';

export type * from './types';
export { DIODES, BJTS, MOSFETS, AMPLIFIERS, TIMERS, LOGIC, MCUS };

/** Every catalog entry. */
export const PARTS: readonly PartEntry[] = [
  ...DIODES,
  ...BJTS,
  ...MOSFETS,
  ...AMPLIFIERS,
  ...TIMERS,
  ...LOGIC,
  ...MCUS,
];

const normalize = (s: string): string => s.trim().toUpperCase();

const BY_ID: ReadonlyMap<string, PartEntry> = (() => {
  const m = new Map<string, PartEntry>();
  for (const p of PARTS) m.set(normalize(p.id), p);
  // Aliases never shadow a canonical id.
  for (const p of PARTS) {
    for (const a of p.aliases ?? []) {
      const k = normalize(a);
      if (!m.has(k)) m.set(k, p);
    }
  }
  return m;
})();

/** Look a part up by id or alias (case-insensitive). */
export function findPart(id: string): PartEntry | undefined {
  return BY_ID.get(normalize(id));
}

/** All parts of one category. */
export function partsByCategory<C extends PartCategory>(
  category: C,
): Extract<PartEntry, { category: C }>[] {
  return PARTS.filter((p): p is Extract<PartEntry, { category: C }> => p.category === category);
}
