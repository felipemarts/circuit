import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as path from 'node:path';

const run = promisify(execFile);
const repo = path.resolve(__dirname, '..', '..');
const forge = path.join(repo, 'bin', 'forge.mjs');

async function forgeCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await run('node', [forge, ...args], { cwd: repo });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? -1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

describe('forge CLI (end-to-end)', () => {
  it('verify: passing bench exits 0 with a valid JSON RunRecord', async () => {
    const { code, stdout } = await forgeCli([
      'verify',
      'bench/led-driver.bench.ts',
      '--json',
      '--no-ledger',
    ]);
    expect(code).toBe(0);
    const record = JSON.parse(stdout);
    expect(record.schema).toBe('forge-run/0.1');
    expect(record.verdict).toBe('pass');
    expect(record.netlist.components.map((c: { id: string }) => c.id)).toEqual(['D1', 'R1', 'V1']);
  }, 60000);

  it('verify: broken bench exits 1 and --set applying the hint exits 0', async () => {
    const broken = await forgeCli([
      'verify',
      'bench/broken/led-overcurrent.bench.ts',
      '--json',
      '--no-ledger',
    ]);
    expect(broken.code).toBe(1);
    const record = JSON.parse(broken.stdout);
    const hint = record.stages.op.assertions[0].hint;
    expect(hint.kind).toBe('verified-param-range');

    const fixed = await forgeCli([
      'verify',
      'bench/broken/led-overcurrent.bench.ts',
      '--set',
      `R1=${hint.suggestedValue}`,
      '--no-ledger',
    ]);
    expect(fixed.code).toBe(0);
  }, 60000);

  it('verify: lint-broken bench exits 2', async () => {
    const { code, stdout } = await forgeCli([
      'verify',
      'bench/broken/led-no-resistor.bench.ts',
      '--no-ledger',
    ]);
    expect(code).toBe(2);
    expect(stdout).toContain('F105');
  }, 60000);

  it('explain and catalog work and unknown inputs exit 3 with guidance', async () => {
    const explain = await forgeCli(['explain', 'F101']);
    expect(explain.code).toBe(0);
    expect(explain.stdout).toContain('DC path');

    const unknown = await forgeCli(['explain', 'Z999']);
    expect(unknown.code).toBe(3);
    expect(unknown.stderr).toContain('Known codes');

    const catalog = await forgeCli(['catalog', 'LED']);
    expect(catalog.code).toBe(0);
    expect(catalog.stdout).toContain('anode');
  }, 60000);
});
