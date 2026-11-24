/**
 * VHDL sources and source locations.
 *
 * A source is VHDL text plus, optionally, the path it came from:
 *
 *   compileVhdl('entity e is end; architecture a of e is begin end;')
 *   compileVhdl({ text, path: 'rtl/counter.vhd' })
 *   import counter from './counter.vhd';   // in a bench: the loader yields { kind: 'vhdl-source', text, path }
 *   compileVhdl([counter, fullAdder]);     // several sources form one compilation unit
 *
 * Locations in diagnostics:
 *   - source with a path      → `rtl/counter.vhd:12:5`
 *   - inline text in a bench  → `bench/x.bench.ts:7 (vhdl 12:5)` — the bench line of the
 *     compileVhdl() call plus the line:col inside the VHDL text
 *   - otherwise               → `vhdl:12:5`
 */

export interface VhdlSource {
  /** Optional brand set by the bench loader for `.vhd` / `.vhdl` imports. */
  kind?: 'vhdl-source';
  text: string;
  /** Path for diagnostics (relative to the working directory, forward slashes). */
  path?: string;
}

export type VhdlInput = string | VhdlSource | (string | VhdlSource)[];

export interface Loc {
  /** Index into the compilation's source table. */
  src: number;
  line: number;
  col: number;
}

export interface SourceInfo {
  text: string;
  path?: string;
  /** Bench location of the call that compiled an inline source ('x.bench.ts:7'). */
  origin?: string;
}

export function normalizeSources(input: VhdlInput, origin: string | undefined): SourceInfo[] {
  const list = Array.isArray(input) ? input : [input];
  if (list.length === 0) throw new Error('compileVhdl: no VHDL source given');
  return list.map((s, i) => {
    if (typeof s === 'string') return { text: s, origin };
    if (s && typeof s === 'object' && typeof s.text === 'string') {
      if (s.path !== undefined && typeof s.path !== 'string') throw new Error(`compileVhdl: source ${i} has a non-string path`);
      return s.path ? { text: s.text, path: s.path.replace(/\\/g, '/') } : { text: s.text, origin };
    }
    throw new Error(`compileVhdl: source ${i} must be VHDL text or { text, path }, got ${JSON.stringify(s)?.slice(0, 60)}`);
  });
}

export function formatLoc(sources: SourceInfo[], loc: Loc | undefined): string | undefined {
  if (!loc) return undefined;
  const s = sources[loc.src];
  if (!s) return `vhdl:${loc.line}:${loc.col}`;
  if (s.path) return `${s.path}:${loc.line}:${loc.col}`;
  if (s.origin) return `${s.origin} (vhdl ${loc.line}:${loc.col})`;
  return `vhdl:${loc.line}:${loc.col}`;
}

/**
 * Location (file:line) of the user code that called into the VHDL API — the
 * same technique as src/elab/loc.ts, but skipping the platform's own
 * directories (vhdl, digital, elab) so the bench frame is found.
 */
export function callerLoc(): string | undefined {
  const stack = new Error().stack;
  if (!stack) return undefined;
  let selfFile: string | undefined;
  for (const line of stack.split('\n').slice(1)) {
    const m = line.match(/\((.+?):(\d+):(\d+)\)$/) ?? line.match(/^\s*at (.+?):(\d+):(\d+)$/);
    if (!m) continue;
    let file = m[1].startsWith('file://') ? decodeURIComponent(m[1].replace(/^file:\/\/\/?/, '')) : m[1];
    if (m[1].startsWith('file://') && !/^[A-Za-z]:/.test(file)) file = `/${file}`;
    if (selfFile === undefined) selfFile = file;
    if (file === selfFile) continue;
    if (/[\\/]src[\\/](vhdl|digital|elab)[\\/]/.test(file)) continue;
    if (file.includes('node_modules')) continue;
    if (file.startsWith('node:')) continue;
    return `${relativeToCwd(file)}:${m[2]}`;
  }
  return undefined;
}

function relativeToCwd(file: string): string {
  const normalized = file.replace(/\\/g, '/');
  const proc = (globalThis as { process?: { cwd?: () => string; platform?: string } }).process;
  if (!proc || typeof proc.cwd !== 'function') return normalized;
  const cwd = `${proc.cwd().replace(/\\/g, '/').replace(/\/$/, '')}/`;
  const fold = proc.platform === 'win32' ? (s: string) => s.toLowerCase() : (s: string) => s;
  return fold(normalized).startsWith(fold(cwd)) ? normalized.slice(cwd.length) : normalized;
}
