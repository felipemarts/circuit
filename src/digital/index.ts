/**
 * circuitsvibe digital engine — event-driven 4-valued logic simulation with
 * a co-simulation API for the analog transient. Browser-safe, zero deps.
 * See src/digital/README.md.
 */

export {
  DigitalCircuit,
  DigitalPart,
  DigitalPin,
  partFromJSON,
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
  Const,
  Pull,
  Stimulus,
  Behavioral,
} from './circuit';
export type { DigitalCircuitOptions } from './circuit';

export { registerBehavior, hasBehavior } from './behavior';
export type { BehaviorFactory } from './behavior';
export type { Host, Model, ModelCtx } from './model';

export { DigitalSim } from './sim';
export type { DigitalSimOptions, DigitalChange, NetTrace, DigitalRecording, DigitalStats } from './sim';

export { lintDigital } from './lint';
export { toVCD } from './vcd';

export {
  valueAt,
  edgeTimes,
  edgeCount,
  period,
  frequency,
  dutyCycle,
  firstTime,
  checkValueAt,
  checkStable,
} from './measure';
export type { EdgeKind, MeasureWindow, LogicVerdict } from './measure';

export {
  logicAnd,
  logicOr,
  logicXor,
  logicNot,
  logicBuf,
  logicNand,
  logicNor,
  logicXnor,
  resolveLogic,
  parseLogic,
} from './logic';
export type { Logic, Strength, ResolvedLogic } from './logic';

export { DIGITAL_CODES } from './diagnostics';
export type { DigitalDiagnostic, DigitalFix, DigitalCodeInfo } from './diagnostics';

export { PART_DEFS, DEFAULT_DELAY, gatePins } from './parts';
export type {
  PartDef,
  PartParams,
  PinLayout,
  DelayLike,
  TimingOptions,
  GateOptions,
  TriBufOptions,
  MuxOptions,
  SequentialOptions,
  FlipFlopOptions,
  LatchOptions,
  CounterOptions,
  ShiftRegisterOptions,
  ClockOptions,
  StimulusOptions,
  BehavioralOptions,
  JsonValue,
} from './parts';

export { DIGITAL_NETLIST_SCHEMA } from './netlist';
export type { DigitalNetlist, DigitalNetlistComponent, DigitalInputPort } from './netlist';

export { TICKS_PER_SECOND, parseTime, toTicks, fromTicks } from './units';
export type { ValueLike } from './units';
