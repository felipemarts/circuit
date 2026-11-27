import type { Diagnostic, Fix } from '../schema/types';

/**
 * T010–T029: circuit document and share-link tooling codes. Registered (with
 * long explanations) in src/verify/registry.ts and listed in docs/DIAGNOSTICS.md.
 * They are tooling faults: a RunRecord carrying one exits 3.
 */
export const DOC_CODES = {
  T010: 'invalid-circuit-document',
  T011: 'unsupported-circuit-schema',
  T012: 'unknown-component-type',
  T013: 'custom-component-not-serializable',
  T014: 'invalid-component',
  T015: 'share-payload-too-large',
  T016: 'malformed-share-link',
  T017: 'unsupported-share-encoding',
  T018: 'long-share-link',
  T019: 'custom-code-not-allowed',
  T020: 'circuit-service-error',
} as const;

export type DocCode = keyof typeof DOC_CODES;

export function docDiagnostic(
  code: DocCode,
  message: string,
  extra: { path?: string; components?: string[]; note?: string; fixes?: Fix[]; evidence?: Record<string, unknown>; severity?: 'error' | 'warning' } = {},
): Diagnostic {
  const evidence = { ...(extra.path !== undefined ? { path: extra.path } : {}), ...(extra.evidence ?? {}) };
  return {
    code,
    slug: DOC_CODES[code],
    severity: extra.severity ?? 'error',
    stage: 'lint',
    message,
    ...(extra.components && extra.components.length > 0 ? { subject: { components: extra.components } } : {}),
    ...(extra.note ? { note: extra.note } : {}),
    ...(Object.keys(evidence).length > 0 ? { evidence } : {}),
    fixes: extra.fixes ?? [],
  };
}

/**
 * Thrown by toCircuitDoc / benchFromDoc / encodeShareUrl / decodeShareUrl.
 * `code` is the first diagnostic's code; `diagnostics` holds all of them.
 */
export class CircuitDocError extends Error {
  readonly code: string;
  readonly diagnostics: Diagnostic[];
  constructor(diagnostics: Diagnostic[]) {
    const first = diagnostics[0];
    const more = diagnostics.length > 1 ? ` (+${diagnostics.length - 1} more)` : '';
    super(`${first.code} ${first.slug}: ${first.message}${more}`);
    this.name = 'CircuitDocError';
    this.code = first.code;
    this.diagnostics = diagnostics;
  }
}

/** Structural check (works across bundle copies, unlike instanceof). */
export function isCircuitDocError(err: unknown): err is CircuitDocError {
  return (
    err instanceof Error &&
    err.name === 'CircuitDocError' &&
    Array.isArray((err as { diagnostics?: unknown }).diagnostics)
  );
}
