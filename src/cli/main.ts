import { runLadder } from '../verify/ladder';
import { renderHuman } from '../report/human';
import { findDiagnosticDoc, DIAGNOSTIC_DOCS } from '../verify/registry';
import { appendRun, listRuns, findRun, LEDGER_DIR } from '../ledger/ledger';
import { parseValue, formatEng } from '../elab/units';
import { loadBench } from './load';
import { COMPONENT_CATALOG, GRAMMAR_NOTES } from './catalog';
import { CLI, ENGINE, VERSION } from '../schema/version';
import { init } from './init';
import AGENTS_MD from '../../AGENTS.md';
import { STAGE_ORDER, type StageName } from '../schema/types';
import { sweepBench, renderSweepTable } from './sweep';
import { loadCircuit, docErrorRecord, benchNameFromFile, type LoadedCircuit } from './circuit';
import { toCircuitDoc } from '../doc/convert';
import { canonicalJson } from '../doc/canonical';
import { createShareLink, decodeShareUrl, type ShareLink } from '../doc/share';
import { isCircuitDocError } from '../doc/errors';
import type { CircuitMeta } from '../doc/types';
import type { Diagnostic, RunRecord } from '../schema/types';
import * as fs from 'node:fs';

const USAGE = `${CLI} — circuits as code; simulation is the feedback loop (${ENGINE})

USAGE
  ${CLI} init [name] [--force]        scaffold <name>.bench.ts + AGENTS.md here
  ${CLI} verify <bench.ts> [options]  run the ladder: lint → op → dc → ac → tran
                                    (also verify <file.circuit.json>: same RunRecord, same exit codes)
  ${CLI} export <bench.ts> [-o file.circuit.json] [--set R1=330]
                                    write the circuit document (circuitsvibe-circuit/1), stdout by default
  ${CLI} share <bench.ts | file.circuit.json> [--base-url URL] [--json]
                                    print a share link: the whole circuit lives in the URL (#c=1.…)
  ${CLI} open <url | #c=…> [-o file]  decode a share link back to the circuit document
  ${CLI} sweep <bench.ts> --source V1 --from 0 --to 5 [--points 51 | --step 0.1] [--probe out,R1.i] [--json]
                                    DC sweep table/JSON (or --param R1 to sweep a component value)
  ${CLI} log list [--json]            list past runs from the ledger (${LEDGER_DIR}/runs.jsonl)
  ${CLI} log show <runId>             full RunRecord of a past run (JSON)
  ${CLI} explain <code>               docs for a diagnostic code, e.g. ${CLI} explain F101
  ${CLI} catalog [type] [--json]      component datasheet + probe/assertion grammar
  ${CLI} agents                       print the agent playbook (AGENTS.md)
  ${CLI} version                      print the engine version

VERIFY OPTIONS
  --stage op,dc,ac,tran  run only these stages (lint ALWAYS runs — it gates the solve)
  --set R1=330,V1=5      override scalar values without editing the bench
  --json                 emit the full RunRecord as JSON on stdout
  --no-hints             skip verified sizing hints (faster)
  --no-ledger            do not append this run to ${LEDGER_DIR}/runs.jsonl
  --share                add a share link (JSON: "share": { "url", "bytes", "warnings" })

SHARE / EXPORT OPTIONS
  --base-url URL         page that opens links (default https://circuitsvibe.com/app.html)
  --title, --description, --author TEXT   document metadata (kept in share links)
  -o, --out FILE         write to FILE instead of stdout (export, open)
  --json                 share: print { url, bytes, warnings }

EXIT CODES
  0  all requested stages pass
  1  assertion failed — circuit valid, spec not met: tune values (see hints) or topology
  2  circuit invalid or unsolvable — fix structure first (see F/S diagnostics)
  3  tooling error — bad usage or the bench file itself threw

EXAMPLE
  ${CLI} init led-driver && ${CLI} verify led-driver.bench.ts --json`;

const VALUE_OPTIONS = ['--source', '--param', '--from', '--to', '--points', '--step', '--probe', '--base-url', '--title', '--description', '--author', '--out'];

interface Flags {
  json: boolean;
  force: boolean;
  share: boolean;
  hints: boolean;
  ledger: boolean;
  stages?: StageName[];
  overrides: Record<string, number>;
  /** Value options of the sweep command (--source V1 --from 0 ...). */
  options: Record<string, string>;
  positional: string[];
}

