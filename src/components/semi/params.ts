/**
 * Model-parameter schemas of the semiconductor devices. One table per device
 * drives the constructor (case-insensitive names, unit strings), the
 * `.model` parser (SPICE names), the netlist description (only non-default
 * values are recorded) and `circuitsvibe catalog`.
 */
import { parseValue } from '../../core/units';

export type ParamCheck = 'positive' | 'nonNegative' | 'fraction' | 'any';

export interface ParamDef {
  /** Canonical name (netlist params, catalog). */
  name: string;
  /** Default value; Infinity = "not set / infinite" (SPICE writes 0 for VAF/IKF…). */
  default: number;
  /** Other accepted spellings (compared case-insensitively). */
  aliases?: string[];
  unit: string;
  description: string;
  check: ParamCheck;
  /** SPICE convention: a value of 0 means infinite (VAF, VAR, IKF, IKR). */
  zeroIsInfinite?: boolean;
}

export const THERMAL_VOLTAGE = 0.02585;

export interface SchemaInfo {
  device: string;
  defs: ParamDef[];
}

function lookup(defs: ParamDef[]): Map<string, ParamDef> {
  const m = new Map<string, ParamDef>();
  for (const d of defs) {
    m.set(d.name.toLowerCase(), d);
    for (const a of d.aliases ?? []) m.set(a.toLowerCase(), d);
  }
  return m;
}

const LOOKUP_CACHE = new WeakMap<ParamDef[], Map<string, ParamDef>>();

export function findParamDef(defs: ParamDef[], key: string): ParamDef | undefined {
  let m = LOOKUP_CACHE.get(defs);
  if (!m) {
    m = lookup(defs);
    LOOKUP_CACHE.set(defs, m);
  }
  return m.get(key.toLowerCase());
}

function checkValue(device: string, def: ParamDef, v: number): number {
  if (def.zeroIsInfinite && v === 0) return Infinity;
  if (Number.isNaN(v)) throw new Error(`${device} ${def.name}: not a number`);
  switch (def.check) {
    case 'positive':
      if (!(v > 0)) throw new Error(`${device} ${def.name} must be > 0, got ${v}`);
      break;
    case 'nonNegative':
      if (!(v >= 0)) throw new Error(`${device} ${def.name} must be >= 0, got ${v}`);
      break;
    case 'fraction':
      if (!(v >= 0 && v < 1)) throw new Error(`${device} ${def.name} must be in [0, 1), got ${v}`);
      break;
    case 'any':
      if (!Number.isFinite(v)) throw new Error(`${device} ${def.name} must be finite, got ${v}`);
      break;
  }
  if (!Number.isFinite(v) && !def.zeroIsInfinite && def.default !== Infinity) {
    throw new Error(`${device} ${def.name} must be finite, got ${v}`);
  }
  return v;
}

/**
 * Normalize user-supplied parameters: case-insensitive names (and aliases),
 * numbers or unit strings ('100u', '1.5k'), range checks. Unknown names throw
 * (a typo must not silently fall back to a default). Keys listed in
 * `passthrough` are left to the caller.
 */
export function normalizeParams(
  device: string,
  defs: ParamDef[],
  input: Record<string, unknown> | undefined,
  passthrough: string[] = [],
): { values: Record<string, number>; given: Set<string> } {
  const values: Record<string, number> = {};
  const given = new Set<string>();
  for (const d of defs) values[d.name] = d.default;
  const pass = new Set(passthrough.map(p => p.toLowerCase()));
  for (const [key, raw] of Object.entries(input ?? {})) {
    if (raw === undefined || pass.has(key.toLowerCase())) continue;
    const def = findParamDef(defs, key);
    if (!def) {
      throw new Error(
        `${device}: unknown parameter '${key}'. Known parameters (case-insensitive): ${defs.map(d => d.name).join(', ')}`,
      );
    }
    if (given.has(def.name)) throw new Error(`${device}: parameter '${def.name}' given twice ('${key}')`);
    let v: number;
    if (typeof raw === 'number') v = raw;
    else if (typeof raw === 'string') v = parseValue(raw, `${device} ${def.name}`);
    else throw new Error(`${device} ${def.name}: expected a number or a unit string, got ${typeof raw}`);
    values[def.name] = checkValue(device, def, v);
    given.add(def.name);
  }
  return { values, given };
}

