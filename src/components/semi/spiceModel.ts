/**
 * SPICE `.model` card parser for the supported device subset:
 *
 *   .model D1N4148 D(IS=2.52n RS=0.568 N=1.752 CJO=4p M=0.4 TT=20n BV=100 IBV=100u)
 *   .MODEL Q2N3904 NPN (Is=6.734f Xti=3 Eg=1.11 Vaf=74.03 Bf=416.4 ...
 *   +                   Cjc=3.638p Mjc=.3085 Vjc=.75 Fc=.5 Tr=239.5n Tf=301.2p)
 *
 * Case-insensitive keywords and parameter names; SPICE value suffixes are
 * case-insensitive too (M = milli, MEG = mega, MIL = 25.4 µm; a trailing unit
 * like `pF` or `V` is ignored); continuation lines start with `+`; the
 * parentheses and commas are optional; `*` comment lines and `;`/`$` inline
 * comments are skipped.
 *
 * Never throws: problems become model diagnostics that the lint stage
 * reports with stable codes —
 *   T005 (warning) unknown parameter, ignored;
 *   T006 (error)   unsupported device type or LEVEL;
 *   T007 (error)   malformed card (syntax or value);
 *   T008 (warning) known SPICE parameter this simulator does not model.
 */
import { BJT_PARAMS, DIODE_PARAMS, MOSFET_PARAMS, findParamDef, type ParamDef } from './params';

export type SpiceType = 'D' | 'NPN' | 'PNP' | 'NMOS' | 'PMOS';

export interface ModelDiagnostic {
  code: 'T005' | 'T006' | 'T007' | 'T008';
  severity: 'error' | 'warning';
  message: string;
  /** Parameter names concerned (as written in the card). */
  params?: string[];
}

export interface ParsedModel {
  /** Model name as written. */
  name: string;
  /** SPICE device type (uppercase), or the unsupported type as written. */
  type: string;
  level?: number;
  /** Modeled parameters, canonical names (see the device schemas), SI values. */
  params: Record<string, number>;
  /** Every numeric parameter as written (uppercased name → value). */
  raw: Record<string, number>;
  /** Non-numeric or vendor metadata (mfg=…, Vceo=… on LTspice cards). */
  metadata: Record<string, string>;
  diagnostics: ModelDiagnostic[];
}

