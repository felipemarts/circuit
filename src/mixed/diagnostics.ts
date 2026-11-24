/**
 * Mixed-signal diagnostic codes (bench-level digital lint and the analog↔digital
 * bridge runtime). Registered in src/verify/registry.ts and docs/DIAGNOSTICS.md.
 *
 *   F135–F139  bench-level digital lint (pre-simulation)
 *   D508–D549  mixed-signal runtime (op and tran stages)
 */
import type { Diagnostic, Fix, Severity, StageName } from '../schema/types';

export interface MixedCodeInfo {
  code: string;
  slug: string;
  /** Default severity ('error / warning' codes pick per case). */
  severity: Severity;
  stage: 'lint' | 'runtime';
  title: string;
}

export const MIXED_CODES: Record<string, MixedCodeInfo> = {
  F135: { code: 'F135', slug: 'ic-supply-unconnected', severity: 'error', stage: 'lint', title: 'IC supply pin (VCC/GND) unconnected or shorted to the other' },
  F136: { code: 'F136', slug: 'outputs-tied', severity: 'error', stage: 'lint', title: 'two push-pull logic outputs on one analog net' },
  F137: { code: 'F137', slug: 'floating-logic-input', severity: 'error', stage: 'lint', title: 'logic input with nothing that sets its voltage' },
  F138: { code: 'F138', slug: 'output-on-rail', severity: 'error', stage: 'lint', title: 'logic output tied to ground or to an ideal source' },
  D508: { code: 'D508', slug: 'input-forbidden-zone', severity: 'error', stage: 'runtime', title: 'logic input between VIL and VIH for too long' },
  D509: { code: 'D509', slug: 'supply-out-of-range', severity: 'error', stage: 'runtime', title: 'IC supply outside its operating range (error above the absolute maximum)' },
  D510: { code: 'D510', slug: 'ic-unpowered', severity: 'error', stage: 'runtime', title: 'IC unpowered (supply below half the minimum operating voltage)' },
  D511: { code: 'D511', slug: 'output-overcurrent', severity: 'error', stage: 'runtime', title: 'logic output current above the absolute maximum (overload or contention)' },
  D512: { code: 'D512', slug: 'unknown-output', severity: 'warning', stage: 'runtime', title: 'an X (unknown) logic value drives an analog net' },
  D513: { code: 'D513', slug: 'input-clamp-overcurrent', severity: 'error', stage: 'runtime', title: 'input protection-diode current above the absolute maximum' },
  D514: { code: 'D514', slug: 'no-static-logic-state', severity: 'warning', stage: 'runtime', title: 'no consistent DC logic state (the circuit oscillates)' },
};

export function mixedDiagnostic(
  code: keyof typeof MIXED_CODES,
  stage: StageName,
  fields: {
    message: string;
    severity?: Severity;
    subject?: Diagnostic['subject'];
    note?: string;
    evidence?: Record<string, unknown>;
    fixes?: Fix[];
    at?: string;
    time?: number;
  },
): Diagnostic & { time?: number } {
  const info = MIXED_CODES[code];
  const d: Diagnostic & { time?: number } = {
    code: info.code,
    slug: info.slug,
    severity: fields.severity ?? info.severity,
    stage,
    message: fields.message,
    ...(fields.subject ? { subject: fields.subject } : {}),
    ...(fields.time !== undefined ? { time: fields.time } : {}),
    ...(fields.note ? { note: fields.note } : {}),
    ...(fields.evidence ? { evidence: fields.evidence } : {}),
    fixes: fields.fixes ?? [],
    ...(fields.at ? { at: fields.at } : {}),
  };
  return d;
}
