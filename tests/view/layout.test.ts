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

  it('symbol registry covers unknown types with a labelled box', () => {
    const s = symbolFor({ id: 'U9', type: 'ArduinoUno', params: { board: 'uno' }, pins: { D13: 'n1', GND: 'gnd', '5V': 'vcc', A0: 'n2', TX: 'n3' } });
    expect(s.kind).toBe('box');
    expect(s.pins.map(p => p.name).sort()).toEqual(['5V', 'A0', 'D13', 'GND', 'TX']);
    expect(s.pins.find(p => p.name === 'GND')!.side).toBe('b');
    expect(s.pins.find(p => p.name === '5V')!.side).toBe('t');
    const op = symbolFor({ id: 'U1', type: 'OpAmp', params: {}, pins: { 'in+': 'a', 'in-': 'b', out: 'c', 'v+': 'vcc', 'v-': 'gnd' } });
    expect(op.kind).toBe('opamp');
    expect(op.pins.find(p => p.name === 'out')!.side).toBe('r');
  });
});