function parseFlags(args: string[]): Flags {
  const flags: Flags = { json: false, force: false, share: false, hints: true, ledger: true, overrides: {}, options: {}, positional: [] };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--json') flags.json = true;
    else if (arg === '--force') flags.force = true;
    else if (arg === '--share') flags.share = true;
    else if (arg === '-o') {
      const value = args[++i];
      if (value === undefined || value.startsWith('-')) throw new Error('-o needs a file name');
      flags.options.out = value;
    }
    else if (arg === '--no-hints') flags.hints = false;
    else if (arg === '--no-ledger') flags.ledger = false;
    else if (arg === '--stage') {
      const value = args[++i];
      if (!value) throw new Error(`--stage needs a value, e.g. --stage lint,op`);
      const stages = value.split(',').map(s => s.trim());
      for (const s of stages) {
        if (!(STAGE_ORDER as string[]).includes(s)) {
          throw new Error(`unknown stage '${s}': valid stages are ${STAGE_ORDER.join(', ')}`);
        }
      }
      flags.stages = stages as StageName[];
    } else if (arg === '--set') {
      const value = args[++i];
      if (!value) throw new Error(`--set needs a value, e.g. --set R1=330 or --set R1=330,V1=5`);
      for (const pair of value.split(',')) {
        const eq = pair.indexOf('=');
        if (eq <= 0) throw new Error(`--set entry '${pair}' must look like R1=330`);
        const id = pair.slice(0, eq).trim();
        flags.overrides[id] = parseValue(pair.slice(eq + 1).trim(), `--set ${id}`);
      }
    } else if (VALUE_OPTIONS.includes(arg)) {
      const value = args[++i];
      if (value === undefined || value.startsWith('--')) throw new Error(`${arg} needs a value`);
      flags.options[arg.slice(2)] = value;
    } else if (arg.startsWith('--')) {
      throw new Error(`unknown option '${arg}'`);
    } else {
      flags.positional.push(arg);
    }
  }
  return flags;
}

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    console.log(USAGE);
    return command ? 0 : 3;
  }
  if (command === 'version' || command === '--version' || command === '-v') {
    console.log(VERSION);
    return 0;
  }

  let flags: Flags;
  try {
    flags = parseFlags(rest);
  } catch (err) {
    console.error(`error: ${err instanceof Error ? err.message : err}\n\n${USAGE}`);
    return 3;
  }

  try {
    switch (command) {
      case 'verify':
        return await verify(flags);
      case 'sweep':
        return await sweep(flags);
      case 'export':
        return await exportDoc(flags);
      case 'share':
        return await share(flags);
      case 'open':
        return await open(flags);
      case 'log':
        return log(flags);
      case 'explain':
        return explain(flags);
      case 'catalog':
        return catalog(flags);
      case 'init':
        return init(flags.positional[0], { force: flags.force });
      case 'agents':
        process.stdout.write(AGENTS_MD.endsWith('\n') ? AGENTS_MD : `${AGENTS_MD}\n`);
        return 0;
      default:
        console.error(`error: unknown command '${command}'\n\n${USAGE}`);
        return 3;
    }
  } catch (err) {
    console.error(`error: ${err instanceof Error ? err.message : err}`);
    return 3;
  }
}

async function verify(flags: Flags): Promise<number> {
  const file = flags.positional[0];
  if (!file) {
    console.error(`error: verify needs a bench file\n\nEXAMPLE\n  ${CLI} verify led-driver.bench.ts --json`);
    return 3;
  }

  let loaded: LoadedCircuit;
  try {
    loaded = await loadCircuit(file);
  } catch (err) {
    if (!isCircuitDocError(err)) {
      console.error(`error: ${err instanceof Error ? err.message : err}`);
      return 3;
    }
    // An invalid circuit document still yields a RunRecord (T010–T014, exit 3).
    const failed = docErrorRecord(benchNameFromFile(file), err.diagnostics);
    console.log(flags.json ? JSON.stringify(failed, null, 2) : renderHuman(failed));
    return 3;
  }

  const overrides = { ...loaded.overrides, ...flags.overrides };
  const record: RunRecord = runLadder(loaded.desc, {
    stages: flags.stages,
    overrides,
    hints: flags.hints,
  });

  let runId: string | undefined;
  if (flags.ledger) {
    try {
      runId = appendRun(record).runId;
    } catch {
      // A read-only working directory must not break the verdict.
    }
  }

  const shared = flags.share ? await shareOf(loaded, overrides, flags) : undefined;

  if (flags.json) {
    const out = { ...(runId ? { runId } : {}), ...record, ...(shared ? { share: shared } : {}) };
    console.log(JSON.stringify(out, null, 2));
  } else {
    console.log(renderHuman(record));
    if (runId) console.log(`run ${runId} → ${LEDGER_DIR}/runs.jsonl (${CLI} log show ${runId})`);
    if (shared) printShareHuman(shared);
  }
  return record.exitCode;
}

