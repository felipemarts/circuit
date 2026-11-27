/**
 * CircuitsVibe platform schema — the single source of truth for everything
 * the verification ladder produces. The CLI (`--json`), the ledger, tests,
 * and (later) the MCP server and browser UI all consume exactly these shapes.
 *
 * Design rules (see docs/VISION.md):
 *  - Every failure carries a stable code (F1xx structural, S2xx solver, A3xx assertion,
 *    P8xx board layout).
 *  - Fix suggestions carry a `confidence` contract: `verified` means the fix was
 *    SIMULATED and passes; `mechanical` means a deterministic transformation;
 *    `suggested` means heuristic. Never emit a fix referencing a capability
 *    that does not exist yet.
 *  - Default output is deterministic: no timestamps, stable ordering, so two
 *    identical runs diff clean.
 */

import type { PcbRecord } from '../pcb/types';

/** Ladder order: lint → op → dc → ac → tran → pcb (fail-fast). */
export type StageName = 'lint' | 'op' | 'dc' | 'ac' | 'tran' | 'pcb';

/** Canonical stage order. */
export const STAGE_ORDER: StageName[] = ['lint', 'op', 'dc', 'ac', 'tran', 'pcb'];

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

/** A scalar check on one measured number (op values, DC/AC measurements). */
export type ScalarCheck =
  | { op: 'within'; min: number; max: number }
  | { op: 'closeTo'; value: number; tol: number }
  | { op: 'above'; value: number }
  | { op: 'below'; value: number };

/** Serialized check — the closed assertion vocabulary. */
export type CheckSpec =
  | ScalarCheck
  // DC sweep (curve) checks — x is the swept value
  | { op: 'at'; x: number; check: ScalarCheck }
  | { op: 'slopeAt'; x: number; check: ScalarCheck }
  | { op: 'monotonic'; direction: 'increasing' | 'decreasing' }
  | { op: 'crosses'; level: number; min?: number; max?: number }
  // AC checks — gain in dB, phase in degrees, frequencies in Hz
  | { op: 'gainAt'; f: number; check: ScalarCheck }
  | { op: 'phaseAt'; f: number; check: ScalarCheck }
  | { op: 'bandwidth3dB'; check: ScalarCheck }
  | { op: 'unityGainFrequency'; check: ScalarCheck }
  | { op: 'phaseMargin'; check: ScalarCheck }
  // Transient (waveform) checks
  | { op: 'settleWithin'; target: number; tol: number; by: number }
  | { op: 'neverExceed'; value: number }
  | { op: 'stayAbove'; value: number; from?: number }
  | { op: 'stayBelow'; value: number; from?: number }
  | { op: 'rippleBelow'; amplitude: number; from?: number }
  | { op: 'finalCloseTo'; value: number; tol: number }
  // Logic (digital) checks — tran stage, on logic probes (tb.expect.logic)
  | { op: 'logicAt'; t: number; value: LogicLevel }
  | { op: 'logicEdges'; edge: 'rising' | 'falling' | 'both'; from?: number; to?: number; count?: number; min?: number; max?: number }
  | { op: 'logicFrequency'; value: number; tol: number; from?: number; to?: number }
  | { op: 'logicDutyCycle'; value: number; tol: number; from?: number; to?: number }
  | { op: 'logicStable'; from: number; to: number; value?: LogicLevel }
  // Serial-output checks — tran stage, probe = MCU id (tb.expect.serial)
  | { op: 'serialContains'; text: string; by?: number }
  | { op: 'serialNotContains'; text: string }
  | { op: 'serialMatches'; pattern: string; flags?: string }
  | { op: 'serialLines'; count?: number; min?: number; max?: number };

/** A logic value: 0, 1, unknown 'X' or high-impedance 'Z'. */
export type LogicLevel = 0 | 1 | 'X' | 'Z';

/** Logic-analyzer data of one transient run: value-change lists per signal. */
export interface LogicCapture {
  /** Transient configuration label (same as the probe keys). */
  config: string;
  /** Simulated end time (s). */
  tEnd: number;
  /** signal → [[t, value], …]; the first entry (t = 0) is the power-on value. */
  signals: Record<string, [number, LogicLevel][]>;
  /** Signals cut at the per-signal change limit. */
  truncated?: string[];
  /** Digital events processed. */
  events?: number;
}

