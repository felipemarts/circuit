import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { bench, runLadder, VoltageSource, Resistor, Capacitor, Part } from '../../src/forge';
import type { LogicIC } from '../../src/mixed/device';
import { power, tieLow } from './helpers';

const run = promisify(execFile);
const repo = path.resolve(__dirname, '..', '..');
const cli = path.join(repo, 'bin', 'dev.mjs');

async function forgeCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await run('node', [cli, ...args], { cwd: repo });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? -1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

describe('CLI: logic capture and catalog', () => {
  it('verify --vcd writes the logic capture of the run as VCD', async () => {
    const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cv-vcd-')), 'div.vcd');
    const { code, stdout } = await forgeCli(['verify', 'bench/digital/hc74-divider.bench.ts', '--json', '--no-ledger', '--vcd', out]);
    expect(code).toBe(0);
    const rec = JSON.parse(stdout);
    expect(Object.keys(rec.stages.tran.logic[0].signals).sort()).toEqual(['U1.1CLK', 'q']);
    const vcd = fs.readFileSync(out, 'utf8');
    expect(vcd).toContain('$timescale 1ps $end');
    expect(vcd).toMatch(/\$var wire 1 \S+ q \$end/);
    expect(vcd).toContain('$var wire 1 ! U1.1CLK $end');
  }, 60000);

  it('catalog lists the logic ICs with pin numbers, levels per VCC and citations', async () => {
    const { code, stdout } = await forgeCli(['catalog', '74HC00']);
    expect(code).toBe(0);
    expect(stdout).toContain('1=1A (in)');
    expect(stdout).toContain('14=VCC (supply)');
    expect(stdout).toContain('VCC 5 V: VIL 1.5 V, VIH 3.5 V');
    expect(stdout).toContain('source: Texas Instruments');
    const json = await forgeCli(['catalog', '--json']);
    const types = JSON.parse(json.stdout).components.map((c: { type: string }) => c.type);
    for (const t of ['74HC00', '74HC04', '74HC14', '74HC74', '74HC595', '74HCT04', 'CD4017', 'CD4011', 'NE555', 'Nand', 'DFF', 'Clock']) {
      expect(types).toContain(t);
    }
  }, 60000);
});

describe('AC with logic ICs', () => {
  it('an IC input on an RC filter node: small-signal model loads it negligibly (no S204)', () => {
    const r = runLadder(
      bench('ac-ic', tb => {
        const u = tb.add('U1', Part('74HC04')) as LogicIC;
        power(tb, u, 5);
        const vin = tb.add('VIN', new VoltageSource({ dc: 0, ac: 1 }));
        const r1 = tb.add('R1', new Resistor('1k'));
        const c1 = tb.add('C1', new Capacitor('159.155n'));
        vin.pin('-').connect(tb.gnd);
        vin.pin('+').connect(r1.pin('1'));
        r1.pin('2').connect(u.pin('1A'));
        c1.pin('1').connect(u.pin('1A'));
        c1.pin('2').connect(tb.gnd);
        tieLow(tb, u, ['2A', '3A', '4A', '5A', '6A']);
        tb.name('out', u.pin('1A'));
        tb.expect.ac({ from: '10', to: '100k' }).probe('out').gainAt('1k').toBeCloseTo(-3.0103, 0.01);
      }),
    );
    expect(r.exitCode, JSON.stringify(r.diagnostics)).toBe(0);
  });
});
