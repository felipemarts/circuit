/**
 * circuitsvibe platform entry — what bench files import.
 *
 *   import { bench, VoltageSource, Resistor, LED } from 'circuitsvibe';
 *
 * Browser-safe: no Node APIs here (the CLI and ledger live elsewhere).
 */

export { bench, elaborate, TB } from './elab/bench';
export type { BenchDescriptor, Elaboration, ValueLike, TranInput } from './elab/bench';
export { DcExpect, DcProbeExpect, CrossExpect, AcExpect, AcProbeExpect, ScalarExpect } from './elab/expect';
export type { DcSweepInput, AcSweepInput } from './elab/expect';
export { describeComponent, buildComponent } from './elab/describe';
export { runSweep, sweepValues } from './verify/dc';
export type { SweepCurve, SweepOutcome } from './verify/dc';
export { parseValue, formatEng } from './elab/units';

export { runLadder } from './verify/ladder';
export type { LadderOptions } from './verify/ladder';
export { runLint } from './verify/lint';
export { renderHuman } from './report/human';
export { DIAGNOSTIC_DOCS, findDiagnosticDoc } from './verify/registry';

export * from './schema/types';
export { ENGINE } from './schema/version';

// Engine surface (same exports as the library root).
export { Circuit } from './core/Circuit';
export { Pin } from './core/Pin';
export { Node } from './core/Node';
export { Component } from './core/Component';
export { TwoTerminalComponent } from './core/TwoTerminalComponent';
export { CustomComponent, defineComponent } from './core/CustomComponent';
export type { ComponentDef, StampContext, AcStampContext } from './core/CustomComponent';
export { Resistor } from './components/Resistor';
export { VoltageSource } from './components/VoltageSource';
export { CurrentSource } from './components/CurrentSource';
export { Capacitor } from './components/Capacitor';
export { Inductor } from './components/Inductor';
export { Diode } from './components/Diode';
export { LED } from './components/LED';
export { Switch } from './components/Switch';
export { Button } from './components/Button';
export type { SourceOptions, AcStimulus } from './components/source';
export type {
  WaveformSpec,
  SinWave,
  PulseWave,
  PwlWave,
  PwmWave,
  SinInput,
  PulseInput,
  PwlInput,
  PwmInput,
} from './components/waveforms';
export { waveformValue, waveformNextBreakpoint } from './components/waveforms';
export { pnjlim, fetlim, limvds, junctionVcrit } from './solver/limiting';
export { ReactiveState } from './analysis/integration';
export type { LoadContext, AcLoadContext, StepContext, InitContext, AcceptContext, Phasor } from './analysis/context';
export { SimulationSystem, TransientEngine, ConvergenceError, TimestepTooSmallError, NoAcModelError } from './analysis/engine';
export type { OpTelemetry, TranTelemetry, TransientOptions, NRTelemetry } from './analysis/engine';
