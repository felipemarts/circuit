import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadBench } from '../../src/cli/load';
import { elaborate } from '../../src/forge';

// The CLI's bench loader: pure-JS TS transpilation, no esbuild. These pin the
// properties agents depend on — line-accurate locations, local imports, and
// actionable errors for unsupported syntax.

let dir: string;

function write(rel: string, content: string): string {
  const file = path.join(dir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

const LED_BENCH = (importLine: string, value: string) => `import { bench, VoltageSource, Resistor, LED } from 'circuitsvibe';
${importLine}

interface Unused { a: number }

export default bench('loader', (tb) => {
  const v1 = tb.add('V1', new VoltageSource(5));
  const r1 = tb.add('R1', new Resistor(${value}));
  const d1 = tb.add('D1', new LED());
  v1.pin('+').connect(r1.pin('1'));
  r1.pin('2').connect(d1.pin('anode'));
  d1.pin('cathode').connect(tb.gnd);
  v1.pin('-').connect(tb.gnd);
  tb.expect.op('D1.i').toBeWithin('5m', '15m');
});
`;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cv loader '));
});
afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('bench loader', () => {
  it('strips types, follows relative imports (incl. .js → .ts) and keeps line numbers', async () => {
    write('lib/values.ts', `export enum Ohms { Led = 330 }\nexport const unit: string = '';\n`);
    const file = write('a.bench.ts', LED_BENCH(`import { Ohms } from './lib/values.js';`, 'Ohms.Led'));
    const desc = await loadBench(file);
    expect(desc.name).toBe('loader');

    const elab = elaborate(desc);
    // Line 8 of the file is the tb.add('R1', …) call; the temp dir (with a
    // space in its name) is outside the cwd, so the path stays absolute.
    expect(elab.locOf.get('R1')).toBe(`${file.replace(/\\/g, '/')}:8`);
    expect(elab.assertions[0].at).toMatch(/a\.bench\.ts:14$/);
  });

  it('resolves directory index files and JSON', async () => {
    write('cfg/index.ts', `import data from './data.json';\nexport const r = data.r as string;\n`);
    write('cfg/data.json', `{ "r": "470" }`);
    const file = write('b.bench.ts', LED_BENCH(`import { r } from './cfg';`, 'r'));
    const elab = elaborate(await loadBench(file));
    expect(elab.netlist.components.find(c => c.id === 'R1')?.params.r).toBe(470);
  });

  it('fails with actionable messages', async () => {
    await expect(loadBench(path.join(dir, 'missing.bench.ts'))).rejects.toThrow(/bench file not found/);

    const syntax = write('syntax.bench.ts', `export default bench('x', (tb) => {\n`);
    await expect(loadBench(syntax)).rejects.toThrow(/failed to compile/);

    const meta = write('meta.bench.ts', `console.log(import.meta.url);\nexport default 1;\n`);
    await expect(loadBench(meta)).rejects.toThrow(/import\.meta is not supported/);

    const tla = write('tla.bench.ts', `await Promise.resolve();\nexport default 1;\n`);
    await expect(loadBench(tla)).rejects.toThrow(/top-level await/);

    const noDefault = write('nodefault.bench.ts', `export const x = 1;\n`);
    await expect(loadBench(noDefault)).rejects.toThrow(/must default-export a bench/);

    const badImport = write('badimport.bench.ts', `import { x } from './nope';\nexport default x;\n`);
    await expect(loadBench(badImport)).rejects.toThrow(/cannot resolve '\.\/nope'/);
  });
});
