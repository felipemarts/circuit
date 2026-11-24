import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { repo } from './helpers';

const run = promisify(execFile);
const cli = path.join(repo, 'bin', 'dev.mjs');

async function cv(args: string[], cwd = repo): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await run('node', [cli, ...args], { cwd, maxBuffer: 64 * 1024 * 1024 });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? -1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

let dir: string;
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cv-share-'));
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('CLI: export → verify <doc.json> gives the bench RunRecord and exit code', () => {
  const cases: [string, number, string[]][] = [
    ['bench/led-driver.bench.ts', 0, []],
    ['bench/broken/led-overcurrent.bench.ts', 1, []],
    ['bench/broken/led-overcurrent.bench.ts', 0, ['--set', 'R1=270']],
    ['bench/broken/led-no-resistor.bench.ts', 2, []],
    ['bench/broken/ac-no-stimulus.bench.ts', 3, []],
    ['bench/analog/rlc-ac-bandpass.bench.ts', 0, []],
  ];
  for (const [bench, exit, extra] of cases) {
    it(`${bench} ${extra.join(' ')} → exit ${exit}`, async () => {
      const file = path.join(dir, `${path.basename(bench, '.bench.ts')}${extra.length ? '-set' : ''}.circuit.json`);
      const exported = await cv(['export', bench, '-o', file, ...extra]);
      expect(exported.code, exported.stderr).toBe(0);
      const direct = await cv(['verify', bench, '--json', '--no-ledger', ...extra]);
      const viaDoc = await cv(['verify', file, '--json', '--no-ledger']);
      expect(direct.code).toBe(exit);
      expect(viaDoc.code).toBe(exit);
      expect(viaDoc.stdout).toBe(direct.stdout);
    }, 120000);
  }

  it('export to stdout is the same canonical document as -o', async () => {
    const out = await cv(['export', 'bench/led-driver.bench.ts']);
    expect(out.code).toBe(0);
    expect(out.stdout).toBe(fs.readFileSync(path.join(dir, 'led-driver.circuit.json'), 'utf8'));
    const doc = JSON.parse(out.stdout);
    expect(doc.schema).toBe('circuitsvibe-circuit/1');
    expect(Object.keys(doc)).toEqual([...Object.keys(doc)].sort());
  }, 60000);

  it('an invalid document still yields a RunRecord with T010 and exit 3', async () => {
    const bad = path.join(dir, 'bad.circuit.json');
    fs.writeFileSync(bad, JSON.stringify({ schema: 'circuitsvibe-circuit/1', name: 'bad', components: [{ id: 'R1', type: 'Resistor', params: { r: 1 }, pins: { '1': 'x', '2': 'gnd' } }], assertions: [] }));
    const r = await cv(['verify', bad, '--json', '--no-ledger']);
    expect(r.code).toBe(3);
    const record = JSON.parse(r.stdout);
    expect(record).toMatchObject({ schema: 'circuitsvibe-run/0.1', bench: 'bad', verdict: 'error', firstFailure: 'T010', exitCode: 3 });
    fs.writeFileSync(bad, '{ nope');
    const human = await cv(['verify', bad, '--no-ledger']);
    expect(human.code).toBe(3);
    expect(human.stdout).toContain('T010');
  }, 60000);
});

