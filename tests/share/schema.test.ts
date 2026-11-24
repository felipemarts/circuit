import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { toCircuitDoc, stripLocations, validateCircuitDoc, type CircuitDoc } from '../../src/forge';
import { validateJsonSchema } from './mini-json-schema';
import { findBenches, load, definitionsOf, repo } from './helpers';

const schema = JSON.parse(fs.readFileSync(path.join(repo, 'schema', 'circuit.schema.json'), 'utf8'));

describe('schema/circuit.schema.json', () => {
  it('is shipped in the npm package', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'));
    expect(pkg.files).toContain('schema');
    expect(pkg.exports['./circuit.schema.json']).toBe('./schema/circuit.schema.json');
  });

  it('validates the document of every bench (with and without locations)', async () => {
    for (const rel of findBenches()) {
      const desc = await load(rel);
      const doc = toCircuitDoc(desc, {}, { definitions: definitionsOf(desc) });
      expect(validateJsonSchema(schema, doc), rel).toEqual([]);
      expect(validateJsonSchema(schema, stripLocations(doc)), rel).toEqual([]);
    }
  });

  it('validates a document using every optional field', async () => {
    const doc: CircuitDoc = {
      ...toCircuitDoc(await load('bench/broken/led-overcurrent.bench.ts'), { R1: 270 }),
      meta: { title: 'LED', description: 'd', author: 'a' },
      sources: [{ path: 'rtl/counter.vhd', language: 'vhdl', text: 'entity counter is end;' }],
      layout: { components: { R1: { x: 0, y: 0, rotation: 90, flip: true, label: 'viewer-owned' } }, wires: [{ from: 'R1.2', to: 'D1.anode', points: [[1, 2]] }], grid: 10 },
    };
    expect(validateJsonSchema(schema, doc)).toEqual([]);
    expect(validateCircuitDoc(doc).ok).toBe(true);
  });

  it('agrees with validateCircuitDoc on structural errors', async () => {
    const good = toCircuitDoc(await load('bench/rc-lowpass.bench.ts'));
    const mutate = (f: (d: any) => void): unknown => {
      const d = JSON.parse(JSON.stringify(good));
      f(d);
      return d;
    };
    const bad: [string, unknown][] = [
      ['wrong schema', mutate(d => (d.schema = 'circuitsvibe-circuit/2'))],
      ['unknown top-level field', mutate(d => (d.extra = 1))],
      ['missing assertions', mutate(d => delete d.assertions)],
      ['empty name', mutate(d => (d.name = ''))],
      ['bad id', mutate(d => (d.components[0].id = '1R'))],
      ['unknown component field', mutate(d => (d.components[0].value = 3))],
      ['null param', mutate(d => (d.components[0].params.c = null))],
      ['bad scale', mutate(d => (d.components[0].free = { min: 1, max: 2, scale: 'exp' }))],
      ['reserved net declared', mutate(d => d.nets.push('n3'))],
      ['bad stage', mutate(d => (d.assertions[0].stage = 'lint'))],
      ['op check on tran', mutate(d => (d.assertions.at(-1).check = { op: 'within', min: 0, max: 1 }))],
      ['missing tran config', mutate(d => delete d.assertions.at(-1).tran)],
      ['unknown check field', mutate(d => (d.assertions[0].check.extra = 1))],
      ['non-integer points', mutate(d => (d.assertions[0] = { id: 'a1', stage: 'dc', probe: 'out', check: { op: 'monotonic', direction: 'increasing' }, dc: { source: 'V1', from: 0, to: 1, points: 2.5 } }))],
      ['bad rotation', mutate(d => (d.layout = { components: { R1: { x: 0, y: 0, rotation: 45 } } }))],
      ['bad source path', mutate(d => (d.sources = [{ path: '../etc/passwd', language: 'text', text: '' }]))],
      ['bad language', mutate(d => (d.sources = [{ path: 'a.txt', language: 'Text', text: '' }]))],
      ['string override', mutate(d => (d.overrides = { R1: '1k' }))],
      ['unknown meta field', mutate(d => (d.meta = { tags: 'x' }))],
    ];
    for (const [what, doc] of bad) {
      expect(validateJsonSchema(schema, doc).length, `schema should reject: ${what}`).toBeGreaterThan(0);
      expect(validateCircuitDoc(doc).ok, `validateCircuitDoc should reject: ${what}`).toBe(false);
    }
  });
});
