/**
 * circuitsvibe VHDL front end — a synthesizable VHDL subset compiled onto the
 * digital event engine (src/digital). Pure TypeScript, zero dependencies,
 * browser-safe, deterministic. See src/vhdl/README.md.
 *
 *   const { ok, design, diagnostics } = compileVhdl(source);
 *   const u1 = design!.instantiate(circuit, 'U1', { generics: { N: 4 }, ports: { clk: 'CLK', q: 'Q' } });
 */
export { compileVhdl, compileVhdlOrThrow, instantiateVhdl, parseVhdl, VhdlDesign, VhdlInstance } from './design';
export type {
  VhdlCompileOptions,
  VhdlCompileResult,
  VhdlEntityInfo,
  VhdlGenericInfo,
  VhdlPortDecl,
  VhdlGenericValue,
  VhdlInstantiateOptions,
  VhdlPort,
  VhdlPortKind,
  VhdlSignalInfo,
  VhdlReadValue,
} from './design';
export { VHDL_CODES, VhdlError } from './diagnostics';
export type { VhdlDiagnostic, VhdlFix, VhdlCodeInfo } from './diagnostics';
export type { VhdlSource, VhdlInput } from './source';
export { printVhdl } from './printer';
export type { DesignFile } from './ast';
export { registerVhdlBehavior, VHDL_BEHAVIOR } from './runtime';
export type { ProcessConfig } from './ir';
