import { describe, it, expect } from 'vitest';
import {
  DigitalCircuit,
  DigitalSim,
  Clock,
  DFF,
  Not,
  Xor,
  And,
  TriBuf,
  Const,
  Stimulus,
  ShiftRegister,
  Mux,
  Counter,
  toVCD,
} from '../../src/digital';
import type { DigitalChange, DigitalPart } from '../../src/digital';

describe('co-simulation API', () => {
  it('nextEventTime gives the analog side its breakpoints; advanceTo processes events ≤ t', () => {
    const c = new DigitalCircuit();
    c.add('CLK', new Clock({ period: '1u', start: '0.25u' }), { y: 'clk' });
    const sim = c.build();
    expect(sim.now).toBe(0);
    expect(sim.nextEventTime()).toBeCloseTo(0.25e-6, 15);
    sim.advanceTo('0.2u');
    expect(sim.value('clk')).toBe(0);
    expect(sim.now).toBeCloseTo(0.2e-6, 15);
    sim.advanceTo(sim.nextEventTime()!); // exactly the edge: processed
    expect(sim.value('clk')).toBe(1);
    expect(sim.nextEventTime()).toBeCloseTo(0.75e-6, 15);
    sim.advanceTo('0.1u'); // the past: no-op
    expect(sim.now).toBeCloseTo(0.25e-6, 15);
  });

  it('a mock analog loop: threshold-crossing drive in, timestamped changes out, clock edges as breakpoints', () => {
    const c = new DigitalCircuit();
    c.input('VIN', { initial: 0 });
    c.add('N1', new Not({ delay: '10n' }), { a: 'VIN', y: 'OUT' });
    c.add('CLK', new Clock({ freq: '1M' }), { y: 'clk' });
    const sim = c.build();
    const outChanges: DigitalChange[] = [];
    sim.onChange(ch => outChanges.push(ch), { nets: ['OUT'] });

    const tau = 1e-6;
    const v = (t: number) => 1 - Math.exp(-t / tau); // "analog" RC charging towards 1 V
    const tCross = tau * Math.log(2); // v = 0.5
    const steps: number[] = [];
    let t = 0;
    const tstop = 3e-6;
    while (t < tstop) {
      let tn = Math.min(t + 0.4e-6, sim.nextEventTime() ?? Infinity, tstop);
      // A→D bridge: a threshold crossing inside the step cuts the step at the crossing
      // (standard breakpoint handling), so digital responses after it become future breakpoints.
      if (v(t) < 0.5 && v(tn) >= 0.5) {
        tn = tCross;
        sim.drive('VIN', 1, tCross);
      }
      sim.advanceTo(tn);
      steps.push(tn);
      t = tn;
    }
    // D→A side saw OUT fall exactly 10 ns after the crossing, timestamped.
    expect(outChanges).toHaveLength(1);
    expect(outChanges[0]).toMatchObject({ net: 'OUT', value: 0, previous: 1 });
    expect(outChanges[0].t).toBeCloseTo(tCross + 10e-9, 12);
    // Every clock transition was a breakpoint of the analog loop.
    for (const edge of [0.5e-6, 1e-6, 1.5e-6, 2e-6, 2.5e-6, 3e-6]) {
      expect(steps.some(s => Math.abs(s - edge) < 1e-15), `breakpoint at ${edge}`).toBe(true);
    }
    // …and the OUT change itself (scheduled 10 ns after the drive) was one too.
    expect(steps.some(s => Math.abs(s - (tCross + 10e-9)) < 1e-12)).toBe(true);
  });

  it('drive at the current time is processed by the next advanceTo; the last drive at a time wins', () => {
    const c = new DigitalCircuit();
    c.input('A', { initial: 0 });
    c.add('B1', new And({ delay: 0 }), { a: 'A', b: 'A', y: 'Y' });
    const sim = c.build();
    sim.advanceTo('10n');
    sim.drive('A', 1); // at now = 10n
    expect(sim.nextEventTime()).toBeCloseTo(10e-9, 15);
    sim.advanceTo('10n');
    expect(sim.value('Y')).toBe(1);
    sim.drive('A', 0, '20n').drive('A', 1, '20n');
    sim.advanceTo('30n');
    expect(sim.value('A')).toBe(1);
    expect(sim.trace('A').t).toEqual([0, 10e-9]);
  });

  it('drive into the past ⇒ D505, applied at now', () => {
    const c = new DigitalCircuit();
    c.input('A', { initial: 0 });
    const sim = c.build().advanceTo('100n');
    sim.drive('A', 1, '50n').advanceTo('100n');
    const [d] = sim.diagnostics();
    expect(d.code).toBe('D505');
    expect(d.evidence).toEqual({ requested: 50e-9, now: 100e-9 });
    expect(sim.trace('A').t).toEqual([0, 100e-9]);
  });

  it('release (Z) hands the net back to a pull or makes it float', () => {
    const c = new DigitalCircuit();
    c.input('A', { initial: 1 });
    c.add('N1', new Not({ delay: 0 }), { a: 'A', y: 'Y' });
    const sim = c.build();
    expect(sim.value('Y')).toBe(0);
    sim.release('A', '1n').advanceTo('2n');
    expect(sim.value('A')).toBe('Z');
    expect(sim.value('Y')).toBe('X');
  });

  it('onChange: unsubscribe, pin refs, values()', () => {
    const c = new DigitalCircuit();
    c.add('CLK', new Clock({ period: '10n', start: '5n' }), { y: 'clk' });
    c.add('N1', new Not({ delay: '1n' }), { a: 'clk' }); // output on an auto net 'N1.y'
    const sim = c.build();
    const seen: string[] = [];
    const off = sim.onChange(ch => seen.push(`${ch.net}@${Math.round(ch.t * 1e9)}=${ch.value}`));
    sim.advanceTo('7n');
    off();
    sim.advanceTo('33n');
    expect(seen).toEqual(['clk@5=1', 'N1.y@6=0']);
    expect(sim.value('N1.a')).toBe(0); // fell at 30n
    expect(sim.value('N1.y')).toBe(1); // rose at 31n
    expect(sim.netOf('N1.a')).toBe('clk');
    expect(Object.keys(sim.values())).toEqual(['clk']);
    expect(() => sim.value('nope')).toThrow(/unknown net 'nope'/);
  });
});

