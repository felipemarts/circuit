/**
 * Circuit Forge platform schema — the single source of truth for everything
 * the verification ladder produces. The CLI (`--json`), the ledger, tests,
 * and (later) the MCP server and browser UI all consume exactly these shapes.
 *
 * Design rules (see docs/VISION.md):
 *  - Every failure carries a stable code (F1xx structural, S2xx solver, A3xx assertion).
 *  - Fix suggestions carry a `confidence` contract: `verified` means the fix was
 *    SIMULATED and passes; `mechanical` means a deterministic transformation;
 *    `suggested` means heuristic. Never emit a fix referencing a capability
 *    that does not exist yet.
 *  - Default output is deterministic: no timestamps, stable ordering, so two
 *    identical runs diff clean.
 */

export type StageName = 'lint' | 'op' | 'tran';

export type Severity = 'error' | 'warning';

export type FixConfidence = 'verified' | 'mechanical' | 'suggested';

export interface Fix {
  kind: string;
  confidence: FixConfidence;
  /** Human-readable imperative instruction ("add a bleed resistor from n3 to gnd"). */
  detail: string;
  /** Optional code patch the agent can apply as-is. */
  patch?: string;
}

export interface Diagnostic {
  /** Stable code, e.g. "F101". Never reworded away — parsers may key on it. */
  code: string;
  slug: string;
  severity: Severity;
  stage: StageName;
  /** One line, lowercase, root cause first. */
  message: string;
  subject?: {
    net?: string;
    components?: string[];
    pins?: string[];
  };
  /** The physics reason this is wrong. */
  note?: string;
  /** Machine-readable evidence (iterations, residuals, oscillation window...). */
  evidence?: Record<string, unknown>;
  fixes: Fix[];
  /** Source location (file:line) of the component/wiring that caused this, when known. */
  at?: string;
}

/** Serialized check — the closed assertion vocabulary. */
export type CheckSpec =
  | { op: 'within'; min: number; max: number }
  | { op: 'closeTo'; value: number; tol: number }
  | { op: 'above'; value: number }
  | { op: 'below'; value: number }
  | { op: 'settleWithin'; target: number; tol: number; by: number }
  | { op: 'neverExceed'; value: number }
  | { op: 'stayAbove'; value: number; from?: number }
  | { op: 'stayBelow'; value: number; from?: number }
  | { op: 'rippleBelow'; amplitude: number; from?: number }
  | { op: 'finalCloseTo'; value: number; tol: number };

export interface AssertionSpec {
  id: string;
  stage: StageName;
  /** Probe grammar: "R1.i" | "D1.v" | "<netName>" (nets: op stage only). */
  probe: string;
  check: CheckSpec;
  /** Source location "file:line" of the tb.expect call. */
  at?: string;
  /** Transient config this assertion runs under (tran stage only). */
  tran?: { tstop: number; dt: number };
}

export interface ParamSpec {
  min: number;
  max: number;
  scale: 'lin' | 'log';
}

/** Verified-by-simulation sizing hint attached to a failed assertion. */
export interface VerifiedParamHint {
  kind: 'verified-param-range';
  param: string;
  /** Range of sampled values where ALL op-stage assertions pass. */
  passingRange: [number, number];
  suggestedValue: number;
  /** Sampled values that were simulated and passed every op assertion. */
  passingSamples: number[];
  note: string;
}

export interface AssertionResult {
  id: string;
  stage: StageName;
  probe: string;
  check: CheckSpec;
  verdict: 'pass' | 'fail';
  measured?: number;
  /** For band checks: how far out, as absolute and ratio. */
  margin?: { outsideBy: number; ratio?: number };
  /** Simulated time of the first violation (tran checks). */
  tFirstViolation?: number;
  /** Waveform excerpt around the first violation (tran checks): [t, value] pairs. */
  excerpt?: [number, number][];
  at?: string;
  hint?: VerifiedParamHint;
}

export interface NetlistComponent {
  id: string;
  type: string;
  params: Record<string, number | boolean>;
  /** pin name -> net name */
  pins: Record<string, string>;
  free?: ParamSpec;
  /** Source location "file:line" of the tb.add call. */
  at?: string;
}

export interface NetlistDoc {
  /** FNV-1a 64-bit hash (hex) of the canonical netlist. Identity, not crypto. */
  hash: string;
  components: NetlistComponent[];
  /** net name -> sorted "componentId.pin" refs */
  nets: Record<string, string[]>;
}

export interface StageRecord {
  verdict: 'pass' | 'fail' | 'error' | 'skipped';
  reason?: string;
  /** Probe values measured in this stage (op: scalars). */
  probes?: Record<string, number>;
  solver?: { method: 'linear' | 'newton-raphson'; iterations?: number };
  assertions?: AssertionResult[];
}

export interface RunRecord {
  schema: 'forge-run/0.1';
  bench: string;
  netlist: NetlistDoc;
  /** Engine + package version pin, for replay comparisons. */
  engine: string;
  /** Parameter overrides applied to this run (from --set / micro-sweeps). */
  overrides?: Record<string, number>;
  stages: Partial<Record<StageName, StageRecord>>;
  diagnostics: Diagnostic[];
  verdict: 'pass' | 'fail' | 'error';
  /** Assertion id or diagnostic code of the first failure. */
  firstFailure?: string;
  /**
   * Exit-code contract:
   *   0 = all requested stages pass
   *   1 = assertion failure (circuit valid, spec not met — tune values/topology)
   *   2 = diagnostic error (circuit invalid or unsolvable — fix structure first)
   *   3 = tooling/internal error (bench threw, bad flags, engine bug)
   */
  exitCode: 0 | 1 | 2 | 3;
}
