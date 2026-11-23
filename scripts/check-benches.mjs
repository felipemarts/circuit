#!/usr/bin/env node
// Runs every bench under bench/ through the CLI and checks it against the
// expectation written in its header comment:
//   - benches outside bench/broken/ must exit 0;
//   - seeded-broken benches declare `Expected: <CODE> ... exit <N>` and must
//     exit N and report CODE (as a diagnostic or a failed assertion code).
// Each bench runs twice and the two --json RunRecords must be byte-identical
// (the determinism contract).
//
//   node scripts/check-benches.mjs          # via the dev launcher (src/)
//   node scripts/check-benches.mjs --dist   # via dist/circuitsvibe-standalone.mjs
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const useDist = process.argv.includes('--dist');
const cli = path.join(root, useDist ? 'dist/circuitsvibe-standalone.mjs' : 'bin/dev.mjs');
if (!fs.existsSync(cli)) {
  console.error(`error: ${path.relative(root, cli)} missing — run \`npm run build:lib\` first`);
  process.exit(1);
}

function findBenches(dir) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? findBenches(path.join(dir, e.name)) : [path.join(dir, e.name)]))
    .filter((f) => f.endsWith('.bench.ts'))
    .sort();
}

function expectation(file) {
  const rel = path.relative(root, file).split(path.sep).join('/');
  if (!rel.startsWith('bench/broken/')) return { exit: 0 };
  const header = fs.readFileSync(file, 'utf8').match(/\/\*\*([\s\S]*?)\*\//)?.[1] ?? '';
  const code = header.match(/Expected:\s*([FSAT]\d{3})/)?.[1];
  const exit = header.match(/\bexit (\d)\b/i)?.[1];
  if (!code || exit === undefined) {
    throw new Error(`${rel}: seeded-broken benches must state "Expected: <CODE> … exit <N>" in their header`);
  }
  return { exit: Number(exit), code };
}

function verify(rel) {
  const r = spawnSync(process.execPath, [cli, 'verify', rel, '--json', '--no-ledger'], {
    cwd: root,
    encoding: 'utf8',
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

let failures = 0;
for (const file of findBenches(path.join(root, 'bench'))) {
  const rel = path.relative(root, file).split(path.sep).join('/');
  const want = expectation(file);
  const first = verify(rel);
  const second = verify(rel);
  const problems = [];

  if (first.status !== want.exit) problems.push(`exit ${first.status}, expected ${want.exit}`);
  let record;
  try {
    record = JSON.parse(first.stdout);
  } catch {
    problems.push(`stdout is not a JSON RunRecord${first.stderr ? `: ${first.stderr.trim()}` : ''}`);
  }
  if (record && want.code) {
    const codes = new Set(record.diagnostics.map((d) => d.code));
    for (const stage of Object.values(record.stages)) {
      for (const a of stage.assertions ?? []) if (a.verdict === 'fail') codes.add('A301');
    }
    if (!codes.has(want.code)) problems.push(`expected ${want.code}, got [${[...codes].join(', ')}]`);
  }
  if (first.stdout !== second.stdout) problems.push('two identical runs produced different RunRecords');

  if (problems.length > 0) failures++;
  console.log(`${problems.length ? 'FAIL' : 'ok  '}  exit ${first.status}  ${rel}${problems.length ? `\n      ${problems.join('\n      ')}` : ''}`);
}

console.log(failures ? `\n${failures} bench(es) failed` : `\nall benches match their expectations (${useDist ? 'dist' : 'src'})`);
process.exit(failures ? 1 : 0);