/** A mixed circuit, built with components and wires in a caller-chosen order. */
function buildMixed(order: number[], wireStyle: 'map' | 'connect'): DigitalCircuit {
  const c = new DigitalCircuit();
  type Spec = [string, () => DigitalPart, Record<string, string>];
  const specs: Spec[] = [
    ['CLK', () => new Clock({ freq: '50M' }), { y: 'clk' }],
    ['FF0', () => new DFF({ delay: '2n', setup: '1n' }), { d: 'n0', clk: 'clk', q: 'Q0' }],
    ['FF1', () => new DFF({ delay: '2n', setup: '1n' }), { d: 'n1', clk: 'clk', q: 'Q1' }],
    ['INV', () => new Not({ delay: '1n' }), { a: 'Q0', y: 'n0' }],
    ['X1', () => new Xor({ delay: '1n' }), { a: 'Q0', b: 'Q1', y: 'n1' }],
    ['SR', () => new ShiftRegister({ bits: 3, delay: '1n' }), { si: 'Q1', clk: 'clk', q0: 'S0', q2: 'S2' }],
    ['MX', () => new Mux({ delay: '1n' }), { s0: 'Q0', d0: 'S0', d1: 'S2', y: 'M' }],
    ['CT', () => new Counter({ bits: 2, delay: '1n' }), { clk: 'Q1', q1: 'C1' }],
    ['KA', () => new Const(0), {}],
    ['TA', () => new TriBuf({ delay: '1n' }), { en: 'Q0', y: 'BUS' }],
    ['TB', () => new TriBuf({ delay: '1n' }), { a: 'Q0', en: 'Q1', y: 'BUS' }],
    // 38n: 2 ns before the 40n edge (setup 5n); 81n: 1 ns after the 80n edge (hold 2n)
    ['SD', () => new Stimulus({ changes: [['38n', 1], ['81n', 0]] }), {}],
    ['FF2', () => new DFF({ delay: '1n', setup: '5n', hold: '2n' }), { clk: 'clk', q: 'Q2' }],
  ];
  // Unnamed nets, wired pin-to-pin: [part, pin, other part, other pin].
  const links: [string, string, string, string][] = [
    ['TA', 'a', 'KA', 'y'],
    ['FF2', 'd', 'SD', 'y'],
  ];
  const parts = new Map<string, DigitalPart>();
  for (const i of order) {
    const [id, make, wiring] = specs[i];
    if (wireStyle === 'map') parts.set(id, c.add(id, make(), wiring));
    else parts.set(id, c.add(id, make()));
  }
  if (wireStyle === 'connect') {
    for (const i of [...order].reverse()) {
      const [id, , wiring] = specs[i];
      for (const [pin, net] of Object.entries(wiring).reverse()) parts.get(id)!.pin(pin).connect(net);
    }
    for (const [a, ap, b, bp] of [...links].reverse()) parts.get(b)!.pin(bp).connect(parts.get(a)!.pin(ap));
  } else {
    for (const [a, ap, b, bp] of links) c.connect(parts.get(a)!.pin(ap), parts.get(b)!.pin(bp));
  }
  return c;
}

