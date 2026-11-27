import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { toCircuitDoc, benchFromDoc, runLadder, validateCircuitDoc, loadDocDefinitions, stripLocations, isCircuitDocError } from '../../src/forge';
import * as forge from '../../src/forge';
import { loadBench, definitionSourcesOf } from '../../src/cli/load';
import { validateJsonSchema } from './mini-json-schema';
import { repo } from './helpers';

const schema = JSON.parse(fs.readFileSync(path.join(repo, 'schema', 'circuit.schema.json'), 'utf8'));
const platform = { __esModule: true, ...forge };

const NTC = `import { defineComponent } from 'circuitsvibe';
import { kelvin } from './util';
export default defineComponent({
  name: 'Ntc',
  pins: ['1', '2'],
  params: { r25: { default: 10000 }, beta: { default: 3950 }, tempC: { default: 25 } },
  stamp(ctx) {
    ctx.stampResistance('1', '2', ctx.params.r25 * Math.exp(ctx.params.beta * (1 / kelvin(ctx.params.tempC) - 1 / 298.15)));
  },
});
`;
const UTIL = `export const kelvin = (c: number) => c + 273.15;\n`;
const BENCH = `import { bench, VoltageSource, Resistor } from 'circuitsvibe';
import Ntc from './parts/ntc.part';
export default bench('ntc', (tb) => {
  const v1 = tb.add('V1', new VoltageSource(5));
  const r1 = tb.add('R1', new Resistor('10k'));
  const t1 = tb.add('TH1', new Ntc({ tempC: 50 }));
  v1.pin('+').connect(r1.pin('1'));
  r1.pin('2').connect(t1.pin('1'));
  t1.pin('2').connect(tb.gnd);
  v1.pin('-').connect(tb.gnd);
  tb.name('out', t1.pin('1'));
  tb.expect.op('out').toBeBelow(2.5);
});
`;

let dir = '';
const cwd = process.cwd();

