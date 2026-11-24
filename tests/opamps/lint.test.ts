import { describe, it, expect } from 'vitest';
import { bench, elaborate, runLint, runLadder, IdealOpAmp, OpAmp, Comparator, Part, Resistor, Capacitor, VoltageSource, LED, type TB } from '../../src/forge';
import { inverting, nonInverting, supplies } from './helpers';

const codes = (b: ReturnType<typeof bench>) => runLint(elaborate(b)).map(d => d.code);

describe('op-amp / comparator lint (F120–F124)', () => {
  it('F120: macro-model supply pins left open (error, names the pins)', () => {
    const b = inverting(() => Part('LM358'), { vin: 0.1, r1: 1e3, r2: 1e4, rails: null });
    const d = runLint(elaborate(b)).find(x => x.code === 'F120')!;
    expect(d.severity).toBe('error');
    expect(d.subject!.pins).toEqual(['U1.v+', 'U1.v-']);
    expect(d.at).toMatch(/helpers\.ts:\d+/);
    expect(runLadder(b).exitCode).toBe(2);
  });

  it('F120: IdealOpAmp with exactly one supply pin connected; none or both are fine', () => {
    const one = inverting(() => new IdealOpAmp(), {
      vin: 0.1, r1: 1e3, r2: 1e4, rails: null,
      build: (tb, u) => {
        const vp = tb.add('VP', new VoltageSource(5));
        vp.pin('+').connect(u.pin('v+'));
        vp.pin('-').connect(tb.gnd);
      },
    });
    expect(codes(one)).toContain('F120');
    expect(codes(inverting(() => new IdealOpAmp(), { vin: 0.1, r1: 1e3, r2: 1e4, rails: null }))).toEqual([]);
    expect(codes(inverting(() => new IdealOpAmp(), { vin: 0.1, r1: 1e3, r2: 1e4 }))).toEqual([]);
  });

  it('F120: v+ and v- on the same net', () => {
    const b = inverting(() => new OpAmp(), {
      vin: 0.1, r1: 1e3, r2: 1e4, rails: null,
      build: (tb, u) => {
        u.pin('v+').connect(tb.gnd);
        u.pin('v-').connect(tb.gnd);
      },
    });
    expect(codes(b)).toContain('F120');
  });

  it('F121 replaces F101 when a floating net holds an amplifier input (AC-coupled input without bias)', () => {
    const b = bench('ac-coupled', tb => {
      const u = tb.add('U1', new OpAmp());
      const vi = tb.add('VI', new VoltageSource({ dc: 0, ac: 1 }));
      const c = tb.add('C1', new Capacitor('1u'));
      vi.pin('+').connect(c.pin('1'));
      vi.pin('-').connect(tb.gnd);
      c.pin('2').connect(u.pin('inp'));
      u.pin('inn').connect(u.pin('out'));
      supplies(tb, u, 15, -15);
    });
    const ds = runLint(elaborate(b));
    expect(ds.map(d => d.code)).toEqual(['F121']);
    expect(ds[0].subject!.pins).toContain('U1.inp');
    expect(ds[0].fixes[0].patch).toMatch(/Resistor\('100k'\)/);
    // With a bias resistor it is clean.
    const fixed = bench('ac-coupled-biased', tb => {
      b.build(tb);
      const rb = tb.add('RB', new Resistor('100k'));
      rb.pin('1').connect(tb._components.get('U1')!.pin('inp'));
      rb.pin('2').connect(tb.gnd);
    });
    expect(codes(fixed)).toEqual([]);
  });

  it('an op-amp output is a DC-driven node: an integrator output net is not floating, its inputs are', () => {
    const b = bench('integrator-open', tb => {
      const u = tb.add('U1', new OpAmp());
      const c = tb.add('C1', new Capacitor('1n'));
      const vi = tb.add('VI', new VoltageSource(1));
      const ci = tb.add('CI', new Capacitor('1n'));
      vi.pin('+').connect(ci.pin('1'));
      vi.pin('-').connect(tb.gnd);
      ci.pin('2').connect(u.pin('inn'));
      c.pin('1').connect(u.pin('inn'));
      c.pin('2').connect(u.pin('out'));
      u.pin('inp').connect(tb.gnd);
      supplies(tb, u, 15, -15);
    });
    const ds = runLint(elaborate(b));
    expect(ds.map(d => d.code)).toEqual(['F121']);
    expect(ds[0].subject!.pins).toEqual(['C1.1', 'CI.2', 'U1.inn']);
  });

  it('F122: op-amp feedback only into inp (warning); none for normal feedback, followers, or comparators', () => {
    const pos = bench('positive', tb => {
      const u = tb.add('U1', new OpAmp());
      const vi = tb.add('VI', new VoltageSource(0.1));
      const r1 = tb.add('R1', new Resistor('10k'));
      const r2 = tb.add('R2', new Resistor('100k'));
      vi.pin('+').connect(u.pin('inn'));
      vi.pin('-').connect(tb.gnd);
      r1.pin('1').connect(u.pin('inp'));
      r1.pin('2').connect(tb.gnd);
      r2.pin('1').connect(u.pin('inp'));
      r2.pin('2').connect(u.pin('out'));
      supplies(tb, u, 15, -15);
    });
    const ds = runLint(elaborate(pos));
    expect(ds.map(d => d.code)).toEqual(['F122']);
    expect(ds[0].severity).toBe('warning');
    expect(codes(inverting(() => new OpAmp(), { vin: 0.1, r1: 1e3, r2: 1e4 }))).toEqual([]);
    expect(codes(nonInverting(() => new OpAmp(), { vin: 0.1, r1: 1e3, r2: 1e4 }))).toEqual([]);
    expect(codes(nonInverting(() => new OpAmp(), { vin: 0.1, r1: Infinity, r2: 0 }))).toEqual([]);
    // Sallen-Key-like: out reaches inp through a capacitor, but out is also inn (follower) → no warning.
    const sk = nonInverting(() => new OpAmp(), {
      vin: 0.1, r1: Infinity, r2: 0,
      build: (tb, u) => {
        const c = tb.add('CF', new Capacitor('1n'));
        const r = tb.add('RS', new Resistor('1k'));
        c.pin('1').connect(u.pin('out'));
        c.pin('2').connect(r.pin('1'));
        r.pin('2').connect(u.pin('inp'));
      },
    });
    expect(codes(sk)).toEqual([]);
  });

  it('F123: IdealOpAmp output on gnd, across an ideal source, or tied to another ideal output', () => {
    const onGnd = bench('out-gnd', tb => {
      const u = tb.add('U1', new IdealOpAmp());
      const vi = tb.add('VI', new VoltageSource(1));
      vi.pin('+').connect(u.pin('inp'));
      vi.pin('-').connect(tb.gnd);
      u.pin('inn').connect(tb.gnd);
      u.pin('out').connect(tb.gnd);
    });
    expect(codes(onGnd)).toEqual(['F123']);
    const across = nonInverting(() => new IdealOpAmp(), {
      vin: 1, r1: 1e3, r2: 1e3, rails: null,
      build: (tb, u) => {
        const vx = tb.add('VX', new VoltageSource(2));
        vx.pin('+').connect(u.pin('out'));
        vx.pin('-').connect(tb.gnd);
      },
    });
    expect(codes(across)).toEqual(['F123']);
    const two = nonInverting(() => new IdealOpAmp(), {
      vin: 1, r1: Infinity, r2: 0, rails: null,
      build: (tb, u) => {
        const u2 = tb.add('U2', new IdealOpAmp());
        u2.pin('inp').connect(u.pin('inp'));
        u2.pin('inn').connect(u.pin('out'));
        u2.pin('out').connect(u.pin('out'));
      },
    });
    expect(codes(two)).toEqual(['F123']);
    // A macro-model output may be shorted (current limit) — no F123.
    const macro = nonInverting(() => new OpAmp(), { vin: 1, r1: Infinity, r2: 0, build: (tb, u) => void u.pin('out') });
    expect(codes(macro)).toEqual([]);
  });

  it('F124: comparator open-collector output with no pull-up (an LED to ground is not a pull-up)', () => {
    const noPull = (load: (tb: TB, out: ReturnType<Comparator['pin']>) => void) =>
      bench('no-pullup', tb => {
        const u = tb.add('U1', new Comparator());
        const vi = tb.add('VI', new VoltageSource(1));
        vi.pin('+').connect(u.pin('inp'));
        vi.pin('-').connect(tb.gnd);
        u.pin('inn').connect(tb.gnd);
        supplies(tb, u, 5, 0);
        load(tb, u.pin('out'));
      });
    const led = noPull((tb, out) => {
      const r = tb.add('R1', new Resistor('330'));
      const d = tb.add('D1', new LED());
      r.pin('1').connect(out);
      r.pin('2').connect(d.pin('anode'));
      d.pin('cathode').connect(tb.gnd);
    });
    const ds = runLint(elaborate(led));
    expect(ds.map(d => d.code)).toEqual(['F124']);
    expect(ds[0].severity).toBe('warning');
    const pulled = noPull((tb, out) => {
      const r = tb.add('RP', new Resistor('10k'));
      const v = tb.add('VPU', new VoltageSource(5));
      r.pin('1').connect(out);
      r.pin('2').connect(v.pin('+'));
      v.pin('-').connect(tb.gnd);
    });
    expect(codes(pulled)).toEqual([]);
    // Unused output: only the generic dangling-pin warning.
    expect(codes(noPull(() => {}))).toEqual(['F106']);
  });

  it('lint runs before the solver: an F121 bench never reaches the op stage', () => {
    const b = bench('cap-only', tb => {
      const u = tb.add('U1', new Comparator());
      const c = tb.add('C1', new Capacitor('1n'));
      const rp = tb.add('RP', new Resistor('10k'));
      c.pin('1').connect(u.pin('inp'));
      c.pin('2').connect(tb.gnd);
      u.pin('inn').connect(tb.gnd);
      supplies(tb, u, 5, 0);
      rp.pin('1').connect(u.pin('out'));
      rp.pin('2').connect(u.pin('v+'));
      tb.expect.op('U1.v').toBeAbove(1);
    });
    const r = runLadder(b);
    expect(r.exitCode).toBe(2);
    expect(r.firstFailure).toBe('F121');
    expect(r.stages.op!.verdict).toBe('skipped');
  });
});
