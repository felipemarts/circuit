/**
 * Pin currents of every component — the current entering each pin, SPICE
 * convention. Shared by the web viewer (current animation, scope) and the pcb
 * stage (trace widths from the simulated current, IPC-2221).
 *
 * Covered: two-terminal parts (R, C, L, sources, diodes, LEDs, buttons),
 * BJTs, MOSFETs and switches. ICs, MCUs and logic parts expose no pin
 * currents; the passives around them carry the same currents.
 */
import type { Elaboration } from '../elab/bench';
import { kindOf } from '../elab/describe';
import { asQuantityDevice } from '../elab/quantity';
import type { ProbeSpec } from '../analysis/TransientAnalysis';
import type { Component } from '../core/Component';

/** Pin → current entering the component, from the published op values / quantities (the last analysis run). */
export function pinCurrents(elab: Elaboration): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [id, comp] of elab.components) {
    const kind = kindOf(comp);
    const dev = asQuantityDevice(comp);
    const names = comp.pinEntries().map(([n]) => n);
    const uniq = [...new Set(comp.allPins())].length;
    if (dev && (kind === 'NPN' || kind === 'PNP')) {
      const ic = dev.quantity('ic') ?? 0;
      const ib = dev.quantity('ib') ?? 0;
      out[`${id}.c`] = ic;
      out[`${id}.b`] = ib;
      out[`${id}.e`] = dev.quantity('ie') ?? -(ic + ib);
    } else if (dev && (kind === 'NMOS' || kind === 'PMOS')) {
      const idr = dev.quantity('id') ?? 0;
      out[`${id}.d`] = idr;
      out[`${id}.g`] = dev.quantity('ig') ?? 0;
      out[`${id}.s`] = dev.quantity('is') ?? -idr;
      if (names.includes('b')) out[`${id}.b`] = dev.quantity('ib') ?? 0;
    } else if (kind === 'Switch') {
      const i = (comp as { current?: number }).current ?? 0;
      const closed = (comp as { closed?: boolean }).closed ?? false;
      out[`${id}.com`] = i;
      out[`${id}.${closed ? 'b' : 'a'}`] = -i;
      out[`${id}.${closed ? 'a' : 'b'}`] = 0;
    } else if (uniq === 2 && typeof (comp as { current?: number }).current === 'number') {
      const i = (comp as unknown as { current: number }).current;
      const canon = canonicalTwoPins(comp);
      out[`${id}.${canon[0]}`] = i;
      out[`${id}.${canon[1]}`] = -i;
    }
  }
  return out;
}

/** Canonical names of the two unique pins of a two-terminal component ('+','-' win over '1','2'). */
export function canonicalTwoPins(comp: Component): [string, string] {
  const byPin = new Map<unknown, string>();
  for (const [name, pin] of comp.pinEntries()) byPin.set(pin, name); // later aliases win
  const pins = [...new Set(comp.allPins())];
  return [byPin.get(pins[0]) ?? '1', byPin.get(pins[1]) ?? '2'];
}

/** Transient probe specs for every pin current (same decomposition as pinCurrents). */
export function currentProbeSpecs(elab: Elaboration): { ref: string; spec: ProbeSpec; sign: number }[] {
  const out: { ref: string; spec: ProbeSpec; sign: number }[] = [];
  for (const [id, comp] of elab.components) {
    const kind = kindOf(comp);
    const dev = asQuantityDevice(comp);
    const uniq = [...new Set(comp.allPins())].length;
    const q = (pin: string, quantity: string, sign = 1) => out.push({ ref: `${id}.${pin}`, spec: { label: `${id}.${pin}`, color: '', component: comp, type: 'voltage', quantity }, sign });
    if (dev && (kind === 'NPN' || kind === 'PNP')) {
      q('c', 'ic');
      q('b', 'ib');
      q('e', 'ie');
    } else if (dev && (kind === 'NMOS' || kind === 'PMOS')) {
      q('d', 'id');
      q('g', 'ig');
      q('s', 'is');
    } else if (kind === 'Switch') {
      const closed = (comp as { closed?: boolean }).closed ?? false;
      out.push({ ref: `${id}.com`, spec: { label: `${id}.com`, color: '', component: comp, type: 'current' }, sign: 1 });
      out.push({ ref: `${id}.${closed ? 'b' : 'a'}`, spec: { label: `${id}.x`, color: '', component: comp, type: 'current' }, sign: -1 });
    } else if (uniq === 2 && typeof (comp as { current?: number }).current === 'number') {
      const canon = canonicalTwoPins(comp);
      out.push({ ref: `${id}.${canon[0]}`, spec: { label: `${id}.${canon[0]}`, color: '', component: comp, type: 'current' }, sign: 1 });
      out.push({ ref: `${id}.${canon[1]}`, spec: { label: `${id}.${canon[1]}`, color: '', component: comp, type: 'current' }, sign: -1 });
    }
  }
  return out;
}
