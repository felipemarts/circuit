import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadBench } from '../../src/cli/load';
import { elaborate, type BenchDescriptor, type ComponentDef } from '../../src/forge';

export const repo = path.resolve(__dirname, '..', '..');

/** Every bench file under bench/ (recursive), repo-relative with forward slashes. */
export function findBenches(dir = path.join(repo, 'bench')): string[] {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap(e => (e.isDirectory() ? findBenches(path.join(dir, e.name)) : [path.join(dir, e.name)]))
    .filter(f => f.endsWith('.bench.ts'))
    .map(f => path.relative(repo, f).split(path.sep).join('/'))
    .sort();
}

export async function load(rel: string): Promise<BenchDescriptor> {
  const cwd = process.cwd();
  process.chdir(repo);
  try {
    return await loadBench(rel);
  } finally {
    process.chdir(cwd);
  }
}

/** The defineComponent definitions a bench uses (a test-side definition registry). */
export function definitionsOf(desc: BenchDescriptor): Record<string, ComponentDef> {
  const defs: Record<string, ComponentDef> = {};
  for (const comp of elaborate(desc).components.values()) {
    const def = (comp as { _def?: ComponentDef })._def;
    if (def) defs[def.name] = def;
  }
  return defs;
}

/** Deep copy without any `at` member (locations are not carried by share links). */
export function withoutAt<T>(value: T): T {
  return JSON.parse(JSON.stringify(value, (k, v) => (k === 'at' ? undefined : v))) as T;
}
