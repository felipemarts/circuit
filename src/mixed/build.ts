/**
 * Rebuild of the components whose params reference embedded source files
 * (circuit document `sources[]`): microcontrollers (firmware) and VHDL blocks.
 * Called by buildComponent (src/elab/describe.ts) after the logic ICs / primitives.
 */
import type { Component } from '../core/Component';
import type { ParamValue } from '../schema/types';
import { buildMcuComponent } from './mcu';
import { buildVhdlComponent } from './vhdl-block';

/** A document source file (path + text). */
export interface SourceFile {
  path: string;
  text: string;
}

export function buildSourcedComponent(type: string, params: Record<string, ParamValue>, sources: SourceFile[] | undefined): Component | undefined {
  return buildMcuComponent(type, params, sources) ?? buildVhdlComponent(type, params, sources);
}