/** Plain-JSON description: only values that differ from the defaults (Infinity never appears). */
export function describeValues(defs: ParamDef[], values: Record<string, number>, always: string[] = []): Record<string, number> {
  const out: Record<string, number> = {};
  for (const d of defs) {
    const v = values[d.name];
    if (!always.includes(d.name) && (v === d.default || (Number.isNaN(v) && Number.isNaN(d.default)))) continue;
    if (!Number.isFinite(v)) continue;
    out[d.name] = v;
  }
  return out;
}

// ─── Schemas ────────────────────────────────────────────────────────────────

export const DIODE_PARAMS: ParamDef[] = [
  { name: 'Is', default: 1e-14, unit: 'A', description: 'saturation current', check: 'positive' },
  { name: 'n', default: 1, aliases: ['N'], unit: '1', description: 'emission coefficient (ideality)', check: 'positive' },
  { name: 'Rs', default: 0, unit: 'Ω', description: 'series resistance (internal node)', check: 'nonNegative' },
  { name: 'Cjo', default: 0, aliases: ['Cj0', 'Cj'], unit: 'F', description: 'zero-bias junction capacitance', check: 'nonNegative' },
  { name: 'Vj', default: 1, aliases: ['Pb'], unit: 'V', description: 'junction potential', check: 'positive' },
  { name: 'M', default: 0.5, aliases: ['Mj'], unit: '1', description: 'grading coefficient', check: 'fraction' },
  { name: 'Fc', default: 0.5, unit: '1', description: 'forward-bias depletion capacitance coefficient', check: 'fraction' },
  { name: 'Tt', default: 0, unit: 's', description: 'transit time (diffusion charge Tt·Id)', check: 'nonNegative' },
  { name: 'BV', default: Infinity, unit: 'V', description: 'reverse breakdown voltage (Zener voltage at IBV)', check: 'positive', zeroIsInfinite: true },
  { name: 'IBV', default: 1e-3, unit: 'A', description: 'reverse current at -BV', check: 'positive' },
  { name: 'Nbv', default: NaN, unit: '1', description: 'breakdown emission coefficient (default n)', check: 'positive' },
  { name: 'Vt', default: THERMAL_VOLTAGE, unit: 'V', description: 'thermal voltage kT/q', check: 'positive' },
];

export const BJT_PARAMS: ParamDef[] = [
  { name: 'Is', default: 1e-16, unit: 'A', description: 'transport saturation current', check: 'positive' },
  { name: 'Bf', default: 100, unit: '1', description: 'ideal maximum forward beta', check: 'positive' },
  { name: 'Nf', default: 1, unit: '1', description: 'forward emission coefficient', check: 'positive' },
  { name: 'Vaf', default: Infinity, aliases: ['Va'], unit: 'V', description: 'forward Early voltage (0 = infinite)', check: 'positive', zeroIsInfinite: true },
  { name: 'Ikf', default: Infinity, aliases: ['Ik'], unit: 'A', description: 'forward high-injection knee current (0 = infinite)', check: 'positive', zeroIsInfinite: true },
  { name: 'Ise', default: 0, unit: 'A', description: 'B-E leakage saturation current', check: 'nonNegative' },
  { name: 'Ne', default: 1.5, unit: '1', description: 'B-E leakage emission coefficient', check: 'positive' },
  { name: 'Br', default: 1, unit: '1', description: 'ideal maximum reverse beta', check: 'positive' },
  { name: 'Nr', default: 1, unit: '1', description: 'reverse emission coefficient', check: 'positive' },
  { name: 'Var', default: Infinity, aliases: ['Vb'], unit: 'V', description: 'reverse Early voltage (0 = infinite)', check: 'positive', zeroIsInfinite: true },
  { name: 'Ikr', default: Infinity, unit: 'A', description: 'reverse high-injection knee current (0 = infinite)', check: 'positive', zeroIsInfinite: true },
  { name: 'Isc', default: 0, unit: 'A', description: 'B-C leakage saturation current', check: 'nonNegative' },
  { name: 'Nc', default: 2, unit: '1', description: 'B-C leakage emission coefficient', check: 'positive' },
  { name: 'Rb', default: 0, unit: 'Ω', description: 'base resistance (constant; no Irb/Rbm modulation)', check: 'nonNegative' },
  { name: 'Re', default: 0, unit: 'Ω', description: 'emitter resistance', check: 'nonNegative' },
  { name: 'Rc', default: 0, unit: 'Ω', description: 'collector resistance', check: 'nonNegative' },
  { name: 'Cje', default: 0, unit: 'F', description: 'B-E zero-bias depletion capacitance', check: 'nonNegative' },
  { name: 'Vje', default: 0.75, aliases: ['Pe'], unit: 'V', description: 'B-E built-in potential', check: 'positive' },
  { name: 'Mje', default: 0.33, aliases: ['Me'], unit: '1', description: 'B-E junction grading', check: 'fraction' },
  { name: 'Cjc', default: 0, unit: 'F', description: 'B-C zero-bias depletion capacitance', check: 'nonNegative' },
  { name: 'Vjc', default: 0.75, aliases: ['Pc'], unit: 'V', description: 'B-C built-in potential', check: 'positive' },
  { name: 'Mjc', default: 0.33, aliases: ['Mc'], unit: '1', description: 'B-C junction grading', check: 'fraction' },
  { name: 'Tf', default: 0, unit: 's', description: 'ideal forward transit time', check: 'nonNegative' },
  { name: 'Tr', default: 0, unit: 's', description: 'ideal reverse transit time', check: 'nonNegative' },
  { name: 'Fc', default: 0.5, unit: '1', description: 'forward-bias depletion capacitance coefficient', check: 'fraction' },
  { name: 'Vt', default: THERMAL_VOLTAGE, unit: 'V', description: 'thermal voltage kT/q', check: 'positive' },
];

