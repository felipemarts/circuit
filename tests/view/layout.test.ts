import { describe, it, expect } from 'vitest';
import { toCircuitDoc, type CircuitDoc } from '../../src/forge';
import { layoutCircuit, type Layout } from '../../src/view/layout';
import { symbolFor, G } from '../../src/view/symbols';
import { findBenches, load, definitionsOf } from '../share/helpers';

// The auto-layout must work for EVERY bench in bench/ — LLM-made documents
// never carry positions — and be deterministic, overlap-free and complete.

const benches = findBenches();

async function docOf(rel: string): Promise<CircuitDoc | null> {
  const desc = await load(rel);
  const defs = definitionsOf(desc);
  try {
    return toCircuitDoc(desc, {}, { definitions: defs });
  } catch {
    return null; // custom parts that cannot be serialized: not a viewer case
  }
}

function overlaps(a: { x: number; y: number; hw: number; hh: number }, b: { x: number; y: number; hw: number; hh: number }): boolean {
  return Math.abs(a.x - b.x) < a.hw + b.hw && Math.abs(a.y - b.y) < a.hh + b.hh;
}

/** Whether a wire polyline passes strictly through a component body. */
function wireThroughBody(layout: Layout): string[] {
  const hits: string[] = [];
  for (const w of layout.wires) {
    for (let k = 1; k < w.points.length; k++) {
      const a = w.points[k - 1];
      const b = w.points[k];
      for (const c of layout.components) {
        // sample along the segment, excluding the end points (they may be pins on the body edge)
        const steps = Math.max(1, Math.round((Math.abs(b.x - a.x) + Math.abs(b.y - a.y)) / G));
        for (let s = 1; s < steps; s++) {
          const x = a.x + ((b.x - a.x) * s) / steps;
          const y = a.y + ((b.y - a.y) * s) / steps;
          if (x > c.x - c.hw + 1 && x < c.x + c.hw - 1 && y > c.y - c.hh + 1 && y < c.y + c.hh - 1) hits.push(`${w.net} through ${c.id}`);
        }
      }
    }
  }
  return [...new Set(hits)];
}

type Seg = { a: { x: number; y: number }; b: { x: number; y: number }; net: string };

/** Every drawn segment: routed wires and ground / rail port wires. */
function segments(layout: Layout): Seg[] {
  const segs: Seg[] = [];
  const add = (pts: { x: number; y: number }[], net: string) => {
    for (let k = 1; k < pts.length; k++) segs.push({ a: pts[k - 1], b: pts[k], net });
  };
  for (const w of layout.wires) add(w.points, w.net);
  for (const p of layout.ports) for (const pts of p.points) add(pts, p.net);
  return segs;
}

/** Wire crossings between different nets, and collinear overlaps of different nets (a drawn short). */
function crossings(layout: Layout): { crossings: number; shorts: string[] } {
  const segs = segments(layout);
  let n = 0;
  const shorts: string[] = [];
  const overlap = (a0: number, a1: number, b0: number, b1: number) => Math.min(Math.max(a0, a1), Math.max(b0, b1)) > Math.max(Math.min(a0, a1), Math.min(b0, b1));
  for (let i = 0; i < segs.length; i++) {
    for (let j = i + 1; j < segs.length; j++) {
      const s = segs[i];
      const t = segs[j];
      if (s.net === t.net) continue;
      const sh = s.a.y === s.b.y;
      const th = t.a.y === t.b.y;
      if (sh === th) {
        if (sh && s.a.y === t.a.y && overlap(s.a.x, s.b.x, t.a.x, t.b.x)) shorts.push(`${s.net}/${t.net}`);
        if (!sh && s.a.x === t.a.x && overlap(s.a.y, s.b.y, t.a.y, t.b.y)) shorts.push(`${s.net}/${t.net}`);
        continue;
      }
      const h = sh ? s : t;
      const v = sh ? t : s;
      const x = v.a.x;
      const y = h.a.y;
      if (x > Math.min(h.a.x, h.b.x) && x < Math.max(h.a.x, h.b.x) && y > Math.min(v.a.y, v.b.y) && y < Math.max(v.a.y, v.b.y)) n++;
    }
  }
  return { crossings: n, shorts };
}

