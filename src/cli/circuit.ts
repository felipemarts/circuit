import * as fs from 'node:fs';
import * as path from 'node:path';
import type { BenchDescriptor } from '../elab/bench';
import type { Diagnostic, RunRecord } from '../schema/types';
import type { ComponentDef } from '../core/CustomComponent';
import { ENGINE, RUN_SCHEMA } from '../schema/version';
import { benchFromDoc, type DefinitionSource } from '../doc/convert';
import { CircuitDocError, docDiagnostic } from '../doc/errors';
import { decodeShareUrl } from '../doc/share';
import { describeDefinitions, loadDocDefinitions } from '../doc/definitions';
import type { CircuitDoc } from '../doc/types';
import { loadBench, definitionSourcesOf, PLATFORM_MODULE } from './load';
import { circuitIdOf, fetchCircuitDoc, type ServiceCircuit } from './service';

/** A circuit input of the CLI: a `.bench.ts` file, a circuit document (`.json`) or a share link. */
export interface LoadedCircuit {
  kind: 'bench' | 'doc';
  desc: BenchDescriptor;
  /** Overrides recorded in a document (merged under --set). */
  overrides: Record<string, number>;
  /** Benches: the module each custom component is exported from (documents carry its source). */
  definitionSources?: (def: ComponentDef) => DefinitionSource | undefined;
  /** Inputs fetched from the service (`…/app.html?c=<id>`): the circuit's metadata. */
  service?: ServiceCircuit;
}

export interface LoadOptions {
  /** Execute the custom-component code a document carries (definitions[]). Never needed for bench files. */
  allowCode?: boolean;
}

export function isDocFile(file: string): boolean {
  return /\.json$/i.test(file);
}

export function isLink(input: string): boolean {
  return /^https?:\/\//i.test(input) || /#c=\d+\./.test(input);
}

/**
 * Load a bench file, a circuit document or a share link (`…/app.html?c=<id>`
 * from the service, or a `#c=1.…` link). Document problems throw
 * CircuitDocError (T010–T014, T019 code not allowed, T020 service); bench
 * problems throw a plain Error, as before.
 */
export async function loadCircuit(file: string, opts: LoadOptions = {}): Promise<LoadedCircuit> {
  if (!isDocFile(file) && !isLink(file)) {
    const desc = await loadBench(file);
    return { kind: 'bench', desc, overrides: {}, definitionSources: definitionSourcesOf(desc) };
  }
  const { doc: value, service } = await readDoc(file);
  const doc = value as CircuitDoc;
  const definitions = opts.allowCode && Array.isArray(doc?.definitions) && doc.definitions.length > 0 ? loadDocDefinitions(doc, PLATFORM_MODULE) : undefined;
  const desc = benchFromDoc(value, definitions ? { definitions } : {});
  return { kind: 'doc', desc, overrides: { ...(desc.circuitDoc.overrides ?? {}) }, ...(service ? { service } : {}) };
}

/** The raw JSON of a document file or share link (not validated, no code run). */
export async function readDoc(file: string): Promise<{ doc: unknown; service?: ServiceCircuit }> {
  let value: unknown;
  let service: ServiceCircuit | undefined;
  if (isLink(file)) {
    if (circuitIdOf(file)) ({ doc: value, circuit: service } = await fetchCircuitDoc(file) as { doc: CircuitDoc; circuit: ServiceCircuit });
    else value = await decodeShareUrl(file);
  } else {
    const abs = path.resolve(file);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) throw new Error(`circuit document not found: ${file}`);
    const text = fs.readFileSync(abs, 'utf8').replace(/^﻿/, '');
    try {
      value = JSON.parse(text);
    } catch (err) {
      throw new CircuitDocError([
        docDiagnostic('T010', `${file} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`, {
          fixes: [{ kind: 'reexport', confidence: 'suggested', detail: 'regenerate it with `circuitsvibe export <bench.ts> -o <file>.circuit.json`' }],
        }),
      ]);
    }
  }
  return { doc: value, ...(service ? { service } : {}) };
}

/** Lines naming the code a document would run (for the T019 human report). */
export function codeNotice(doc: CircuitDoc): string[] {
  return describeDefinitions(doc);
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
  if (isLink(file)) return circuitIdOf(file) ?? 'shared-circuit';
  return path.basename(file).replace(/(\.circuit)?\.json$/i, '');
}