export const MOSFET_PARAMS: ParamDef[] = [
  { name: 'Vto', default: 0, aliases: ['Vt0'], unit: 'V', description: 'zero-bias threshold voltage (negative for enhancement PMOS)', check: 'any' },
  { name: 'Kp', default: 2e-5, unit: 'A/V²', description: 'transconductance parameter (beta = Kp·W/Leff)', check: 'positive' },
  { name: 'Lambda', default: 0, unit: '1/V', description: 'channel-length modulation', check: 'nonNegative' },
  { name: 'Gamma', default: 0, unit: '√V', description: 'bulk threshold (body-effect) parameter', check: 'nonNegative' },
  { name: 'Phi', default: 0.6, unit: 'V', description: 'surface potential', check: 'positive' },
  { name: 'Rd', default: 0, unit: 'Ω', description: 'drain ohmic resistance', check: 'nonNegative' },
  { name: 'Rs', default: 0, unit: 'Ω', description: 'source ohmic resistance', check: 'nonNegative' },
  { name: 'W', default: 1, unit: 'm', description: 'channel width (lumped convention W = L = 1)', check: 'positive' },
  { name: 'L', default: 1, unit: 'm', description: 'channel length', check: 'positive' },
  { name: 'Ld', default: 0, unit: 'm', description: 'lateral diffusion (Leff = L − 2·Ld)', check: 'nonNegative' },
  { name: 'Cgso', default: 0, unit: 'F/m', description: 'gate-source overlap capacitance per width (total F with W = 1)', check: 'nonNegative' },
  { name: 'Cgdo', default: 0, unit: 'F/m', description: 'gate-drain overlap capacitance per width', check: 'nonNegative' },
  { name: 'Cgbo', default: 0, unit: 'F/m', description: 'gate-bulk overlap capacitance per length', check: 'nonNegative' },
  { name: 'Cbd', default: 0, unit: 'F', description: 'zero-bias bulk-drain junction capacitance', check: 'nonNegative' },
  { name: 'Cbs', default: 0, unit: 'F', description: 'zero-bias bulk-source junction capacitance', check: 'nonNegative' },
  { name: 'Is', default: 1e-14, unit: 'A', description: 'bulk junction saturation current', check: 'positive' },
  { name: 'Pb', default: 0.8, unit: 'V', description: 'bulk junction potential', check: 'positive' },
  { name: 'Mj', default: 0.5, unit: '1', description: 'bulk junction grading', check: 'fraction' },
  { name: 'Fc', default: 0.5, unit: '1', description: 'bulk junction forward-bias capacitance coefficient', check: 'fraction' },
  { name: 'Vt', default: THERMAL_VOLTAGE, unit: 'V', description: 'thermal voltage kT/q', check: 'positive' },
];