/** Parse a SPICE number with an optional (case-insensitive) scale suffix and unit. */
export function parseSpiceNumber(token: string): number | undefined {
  const m = token.trim().match(/^([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)([a-zA-Zµ]*)$/);
  if (!m) return undefined;
  const base = Number(m[1]);
  const suffix = m[2].toLowerCase();
  let scale = 1;
  if (suffix.startsWith('meg')) scale = 1e6;
  else if (suffix.startsWith('mil')) scale = 25.4e-6;
  else if (suffix.length > 0) {
    const s: Record<string, number> = { t: 1e12, g: 1e9, k: 1e3, m: 1e-3, u: 1e-6, 'µ': 1e-6, n: 1e-9, p: 1e-12, f: 1e-15, a: 1e-18 };
    scale = s[suffix[0]] ?? 1; // anything else is a unit name (V, A, ohm…) and ignored
  }
  const v = base * scale;
  return Number.isFinite(v) ? v : undefined;
}

const DEVICE_TYPES: Record<string, SpiceType> = { D: 'D', NPN: 'NPN', PNP: 'PNP', NMOS: 'NMOS', PMOS: 'PMOS' };

/** Metadata keys some vendors/LTspice put on cards (not model parameters). */
const METADATA = new Set(['mfg', 'vceo', 'icrating', 'iave', 'vpk', 'vds', 'ron', 'qg', 'type', 'iav', 'vbr']);

/** Known SPICE parameters with no effect at the nominal temperature or on noise only. */
const NO_EFFECT: Record<'D' | 'BJT' | 'MOS', string[]> = {
  D: ['eg', 'xti', 'tnom', 'kf', 'af', 'tbv1', 'tbv2', 'trs1', 'trs2', 'tt1', 'tt2', 'tm1', 'tm2', 'cta', 'ctp', 'tcv', 'tlev', 'tlevc', 'tpb', 'tphp', 'trs', 'tref', 'area'],
  BJT: ['xtb', 'eg', 'xti', 'tnom', 'kf', 'af', 'tre1', 'tre2', 'trb1', 'trb2', 'trc1', 'trc2', 'trm1', 'trm2', 'tbf1', 'tbf2', 'tbr1', 'tbr2', 'tref'],
  MOS: ['tnom', 'kf', 'af', 'tref'],
};

/** Known SPICE parameters that change the device but are not modeled here, with their no-effect defaults. */
const UNMODELED: Record<'D' | 'BJT' | 'MOS', Record<string, number | null>> = {
  D: { isr: 0, nr: 2, ikf: 0, ikr: 0, jsw: 0, cjp: 0, cjsw: 0, php: null, mjsw: null, fcs: null, ibvl: 0, nbvl: null, bvj: null },
  BJT: { irb: 0, rbm: null, xtf: 0, vtf: 0, itf: 0, ptf: 0, xcjc: 1, cjs: 0, ccs: 0, vjs: null, ps: null, mjs: null, ms: null, nk: null, iss: 0, ns: null, qco: 0, rco: 0, vo: 0, gamma: 0, quasimod: 0 },
  MOS: { tox: null, uo: null, u0: null, nsub: 0, nss: 0, nfs: 0, tpg: null, xj: 0, js: 0, jssw: 0, cj: 0, mjsw: null, cjsw: 0, pbsw: null, rsh: 0, ucrit: null, uexp: 0, utra: 0, vmax: 0, neff: null, delta: 0, theta: 0, eta: 0, kappa: null, nrd: null, nrs: null, xqc: null },
};

function familyOf(type: SpiceType): 'D' | 'BJT' | 'MOS' {
  return type === 'D' ? 'D' : type === 'NPN' || type === 'PNP' ? 'BJT' : 'MOS';
}

export function schemaFor(type: SpiceType): ParamDef[] {
  const f = familyOf(type);
  return f === 'D' ? DIODE_PARAMS : f === 'BJT' ? BJT_PARAMS : MOSFET_PARAMS;
}

/** Join continuation lines and strip comments. */
function logicalText(text: string): string {
  const lines: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.replace(/;.*$/, '').replace(/\s\$.*$/, '');
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('*')) continue;
    if (trimmed.startsWith('+')) {
      if (lines.length === 0) lines.push(trimmed.slice(1));
      else lines[lines.length - 1] += ' ' + trimmed.slice(1);
      continue;
    }
    line = trimmed;
    lines.push(line);
  }
  return lines.join('\n');
}

