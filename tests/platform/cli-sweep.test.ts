import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as path from 'node:path';

const run = promisify(execFile);
const repo = path.resolve(__dirname, '..', '..');
const cli = path.join(repo, 'bin', 'dev.mjs');

async function cvibe(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await run('node', [cli, ...args], { cwd: repo });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? -1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

describe('circuitsvibe sweep / new stages (end-to-end)', () => {
  it('sweep prints a deterministic JSON curve and a fixed-width table', async () => {
    const args = ['sweep', 'bench/analog/divider-dc-sweep.bench.ts', '--source', 'V1', '--from', '0', '--to', '10', '--points', '6', '--probe', 'out,R1.i'];
    const a = await cvibe([...args, '--json']);
    const b = await cvibe([...args, '--json']);
    expect(a.code).toBe(0);
    expect(a.stdout).toBe(b.stdout);
    const record = JSON.parse(a.stdout);
    expect(record.schema).toBe('circuitsvibe-sweep/0.1');
    expect(record.x).toEqual([0, 2, 4, 6, 8, 10]);
    expect(record.probes.out).toEqual([0, 1, 2, 3, 4, 5]);
    expect(record.probes['R1.i'][5]).toBeCloseTo(5e-4, 15);

    const table = await cvibe(args);
    expect(table.code).toBe(0);
    expect(table.stdout).toMatch(/\s+V1\s+out\s+R1\.i/);
    expect(table.stdout.trim().split('\n').length).toBe(1 + 1 + 6 + 1);
  }, 60000);

  it('sweep misuse exits 3 with guidance', async () => {
    const r = await cvibe(['sweep', 'bench/analog/divider-dc-sweep.bench.ts', '--source', 'R1', '--from', '0', '--to', '1']);
    expect(r.code).toBe(3);
    expect(r.stderr).toMatch(/--param R1/);
    const missing = await cvibe(['sweep', 'bench/analog/divider-dc-sweep.bench.ts', '--from', '0']);
    expect(missing.code).toBe(3);
  }, 60000);

  it('--stage accepts dc and ac; unknown stages list the valid names', async () => {
    const r = await cvibe(['verify', 'bench/analog/rlc-ac-bandpass.bench.ts', '--stage', 'ac', '--json', '--no-ledger']);
    expect(r.code).toBe(0);
    const record = JSON.parse(r.stdout);
    expect(Object.keys(record.stages)).toEqual(['lint', 'ac']);
    const bad = await cvibe(['verify', 'bench/analog/rlc-ac-bandpass.bench.ts', '--stage', 'noise']);
    expect(bad.code).toBe(3);
    expect(bad.stderr).toMatch(/lint, op, dc, ac, tran/);
  }, 60000);
});