/** Serial output of one MCU in one transient run. */
export interface SerialCapture {
  /** Transient configuration label (same as the probe keys). */
  config: string;
  /** MCU component id. */
  mcu: string;
  /** Complete lines as [completion time (s), text] (line terminators stripped). */
  lines: [number, string][];
  /** Text after the last line terminator: [time of its last chunk, text]. */
  partial?: [number, string];
  /** More lines than the capture limit (2000) were printed. */
  truncated?: boolean;
}

export interface AssertionSpec {
  id: string;
  stage: StageName;
  /** Probe grammar: "R1.i" | "D1.v" | "<netName>" (nets: op stage only). */
  probe: string;
  check: CheckSpec;
  /** Source location "file:line" of the tb.expect call. */
  at?: string;
  /** AC only: probe expression the probe is divided by (default: the AC stimulus). */
  ref?: string;
  /** Transient config this assertion runs under (tran stage only). */
  tran?: TranConfig;
  /** DC sweep this assertion runs under (dc stage only). */
  dc?: DcSweepConfig;
  /** AC sweep this assertion runs under (ac stage only). */
  ac?: AcSweepConfig;
}

/** Transient analysis settings (all times in seconds). */
export interface TranConfig {
  tstop: number;
  /** Initial step; also the step ceiling unless maxStep is given. */
  dt: number;
  maxStep?: number;
  /** Step floor: a step that must shrink below it fails with S203 (default maxStep·1e-9). */
  minStep?: number;
  /** Default 'trap' (BE right after t = 0 and every breakpoint). */
  method?: 'trap' | 'be';
  /** 'zero' (default): caps 0 V, inductors 0 A at t = 0; 'op': start from the DC operating point. */
  ic?: 'zero' | 'op';
  /** Relative truncation-error tolerance (default 1e-3). */
  reltol?: number;
}

/** DC sweep: the DC value of a source (`source`) or the value of a component (`param`). */
export interface DcSweepConfig {
  source?: string;
  param?: string;
  from: number;
  to: number;
  points: number;
}

/** Logarithmic AC sweep. */
export interface AcSweepConfig {
  from: number;
  to: number;
  pointsPerDecade: number;
}

/** AC probe options: the reference the probe is divided by. */
export interface AcProbeRef {
  /** Probe expression of the denominator (default: the AC stimulus phasor). */
  ref?: string;
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
  /** AC only: reference probe of the ratio (absent = the stimulus). */
  ref?: string;
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
  /** Why a measurement could not be made (e.g. no -3 dB crossing inside the sweep). */
  note?: string;
  /** Sweep value of the first violation (dc: x, ac: Hz). */
  xFirstViolation?: number;
  /** Logic assertions: the logic value measured (when it is not a number, e.g. 'X'). */
  measuredLogic?: LogicLevel;
}

export interface NetlistComponent {
  id: string;
  type: string;
  /** Plain-JSON configuration; enough to rebuild an identical component. */
  params: Record<string, ParamValue>;
  /** pin name -> net name */
  pins: Record<string, string>;
  free?: ParamSpec;
  /** Source location "file:line" of the tb.add call. */
  at?: string;
}

/** JSON value of a component parameter (numbers, booleans, waveform objects). */
export type ParamValue = number | boolean | string | ParamValue[] | { [key: string]: ParamValue };

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
  solver?: SolverRecord;
  assertions?: AssertionResult[];
  /** tran: logic-analyzer capture per transient run (mixed-signal / digital benches). */
  logic?: LogicCapture[];
  /** tran: serial output of each microcontroller per transient run (timestamped lines). */
  serial?: SerialCapture[];
  /**
   * Real-part datasheet checks (absolute maximum ratings of Part() devices),
   * kept apart from the bench's own assertions (the simulated spec). Present
   * on op, dc and tran when the circuit contains catalog parts.
   */
  ratings?: RatingResult[];
  /** pcb: the board layout — placements, unplaced parts, ratsnest (see src/pcb/types.ts). */
  pcb?: PcbRecord;
}

