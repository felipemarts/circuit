/**
 * circuit-forge platform entry — what bench files import.
 *
 *   import { bench, VoltageSource, Resistor, LED } from 'circuit-forge';
 *
 * Browser-safe: no Node APIs here (the CLI and ledger live elsewhere).
 */

export { bench, elaborate, TB } from './elab/bench';
export type { BenchDescriptor, Elaboration, ValueLike } from './elab/bench';
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
export type { ComponentDef, StampContext } from './core/CustomComponent';
export { Resistor } from './components/Resistor';
export { VoltageSource } from './components/VoltageSource';
export { CurrentSource } from './components/CurrentSource';
export { Capacitor } from './components/Capacitor';
export { Inductor } from './components/Inductor';
export { Diode } from './components/Diode';
export { LED } from './components/LED';
export { Switch } from './components/Switch';
export { Button } from './components/Button';