/** Parse one `.model` card. */
export function parseSpiceModel(text: string): ParsedModel {
  const out: ParsedModel = { name: '', type: '', params: {}, raw: {}, metadata: {}, diagnostics: [] };
  const err = (code: ModelDiagnostic['code'], message: string, params?: string[]) =>
    out.diagnostics.push({ code, severity: code === 'T005' || code === 'T008' ? 'warning' : 'error', message, ...(params ? { params } : {}) });

  if (typeof text !== 'string' || text.trim() === '') {
    err('T007', `empty .model card: expected '.model <name> <type>(<param>=<value> ...)'`);
    return out;
  }
  const lines = logicalText(text).split('\n').filter(l => l.trim() !== '');
  const cards = lines.filter(l => /^\.model\b/i.test(l.trim()));
  if (cards.length !== 1 || lines.length !== 1) {
    err(
      'T007',
      cards.length === 0
        ? `no '.model' line found: expected '.model <name> <type>(<param>=<value> ...)'`
        : `expected exactly one .model card, found ${cards.length} card(s) and ${lines.length - cards.length} other line(s)`,
    );
    if (cards.length === 0) return out;
  }
  const body = cards[0]
    .trim()
    .replace(/[(),]/g, ' ')
    .replace(/\s*=\s*/g, '=');
  const tokens = body.split(/\s+/).filter(Boolean);
  // tokens[0] = .model
  if (tokens.length < 3) {
    err('T007', `malformed .model card '${cards[0].trim()}': expected '.model <name> <type>(...)'`);
    return out;
  }
  out.name = tokens[1];
  const typeToken = tokens[2].toUpperCase();
  out.type = typeToken;
  const type = DEVICE_TYPES[typeToken];
  if (!type) {
    err(
      'T006',
      `.model ${out.name}: device type '${tokens[2]}' is not supported (supported: D, NPN, PNP, NMOS, PMOS)`,
    );
    return out;
  }
  const family = familyOf(type);
  const schema = schemaFor(type);
  const unknown: string[] = [];
  const unmodeled: string[] = [];
  for (const tok of tokens.slice(3)) {
    const eq = tok.indexOf('=');
    if (eq <= 0 || eq === tok.length - 1) {
      err('T007', `.model ${out.name}: '${tok}' is not a <param>=<value> pair`);
      continue;
    }
    const key = tok.slice(0, eq);
    const valueText = tok.slice(eq + 1);
    const lower = key.toLowerCase();
    if (METADATA.has(lower)) {
      out.metadata[key] = valueText;
      continue;
    }
    const value = parseSpiceNumber(valueText);
    if (value === undefined) {
      err('T007', `.model ${out.name}: ${key}='${valueText}' is not a number (SPICE suffixes: T G MEG K M MIL U N P F)`);
      continue;
    }
    out.raw[key.toUpperCase()] = value;
    if (lower === 'level') {
      out.level = value;
      continue;
    }
    if (family === 'MOS' && (lower === 'tox' || lower === 'uo' || lower === 'u0')) continue; // handled below
    const def = findParamDef(schema, key);
    if (def) {
      out.params[def.name] = def.zeroIsInfinite && value === 0 ? Infinity : value;
      continue;
    }
    if (NO_EFFECT[family].includes(lower)) continue;
    if (lower in UNMODELED[family]) {
      const neutral = UNMODELED[family][lower];
      if (neutral === null || value !== neutral) unmodeled.push(key);
      continue;
    }
    unknown.push(key);
  }

  // LEVEL: only the Level-1 equations (Shichman-Hodges) and the SPICE level-1 diode/BJT exist.
  if (out.level !== undefined && out.level !== 1) {
    err(
      'T006',
      `.model ${out.name}: LEVEL=${out.level} is not supported — only LEVEL=1${family === 'MOS' ? ' (Shichman-Hodges)' : ''} is implemented`,
    );
  }

  if (family === 'MOS') {
    // Kp from process parameters (SPICE): KP = UO·εox/TOX when KP is not given.
    const tox = out.raw['TOX'];
    const uo = out.raw['UO'] ?? out.raw['U0'];
    if (out.params.Kp === undefined && tox !== undefined && uo !== undefined && tox > 0) {
      out.params.Kp = (uo * 1e-4 * 3.9 * 8.854187817e-12) / tox;
    } else if (tox !== undefined || uo !== undefined) {
      if (out.params.Kp === undefined) unmodeled.push(...['TOX', 'UO'].filter(k => out.raw[k] !== undefined));
    }
    // Physical sanity: an NMOS card with negative threshold is a depletion device — fine, no diagnostic.
  }

  // Validate modeled values with the device's own range checks.
  for (const [name, v] of Object.entries(out.params)) {
    const def = schema.find(d => d.name === name)!;
    const ok =
      v === Infinity && def.zeroIsInfinite
        ? true
        : def.check === 'positive'
          ? v > 0
          : def.check === 'nonNegative'
            ? v >= 0
            : def.check === 'fraction'
              ? v >= 0 && v < 1
              : Number.isFinite(v);
    if (!ok) {
      err('T007', `.model ${out.name}: ${name}=${v} is out of range (${def.check === 'fraction' ? 'must be in [0, 1)' : def.check === 'positive' ? 'must be > 0' : 'must be >= 0'})`);
      delete out.params[name];
    }
  }

  if (unknown.length > 0) {
    err('T005', `.model ${out.name}: unknown parameter${unknown.length > 1 ? 's' : ''} ${unknown.join(', ')} ignored`, unknown);
  }
  if (unmodeled.length > 0) {
    err(
      'T008',
      `.model ${out.name}: ${unmodeled.join(', ')} ${unmodeled.length > 1 ? 'are' : 'is a'} SPICE parameter${unmodeled.length > 1 ? 's' : ''} this simulator does not model — ignored, results can differ from a full SPICE run`,
      unmodeled,
    );
  }
  return out;
}

/** Parameters listed in a card that this simulator ignores (for the catalog). */
export function unmodeledParams(type: SpiceType, params: Record<string, number | undefined>): string[] {
  const family = familyOf(type);
  const schema = schemaFor(type);
  const out: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    const lower = key.toLowerCase();
    if (findParamDef(schema, key) || NO_EFFECT[family].includes(lower) || lower === 'level') continue;
    if (lower in UNMODELED[family]) {
      const neutral = UNMODELED[family][lower];
      if (neutral !== null && value === neutral) continue;
      // Parameters that only matter when their parent is non-zero.
      if ((lower === 'vjs' || lower === 'mjs') && !params.Cjs && !params.CJS) continue;
      if ((lower === 'vtf' || lower === 'itf') && !params.Xtf && !params.XTF) continue;
    }
    out.push(key);
  }
  return out;
}
