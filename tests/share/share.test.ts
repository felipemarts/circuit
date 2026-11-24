import { describe, it, expect } from 'vitest';
import {
  toCircuitDoc,
  benchFromDoc,
  canonicalJson,
  canonicalizeDoc,
  encodeShareUrl,
  decodeShareUrl,
  createShareLink,
  base64UrlEncode,
  base64UrlDecode,
  isCircuitDocError,
  validateCircuitDoc,
  stripLocations,
  runLadder,
  bench,
  defineComponent,
  VoltageSource,
  Resistor,
  SHARE_WARN_LENGTH,
  SHARE_MAX_LENGTH,
  type CircuitDoc,
} from '../../src/forge';
import { load } from './helpers';

async function codeOf(p: Promise<unknown> | (() => unknown)): Promise<string | undefined> {
  try {
    await (typeof p === 'function' ? p() : p);
  } catch (err) {
    if (isCircuitDocError(err)) return err.code;
    throw err;
  }
  return undefined;
}

function shuffled<T>(xs: T[]): T[] {
  return [...xs].reverse();
}

/** Rebuild every object with its keys in reverse order. */
function reverseKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(reverseKeys);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.keys(v).reverse().map(k => [k, reverseKeys((v as Record<string, unknown>)[k])]));
  }
  return v;
}

/** Deterministic pseudo-random printable text (incompressible-ish). */
function noise(n: number, seed = 1): string {
  let x = seed;
  let s = '';
  for (let i = 0; i < n; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    s += String.fromCharCode(33 + ((x >>> 0) % 94));
  }
  return s;
}

async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  const out = new Response(new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream('deflate-raw')));
  return new Uint8Array(await out.arrayBuffer());
}

describe('canonical JSON', () => {
  it('is independent of key order and component order', async () => {
    const doc = toCircuitDoc(await load('bench/rc-lowpass.bench.ts'));
    const scrambled = reverseKeys({ ...doc, components: shuffled(doc.components) }) as CircuitDoc;
    expect(JSON.stringify(scrambled)).not.toBe(JSON.stringify(doc));
    expect(canonicalJson(canonicalizeDoc(scrambled))).toBe(canonicalJson(doc));
    expect(await encodeShareUrl(scrambled)).toBe(await encodeShareUrl(doc));
    // Rebuilding from a scrambled document gives the same RunRecord.
    expect(JSON.stringify(runLadder(benchFromDoc(scrambled)))).toBe(JSON.stringify(runLadder(benchFromDoc(doc))));
  });

  it('sorts keys, drops undefined, keeps array order, rejects non-finite numbers', () => {
    expect(canonicalJson({ b: 1, a: [3, 1, { d: undefined, c: 'x' }] })).toBe('{"a":[3,1,{"c":"x"}],"b":1}');
    expect(canonicalJson({ b: 1, a: 2 }, 2)).toBe('{\n  "a": 2,\n  "b": 1\n}');
    expect(() => canonicalJson({ x: Infinity })).toThrow(/non-finite/);
  });

  it('the same circuit declared in a different order gives the same document and URL', async () => {
    const make = (reverse: boolean) =>
      bench('div', tb => {
        const add = () => {
          const parts: [string, () => unknown][] = [
            ['V1', () => tb.add('V1', new VoltageSource(10))],
            ['R1', () => tb.add('R1', new Resistor('1k'))],
            ['R2', () => tb.add('R2', new Resistor('2k'))],
          ];
          for (const [, f] of reverse ? parts.reverse() : parts) f();
        };
        add();
        const [v, a, b] = ['V1', 'R1', 'R2'].map(id => tb._components.get(id)!);
        v.pin('+').connect(a.pin('1'));
        a.pin('2').connect(b.pin('1'));
        b.pin('2').connect(tb.gnd);
        v.pin('-').connect(tb.gnd);
        tb.name('mid', a.pin('2'));
        tb.expect.op('mid').toBeWithin(6, 7);
      });
    const d1 = toCircuitDoc(make(false), {}, { locations: false });
    const d2 = toCircuitDoc(make(true), {}, { locations: false });
    expect(canonicalJson(d2)).toBe(canonicalJson(d1));
    expect(await encodeShareUrl(d2)).toBe(await encodeShareUrl(d1));
  });
});