type ShareResult =
  | { url: string; bytes: number; warnings: Diagnostic[] }
  | { error: { code: string; message: string } };

function metaFlags(flags: Flags): CircuitMeta {
  const meta: CircuitMeta = {};
  for (const k of ['title', 'description', 'author'] as const) if (flags.options[k]) meta[k] = flags.options[k];
  return meta;
}

/** verify --share: never changes the verify verdict; a failure to share is reported in place. */
async function shareOf(loaded: LoadedCircuit, overrides: Record<string, number>, flags: Flags): Promise<ShareResult> {
  try {
    const doc = toCircuitDoc(loaded.desc, overrides, { meta: metaFlags(flags) });
    const link = await createShareLink(doc, { baseUrl: flags.options['base-url'] });
    return { url: link.url, bytes: link.bytes, warnings: link.warnings };
  } catch (err) {
    if (isCircuitDocError(err)) return { error: { code: err.code, message: err.diagnostics[0].message } };
    return { error: { code: 'T002', message: err instanceof Error ? err.message : String(err) } };
  }
}

function printShareHuman(shared: ShareResult): void {
  if ('error' in shared) {
    console.log(`share: not available — ${shared.error.code} ${shared.error.message}`);
    return;
  }
  console.log(`share: ${shared.url}`);
  for (const w of shared.warnings) console.log(`  warning ${w.code}: ${w.message}`);
}

function reportDocError(err: unknown, json: boolean): number {
  if (isCircuitDocError(err)) {
    if (json) {
      console.log(JSON.stringify({ diagnostics: err.diagnostics, exitCode: 3 }, null, 2));
    } else {
      for (const d of err.diagnostics) console.error(`error: ${d.code} ${d.slug}: ${d.message}`);
      const fix = err.diagnostics[0].fixes[0];
      if (fix) console.error(`  fix: ${fix.detail}`);
      console.error(`  (${CLI} explain ${err.code})`);
    }
    return 3;
  }
  console.error(`error: ${err instanceof Error ? err.message : err}`);
  return 3;
}

function writeOut(text: string, flags: Flags): void {
  const out = flags.options.out;
  if (out) fs.writeFileSync(out, text);
  else process.stdout.write(text);
}

async function exportDoc(flags: Flags): Promise<number> {
  const file = flags.positional[0];
  if (!file) {
    console.error(`error: export needs a bench file\n\nEXAMPLE\n  ${CLI} export led-driver.bench.ts -o led-driver.circuit.json`);
    return 3;
  }
  try {
    const loaded = await loadCircuit(file);
    const doc = toCircuitDoc(loaded.desc, { ...loaded.overrides, ...flags.overrides }, { meta: metaFlags(flags) });
    writeOut(`${canonicalJson(doc, 2)}\n`, flags);
    if (flags.options.out) {
      console.error(`wrote ${flags.options.out} (${doc.components.length} components, ${doc.assertions.length} assertions)`);
    }
    return 0;
  } catch (err) {
    return reportDocError(err, false);
  }
}

async function share(flags: Flags): Promise<number> {
  const file = flags.positional[0];
  if (!file) {
    console.error(`error: share needs a bench file or a circuit document\n\nEXAMPLE\n  ${CLI} share led-driver.bench.ts`);
    return 3;
  }
  let link: ShareLink;
  try {
    const loaded = await loadCircuit(file);
    const doc = toCircuitDoc(loaded.desc, { ...loaded.overrides, ...flags.overrides }, { meta: metaFlags(flags) });
    link = await createShareLink(doc, { baseUrl: flags.options['base-url'] });
  } catch (err) {
    return reportDocError(err, flags.json);
  }
  if (flags.json) {
    console.log(JSON.stringify({ url: link.url, bytes: link.bytes, warnings: link.warnings }, null, 2));
  } else {
    console.log(link.url);
    for (const w of link.warnings) console.error(`warning ${w.code}: ${w.message}`);
  }
  return 0;
}

async function open(flags: Flags): Promise<number> {
  const input = flags.positional[0];
  if (!input) {
    console.error(`error: open needs a share link\n\nEXAMPLE\n  ${CLI} open "https://circuitsvibe.com/app.html#c=1.…" -o circuit.circuit.json`);
    return 3;
  }
  try {
    const doc = await decodeShareUrl(input);
    writeOut(`${canonicalJson(doc, 2)}\n`, flags);
    return 0;
  } catch (err) {
    return reportDocError(err, flags.json);
  }
}