async function inDir<T>(f: () => Promise<T>): Promise<T> {
  process.chdir(dir);
  try {
    return await f();
  } finally {
    process.chdir(cwd);
  }
}

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cv-defs-'));
  fs.mkdirSync(path.join(dir, 'parts'));
  fs.writeFileSync(path.join(dir, 'parts', 'ntc.part.ts'), NTC);
  fs.writeFileSync(path.join(dir, 'parts', 'util.ts'), UTIL);
  fs.writeFileSync(path.join(dir, 'ntc.bench.ts'), BENCH);
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('custom components travel in circuit documents as source', () => {
  it('export carries definitions[] + the module and its relative imports; the round trip is byte-identical', async () => {
    const desc = await inDir(() => loadBench('ntc.bench.ts'));
    const doc = await inDir(async () => toCircuitDoc(desc, {}, { definitionSources: definitionSourcesOf(desc) }));
    expect(doc.definitions).toEqual([{ type: 'Ntc', pins: ['1', '2'], source: 'parts/ntc.part.ts' }]);
    expect(doc.sources?.map(s => s.path)).toEqual(['parts/ntc.part.ts', 'parts/util.ts']);
    expect(doc.sources?.find(s => s.path === 'parts/ntc.part.ts')?.text).toBe(NTC);
    expect(validateJsonSchema(schema, doc)).toEqual([]);
    expect(validateJsonSchema(schema, stripLocations(doc))).toEqual([]);

    const definitions = loadDocDefinitions(doc, platform);
    const fromDoc = benchFromDoc(doc, { definitions });
    const a = await inDir(async () => JSON.stringify(runLadder(desc)));
    const b = await inDir(async () => JSON.stringify(runLadder(fromDoc)));
    expect(b).toBe(a);
    expect(JSON.parse(a).exitCode).toBe(0);
    expect(toCircuitDoc(fromDoc)).toEqual(doc); // the document survives its own round trip
  });

  it('reading needs no code (types and pins are declared); simulating without the code is T019', async () => {
    const desc = await inDir(() => loadBench('ntc.bench.ts'));
    const doc = await inDir(async () => toCircuitDoc(desc, {}, { definitionSources: definitionSourcesOf(desc) }));
    expect(validateCircuitDoc(doc).ok).toBe(true);
    const badPins = JSON.parse(JSON.stringify(doc));
    badPins.components.find((c: any) => c.id === 'TH1').pins = { 1: 'out', 3: 'gnd' };
    const v = validateCircuitDoc(badPins);
    expect(v.ok).toBe(false);
    let err: unknown;
    try {
      benchFromDoc(doc);
    } catch (e) {
      err = e;
    }
    expect(isCircuitDocError(err) && err.code).toBe('T019');
  });

  it('the code must match its declaration (type name, pins) — T014', async () => {
    const desc = await inDir(() => loadBench('ntc.bench.ts'));
    const doc = await inDir(async () => toCircuitDoc(desc, {}, { definitionSources: definitionSourcesOf(desc) }));
    const lie = JSON.parse(JSON.stringify(doc));
    lie.definitions[0].pins = ['a', 'b'];
    lie.components.find((c: any) => c.id === 'TH1').pins = { a: 'out', b: 'gnd' };
    expect(() => loadDocDefinitions(lie, platform)).toThrow(/pins are \[1, 2\]/);
    const broken = JSON.parse(JSON.stringify(doc));
    broken.sources.find((s: any) => s.path === 'parts/util.ts').text = 'export const kelvin = (c: number) => { throw new Error("boom"); };';
    expect(() => benchFromDoc(broken, { definitions: loadDocDefinitions(broken, platform) }).build).not.toThrow(); // evaluation is lazy until stamp
  });

  it('a definition written inside the bench file (not exported from a module) is still T013', async () => {
    fs.writeFileSync(path.join(dir, 'inline.bench.ts'), `import { bench, defineComponent, VoltageSource } from 'circuitsvibe';
const R = defineComponent({ name: 'R', pins: ['a', 'b'], stamp(ctx) { ctx.stampResistance('a', 'b', 100); } });
export default bench('inline', (tb) => {
  const v = tb.add('V1', new VoltageSource(1));
  const r = tb.add('R1', new R());
  v.pin('+').connect(r.pin('a')); r.pin('b').connect(tb.gnd); v.pin('-').connect(tb.gnd);
});
`);
    const desc = await inDir(() => loadBench('inline.bench.ts'));
    let err: unknown;
    try {
      await inDir(async () => toCircuitDoc(desc, {}, { definitionSources: definitionSourcesOf(desc) }));
    } catch (e) {
      err = e;
    }
    expect(isCircuitDocError(err) && err.diagnostics[0]).toMatchObject({ code: 'T013', fixes: [{ kind: 'module-file' }, { kind: 'use-builtin' }] });
  });

  it('a registry-installed file carries its provenance only while unmodified', async () => {
    const source = `import { defineComponent } from 'circuitsvibe';\nexport default defineComponent({ name: 'Ntc', pins: ['1', '2'], stamp(ctx) { ctx.stampResistance('1', '2', 1e4); } });\n`;
    const hash = `sha256:${createHash('sha256').update(source).digest('hex')}`;
    fs.writeFileSync(path.join(dir, 'parts', 'ntc.part.ts'), `// @circuitsvibe-component alice/ntc@3 ${hash}\n${source}`);
    let desc = await inDir(() => loadBench('ntc.bench.ts'));
    let doc = await inDir(async () => toCircuitDoc(desc, {}, { definitionSources: definitionSourcesOf(desc) }));
    expect(doc.definitions?.[0].registry).toEqual({ ref: 'alice/ntc@3', hash });
    expect(validateJsonSchema(schema, doc)).toEqual([]);

    fs.writeFileSync(path.join(dir, 'parts', 'ntc.part.ts'), `// @circuitsvibe-component alice/ntc@3 ${hash}\n${source.replace('1e4', '2e4')}`);
    desc = await inDir(() => loadBench('ntc.bench.ts'));
    doc = await inDir(async () => toCircuitDoc(desc, {}, { definitionSources: definitionSourcesOf(desc) }));
    expect(doc.definitions?.[0].registry).toBeUndefined(); // edited locally: a fork, not the published part
    fs.writeFileSync(path.join(dir, 'parts', 'ntc.part.ts'), NTC);
  });
});
