/**
 * Digital diagnostics — plain data, stable codes.
 *
 *   D501–D549  digital runtime / timing (emitted while simulating)
 *   F130–F139  digital lint (structural, before simulating)
 *
 * A DigitalDiagnostic is structurally a platform `Diagnostic` (see the
 * compile-time check at the bottom) plus `time` (seconds) for runtime codes
 * and a `nets` list in `subject`, so the integrator can merge both streams
 * into one RunRecord without conversion.
 */
import type { Diagnostic } from '../schema/types';

export type DigitalSeverity = 'error' | 'warning';
export type DigitalFixConfidence = 'verified' | 'mechanical' | 'suggested';

export interface DigitalFix {
  kind: string;
  confidence: DigitalFixConfidence;
  detail: string;
  patch?: string;
}

export interface DigitalDiagnostic {
  code: string;
  slug: string;
  severity: DigitalSeverity;
  /** 'lint' for F13x, 'tran' for D5xx (the digital engine runs inside the transient stage). */
  stage: 'lint' | 'tran';
  message: string;
  subject?: {
    net?: string;
    nets?: string[];
    components?: string[];
    pins?: string[];
  };
  /** Simulated time in seconds (runtime codes only). */
  time?: number;
  note?: string;
  evidence?: Record<string, unknown>;
  fixes: DigitalFix[];
  at?: string;
}

export interface DigitalCodeInfo {
  code: string;
  slug: string;
  severity: DigitalSeverity;
  stage: 'lint' | 'tran';
  title: string;
}

/** Every code this module can emit. Registered in src/verify/registry.ts and docs/DIAGNOSTICS.md. */
export const DIGITAL_CODES: Record<string, DigitalCodeInfo> = {
  D501: { code: 'D501', slug: 'drive-contention', severity: 'error', stage: 'tran', title: 'strong 0 and strong 1 drive the same net' },
  D502: { code: 'D502', slug: 'setup-violation', severity: 'error', stage: 'tran', title: 'setup time violated at a clock edge' },
  D503: { code: 'D503', slug: 'hold-violation', severity: 'error', stage: 'tran', title: 'hold time violated after a clock edge' },
  D504: { code: 'D504', slug: 'delta-cycle-limit', severity: 'error', stage: 'tran', title: 'zero-delay activity did not settle (delta-cycle limit)' },
  D505: { code: 'D505', slug: 'drive-in-past', severity: 'error', stage: 'tran', title: 'external drive scheduled before the current time' },
  D506: { code: 'D506', slug: 'unknown-control', severity: 'warning', stage: 'tran', title: 'clock or async control is X/Z' },
  D507: { code: 'D507', slug: 'weak-contention', severity: 'warning', stage: 'tran', title: 'weak 0 and weak 1 (pull-up vs pull-down) on the same net' },
  F130: { code: 'F130', slug: 'floating-input', severity: 'error', stage: 'lint', title: 'input pin on a net with no driver' },
  F131: { code: 'F131', slug: 'multiple-drivers', severity: 'error', stage: 'lint', title: 'push-pull output shares a net with other drivers' },
  F132: { code: 'F132', slug: 'output-short', severity: 'error', stage: 'lint', title: 'outputs shorted together' },
  F133: { code: 'F133', slug: 'zero-delay-loop', severity: 'error', stage: 'lint', title: 'combinational loop with zero total delay' },
  F134: { code: 'F134', slug: 'unconnected-clock', severity: 'error', stage: 'lint', title: 'clock input not driven' },
};

export function makeDiagnostic(
  code: keyof typeof DIGITAL_CODES | string,
  fields: Omit<DigitalDiagnostic, 'code' | 'slug' | 'severity' | 'stage'> & { severity?: DigitalSeverity },
): DigitalDiagnostic {
  const info = DIGITAL_CODES[code];
  if (!info) throw new Error(`unknown digital diagnostic code ${code}`);
  const { severity, ...rest } = fields;
  const d: DigitalDiagnostic = { code: info.code, slug: info.slug, severity: severity ?? info.severity, stage: info.stage, ...rest };
  return d;
}

// Compile-time contract: a DigitalDiagnostic can be pushed into a RunRecord's diagnostics[].
type _Assignable = DigitalDiagnostic extends Diagnostic ? true : never;
const _assignable: _Assignable = true;
void _assignable;
