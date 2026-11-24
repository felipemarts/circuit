/**
 * Newton-Raphson now lives in the analysis engine (src/analysis/engine.ts),
 * which adds voltage limiting, gmin stepping and source stepping. This module
 * keeps the historical import path for the error/telemetry types.
 */
export { ConvergenceError } from '../analysis/engine';
export type { NRTelemetry, WorstDevice, AttemptTelemetry } from '../analysis/engine';