describe('CLI: share / open / verify --share', () => {
  it('share prints a URL that open decodes back to the same document (minus locations)', async () => {
    const shared = await cv(['share', 'bench/rc-lowpass.bench.ts', '--title', 'RC low-pass']);
    expect(shared.code).toBe(0);
    const url = shared.stdout.trim();
    expect(url).toMatch(/^https:\/\/circuitsvibe\.com\/app\.html#c=1\.[A-Za-z0-9_-]+$/);

    const opened = await cv(['open', url]);
    expect(opened.code).toBe(0);
    const exported = JSON.parse((await cv(['export', 'bench/rc-lowpass.bench.ts', '--title', 'RC low-pass'])).stdout);
    const strip = (d: any) => JSON.parse(JSON.stringify(d, (k, v) => (k === 'at' ? undefined : v)));
    expect(JSON.parse(opened.stdout)).toEqual(strip(exported));
    expect(JSON.parse(opened.stdout).meta).toEqual({ title: 'RC low-pass' });

    // A decoded link verifies like the bench (locations aside).
    const file = path.join(dir, 'opened.circuit.json');
    expect((await cv(['open', url, '-o', file])).code).toBe(0);
    const v = await cv(['verify', file, '--json', '--no-ledger']);
    expect(v.code).toBe(0);
    const direct = JSON.parse((await cv(['verify', 'bench/rc-lowpass.bench.ts', '--json', '--no-ledger'])).stdout);
    expect(JSON.parse(v.stdout)).toEqual(strip(direct));

    // share of a document file gives the same link.
    const fromDoc = await cv(['share', path.join(dir, 'opened.circuit.json')]);
    expect(fromDoc.stdout.trim()).toBe(url);
  }, 120000);

  it('share --json reports { url, bytes, warnings } and honours --base-url', async () => {
    const r = await cv(['share', 'bench/led-driver.bench.ts', '--json', '--base-url', 'http://localhost:5173/app.html']);
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(Object.keys(out)).toEqual(['url', 'bytes', 'warnings']);
    expect(out.url.startsWith('http://localhost:5173/app.html#c=1.')).toBe(true);
    expect(out.bytes).toBe(out.url.length);
    expect(out.warnings).toEqual([]);
  }, 60000);

  it('verify --share adds share.url to the RunRecord and prints it in human mode', async () => {
    const json = await cv(['verify', 'bench/led-driver.bench.ts', '--json', '--no-ledger', '--share']);
    expect(json.code).toBe(0);
    const record = JSON.parse(json.stdout);
    const plain = JSON.parse((await cv(['verify', 'bench/led-driver.bench.ts', '--json', '--no-ledger'])).stdout);
    const { share, ...rest } = record;
    expect(rest).toEqual(plain);
    expect(share.url).toBe((await cv(['share', 'bench/led-driver.bench.ts'])).stdout.trim());
    expect(share.bytes).toBe(share.url.length);

    const human = await cv(['verify', 'bench/led-driver.bench.ts', '--no-ledger', '--share']);
    expect(human.code).toBe(0);
    expect(human.stdout).toContain(`share: ${share.url}`);

    // The link carries the --set values that were verified.
    const set = JSON.parse((await cv(['verify', 'bench/broken/led-overcurrent.bench.ts', '--json', '--no-ledger', '--share', '--set', 'R1=270'])).stdout);
    const doc = JSON.parse((await cv(['open', set.share.url])).stdout);
    expect(doc.overrides).toEqual({ R1: 270 });
    expect(doc.components.find((c: any) => c.id === 'R1').params).toEqual({ r: 270 });
  }, 120000);

  it('custom components: export/share exit 3 with T013 naming the part; verify --share keeps its verdict', async () => {
    const exp = await cv(['export', 'bench/broken/nr-chatter-tran.bench.ts']);
    expect(exp.code).toBe(3);
    expect(exp.stderr).toContain('T013');
    expect(exp.stderr).toContain('U1 (Chatter)');
    const sh = await cv(['share', 'bench/broken/ac-no-model.bench.ts', '--json']);
    expect(sh.code).toBe(3);
    expect(JSON.parse(sh.stdout).diagnostics[0]).toMatchObject({ code: 'T013', subject: { components: ['U1'] } });
    const v = await cv(['verify', 'bench/broken/nr-chatter-tran.bench.ts', '--json', '--no-ledger', '--share']);
    expect(v.code).toBe(2);
    expect(JSON.parse(v.stdout).share.error.code).toBe('T013');
  }, 120000);

  it('open: garbage and unknown versions exit 3 with T016 / T017', async () => {
    const garbage = await cv(['open', 'https://circuitsvibe.com/app.html#c=1.not-a-payload']);
    expect(garbage.code).toBe(3);
    expect(garbage.stderr).toContain('T016');
    const version = await cv(['open', '#c=9.AAAA', '--json']);
    expect(version.code).toBe(3);
    expect(JSON.parse(version.stdout).diagnostics[0].code).toBe('T017');
    const explain = await cv(['explain', 'T013']);
    expect(explain.code).toBe(0);
    expect(explain.stdout).toContain('custom-component-not-serializable');
  }, 60000);
});
