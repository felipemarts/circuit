/**
 * VHDL front-end diagnostics — plain data, stable codes in V701–V799.
 *
 *   V701–V749  compile / elaboration (stage 'lint': before any event is simulated)
 *   V750–V799  runtime, emitted by compiled VHDL processes while simulating (stage 'tran')
 *
 * A VhdlDiagnostic has exactly the shape of a DigitalDiagnostic (which is
 * structurally a platform `Diagnostic`), so the integrator can merge every
 * stream into one RunRecord. `at` is the VHDL source location: `file:line:col`
 * for a source with a path, `<bench file:line> (vhdl line:col)` for VHDL text
 * given inline in a bench.
 */
import type { DigitalDiagnostic, DigitalFix, DigitalSeverity } from '../digital/diagnostics';

export type VhdlDiagnostic = DigitalDiagnostic;
export type VhdlFix = DigitalFix;

export interface VhdlCodeInfo {
  code: string;
  slug: string;
  severity: DigitalSeverity;
  stage: 'lint' | 'tran';
  title: string;
}

const C = (code: string, slug: string, severity: DigitalSeverity, stage: 'lint' | 'tran', title: string): VhdlCodeInfo => ({
  code,
  slug,
  severity,
  stage,
  title,
});

/** Every code this module can emit. Registered in src/verify/registry.ts and docs/DIAGNOSTICS.md. */
export const VHDL_CODES: Record<string, VhdlCodeInfo> = {
  V701: C('V701', 'vhdl-syntax-error', 'error', 'lint', 'VHDL syntax error'),
  V702: C('V702', 'vhdl-lexical-error', 'error', 'lint', 'invalid character, literal or comment in VHDL source'),
  V703: C('V703', 'vhdl-unsupported', 'error', 'lint', 'VHDL construct outside the supported subset'),
  V704: C('V704', 'vhdl-undeclared', 'error', 'lint', 'name is not declared'),
  V705: C('V705', 'vhdl-type-mismatch', 'error', 'lint', 'operand or value has the wrong type'),
  V706: C('V706', 'vhdl-length-mismatch', 'error', 'lint', 'vector lengths differ'),
  V707: C('V707', 'vhdl-missing-use', 'error', 'lint', 'IEEE package used without its library/use clause'),
  V708: C('V708', 'vhdl-unsupported-library', 'error', 'lint', 'library or package outside the supported set'),
  V709: C('V709', 'vhdl-unknown-entity', 'error', 'lint', 'entity not found in the compiled sources'),
  V710: C('V710', 'vhdl-port-map', 'error', 'lint', 'invalid port map / port association'),
  V711: C('V711', 'vhdl-generic', 'error', 'lint', 'invalid generic value or generic map'),
  V712: C('V712', 'vhdl-illegal-target', 'error', 'lint', 'assignment to something that cannot be assigned'),
  V713: C('V713', 'vhdl-not-static', 'error', 'lint', 'expression must be static (known at elaboration)'),
  V714: C('V714', 'vhdl-unresolved-drivers', 'error', 'lint', 'unresolved signal driven by more than one process'),
  V715: C('V715', 'vhdl-duplicate', 'error', 'lint', 'name declared twice in the same scope'),
  V716: C('V716', 'vhdl-no-sensitivity', 'error', 'lint', 'process has neither a sensitivity list nor a wait'),
  V717: C('V717', 'vhdl-incomplete-sensitivity', 'warning', 'lint', 'combinational process reads a signal missing from its sensitivity list'),
  V718: C('V718', 'vhdl-case-choices', 'error', 'lint', 'case/select choices are incomplete, duplicated or not static'),
  V719: C('V719', 'vhdl-static-range', 'error', 'lint', 'static index, slice or value outside its range'),
  V720: C('V720', 'vhdl-invalid-literal', 'error', 'lint', 'literal is not a valid value of its type'),
  V721: C('V721', 'vhdl-instance', 'error', 'lint', 'invalid instantiateVhdl() arguments'),
  V722: C('V722', 'vhdl-recursive-instance', 'error', 'lint', 'entity instantiates itself'),
  V723: C('V723', 'vhdl-no-architecture', 'error', 'lint', 'entity has no architecture'),
  V750: C('V750', 'vhdl-index-out-of-range', 'error', 'tran', 'index out of range at runtime'),
  V751: C('V751', 'vhdl-range-violation', 'error', 'tran', 'value outside the target subtype range at runtime'),
  V752: C('V752', 'vhdl-assertion', 'error', 'tran', 'VHDL assert/report fired'),
  V753: C('V753', 'vhdl-metavalue', 'warning', 'tran', 'numeric_std operation on X/U/Z/W/- bits'),
  V754: C('V754', 'vhdl-division-by-zero', 'error', 'tran', 'division or mod/rem by zero at runtime'),
  V755: C('V755', 'vhdl-encoded-unknown', 'warning', 'tran', 'integer/enum/boolean signal read X/Z bits from its nets'),
};

export function vhdlDiagnostic(
  code: string,
  fields: Omit<VhdlDiagnostic, 'code' | 'slug' | 'severity' | 'stage' | 'fixes'> & { severity?: DigitalSeverity; fixes?: VhdlFix[] },
): VhdlDiagnostic {
  const info = VHDL_CODES[code];
  if (!info) throw new Error(`unknown VHDL diagnostic code ${code}`);
  const { severity, fixes, ...rest } = fields;
  return { code: info.code, slug: info.slug, severity: severity ?? info.severity, stage: info.stage, ...rest, fixes: fixes ?? [] };
}

/** Thrown by the throwing API (`instantiateVhdl`, `compileVhdlOrThrow`): carries every diagnostic. */
export class VhdlError extends Error {
  readonly diagnostics: VhdlDiagnostic[];
  constructor(diagnostics: VhdlDiagnostic[]) {
    const errors = diagnostics.filter(d => d.severity === 'error');
    const first = errors[0] ?? diagnostics[0];
    super(
      first
        ? `${first.code} ${first.message}${first.at ? ` at ${first.at}` : ''}${errors.length > 1 ? ` (+${errors.length - 1} more error${errors.length > 2 ? 's' : ''})` : ''}`
        : 'VHDL error',
    );
    this.name = 'VhdlError';
    this.diagnostics = diagnostics;
  }
}

/** Drop exact duplicates (same code, location and message), keeping the (deterministic) emission order. */
export function dedupeDiagnostics(ds: VhdlDiagnostic[]): VhdlDiagnostic[] {
  const seen = new Set<string>();
  const out: VhdlDiagnostic[] = [];
  for (const d of ds) {
    const key = `${d.code}|${d.at ?? ''}|${d.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(d);
  }
  return out;
}
