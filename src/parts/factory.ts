/**
 * Part(id): a simulatable device for a real catalog part.
 *
 * The factory is a list of resolvers, each owning some catalog categories and
 * returning undefined for ids it does not handle. Op-amps and comparators
 * resolve through `opampPart` (src/opamps/parts.ts). Another category plugs
 * in by adding its resolver to RESOLVERS — the merge seam is one line.
 */
import type { Component } from '../core/Component';
import { findPart } from './index';
import { opampPart } from '../opamps/parts';

type PartResolver = (id: string) => Component | undefined;

const RESOLVERS: PartResolver[] = [opampPart];

export function Part(id: string): Component {
  for (const resolve of RESOLVERS) {
    const comp = resolve(id);
    if (comp) return comp;
  }
  const entry = findPart(id);
  if (!entry) throw new Error(`Part('${id}'): no such part in the catalog (circuitsvibe catalog lists the parts)`);
  throw new Error(`Part('${id}'): ${entry.category} parts are catalog data only in this release — no simulation model yet`);
}
