import type { Component } from '../core/Component';
import { Resistor } from '../components/Resistor';
import { Capacitor } from '../components/Capacitor';
import { Inductor } from '../components/Inductor';
import { VoltageSource } from '../components/VoltageSource';
import { CurrentSource } from '../components/CurrentSource';
import { Diode } from '../components/Diode';
import { LED } from '../components/LED';
import { Switch } from '../components/Switch';
import { Button } from '../components/Button';
import { NPN, PNP } from '../components/BJT';
import { NMOS, PMOS, type MosfetParams } from '../components/MOSFET';
import { Part } from '../components/Part';
import type { DiodeParams } from '../components/Diode';
import { CustomComponent, type ComponentDef } from '../core/CustomComponent';
import type { SourceOptions } from '../components/source';
import type { ParamValue } from '../schema/types';

export interface ComponentInfo {
  type: string;
  params: Record<string, ParamValue>;
}

/**
 * Components are identified by their `kind` tag, NOT by instanceof: the CLI
 * bundles the platform separately from the user's bench file, so two copies
 * of every class can coexist at runtime. Structural identity is the contract.
 */
export function kindOf(comp: Component): string {
  return (comp as { kind?: string }).kind ?? comp.constructor.name;
}

/** Canonical type name + electrical params, for the netlist document. */
export function describeComponent(comp: Component): ComponentInfo {
  switch (kindOf(comp)) {
    case 'LED':
    case 'Diode':
    case 'NPN':
    case 'PNP':
    case 'NMOS':
    case 'PMOS': {
      // Semiconductors: Diode/LED always carry Is, n, Vt; every other model
      // parameter appears when it differs from its SPICE default; catalog
      // parts carry part: '<id>' (rebuilt from the catalog).
      const d = comp as unknown as { describeParams(): Record<string, ParamValue> };
      return { type: kindOf(comp), params: d.describeParams() };
    }
    case 'Resistor':
      return { type: 'Resistor', params: { r: (comp as Resistor).resistance } };
    case 'Capacitor':
      return { type: 'Capacitor', params: { c: (comp as Capacitor).capacitance } };
    case 'Inductor':
      return { type: 'Inductor', params: { l: (comp as Inductor).inductance } };
    case 'VoltageSource':
      return { type: 'VoltageSource', params: (comp as VoltageSource).describeParams() as Record<string, ParamValue> };
    case 'CurrentSource':
      return { type: 'CurrentSource', params: (comp as CurrentSource).describeParams() as Record<string, ParamValue> };
    case 'Switch':
      return { type: 'Switch', params: { closed: (comp as Switch).closed } };
    case 'Button':
      return { type: 'Button', params: { pressed: (comp as Button).pressed } };
    default: {
      // defineComponent parts carry their params in _params; without them,
      // electrically different custom circuits would share a netlist hash.
      const custom = (comp as { _params?: Record<string, number> })._params;
      const params: Record<string, number> = {};
      if (custom && typeof custom === 'object') {
        for (const [key, value] of Object.entries(custom)) {
          if (typeof value === 'number' && Number.isFinite(value)) params[key] = value;
        }
      }
      return { type: kindOf(comp), params };
    }
  }
}

/**
 * Rebuild a single-scalar component with a new value — used by `--set`
 * overrides and by verified-hint micro-sweeps.
 */
export function rebuildWithValue(comp: Component, value: number): Component {
  switch (kindOf(comp)) {
    case 'Resistor':
      return new Resistor(value);
    case 'Capacitor':
      return new Capacitor(value);
    case 'Inductor':
      return new Inductor(value);
    case 'VoltageSource': {
      // An override sets the DC value; waveform and AC stimulus are kept.
      const original = comp as VoltageSource;
      const rebuilt = new VoltageSource(sourceOptions(value, original.waveform, original.acStimulus));
      rebuilt.acAmplitude = original.acAmplitude;
      rebuilt.frequency = original.frequency;
      return rebuilt;
    }
    case 'CurrentSource': {
      const original = comp as CurrentSource;
      return new CurrentSource(sourceOptions(value, original.waveform, original.acStimulus));
    }
    default:
      throw new Error(
        `cannot override '${kindOf(comp)}' with a scalar value; only Resistor, Capacitor, Inductor, VoltageSource and CurrentSource support --set / tb.param overrides`,
      );
  }
}