/**
 * One absolute-maximum-rating check of a catalog part (Part('2N3904')…).
 * Values are magnitudes in the rated sense (e.g. Vce of an NPN, |Vce| of a
 * PNP). A failing entry carries code R401–R404, message, note, fixes and the
 * tb.add location; its confidence is 'verified' because the value was simulated
 * (`modelEstimated` says when the part's model card is itself a fit).
 */
export interface RatingResult {
  /** R401 voltage · R402 continuous current · R403 pulsed/surge current · R404 power. */
  code: string;
  slug: string;
  verdict: 'pass' | 'fail';
  /** Component id in the bench. */
  component: string;
  /** Catalog part id. */
  part: string;
  /** Rating name as in the catalog (Vceo, IcMax, Vds, Vgs, Id25, IF, IFSM, Pd…). */
  rating: string;
  /** What is rated, in words. */
  description: string;
  /** Probe the value comes from (e.g. 'Q1.vce'). */
  quantity: string;
  /**
   * How the stage value is reduced: 'value' (op), 'peak' (largest over the dc
   * sweep or the transient window), 'average' (time average over the
   * transient window — continuous-current ratings that have a pulsed
   * companion, and Pd).
   */
  measure: 'value' | 'peak' | 'average';
  /** Datasheet absolute maximum (magnitude). */
  limit: number;
  /** tb.ratings({ derate }) factor, when not 1. */
  derate?: number;
  /** limit × derate: the number the value is compared with. */
  allowed: number;
  unit: string;
  /** The compared value (magnitude). */
  value: number;
  /** value / allowed. */
  utilization: number;
  /** allowed − value (negative when exceeded). */
  margin: number;
  /** tran: time of the peak (s). */
  time?: number;
  /** tran: first time the instantaneous value exceeded the allowed value. */
  tFirstViolation?: number;
  /** tran 'average': the averaging window [from, to] (s). */
  window?: [number, number];
  /** dc: sweep value where the peak occurred. */
  x?: number;
  /** dc/tran: which sweep / transient configuration. */
  config?: string;
  /** Datasheet test conditions of the rating (e.g. { TA: 25 }). */
  conditions?: Record<string, number | string>;
  /** Citation of the rating: publisher, document, revision. */
  source: string;
  url?: string;
  /** The rating value itself is estimated (catalog flag). */
  estimated?: boolean;
  /** The part's model card is estimated (fitted), so the simulated value inherits its error. */
  modelEstimated?: boolean;
  confidence: 'verified';
  message?: string;
  note?: string;
  fixes?: Fix[];
  at?: string;
  hint?: VerifiedParamHint;
}

export interface SolverAttempt {
  strategy: 'newton' | 'gmin-stepping' | 'source-stepping';
  iterations: number;
  converged: boolean;
  steps?: number;
}

/** Stage solver telemetry. */
export interface SolverRecord {
  method: 'linear' | 'newton-raphson' | 'trap' | 'be' | 'complex-lu';
  /** Total Newton iterations. */
  iterations?: number;
  /** op: convergence aids that had to be used (absent when plain Newton converged). */
  aids?: ('gmin-stepping' | 'source-stepping')[];
  /** op: every strategy tried, in order (only when plain Newton failed). */
  attempts?: SolverAttempt[];
  /** dc: swept points solved; ac: frequencies solved. */
  points?: number;
  /** dc: points that needed convergence aids. */
  aidedPoints?: number;
  /** tran: one entry per distinct transient configuration. */
  runs?: TranRunTelemetry[];
  /** tran totals over runs. */
  acceptedSteps?: number;
  rejectedSteps?: number;
  minStep?: number;
}

export interface TranRunTelemetry {
  config: TranConfig;
  method: 'trap' | 'be';
  acceptedSteps: number;
  rejectedSteps: number;
  newtonFailures: number;
  lteRejections: number;
  minStep: number;
  maxStepTaken: number;
  breakpoints: number;
  newtonIterations: number;
  /** Mixed-signal: step attempts cut back to a logic threshold crossing. */
  eventCuts?: number;
  /** Mixed-signal / digital: digital events processed. */
  digitalEvents?: number;
}

export interface RunRecord {
  schema: 'circuitsvibe-run/0.1';
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
