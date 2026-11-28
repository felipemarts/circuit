/**
 * The CLI against the real PHP API: an agent registers, shares a circuit with
 * a custom component through the circuit cache (short link), a human installs
 * the published component from the registry and the ranking counts the use.
 * Skipped without PHP (see php.ts).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { phpAvailable, startPhp, repo, type PhpServer } from './php';

let server: PhpServer;
let work = '';

function cv(args: string[], opts: { cwd: string; user: string; stdin?: string }): Promise<{ status: number; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    const p = spawn(process.execPath, [path.join(repo, 'bin', 'dev.mjs'), ...args], {
      cwd: opts.cwd,
      env: { ...process.env, CIRCUITSVIBE_API: `${server.base}/api`, CIRCUITSVIBE_CONFIG_DIR: path.join(work, `.cfg-${opts.user}`), CIRCUITSVIBE_TOKEN: '', CIRCUITSVIBE_PASSWORD: '' },
    });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', d => (stdout += d));
    p.stderr.on('data', d => (stderr += d));
    p.stdin.end(opts.stdin ?? '');
    p.on('close', status => resolve({ status: status ?? -1, stdout, stderr }));
  });
}

const PART = `import { defineComponent } from 'circuitsvibe';
export default defineComponent({
  name: 'Ntc',
  pins: ['1', '2'],
  params: { tempC: { default: 25 } },
  stamp(ctx) { ctx.stampResistance('1', '2', 1e4 * Math.exp(3950 * (1 / (ctx.params.tempC + 273.15) - 1 / 298.15))); },
});
`;
const bench = (importPath: string, tempC: number) => `import { bench, VoltageSource, Resistor } from 'circuitsvibe';
import Ntc from '${importPath}';
export default bench('ntc-${tempC}', (tb) => {
  const v1 = tb.add('V1', new VoltageSource(5));
  const r1 = tb.add('R1', new Resistor('10k'));
  const t1 = tb.add('TH1', new Ntc({ tempC: ${tempC} }));
  v1.pin('+').connect(r1.pin('1')); r1.pin('2').connect(t1.pin('1')); t1.pin('2').connect(tb.gnd); v1.pin('-').connect(tb.gnd);
  tb.name('out', t1.pin('1'));
  tb.expect.op('out').toBeWithin(0.1, 4.9);
});
`;

describe.skipIf(!phpAvailable)('CLI + service (share, links, registry)', { timeout: 60_000 }, () => {
  beforeAll(async () => {
    server = await startPhp();
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'cv-cli-'));
    for (const u of ['agent', 'human']) fs.mkdirSync(path.join(work, u, 'parts'), { recursive: true });
    fs.writeFileSync(path.join(work, 'agent', 'parts', 'ntc.part.ts'), PART);
    fs.writeFileSync(path.join(work, 'agent', 'ntc.bench.ts'), bench('./parts/ntc.part', 25));
  }, 60_000);
  afterAll(() => {
    server?.stop();
    if (work) fs.rmSync(work, { recursive: true, force: true });
  });

  const agent = (args: string[], stdin?: string) => cv(args, { cwd: path.join(work, 'agent'), user: 'agent', stdin });
  const human = (args: string[], stdin?: string) => cv(args, { cwd: path.join(work, 'human'), user: 'human', stdin });

  it('logged out, share falls back to the #c= link; service commands ask for an account (T020)', async () => {
    const s = await agent(['share', 'ntc.bench.ts', '--json']);
    expect(s.status).toBe(0);
    expect(JSON.parse(s.stdout).url).toMatch(/#c=1\./);
    const w = await agent(['whoami']);
    expect(w.status).toBe(3);
    expect(w.stderr).toContain('T020');
  }, 60_000);

  let link = '';
  it('an agent registers (password on stdin) and gets a short private link; verify needs --allow-code (T019)', async () => {
    const reg = await agent(['register', '--user', 'bot-1', '--kind', 'agent', '--json'], 'agent-password\n');
    expect(reg.status).toBe(0);
    expect(JSON.parse(reg.stdout).user).toEqual({ username: 'bot-1', kind: 'agent' });
    const s = await agent(['share', 'ntc.bench.ts', '--json', '--title', 'NTC divider']);
    expect(s.status).toBe(0);
    const out = JSON.parse(s.stdout);
    expect(out).toMatchObject({ visibility: 'private' });
    expect(out.url).toMatch(/\/app\.html\?c=[A-Za-z0-9]{10}$/);
    expect(out.expiresAt).toBeTruthy();
    link = out.url;

    const refused = await agent(['verify', link, '--json', '--no-ledger']);
    expect(refused.status).toBe(3);
    expect(JSON.parse(refused.stdout).firstFailure).toBe('T019');
    const allowed = await agent(['verify', link, '--json', '--no-ledger', '--allow-code']);
    const local = await agent(['verify', 'ntc.bench.ts', '--json', '--no-ledger']);
    expect(allowed.status).toBe(0);
    const strip = (s: string) => JSON.stringify(JSON.parse(s, (k, v) => (k === 'at' || k === 'bench' ? undefined : v)));
    expect(strip(allowed.stdout)).toBe(strip(local.stdout));

    const opened = await agent(['open', link]);
    expect(JSON.parse(opened.stdout).definitions).toEqual([{ pins: ['1', '2'], source: 'parts/ntc.part.ts', type: 'Ntc' }]);
  }, 120_000);

  it('component publish → search → add → a public circuit using it → ranking', async () => {
    const pub = await agent(['component', 'publish', 'parts/ntc.part.ts', '--description', 'NTC thermistor', '--tags', 'sensor', '--json']);
    expect(pub.status).toBe(0);
    expect(JSON.parse(pub.stdout)).toMatchObject({ ref: 'bot-1/ntc', version: 1, created: true });

    expect((await human(['register', '--user', 'maria', '--password', 'maria-password'])).status).toBe(0);
    const search = await human(['component', 'search', 'thermistor', '--json']);
    expect(JSON.parse(search.stdout).items.map((c: any) => c.ref)).toEqual(['bot-1/ntc']);
    const add = await human(['component', 'add', 'bot-1/ntc', '--json']);
    expect(add.status).toBe(0);
    expect(JSON.parse(add.stdout).file.replace(/\\/g, '/')).toBe('components/ntc.part.ts');
    expect(fs.readFileSync(path.join(work, 'human', 'components', 'ntc.part.ts'), 'utf8')).toMatch(/^\/\/ @circuitsvibe-component bot-1\/ntc@1 sha256:[0-9a-f]{64}\n/);

    fs.writeFileSync(path.join(work, 'human', 'hot.bench.ts'), bench('./components/ntc.part', 60));
    const shared = await human(['share', 'hot.bench.ts', '--public', '--tags', 'thermistor', '--json']);
    expect(shared.status).toBe(0);
    expect(JSON.parse(shared.stdout)).toMatchObject({ visibility: 'public', expiresAt: null });

    const ranking = JSON.parse((await human(['component', 'search', '--json'])).stdout);
    expect(ranking.items[0]).toMatchObject({ rank: 1, ref: 'bot-1/ntc', uses: 1, circuits: 1, downloads: 1 });
    const wall = JSON.parse((await human(['circuits', 'thermistor', '--json'])).stdout);
    expect(wall.items.map((c: any) => c.author.username)).toEqual(['maria']);
  }, 120_000);
});
