import type { Component } from '../core/Component';
import { Resistor } from '../components/Resistor';
import { Capacitor } from '../components/Capacitor';
import { Inductor } from '../components/Inductor';
import { VoltageSource } from '../components/VoltageSource';
import { CurrentSource } from '../components/CurrentSource';
import type { Diode } from '../components/Diode';
import type { Switch } from '../components/Switch';
import type { Button } from '../components/Button';

export interface ComponentInfo {
  type: string;
  params: Record<string, number | boolean>;
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
    case 'LED': {
      const d = comp as Diode;
      return { type: 'LED', params: { Is: d.Is, n: d.n, Vt: d.Vt } };
    }
    case 'Diode': {
      const d = comp as Diode;
      return { type: 'Diode', params: { Is: d.Is, n: d.n, Vt: d.Vt } };
    }
    case 'Resistor':
      return { type: 'Resistor', params: { r: (comp as Resistor).resistance } };
    case 'Capacitor':
      return { type: 'Capacitor', params: { c: (comp as Capacitor).capacitance } };
    case 'Inductor':
      return { type: 'Inductor', params: { l: (comp as Inductor).inductance } };
    case 'VoltageSource': {
      const v = comp as VoltageSource;
      const params: Record<string, number> = { v: v.declaredVoltage };
      if (v.frequency > 0) {
        params.ac = v.acAmplitude;
        params.f = v.frequency;
      }
      return { type: 'VoltageSource', params };
    }
    case 'CurrentSource':
      return { type: 'CurrentSource', params: { i: (comp as CurrentSource).currentValue } };
    case 'Switch':
      return { type: 'Switch', params: { closed: (comp as Switch).closed } };
    case 'Button':
      return { type: 'Button', params: { pressed: (comp as Button).pressed } };
    default:
      return { type: kindOf(comp), params: {} };
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
      const rebuilt = new VoltageSource(value);
      const original = comp as VoltageSource;
      rebuilt.acAmplitude = original.acAmplitude;
      rebuilt.frequency = original.frequency;
      return rebuilt;
    }
    case 'CurrentSource':
      return new CurrentSource(value);
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