describe('base64url', () => {
  it('round-trips every length and byte value, alphabet has no + / =', () => {
    for (let n = 0; n < 70; n++) {
      const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 97 + n * 31) & 0xff);
      const text = base64UrlEncode(bytes);
      expect(text).toMatch(/^[A-Za-z0-9_-]*$/);
      expect([...base64UrlDecode(text)]).toEqual([...bytes]);
    }
    const all = Uint8Array.from({ length: 256 }, (_, i) => i);
    expect(base64UrlEncode(all)).not.toMatch(/[+/=]/);
    expect([...base64UrlDecode(base64UrlEncode(all))]).toEqual([...all]);
  });

  it('rejects characters outside the alphabet and impossible lengths', () => {
    expect(() => base64UrlDecode('ab+c')).toThrow(/character/);
    expect(() => base64UrlDecode('abc=')).toThrow(/character/);
    expect(() => base64UrlDecode('abcde')).toThrow(/length/);
  });
});

describe('share URL', () => {
  it('has the documented format and decodes to the same (location-free) document', async () => {
    const doc = toCircuitDoc(await load('bench/led-driver.bench.ts'), {}, { meta: { title: 'LED driver — 5 V', author: 'Zoë' } });
    const url = await encodeShareUrl(doc);
    expect(url).toMatch(/^https:\/\/circuitsvibe\.com\/app\.html#c=1\.[A-Za-z0-9_-]+$/);
    const decoded = await decodeShareUrl(url);
    expect(decoded).toEqual(stripLocations(doc));
    expect(decoded.meta).toEqual({ title: 'LED driver — 5 V', author: 'Zoë' });
    expect(decoded.components.every(c => c.at === undefined)).toBe(true);
    // Fragment-only and bare payload forms, surrounding whitespace / angle brackets.
    const fragment = url.slice(url.indexOf('#'));
    expect(await decodeShareUrl(fragment)).toEqual(decoded);
    expect(await decodeShareUrl(fragment.slice(1))).toEqual(decoded);
    expect(await decodeShareUrl(fragment.slice(3))).toEqual(decoded);
    expect(await decodeShareUrl(`  <${url}>\n`)).toEqual(decoded);
    expect(await decodeShareUrl(`https://example.com/x#foo=1&${fragment.slice(1)}`)).toEqual(decoded);
  });

  it('is deterministic and honours baseUrl (replacing any fragment)', async () => {
    const doc = toCircuitDoc(await load('bench/analog/rlc-ac-bandpass.bench.ts'));
    expect(await encodeShareUrl(doc)).toBe(await encodeShareUrl(JSON.parse(JSON.stringify(doc))));
    const local = await encodeShareUrl(doc, { baseUrl: 'http://localhost:5173/app.html#old' });
    expect(local.startsWith('http://localhost:5173/app.html#c=1.')).toBe(true);
    expect(local.slice(local.indexOf('#'))).toBe((await encodeShareUrl(doc)).slice((await encodeShareUrl(doc)).indexOf('#')));
  });

  it('compression actually shrinks a typical document', async () => {
    const doc = toCircuitDoc(await load('bench/rc-lowpass.bench.ts'));
    const link = await createShareLink(doc);
    const payload = link.url.slice(link.url.indexOf('#c=1.') + 5);
    expect(link.bytes).toBe(link.url.length);
    // base64url of the raw JSON would be 4/3 of jsonBytes.
    expect(payload.length).toBeLessThan(link.jsonBytes * 0.75);
    expect(link.warnings).toEqual([]);
  });

  it('warns (T018) above 8 KiB and fails (T015) above the hard cap', async () => {
    const base = toCircuitDoc(await load('bench/led-driver.bench.ts'));
    const long = await createShareLink({ ...base, sources: [{ path: 'notes.txt', language: 'text', text: noise(12000) }] });
    expect(long.bytes).toBeGreaterThan(SHARE_WARN_LENGTH);
    expect(long.warnings.map(w => [w.code, w.severity])).toEqual([['T018', 'warning']]);
    expect((await decodeShareUrl(long.url)).sources![0].text).toBe(noise(12000));

    const huge = { ...base, sources: [{ path: 'blob.txt', language: 'text', text: noise(SHARE_MAX_LENGTH * 1.5) }] };
    expect(await codeOf(createShareLink(huge))).toBe('T015');
  });

  it('refuses decompression bombs (T015)', async () => {
    const zeros = new Uint8Array(17 * 1024 * 1024);
    const payload = base64UrlEncode(await deflate(zeros));
    expect(payload.length).toBeLessThan(100_000);
    expect(await codeOf(decodeShareUrl(`#c=1.${payload}`))).toBe('T015');
  });

  it('version prefix: other versions are T017, missing prefix is T016', async () => {
    const url = await encodeShareUrl(toCircuitDoc(await load('bench/led-driver.bench.ts')));
    expect(await codeOf(decodeShareUrl(url.replace('#c=1.', '#c=2.')))).toBe('T017');
    expect(await codeOf(decodeShareUrl(url.replace('#c=1.', '#c=10.')))).toBe('T017');
    expect(await codeOf(decodeShareUrl(url.replace('#c=1.', '#c=')))).toBe('T016');
  });

  it('garbage input is T016', async () => {
    const url = await encodeShareUrl(toCircuitDoc(await load('bench/led-driver.bench.ts')));
    const cases = [
      'hello world',
      'https://circuitsvibe.com/app.html',
      'https://circuitsvibe.com/app.html#x=1',
      '#c=1.',
      '#c=1.!!!!',
      '#c=1.AAAA',
      url.slice(0, url.length - 40), // truncated by a chat app
      `#c=1.${base64UrlEncode(await deflate(new Uint8Array([0xff, 0xfe, 0xfd])))}`, // not UTF-8
      `#c=1.${base64UrlEncode(await deflate(new TextEncoder().encode('{not json')))}`,
    ];
    for (const input of cases) expect(await codeOf(decodeShareUrl(input)), input).toBe('T016');
  });

  it('a valid payload that is not a valid document is T010/T011', async () => {
    const enc = async (v: unknown) => `#c=1.${base64UrlEncode(await deflate(new TextEncoder().encode(JSON.stringify(v))))}`;
    expect(await codeOf(decodeShareUrl(await enc({ schema: 'circuitsvibe-circuit/2' })))).toBe('T011');
    expect(await codeOf(decodeShareUrl(await enc([1, 2])))).toBe('T010');
    expect(await codeOf(decodeShareUrl(await enc({ schema: 'circuitsvibe-circuit/1', name: 'x', components: [] })))).toBe('T010');
  });

  it('custom components need a definition registry on both ends', async () => {
    const Load = defineComponent({
      name: 'Load',
      pins: ['a', 'b'],
      params: { g: { default: 1e-3 } },
      stamp(ctx) {
        ctx.stampConductance('a', 'b', ctx.params.g);
      },
    });
    const desc = bench('custom', tb => {
      const v = tb.add('V1', new VoltageSource(1));
      const u = tb.add('U1', new Load({ g: 2e-3 }));
      v.pin('+').connect(u.pin('a'));
      u.pin('b').connect(tb.gnd);
      v.pin('-').connect(tb.gnd);
      tb.expect.op('V1.i').toBeCloseTo(-2e-3, 1e-9);
    });
    expect(await codeOf(() => toCircuitDoc(desc))).toBe('T013');
    const doc = toCircuitDoc(desc, {}, { definitions: [Load] });
    expect(doc.components.find(c => c.id === 'U1')).toMatchObject({ type: 'Load', params: { g: 2e-3 } });
    const url = await encodeShareUrl(doc, { definitions: { Load } });
    expect(await codeOf(decodeShareUrl(url))).toBe('T012');
    const back = await decodeShareUrl(url, { definitions: [Load] });
    expect(runLadder(benchFromDoc(back, { definitions: [Load] })).exitCode).toBe(0);
    expect(await codeOf(() => benchFromDoc(back))).toBe('T012');
  });
});

describe('validateCircuitDoc', () => {
  const codes = (v: unknown) => {
    const r = validateCircuitDoc(v);
    return r.ok ? [] : r.diagnostics.map(d => d.code);
  };

  it('accepts exported documents and reports problems with JSON-pointer paths', async () => {
    const doc = toCircuitDoc(await load('bench/led-driver.bench.ts'));
    expect(validateCircuitDoc(doc)).toEqual({ ok: true, doc, diagnostics: [] });
    const bad = JSON.parse(JSON.stringify(doc));
    bad.components[1].pins['2'] = 'nowhere';
    const r = validateCircuitDoc(bad);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.diagnostics[0]).toMatchObject({ code: 'T010', slug: 'invalid-circuit-document', severity: 'error', evidence: { path: '/components/1/pins/2' } });
      expect(r.diagnostics[0].message).toMatch(/not declared in "nets"/);
    }
  });

  it('flags a RunRecord, wrong versions, unknown types and unbuildable components', async () => {
    const doc = toCircuitDoc(await load('bench/led-driver.bench.ts'));
    const record = runLadder(await load('bench/led-driver.bench.ts'));
    expect(codes(record)).toEqual(['T010']);
    expect(codes({ ...doc, schema: 'circuitsvibe-circuit/2' })).toEqual(['T011']);
    const edit = (f: (d: any) => void) => {
      const d = JSON.parse(JSON.stringify(doc));
      f(d);
      return codes(d);
    };
    expect(edit(d => (d.components[0].type = 'Transistor'))).toEqual(['T012']);
    expect(edit(d => (d.components[1].params = {}))).toEqual(['T014']); // Resistor needs r
    expect(edit(d => (d.components[0].params.part = 'NOPE'))).toEqual(['T014']); // not a catalog part
    expect(edit(d => (d.components[0].params.Is = 'x'))).toEqual(['T014']); // LED params are numbers
    expect(edit(d => (d.components[1].params.tolerance = 0.05))).toEqual(['T014']); // unknown param
    expect(edit(d => delete d.components[1].pins['2'])).toEqual(['T014']); // every pin listed
    expect(edit(d => (d.components[2].pins = { '1': 'n1', '2': 'gnd' }))).toEqual(['T014', 'T014', 'T014', 'T014']); // aliases refused
    expect(edit(d => (d.components[0].free = { min: 1, max: 2, scale: 'lin' }))).toEqual(['T014']); // LED not sweepable
    expect(edit(d => (d.assertions[0].probe = 'Q1.i'))).toEqual(['T010']);
    expect(edit(d => (d.assertions[0].probe = 'n1'))).toEqual(['T010']);
    expect(edit(d => (d.assertions[1].id = 'a1'))).toEqual(['T010']);
    expect(edit(d => (d.overrides = { X9: 1 }))).toEqual(['T010']);
    expect(edit(d => (d.nets = ['led', 'unused']))).toEqual(['T010']);
    expect(edit(d => (d.layout = { wires: [{ from: 'R1.1', to: 'D1.anode' }] }))).toEqual(['T010']); // different nets
    expect(edit(d => (d.sources = [{ path: 'a.txt', language: 'text', text: '' }, { path: 'a.txt', language: 'text', text: '' }]))).toEqual(['T010']);
  });

  it('accepts lenient but unambiguous producer input (omitted defaults, any anonymous names)', async () => {
    const doc: CircuitDoc = {
      schema: 'circuitsvibe-circuit/1',
      name: 'hand-written',
      components: [
        { id: 'V1', type: 'VoltageSource', params: { v: 5, ac: { mag: 1 } }, pins: { '+': 'n7', '-': 'gnd' } },
        { id: 'R1', type: 'Resistor', params: { r: 1000 }, pins: { '1': 'n7', '2': 'out' } },
        { id: 'R2', type: 'Resistor', params: { r: 1000 }, pins: { '1': 'out', '2': 'gnd' } },
      ],
      nets: ['out'],
      assertions: [{ id: 'half', stage: 'op', probe: 'out', check: { op: 'closeTo', value: 2.5, tol: 1e-9 } }],
    };
    expect(codes(doc)).toEqual([]);
    const record = runLadder(benchFromDoc(doc));
    expect(record.exitCode).toBe(0);
    expect(record.firstFailure).toBeUndefined();
    expect(record.netlist.nets.n1).toEqual(['R1.1', 'V1.+']); // anonymous nets are renumbered canonically
    expect(record.stages.op!.assertions![0].id).toBe('half');
  });

  it('DSL rules still apply to a document (T001 at elaboration)', async () => {
    const doc = JSON.parse(JSON.stringify(toCircuitDoc(await load('bench/rc-lowpass.bench.ts'))));
    const settle = doc.assertions.find((a: any) => a.check.op === 'settleWithin');
    settle.check.by = 1; // beyond tstop
    const record = runLadder(benchFromDoc(doc));
    expect(record.exitCode).toBe(3);
    expect(record.firstFailure).toBe('T001');
  });
});
