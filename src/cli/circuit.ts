import * as fs from 'node:fs';
import * as path from 'node:path';
import type { BenchDescriptor } from '../elab/bench';
import type { Diagnostic, RunRecord } from '../schema/types';
import { ENGINE, RUN_SCHEMA } from '../schema/version';
import { benchFromDoc } from '../doc/convert';
import { CircuitDocError, docDiagnostic } from '../doc/errors';
import { loadBench } from './load';

/** A circuit input of the CLI: a `.bench.ts` (or .js) file or a circuit document (`.json`). */
export interface LoadedCircuit {
  kind: 'bench' | 'doc';
  desc: BenchDescriptor;
  /** Overrides recorded in a document (merged under --set). */
  overrides: Record<string, number>;
}

export function isDocFile(file: string): boolean {
  return /\.json$/i.test(file);
}

/**
 * Load a bench file or a circuit document. Document problems throw
 * CircuitDocError (T010–T014); bench problems throw a plain Error, as before.
 */
export async function loadCircuit(file: string): Promise<LoadedCircuit> {
  if (!isDocFile(file)) return { kind: 'bench', desc: await loadBench(file), overrides: {} };
  const abs = path.resolve(file);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) throw new Error(`circuit document not found: ${file}`);
  const text = fs.readFileSync(abs, 'utf8').replace(/^﻿/, '');
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (err) {
    throw new CircuitDocError([
      docDiagnostic('T010', `${file} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`, {
        fixes: [{ kind: 'reexport', confidence: 'suggested', detail: 'regenerate it with `circuitsvibe export <bench.ts> -o <file>.circuit.json`' }],
      }),
    ]);
  }
  const desc = benchFromDoc(value);
  return { kind: 'doc', desc, overrides: { ...(desc.circuitDoc.overrides ?? {}) } };
}

/** RunRecord for an input that could not become a bench (invalid document): exit 3. */
export function docErrorRecord(bench: string, diagnostics: Diagnostic[]): RunRecord {
  return {
    schema: RUN_SCHEMA,
    bench,
    netlist: { hash: '', components: [], nets: {} },
    engine: ENGINE,
    stages: {},
    diagnostics,
    verdict: 'error',
    firstFailure: diagnostics[0]?.code,
    exitCode: 3,
  };
}

export function benchNameFromFile(file: string): string {
  return path.basename(file).replace(/(\.circuit)?\.json$/i, '');
}