/** Whether the component can override/sweep its scalar value. */
export function isOverridable(comp: Component): boolean {
  return ['Resistor', 'Capacitor', 'Inductor', 'VoltageSource', 'CurrentSource'].includes(kindOf(comp));
}

/**
 * Whether the component provides a DC conduction path between its pins.
 * Capacitors are open at DC; current sources do not fix node voltages.
 * Unknown/custom components are assumed conductive to avoid false positives.
 */
export function conductsAtDC(comp: Component): boolean {
  const kind = kindOf(comp);
  return kind !== 'Capacitor' && kind !== 'CurrentSource';
}

/**
 * Whether the component behaves as an ideal voltage source at DC
 * (participates in voltage-source-loop detection). Inductors are 0 V
 * sources at the DC operating point.
 */
export function isDCVoltageSourceEdge(comp: Component): boolean {
  const kind = kindOf(comp);
  return kind === 'VoltageSource' || kind === 'Inductor';
}

function sourceOptions(dc: number, wave: object | null, ac: { mag: number; phase: number } | null): SourceOptions {
  return { dc, ...(wave ? JSON.parse(JSON.stringify(wave)) : {}), ...(ac ? { ac: { mag: ac.mag, phase: ac.phase } } : {}) };
}

/**
 * Rebuild a component from its netlist description (type + params) — the
 * inverse of describeComponent. Custom components need their definition.
 */
export function buildComponent(
  type: string,
  params: Record<string, ParamValue>,
  customDefs: Record<string, ComponentDef> = {},
): Component {
  const n = (key: string): number => {
    const v = params[key];
    if (typeof v !== 'number') throw new Error(`${type}: param '${key}' must be a number`);
    return v;
  };
  switch (type) {
    case 'Resistor':
      return new Resistor(n('r'));
    case 'Capacitor':
      return new Capacitor(n('c'));
    case 'Inductor':
      return new Inductor(n('l'));
    case 'VoltageSource':
    case 'CurrentSource': {
      const key = type === 'VoltageSource' ? 'v' : 'i';
      const options: Record<string, unknown> = { dc: n(key) };
      for (const k of ['sin', 'pulse', 'pwl', 'pwm', 'ac']) {
        if (params[k] !== undefined) options[k] = JSON.parse(JSON.stringify(params[k]));
      }
      return type === 'VoltageSource'
        ? new VoltageSource(options as SourceOptions)
        : new CurrentSource(options as SourceOptions);
    }
    case 'Diode':
    case 'LED':
    case 'NPN':
    case 'PNP':
    case 'NMOS':
    case 'PMOS': {
      if (typeof params.part === 'string') {
        const dev = Part(params.part);
        if ((dev as { kind: string }).kind !== type) {
          throw new Error(`cannot rebuild ${type}: part '${params.part}' is a ${(dev as { kind: string }).kind}`);
        }
        return dev;
      }
      const p: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(params)) if (k !== 'model' && k !== 'part') p[k] = v;
      const dev =
        type === 'Diode'
          ? new Diode(p as DiodeParams)
          : type === 'LED'
            ? new LED(p as DiodeParams)
            : type === 'NPN'
              ? new NPN(p as Record<string, number>)
              : type === 'PNP'
                ? new PNP(p as Record<string, number>)
                : type === 'NMOS'
                  ? new NMOS(p as MosfetParams)
                  : new PMOS(p as MosfetParams);
      if (typeof params.model === 'string') (dev as { modelName?: string }).modelName = params.model;
      return dev;
    }
    case 'Switch':
      return new Switch(params.closed === true);
    case 'Button':
      return new Button(params.pressed === true);
    default: {
      const def = customDefs[type];
      if (!def) throw new Error(`cannot rebuild component type '${type}': unknown type (pass its definition in customDefs)`);
      const p: Record<string, number> = {};
      for (const [k, v] of Object.entries(params)) if (typeof v === 'number') p[k] = v;
      return new CustomComponent(def, p);
    }
  }
}
