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

// Circuit document (circuitsvibe-circuit/1) and share-by-URL links.
export * from './doc';
// Printed circuit board: footprint library, default assignment, layout + checks (P801–P807).
export { getFootprint, footprintCatalog } from './pcb/footprints';
export { defaultFootprint, pinMap } from './pcb/assign';
export { layoutBoard, buildRatsnest } from './pcb/layout';
export type { BoardLayout, PlacedPart, PlacedPad } from './pcb/layout';
export { routeBoard } from './pcb/route';
export type { NetPlan, RouteOutput } from './pcb/route';
export { checkDesignRules } from './pcb/drc';
export type { DrcViolation } from './pcb/drc';
export { traceCapacity, requiredWidth } from './pcb/ipc2221';
export { normalizeBoard, normalizePlacement, normalizeFootprintDef, parseLength } from './pcb/normalize';
export type { BoardInput, PlacementInput, FootprintInput, LengthLike } from './pcb/normalize';
export type * from './pcb/types';
// Viewer helpers (browser-safe, no DOM): auto-layout, symbols, the browser simulation driver and panel models.
export { layoutCircuit } from './view/layout';
export type { Layout as SchematicLayout, PlacedComponent, Wire as SchematicWire, Port as SchematicPort } from './view/layout';
export { symbolFor } from './view/symbols';
export type { SymbolGeom, PinGeom } from './view/symbols';
export { simulateDoc } from './view/simulate';
export type { SimResult, SimProgress, TranData, AcData, DcData, OpState } from './view/simulate';
export { verdictModel, assertionModels, diagnosticModels, ratingGroups, scopeModel, bodeModel, dcModel, logicModel, highlightModels } from './view/models';
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
export { NPN, PNP, BJT } from './components/BJT';
export type { BjtParams, GummelPoonPoint } from './components/BJT';
export { NMOS, PMOS, MOSFET } from './components/MOSFET';
export type { MosfetParams, MosfetInstance, Level1Point } from './components/MOSFET';
export type { DiodeParams } from './components/Diode';
export { semiPart, semiPartIds, partModelInfo, partUnsupportedReason } from './components/Part';
export type { PartDevice, PartModelInfo } from './components/Part';
export { parseSpiceModel, parseSpiceNumber } from './components/semi/spiceModel';
export type { ParsedModel, ModelDiagnostic } from './components/semi/spiceModel';
export { findPart, PARTS } from './parts';
export { Switch } from './components/Switch';
export { Button } from './components/Button';
export { IdealOpAmp, OpAmp, Comparator, OPAMP_DEFAULTS, COMPARATOR_DEFAULTS, opampPart, opampPartParams, comparatorPartParams } from './opamps';
export type { IdealOpAmpParams, OpAmpParams, ComparatorParams } from './opamps';
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

// Real parts: one Part() over every family (logic ICs + NE555, semiconductors; src/elab/part.ts).
// Mixed-signal: generic logic primitives, logic assertions.
export { Part, PART_RESOLVERS, partIds } from './elab/part';
export type { PartOptions, PartResolver } from './elab/part';
export { icPart, icPartIds } from './mixed/part';
export {
  LogicIC,
  LogicPrimitive,
  Buf,
  Not,
  And,
  Or,
  Nand,
  Nor,
  Xor,
  Xnor,
  TriBuf,
  Mux,
  DFF,
  JKFF,
  DLatch,
  Counter,
  ShiftRegister,
  Clock,
  Stimulus,
  Const,
  Pull,
} from './mixed/device';
export type { IcOptions, BridgeOptions } from './mixed/device';
export { LogicExpect } from './elab/logic';
export { toLogicVCD } from './mixed/vcd';
export { ReactiveState } from './analysis/integration';
export type { LoadContext, AcLoadContext, StepContext, InitContext, AcceptContext, Phasor } from './analysis/context';
export { SimulationSystem, TransientEngine, ConvergenceError, TimestepTooSmallError, NoAcModelError } from './analysis/engine';
export type { OpTelemetry, TranTelemetry, TransientOptions, NRTelemetry } from './analysis/engine';

// Microcontrollers (Arduino-style TypeScript firmware, src/mcu) and VHDL blocks (src/vhdl) as bench components.
export { runLadderAsync } from './verify/ladder';
export { AsyncAnalysisError } from './analysis/steps';
export { Mcu, ArduinoUno, mcuPart, mcuPartIds } from './mixed/mcu';
export type { McuOptions, McuPwmMode, FirmwareInput } from './mixed/mcu';
export { VhdlBlock } from './mixed/vhdl-block';
export type { VhdlBlockOptions, VhdlBlockPort } from './mixed/vhdl-block';
export { SerialExpect } from './elab/serial';
export { MCU_PROFILES, getMcuProfile } from './mcu/profiles';
export { MCU_ELECTRICAL } from './mcu/electrical';
export type { McuElectrical } from './mcu/electrical';
export { compileFirmware, instantiateFirmware, setFirmwareHost } from './mcu/firmware';
export type { FirmwareBundle, FirmwareHost } from './mcu/firmware';
export type { McuProfile, Firmware } from './mcu/types';
export { compileVhdl } from './vhdl/design';
export type { VhdlSource } from './vhdl/source';