/** Wire length beyond the Manhattan distance of each wire's end points (loops and detours). */
function detour(layout: Layout): number {
  let d = 0;
  for (const w of layout.wires) {
    let len = 0;
    for (let k = 1; k < w.points.length; k++) len += Math.abs(w.points[k].x - w.points[k - 1].x) + Math.abs(w.points[k].y - w.points[k - 1].y);
    const a = w.points[0];
    const b = w.points[w.points.length - 1];
    d += len - Math.abs(a.x - b.x) - Math.abs(a.y - b.y);
  }
  return d;
}

describe('viewer auto-layout (every bench)', () => {
  for (const rel of benches) {
    it(rel, async () => {
      const doc = await docOf(rel);
      if (!doc) return;
      const a = layoutCircuit(doc);
      const b = layoutCircuit(JSON.parse(JSON.stringify(doc)));
      // deterministic
      expect(JSON.stringify(b)).toBe(JSON.stringify(a));
      // every component placed once, on the grid
      expect(a.components.map(c => c.id).sort()).toEqual(doc.components.map(c => c.id).sort());
      for (const c of a.components) {
        expect(c.x % G).toBe(0);
        expect(c.y % G).toBe(0);
        for (const p of c.pins) {
          expect(p.x % G).toBe(0);
          expect(p.y % G).toBe(0);
        }
      }
      // no overlapping bodies
      for (let i = 0; i < a.components.length; i++) {
        for (let j = i + 1; j < a.components.length; j++) {
          const ci = a.components[i];
          const cj = a.components[j];
          expect(overlaps(ci, cj), `${ci.id} overlaps ${cj.id}`).toBe(false);
        }
      }
      // every pin is accounted for: wired, ported (gnd/rail), labelled or marked unconnected
      const wiredRefs = new Set<string>();
      const netsWired = new Set(a.wires.map(w => w.net));
      for (const w of a.wires) wiredRefs.add(w.from);
      const ported = new Set(a.ports.flatMap(p => p.pinRefs));
      const nc = new Set(a.noConnects.map(n => n.ref));
      const labelled = new Set(a.labels.filter(l => l.kind === 'flag').map(l => l.net));
      for (const c of a.components) {
        for (const p of c.pins) {
          const ok = wiredRefs.has(p.ref) || ported.has(p.ref) || nc.has(p.ref) || labelled.has(p.net) || netsWired.has(p.net);
          expect(ok, `${p.ref} (${p.net}) is not connected to anything in the drawing`).toBe(true);
        }
      }
      // wires never cross a component body
      expect(wireThroughBody(a)).toEqual([]);
      // two nets never drawn on top of each other (e.g. a rail bus and a ground bus in one column)
      expect(crossings(a).shorts).toEqual([]);
      // sane canvas
      expect(a.width).toBeGreaterThan(0);
      expect(a.height).toBeGreaterThan(0);
      expect(a.width).toBeLessThan(4000);
      expect(a.height).toBeLessThan(4000);
    });
  }

  it('honours a full document layout', async () => {
    const doc = (await docOf('bench/led-driver.bench.ts'))!;
    doc.layout = { components: { V1: { x: 100, y: 200 }, R1: { x: 300, y: 100, rotation: 0 }, D1: { x: 500, y: 200, rotation: 90 } } };
    const l = layoutCircuit(doc);
    const r1 = l.components.find(c => c.id === 'R1')!;
    const d1 = l.components.find(c => c.id === 'D1')!;
    expect(d1.rotation).toBe(90);
    expect(d1.x - r1.x).toBe(200);
  });

  it('draws an amplifier feedback part over / under the amplifier, input → output', async () => {
    // inverting amplifier: R2 from out back to the inverting input (bottom input → under the op-amp)
    const inv = layoutCircuit((await docOf('bench/opamp/inverting-amp.bench.ts'))!);
    const u1 = inv.components.find(c => c.id === 'U1')!;
    const r2 = inv.components.find(c => c.id === 'R2')!;
    expect(r2.x).toBe(u1.x);
    expect(r2.y).toBeGreaterThan(u1.y + u1.hh);
    expect(r2.y - u1.y).toBeLessThanOrEqual(12 * G);
    expect([0, 180]).toContain(r2.rotation);
    // its left pin is on the input net, its right pin on the output
    const left = r2.pins.reduce((p, q) => (q.x < p.x ? q : p));
    expect(left.net).toBe(u1.pins.find(p => p.name === 'inn' || p.name === 'in-')?.net ?? left.net);
    expect(detour(inv)).toBeLessThanOrEqual(40);
    // Schmitt trigger: positive feedback to the top input → over the comparator
    const st = layoutCircuit((await docOf('bench/examples/lm393-schmitt-trigger.bench.ts'))!);
    const c1 = st.components.find(c => c.id === 'U1')!;
    const rf = st.components.find(c => c.id === 'RF')!;
    expect(rf.x).toBe(c1.x);
    expect(rf.y).toBeLessThan(c1.y - c1.hh);
    expect(crossings(st).crossings).toBe(0);
    expect(detour(st)).toBeLessThanOrEqual(40);
  });

  it('no feedback loop-backs on the op-amp benches', async () => {
    for (const rel of ['bench/opamp/inverting-amp.bench.ts', 'bench/opamp/integrator.bench.ts', 'bench/opamp/lm358-rail-clipping.bench.ts', 'bench/opamp/non-inverting-ac-bandwidth.bench.ts', 'bench/examples/lm358-non-inverting-bandwidth.bench.ts', 'bench/broken/opamp-positive-feedback.bench.ts']) {
      const l = layoutCircuit((await docOf(rel))!);
      expect(detour(l), rel).toBeLessThanOrEqual(40);
      expect(crossings(l).crossings, rel).toBeLessThanOrEqual(1);
    }
  });

  it('lines up a fan of LED + resistor stacks in rows, nested without crossings', async () => {
    const l = layoutCircuit((await docOf('bench/broken/mcu-port-group-overcurrent.bench.ts'))!);
    const ys = (ids: string[]) => new Set(ids.map(id => l.components.find(c => c.id === id)!.y));
    expect(ys(['R8', 'R9', 'R10', 'R11', 'R12', 'R13']).size).toBe(1);
    expect(ys(['D8', 'D9', 'D10', 'D11', 'D12', 'D13']).size).toBe(1);
    // D8 (lowest pin) nearest the board, D13 (highest pin) farthest
    const xs = ['R8', 'R9', 'R10', 'R11', 'R12', 'R13'].map(id => l.components.find(c => c.id === id)!.x);
    expect([...xs].sort((a, b) => a - b)).toEqual(xs);
    expect(crossings(l).crossings).toBe(0);
    expect(detour(l)).toBe(0);
  });

  it('keeps a rail bus and a ground bus on one side of an IC in separate columns', async () => {
    const l = layoutCircuit((await docOf('bench/digital/hc74-divider.bench.ts'))!);
    const left = l.ports.filter(p => p.pinRefs.length > 1 && p.pinRefs.every(r => r.startsWith('U1.')));
    expect(left.length).toBe(2);
    expect(left[0].x).not.toBe(left[1].x);
    expect(crossings(l).shorts).toEqual([]);
  });

  it('symbol registry covers unknown types with a labelled box', () => {
    const s = symbolFor({ id: 'U9', type: 'SomeNewPart', params: { board: 'uno' }, pins: { D13: 'n1', GND: 'gnd', '5V': 'vcc', A0: 'n2', TX: 'n3' } });
    expect(s.kind).toBe('box');
    expect(s.pins.map(p => p.name).sort()).toEqual(['5V', 'A0', 'D13', 'GND', 'TX']);
    expect(s.pins.find(p => p.name === 'GND')!.side).toBe('b');
    expect(s.pins.find(p => p.name === '5V')!.side).toBe('t');
    const op = symbolFor({ id: 'U1', type: 'OpAmp', params: {}, pins: { 'in+': 'a', 'in-': 'b', out: 'c', 'v+': 'vcc', 'v-': 'gnd' } });
    expect(op.kind).toBe('opamp');
    expect(op.pins.find(p => p.name === 'out')!.side).toBe('r');
  });
});
