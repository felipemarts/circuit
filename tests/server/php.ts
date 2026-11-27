/**
 * Starts the PHP API (server/api) on PHP's built-in server for integration
 * tests: `php` on PATH (8.1+, pdo_sqlite), or Docker with
 * CIRCUITSVIBE_TEST_PHP_DOCKER=php:8.3-cli. `phpAvailable` is false otherwise.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as net from 'node:net';

export const repo = path.resolve(__dirname, '..', '..');
const dockerImage = process.env.CIRCUITSVIBE_TEST_PHP_DOCKER;
const hasPhp = !dockerImage && spawnSync('php', ['-r', 'exit(extension_loaded("pdo_sqlite") ? 0 : 1);']).status === 0;
export const phpAvailable = Boolean(dockerImage) || hasPhp;

async function freePort(): Promise<number> {
  return new Promise(resolve => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

export interface PhpServer {
  base: string;
  stop(): void;
}

export async function startPhp(env: Record<string, string> = {}): Promise<PhpServer> {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  let proc: ChildProcess;
  let dataDir = '';
  let container = '';
  if (dockerImage) {
    container = `cv-test-${process.pid}-${port}`;
    const envArgs = Object.entries({ CIRCUITSVIBE_DATA_DIR: '/tmp/cvdata', ...env }).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
    proc = spawn('docker', ['run', '--rm', '--name', container, '-p', `127.0.0.1:${port}:8080`, ...envArgs, '-v', `${path.join(repo, 'server')}:/srv:ro`, '-w', '/srv', dockerImage, 'php', '-S', '0.0.0.0:8080', 'dev-router.php'], { stdio: 'ignore' });
  } else {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cv-api-'));
    proc = spawn('php', ['-S', `127.0.0.1:${port}`, path.join(repo, 'server', 'dev-router.php')], {
      cwd: path.join(repo, 'server'),
      env: { ...process.env, CIRCUITSVIBE_DATA_DIR: dataDir, ...env },
      stdio: 'ignore',
    });
  }
  for (let i = 0; i < 150; i++) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) break;
    } catch {
      /* not up yet */
    }
    await new Promise(r => setTimeout(r, 200));
    if (i === 149) throw new Error('PHP server did not start');
  }
  return {
    base,
    stop() {
      if (container) spawnSync('docker', ['rm', '-f', container]);
      proc.kill();
      if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}