function runMixed(c: DigitalCircuit) {
  const sim = c.build();
  sim.advanceTo('400n');
  return { vcd: toVCD(sim.recording()), diags: JSON.stringify(sim.diagnostics()), netlist: c.netlist() };
}

describe('determinism', () => {
  it('the same circuit built in different orders gives byte-identical waveforms and diagnostics', () => {
    const n = 13;
    const forward = [...Array(n).keys()];
    const reversed = [...forward].reverse();
    const shuffled = [7, 2, 11, 0, 9, 4, 12, 1, 6, 10, 3, 8, 5];
    const ref = runMixed(buildMixed(forward, 'map'));
    // Sanity: the bench actually exercises contention and timing checks.
    expect(ref.diags).toContain('D501');
    expect(ref.diags).toContain('D502');
    for (const [order, style] of [
      [reversed, 'map'],
      [shuffled, 'map'],
      [forward, 'connect'],
      [shuffled, 'connect'],
    ] as const) {
      const r = runMixed(buildMixed([...order], style));
      expect(r.vcd).toBe(ref.vcd);
      expect(r.diags).toBe(ref.diags);
      expect(r.netlist).toEqual(ref.netlist);
    }
  });

  it('two runs of the same circuit are identical', () => {
    const a = runMixed(buildMixed([...Array(13).keys()], 'map'));
    const b = runMixed(buildMixed([...Array(13).keys()], 'map'));
    expect(a.vcd).toBe(b.vcd);
  });
});

describe('plain-JSON round trip', () => {
  it('netlist → JSON → DigitalCircuit.fromJSON / new DigitalSim rebuilds the identical circuit', () => {
    const c = buildMixed([...Array(13).keys()], 'map');
    const json = JSON.stringify(c.netlist());
    const parsed = JSON.parse(json);
    expect(DigitalCircuit.fromJSON(parsed).netlist()).toEqual(c.netlist());
    const direct = new DigitalSim(parsed).advanceTo('400n');
    expect(toVCD(direct.recording())).toBe(runMixed(c).vcd);
    // Unnamed nets are named after their first output pin, independent of build order.
    expect(Object.keys(parsed.nets)).toContain('KA.y');
    expect(Object.keys(parsed.nets)).toContain('SR.q1');
  });

  it('params are plain JSON with times in seconds', () => {
    const c = new DigitalCircuit();
    c.add('FF1', new DFF({ delay: '2n', setup: '1n', reset: true }));
    expect(c.netlist().components[0]).toEqual({
      id: 'FF1',
      type: 'DFF',
      params: { delay: 2e-9, delayMode: 'inertial', setup: 1e-9, hold: 0, onViolation: 'x', init: 0, set: false, reset: true },
      pins: { d: 'FF1.d', clk: 'FF1.clk', reset: 'FF1.reset', q: 'FF1.q', qn: 'FF1.qn' },
    });
  });

  it('authoring errors are explicit', () => {
    const c = new DigitalCircuit();
    expect(() => c.add('1bad', new Not())).toThrow(/invalid component id/);
    c.add('U1', new Not());
    expect(() => c.add('U1', new Not())).toThrow(/duplicate/);
    expect(() => c.add('U2', new Not(), { b: 'X' })).toThrow(/has no pin 'b'. Pins: a, y/);
    expect(() => new And({ input: 3 } as never)).toThrow(/unknown option 'input'/);
    expect(() => new And({ delay: '5 nano' })).toThrow(/invalid And delay/);
    c.add('U3', new Not(), { a: 'P', y: 'Q' });
    c.connect('P', 'Q');
    expect(() => c.netlist()).toThrow(/'P' and 'Q' are wired together/);
  });
});
