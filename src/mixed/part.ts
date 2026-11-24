/**
 * IC side of the `Part()` factory.
 *
 * `Part(id)` in src/elab/part.ts walks PART_RESOLVERS: this IC family first,
 * then the semiconductors (src/components/Part.ts); each returns `undefined`
 * for ids it does not simulate. A new family is one line in PART_RESOLVERS.
 */
import { LogicIC, type IcOptions } from './device';
import { findIcDef, icIds } from './ics';

/** A simulatable IC (74HC00, 74HC04, 74HC14, 74HC74, 74HC595, 74HCT04, CD4017, CD4011, NE555), or undefined. */
export function icPart(id: string, opts: IcOptions = {}): LogicIC | undefined {
  if (typeof id !== 'string') return undefined;
  const def = findIcDef(id.trim());
  return def ? new LogicIC(def.id, opts) : undefined;
}

/** Ids `icPart` accepts (canonical; catalog aliases such as 'SN74HC00N' or 'LM555' work too). */
export function icPartIds(): string[] {
  return icIds();
}
