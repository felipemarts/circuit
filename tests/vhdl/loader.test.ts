import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadBench } from '../../src/cli/load';
import { compileVhdl } from '../../src/vhdl';

// The bench loader turns `import x from './file.vhd'` into a VhdlSource
// { kind: 'vhdl-source', text, path } so VHDL diagnostics point at the file.

let dir: string;
const fwd = (p: string): string => p.split(path.sep).join('/');

function write(rel: string, content: string): string {
  const file = path.join(dir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cv vhdl loader '));
});
afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const VHD = 'entity e is end entity;\narchitecture a of e is\nbegin\nend architecture;\n';

describe('bench loader: VHDL imports', () => {
  it('imports .vhd / .vhdl files as frozen { kind, text, path } sources', async () => {
    write('rtl/counter.vhd', VHD);
    write('rtl/Adder.VHDL', `-- adder\n${VHD}`);
    const file = write(
      'v.bench.ts',
      `import { bench, VoltageSource, Resistor } from 'circuitsvibe';
import counter from './rtl/counter.vhd';
import * as adderModule from './rtl/Adder.VHDL';

const d = bench('vhdl-import', (tb) => {
  const v1 = tb.add('V1', new VoltageSource(1));
  const r1 = tb.add('R1', new Resistor('1k'));
  v1.pin('+').connect(r1.pin('1'));
  r1.pin('2').connect(tb.gnd);
  v1.pin('-').connect(tb.gnd);
});
export default Object.assign(d, { vhdl: [counter, adderModule] });
`,
    );
    const desc = (await loadBench(file)) as unknown as { name: string; vhdl: { kind: string; text: string; path: string }[] };
    expect(desc.name).toBe('vhdl-import');
    const [counter, adder] = desc.vhdl;
    expect(counter.kind).toBe('vhdl-source');
    expect(counter.text).toBe(VHD);
    // The temp dir is outside the cwd, so the path stays absolute (forward slashes), like bench locations.
    expect(counter.path).toBe(fwd(path.join(dir, 'rtl/counter.vhd')));
    expect(Object.isFrozen(counter)).toBe(true);
    expect(adder.text.startsWith('-- adder')).toBe(true);
  });

  it('diagnostics of an imported file use its path and file:line:col', async () => {
    write('bad.vhd', 'entity e is\n  port (a : in std_logic)\nend entity;\n');
    const file = write(
      'bad.bench.ts',
      `import { bench } from 'circuitsvibe';
import bad from './bad.vhd';
const d = bench('bad', () => {});
export default Object.assign(d, { vhdl: bad });
`,
    );
    const desc = (await loadBench(file)) as unknown as { vhdl: { text: string; path: string } };
    const r = compileVhdl(desc.vhdl);
    expect(r.ok).toBe(false);
    expect(r.diagnostics[0].code).toBe('V701');
    expect(r.diagnostics[0].at).toBe(`${fwd(path.join(dir, 'bad.vhd'))}:3:1`);
  });

  it('leaves other imports alone (a missing .vhd is still an unresolved import)', async () => {
    const file = write('missing.bench.ts', `import x from './nope.vhd';\nexport default x;\n`);
    await expect(loadBench(file)).rejects.toThrow(/cannot resolve '\.\/nope\.vhd'/);
  });
});
