import { describe, it, expect, afterAll } from 'vitest';
import {
  runLadder,
  runLadderAsync,
  toCircuitDoc,
  benchFromDoc,
  canonicalJson,
  createShareLink,
  decodeShareUrl,
  stripLocations,
  isCircuitDocError,
  type BenchDescriptor,
} from '../../src/forge';
import { findBenches, load, definitionsOf, withoutAt } from './helpers';

// The core guarantee of the circuit document: for EVERY bench in bench/,
// verifying the bench and verifying the bench rebuilt from its document give
// byte-identical RunRecords (locations are carried by the exported document;
// share links drop the bench's `at` lines, so there the records match after removing
// `at`; firmware / VHDL locations point into the embedded sources and survive).

const benches = findBenches();
const sizes: { bench: string; components: number; assertions: number; jsonBytes: number; urlBytes: number }[] = [];

afterAll(() => {
  // Size report: URL length per bench (default base URL).
  const lines = sizes.map(s => `  ${s.bench.padEnd(44)} ${String(s.components).padStart(2)} parts ${String(s.assertions).padStart(2)} asserts  json ${String(s.jsonBytes).padStart(5)} B  url ${String(s.urlBytes).padStart(5)} B`);
  console.log(`share link sizes (https://circuitsvibe.com/app.html#c=1.…):\n${lines.join('\n')}`);
});

describe('bench ⇄ circuit document round trip (every bench file)', () => {
  it('discovers the benches', () => {
    expect(benches.length).toBeGreaterThanOrEqual(10);
  });

  for (const rel of benches) {
    it(rel, async () => {
      const desc = await load(rel);
      const defs = definitionsOf(desc);
      const custom = Object.keys(defs).length > 0;

      if (custom) {
        // Without a definition registry, defineComponent parts are refused (T013).
        let err: unknown;
        try {
          toCircuitDoc(desc);
        } catch (e) {
          err = e;
        }
        expect(isCircuitDocError(err)).toBe(true);
        expect((err as { code: string }).code).toBe('T013');
        expect((err as Error).message).toMatch(/U1 \(\w+\)/);
      }
      const opts = { definitions: defs };

      const original = await runLadderAsync(desc);
      const doc = toCircuitDoc(desc, {}, opts);
      // Through JSON text, as a file or another language would hand it over.
      const reread = JSON.parse(canonicalJson(doc, 2));
      const rebuilt = benchFromDoc(reread, opts);
      const replayed = await runLadderAsync(rebuilt);
      expect(JSON.stringify(replayed)).toBe(JSON.stringify(original));

      // Idempotent: the rebuilt bench exports the very same document.
      expect(canonicalJson(toCircuitDoc(rebuilt))).toBe(canonicalJson(doc));
      // Deterministic: same bench ⇒ byte-identical document.
      expect(canonicalJson(toCircuitDoc(desc, {}, opts))).toBe(canonicalJson(doc));

      // Share link: encode → decode → same (location-free) document and record.
      const link = await createShareLink(doc, opts);
      const decoded = await decodeShareUrl(link.url, opts);
      expect(canonicalJson(decoded)).toBe(canonicalJson(stripLocations(doc)));
      const fromLink = await runLadderAsync(benchFromDoc(decoded, opts));
      // Bench `at` lines are dropped; firmware / VHDL locations (paths of embedded sources) remain.
      expect(JSON.stringify(withoutAt(fromLink))).toBe(JSON.stringify(withoutAt(original)));
      sizes.push({ bench: rel, components: doc.components.length, assertions: doc.assertions.length, jsonBytes: link.jsonBytes, urlBytes: link.bytes });
    }, 60000);
  }
});

describe('overrides (--set) survive the round trip', () => {
  it('led-overcurrent with R1 overridden: same RunRecord, params baked, overrides recorded', async () => {
    const desc = await load('bench/broken/led-overcurrent.bench.ts');
    const overrides = { R1: 280 };
    const original = runLadder(desc, { overrides });
    const doc = toCircuitDoc(desc, overrides);
    expect(doc.overrides).toEqual(overrides);
    expect(doc.components.find(c => c.id === 'R1')!.params).toEqual({ r: 280 });
    const replayed = runLadder(benchFromDoc(doc), { overrides: doc.overrides });
    expect(JSON.stringify(replayed)).toBe(JSON.stringify(original));
    expect(replayed.exitCode).toBe(0);
  });

  it('a failing bench keeps its verified hint (tb.param → free)', async () => {
    const desc = await load('bench/broken/led-overcurrent.bench.ts');
    const doc = toCircuitDoc(desc);
    expect(doc.components.find(c => c.id === 'R1')!.free).toEqual({ min: 100, max: 10000, scale: 'log' });
    const record = runLadder(benchFromDoc(doc));
    expect(record.exitCode).toBe(1);
    expect(record.stages.op!.assertions![0].hint?.kind).toBe('verified-param-range');
  });

  it('a source override keeps the waveform', async () => {
    const desc = await load('bench/analog/rc-pulse.bench.ts');
    const doc = toCircuitDoc(desc, { V1: 1 });
    const v1 = doc.components.find(c => c.id === 'V1')!;
    expect(v1.params.v).toBe(1);
    expect(v1.params.pulse).toBeDefined();
    const a = runLadder(desc, { overrides: { V1: 1 }, stages: ['lint', 'op'] });
    const b = runLadder(benchFromDoc(doc), { overrides: doc.overrides, stages: ['lint', 'op'] });
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });
});

describe('document-derived benches keep meta, layout and sources', () => {
  it('re-exporting carries them over; options.meta merges per key', async () => {
    const desc: BenchDescriptor = await load('bench/led-driver.bench.ts');
    const doc = toCircuitDoc(desc, {}, { meta: { title: 'LED driver', author: 'agent' } });
    const enriched = {
      ...doc,
      sources: [{ path: 'notes/readme.txt', language: 'text', text: 'hello' }],
      layout: { components: { R1: { x: 10, y: 20, rotation: 90 as const } }, wires: [{ from: 'R1.2', to: 'D1.anode' }] },
    };
    const again = toCircuitDoc(benchFromDoc(enriched), {}, { meta: { description: 'a 5 V LED driver' } });
    expect(again.meta).toEqual({ title: 'LED driver', author: 'agent', description: 'a 5 V LED driver' });
    expect(again.sources).toEqual(enriched.sources);
    expect(again.layout).toEqual(enriched.layout);
  });
});
