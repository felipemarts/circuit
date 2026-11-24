/**
 * Netlist / circuit-document identity of the amplifier family: describe a
 * component as { type, params } and rebuild it from that (plain JSON).
 */
import type { Component } from '../core/Component';
import type { ParamValue } from '../schema/types';
import { IdealOpAmp } from './IdealOpAmp';
import { OpAmp, type OpAmpParams } from './OpAmp';
import { Comparator, type ComparatorParams } from './Comparator';

export const AMPLIFIER_TYPES = ['IdealOpAmp', 'OpAmp', 'Comparator'] as const;
export type AmplifierType = (typeof AMPLIFIER_TYPES)[number];

const kindOf = (comp: Component): string => (comp as { kind?: string }).kind ?? comp.constructor.name;

export function isAmplifierType(type: string): type is AmplifierType {
  return (AMPLIFIER_TYPES as readonly string[]).includes(type);
}

/** { type, params } of an amplifier-family component, or null for anything else. */
export function describeAmplifier(comp: Component): { type: string; params: Record<string, ParamValue> } | null {
  const kind = kindOf(comp);
  if (!isAmplifierType(kind)) return null;
  const params = (comp as unknown as { describeParams(): Record<string, ParamValue> }).describeParams();
  return { type: kind, params };
}

/** Rebuild an amplifier-family component from its params, or null when `type` is not one. */
export function buildAmplifier(type: string, params: Record<string, ParamValue>): Component | null {
  if (!isAmplifierType(type)) return null;
  const known: Record<AmplifierType, string[]> = {
    IdealOpAmp: ['gain'],
    OpAmp: ['aol', 'gbw', 'sr', 'fp2', 'vos', 'ib', 'ios', 'swingHigh', 'swingLow', 'rout', 'iscSource', 'iscSink', 'iq', 'part'],
    Comparator: ['avd', 'vos', 'ib', 'ios', 'tpdHL', 'tpdLH', 'overdrive', 'tpdFast', 'vol', 'iol', 'isink', 'gleak', 'iq', 'emitterPin', 'part'],
  };
  for (const [k, v] of Object.entries(params)) {
    if (!known[type].includes(k)) throw new Error(`${type}: unknown param '${k}' (known: ${known[type].join(', ')})`);
    const want = k === 'part' ? 'string' : k === 'emitterPin' ? 'boolean' : 'number';
    if (typeof v !== want) throw new Error(`${type}: param '${k}' must be a ${want}`);
  }
  switch (type) {
    case 'IdealOpAmp':
      return new IdealOpAmp(params as { gain?: number });
    case 'OpAmp':
      return new OpAmp(params as OpAmpParams);
    case 'Comparator':
      return new Comparator(params as ComparatorParams);
  }
}
