import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const run = promisify(execFile);
const repo = path.resolve(__dirname, '..', '..');
const cli = path.join(repo, 'bin', 'dev.mjs');

async function forgeCli(
  args: string[],
  cwd = repo,
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await run('node', [cli, ...args], { cwd });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? -1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

describe('circuitsvibe CLI (end-to-end)', () => {
  it('verify: passing bench exits 0 with a valid JSON RunRecord', async () => {
    const { code, stdout } = await forgeCli([
      'verify',
      'bench/led-driver.bench.ts',
      '--json',
      '--no-ledger',
    ]);
    expect(code).toBe(0);
    const record = JSON.parse(stdout);
    expect(record.schema).toBe('circuitsvibe-run/0.1');
    expect(record.engine).toBe('circuitsvibe@0.2.0');
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

  it('reports source locations relative to the working directory with forward slashes', async () => {
    const { stdout } = await forgeCli([
      'verify',
      'bench/broken/led-overcurrent.bench.ts',
      '--json',
      '--no-hints',
      '--no-ledger',
    ]);
    const record = JSON.parse(stdout);
    expect(record.stages.op.assertions[0].at).toBe('bench/broken/led-overcurrent.bench.ts:22');
    expect(record.netlist.components.find((c: { id: string }) => c.id === 'R1').at).toBe(
      'bench/broken/led-overcurrent.bench.ts:12',
    );
  }, 60000);

  it('init scaffolds a passing bench + AGENTS.md, refuses to overwrite, keeps an existing AGENTS.md', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cv-init-'));
    try {
      const first = await forgeCli(['init', 'demo'], dir);
      expect(first.code).toBe(0);
      expect(fs.readFileSync(path.join(dir, 'demo.bench.ts'), 'utf8')).toContain("from 'circuitsvibe'");
      expect(fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8')).toBe(
        fs.readFileSync(path.join(repo, 'AGENTS.md'), 'utf8'),
      );

      const verify = await forgeCli(['verify', 'demo.bench.ts', '--no-ledger'], dir);
      expect(verify.code).toBe(0);

      const again = await forgeCli(['init', 'demo'], dir);
      expect(again.code).toBe(3);
      expect(again.stderr).toContain('--force');

      fs.writeFileSync(path.join(dir, 'AGENTS.md'), 'project rules\n');
      const other = await forgeCli(['init', 'other'], dir);
      expect(other.code).toBe(0);
      expect(other.stdout).toContain('left untouched');
      expect(fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8')).toBe('project rules\n');

      const bad = await forgeCli(['init', '../escape'], dir);
      expect(bad.code).toBe(3);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60000);

  it('agents prints the playbook and version prints the package version', async () => {
    const agents = await forgeCli(['agents']);
    expect(agents.code).toBe(0);
    expect(agents.stdout).toBe(fs.readFileSync(path.join(repo, 'AGENTS.md'), 'utf8'));

    const version = await forgeCli(['version']);
    expect(version.code).toBe(0);
    expect(version.stdout.trim()).toBe(JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')).version);
  }, 60000);
});
