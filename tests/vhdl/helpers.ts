import { compileVhdl } from '../../src/vhdl';
import type { VhdlDesign, VhdlDiagnostic, VhdlInstance, VhdlInstantiateOptions } from '../../src/vhdl';
import { DigitalCircuit } from '../../src/digital';
import type { DigitalSim } from '../../src/digital';

export const HDR = `library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;
`;

/** Compile and fail loudly (with the diagnostics) when there are errors. */
export function design(src: string | string[] | { text: string; path?: string }): VhdlDesign {
  const r = compileVhdl(src);
  if (!r.ok || !r.design) throw new Error(`VHDL did not compile:\n${r.diagnostics.map(d => `${d.code} ${d.message} @ ${d.at}`).join('\n')}`);
  return r.design;
}

/** All diagnostics of compiling (and, when it compiles and `inst` is given, instantiating) a source. */
export function diagnostics(src: string | string[], inst?: VhdlInstantiateOptions): VhdlDiagnostic[] {
  const r = compileVhdl(src);
  if (!r.ok || !inst) return r.diagnostics;
  const e = r.design!.elaborate('U1', inst);
  return [...r.diagnostics, ...e.diagnostics];
}

export const codes = (ds: VhdlDiagnostic[]): string[] => ds.map(d => d.code);

export interface Built {
  c: DigitalCircuit;
  u: VhdlInstance;
  sim: DigitalSim;
}

/** Instantiate an entity as 'U1'; `setup` may add stimuli before the sim is built. */
export function build(src: string | string[], opts: VhdlInstantiateOptions = {}, setup?: (c: DigitalCircuit) => void): Built {
  const d = design(src);
  const c = new DigitalCircuit();
  const u = d.instantiate(c, 'U1', opts);
  setup?.(c);
  const sim = c.build();
  return { c, u, sim };
}

/** Integer value of nets[] (LSB first) at the current time, or -1 if any bit is X/Z. */
export function busValue(sim: DigitalSim, nets: string[]): number {
  let v = 0;
  for (let i = 0; i < nets.length; i++) {
    const b = sim.value(nets[i]);
    if (b !== 0 && b !== 1) return -1;
    v += b * 2 ** i;
  }
  return v;
}

export const ns = (x: number): number => x * 1e-9;
