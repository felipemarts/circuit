import { runLadder } from '../verify/ladder';
import { renderHuman } from '../report/human';
import { findDiagnosticDoc, DIAGNOSTIC_DOCS } from '../verify/registry';
import { appendRun, listRuns, findRun } from '../ledger/ledger';
import { parseValue, formatEng } from '../elab/units';
import { loadBench } from './load';
import { COMPONENT_CATALOG, GRAMMAR_NOTES } from './catalog';
import type { StageName } from '../schema/types';

const USAGE = `forge — code becomes circuits; verification is the feedback loop

USAGE
  forge verify <bench.ts> [options]   run the ladder: lint → op → tran
  forge log list [--json]             list past runs from the ledger (.forge/runs.jsonl)
  forge log show <runId> [--json]     full RunRecord of a past run
  forge explain <code>                docs for a diagnostic code, e.g. forge explain F101
  forge catalog [type] [--json]       component datasheet + probe/assertion grammar

VERIFY OPTIONS
  --stage lint,op,tran   run only these stages (gating still applies)
  --set R1=330,V1=5      override scalar values without editing the bench
  --json                 emit the full RunRecord as JSON on stdout
  --no-hints             skip verified sizing hints (faster)
  --no-ledger            do not append this run to .forge/runs.jsonl

EXIT CODES
  0  all requested stages pass
  1  assertion failed — circuit valid, spec not met: tune values (see hints) or topology
  2  circuit invalid or unsolvable — fix structure first (see F/S diagnostics)
  3  tooling error — bad usage or the bench file itself threw

EXAMPLE
  forge verify bench/led-driver.bench.ts --json`;

interface Flags {
  json: boolean;
  hints: boolean;
  ledger: boolean;
  stages?: StageName[];
  overrides: Record<string, number>;
  positional: string[];
}

function parseFlags(args: string[]): Flags {
  const flags: Flags = { json: false, hints: true, ledger: true, overrides: {}, positional: [] };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--json') flags.json = true;
    else if (arg === '--no-hints') flags.hints = false;
    else if (arg === '--no-ledger') flags.ledger = false;
    else if (arg === '--stage') {
      const value = args[++i];
      if (!value) throw new Error(`--stage needs a value, e.g. --stage lint,op`);
      const stages = value.split(',').map(s => s.trim());
      for (const s of stages) {
        if (!['lint', 'op', 'tran'].includes(s)) {
          throw new Error(`unknown stage '${s}': valid stages are lint, op, tran`);
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
      case 'log':
        return log(flags);
      case 'explain':
        return explain(flags);
      case 'catalog':
        return catalog(flags);
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
    console.error(`error: verify needs a bench file\n\nEXAMPLE\n  forge verify bench/led-driver.bench.ts --json`);
    return 3;
  }

  let desc;
  try {
    desc = await loadBench(file);
  } catch (err) {
    console.error(`error: ${err instanceof Error ? err.message : err}`);
    return 3;
  }

  const record = runLadder(desc, {
    stages: flags.stages,
    overrides: flags.overrides,
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

  if (flags.json) {
    console.log(JSON.stringify(runId ? { runId, ...record } : record, null, 2));
  } else {
    console.log(renderHuman(record));
    if (runId) console.log(`run ${runId} → .forge/runs.jsonl (forge log show ${runId})`);
  }
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
      console.log('no runs recorded yet — forge verify <bench.ts> appends to .forge/runs.jsonl');
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
      console.error(`error: log show needs a runId\n\nEXAMPLE\n  forge log show 4be2a1c09d77-001`);
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
  console.error(`error: log needs 'list' or 'show <runId>'\n\nEXAMPLE\n  forge log list`);
  return 3;
}

function explain(flags: Flags): number {
  const code = flags.positional[0];
  if (!code) {
    console.error(`error: explain needs a diagnostic code\n\nEXAMPLE\n  forge explain F101`);
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
