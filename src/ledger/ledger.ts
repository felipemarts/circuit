import * as fs from 'node:fs';
import * as path from 'node:path';
import type { RunRecord } from '../schema/types';

/**
 * Append-only run ledger: .forge/runs.jsonl in the working directory.
 * Persists every RunRecord so agents can query what was already tried
 * instead of re-deriving it from their own context (anti context-attrition).
 *
 * Node-only module — never imported by browser-safe layers.
 */

export interface LedgerEntry extends RunRecord {
  runId: string;
  at: string;
}

const LEDGER_DIR = '.forge';
const LEDGER_FILE = 'runs.jsonl';

function ledgerPath(cwd: string): string {
  return path.join(cwd, LEDGER_DIR, LEDGER_FILE);
}

export function appendRun(record: RunRecord, cwd = process.cwd()): LedgerEntry {
  const file = ledgerPath(cwd);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const seq = countRuns(cwd) + 1;
  const shortHash = record.netlist.hash ? record.netlist.hash.slice(0, 12) : 'nohash';
  const entry: LedgerEntry = {
    runId: `${shortHash}-${String(seq).padStart(3, '0')}`,
    at: new Date().toISOString(),
    ...record,
  };
  fs.appendFileSync(file, `${JSON.stringify(entry)}\n`);
  return entry;
}

export function listRuns(cwd = process.cwd()): LedgerEntry[] {
  const file = ledgerPath(cwd);
  if (!fs.existsSync(file)) return [];
  const entries: LedgerEntry[] = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (line.trim().length === 0) continue;
    try {
      entries.push(JSON.parse(line) as LedgerEntry);
    } catch {
      // One corrupt line (crash mid-append, manual edit) must not brick the
      // log commands; skip it.
    }
  }
  return entries;
}

/**
 * Last match wins: concurrent appends can theoretically mint the same runId
 * (count-then-append race); for this local single-user CLI the newest record
 * is the one the user means.
 */
export function findRun(runId: string, cwd = process.cwd()): LedgerEntry | undefined {
  const runs = listRuns(cwd);
  for (let i = runs.length - 1; i >= 0; i--) {
    if (runs[i].runId === runId) return runs[i];
  }
  return undefined;
}

function countRuns(cwd: string): number {
  const file = ledgerPath(cwd);
  if (!fs.existsSync(file)) return 0;
  const text = fs.readFileSync(file, 'utf8');
  let count = 0;
  for (const line of text.split('\n')) if (line.trim().length > 0) count++;
  return count;
}