async function sweep(flags: Flags): Promise<number> {
  const file = flags.positional[0];
  const o = flags.options;
  if (!file || (o.source === undefined && o.param === undefined) || o.from === undefined || o.to === undefined) {
    console.error(`error: sweep needs a bench file, --source <id> (or --param <id>), --from and --to

EXAMPLE
  ${CLI} sweep divider.bench.ts --source V1 --from 0 --to 5 --points 11 --probe out`);
    return 3;
  }
  let desc;
  try {
    desc = await loadBench(file);
  } catch (err) {
    console.error(`error: ${err instanceof Error ? err.message : err}`);
    return 3;
  }
  let points: number | undefined;
  if (o.points !== undefined) {
    points = Number(o.points);
    if (!Number.isInteger(points)) {
      console.error(`error: --points must be an integer, got '${o.points}'`);
      return 3;
    }
  }
  let record;
  try {
    record = sweepBench(desc, {
      source: o.source,
      param: o.param,
      from: o.from,
      to: o.to,
      points,
      step: o.step,
      probes: o.probe ? o.probe.split(',').map(p => p.trim()).filter(Boolean) : [],
      overrides: flags.overrides,
    });
  } catch (err) {
    console.error(`error: ${err instanceof Error ? err.message : err}`);
    return 3;
  }
  console.log(flags.json ? JSON.stringify(record, null, 2) : renderSweepTable(record));
  return record.exitCode;
}

function log(flags: Flags): number {
  const [sub, runId] = flags.positional;
  if (sub === 'list') {
    const runs = listRuns();
    if (flags.json) {
      console.log(
        JSON.stringify(
          runs.map(r => ({
            runId: r.runId,
            bench: r.bench,
            verdict: r.verdict,
            exitCode: r.exitCode,
            firstFailure: r.firstFailure ?? null,
            overrides: r.overrides ?? null,
          })),
          null,
          2,
        ),
      );
      return 0;
    }
    if (runs.length === 0) {
      console.log(`no runs recorded yet — ${CLI} verify <bench.ts> appends to ${LEDGER_DIR}/runs.jsonl`);
      return 0;
    }
    for (const r of runs) {
      const overrides = r.overrides
        ? ` set ${Object.entries(r.overrides)
            .map(([k, v]) => `${k}=${formatEng(v)}`)
            .join(',')}`
        : '';
      console.log(
        `${r.runId}  ${r.verdict.toUpperCase().padEnd(5)} exit ${r.exitCode}  ${r.bench}${overrides}${r.firstFailure ? `  first: ${r.firstFailure}` : ''}`,
      );
    }
    return 0;
  }
  if (sub === 'show') {
    if (!runId) {
      console.error(`error: log show needs a runId\n\nEXAMPLE\n  ${CLI} log show 4be2a1c09d77-001`);
      return 3;
    }
    const run = findRun(runId);
    if (!run) {
      const known = listRuns().map(r => r.runId);
      console.error(`error: run '${runId}' not found. Known runs: ${known.join(', ') || '(none)'}`);
      return 3;
    }
    console.log(JSON.stringify(run, null, 2));
    return 0;
  }
  console.error(`error: log needs 'list' or 'show <runId>'\n\nEXAMPLE\n  ${CLI} log list`);
  return 3;
}

function explain(flags: Flags): number {
  const code = flags.positional[0];
  if (!code) {
    console.error(`error: explain needs a diagnostic code\n\nEXAMPLE\n  ${CLI} explain F101`);
    return 3;
  }
  const doc = findDiagnosticDoc(code);
  if (!doc) {
    console.error(
      `error: unknown diagnostic code '${code}'. Known codes: ${DIAGNOSTIC_DOCS.map(d => d.code).join(', ')}`,
    );
    return 3;
  }
  console.log(`${doc.code} (${doc.slug}) — ${doc.title}\n\n${doc.explanation}`);
  return 0;
}

function catalog(flags: Flags): number {
  const type = flags.positional[0];
  const entries = type
    ? COMPONENT_CATALOG.filter(e => e.type.toLowerCase() === type.toLowerCase())
    : COMPONENT_CATALOG;
  if (type && entries.length === 0) {
    console.error(
      `error: unknown component type '${type}'. Known types: ${COMPONENT_CATALOG.map(e => e.type).join(', ')}`,
    );
    return 3;
  }
  if (flags.json) {
    console.log(JSON.stringify({ components: entries, grammar: GRAMMAR_NOTES }, null, 2));
    return 0;
  }
  for (const e of entries) {
    console.log(`${e.type}\n  example: ${e.example}\n  pins:    ${e.pins}\n  value:   ${e.value}\n  dc:      ${e.dc}\n`);
  }
  if (!type) console.log(GRAMMAR_NOTES);
  return 0;
}
