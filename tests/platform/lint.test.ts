import { describe, it, expect } from 'vitest';
import {
  bench,
  elaborate,
  runLint,
  VoltageSource,
  Resistor,
  Capacitor,
  Inductor,
  CurrentSource,
  LED,
} from '../../src/forge';
import type { TB } from '../../src/forge';

function lint(build: (tb: TB) => void) {
  return runLint(elaborate(bench('t', build)));
}

describe('lint (L0)', () => {
  it('passes a clean circuit with no diagnostics', () => {
    const diags = lint((tb) => {
      const v1 = tb.add('V1', new VoltageSource(5));
      const r1 = tb.add('R1', new Resistor(330));
      const d1 = tb.add('D1', new LED());
      v1.pin('+').connect(r1.pin('1'));
      r1.pin('2').connect(d1.pin('anode'));
      d1.pin('cathode').connect(tb.gnd);
      v1.pin('-').connect(tb.gnd);
    });
    expect(diags).toEqual([]);
  });

  it('F103: flags components disconnected from the grounded circuit', () => {
    const diags = lint((tb) => {
      const v1 = tb.add('V1', new VoltageSource(5));
      const r1 = tb.add('R1', new Resistor(100));
      v1.pin('+').connect(r1.pin('1'));
      r1.pin('2').connect(tb.gnd);
      v1.pin('-').connect(tb.gnd);
      // Island: two resistors wired to each other, never to the circuit
      const r2 = tb.add('R2', new Resistor(100));
      const r3 = tb.add('R3', new Resistor(100));
      r2.pin('1').connect(r3.pin('1'));
      r2.pin('2').connect(r3.pin('2'));
    });
    const f103 = diags.find(d => d.code === 'F103');
    expect(f103).toBeDefined();
    expect(f103!.severity).toBe('error');
    expect(f103!.subject?.components).toEqual(['R2', 'R3']);
  });

  it('F103: flags a totally ungrounded circuit', () => {
    const diags = lint((tb) => {
      const v1 = tb.add('V1', new VoltageSource(5));
      const r1 = tb.add('R1', new Resistor(100));
      v1.pin('+').connect(r1.pin('1'));
      r1.pin('2').connect(v1.pin('-')); // loop closed, but no ground anywhere
    });
    const f103 = diags.find(d => d.code === 'F103');
    expect(f103).toBeDefined();
    expect(f103!.message).toMatch(/floats entirely/);
  });

  it('F101: groups a cap-isolated island into one diagnostic', () => {
    const diags = lint((tb) => {
      const v1 = tb.add('V1', new VoltageSource(5));
      const r1 = tb.add('R1', new Resistor(1000));
      const c2 = tb.add('C2', new Capacitor(1e-7));
      const r3 = tb.add('R3', new Resistor(10000));
      v1.pin('+').connect(r1.pin('1'));
      r1.pin('2').connect(tb.gnd);
      v1.pin('-').connect(tb.gnd);
      v1.pin('+').connect(c2.pin('1'));
      c2.pin('2').connect(r3.pin('1'));
    });
    const f101s = diags.filter(d => d.code === 'F101');
    expect(f101s).toHaveLength(1); // one island, one diagnostic — no cascade
    expect(f101s[0].severity).toBe('error');
    expect(f101s[0].subject?.pins).toEqual(expect.arrayContaining(['C2.2', 'R3.1']));
  });

  it('F101: flags a node fed only by a current source', () => {
    const diags = lint((tb) => {
      const i1 = tb.add('I1', new CurrentSource(0.001));
      const c1 = tb.add('C1', new Capacitor(1e-6));
      i1.pin('+').connect(c1.pin('1'));
      i1.pin('-').connect(tb.gnd);
      c1.pin('2').connect(tb.gnd);
    });
    expect(diags.some(d => d.code === 'F101')).toBe(true);
  });

  it('F104: flags parallel voltage sources even with identical values', () => {
    const diags = lint((tb) => {
      const v1 = tb.add('V1', new VoltageSource(5));
      const v2 = tb.add('V2', new VoltageSource(5));
      const r1 = tb.add('R1', new Resistor(100));
      v1.pin('+').connect(v2.pin('+'));
      v1.pin('-').connect(v2.pin('-'));
      v1.pin('+').connect(r1.pin('1'));
      r1.pin('2').connect(tb.gnd);
      v1.pin('-').connect(tb.gnd);
    });
    const f104 = diags.find(d => d.code === 'F104');
    expect(f104).toBeDefined();
    expect(f104!.slug).toBe('voltage-source-loop');
  });

  it('F104: flags an inductor directly across a source (0 V source at DC)', () => {
    const diags = lint((tb) => {
      const v1 = tb.add('V1', new VoltageSource(5));
      const l1 = tb.add('L1', new Inductor(0.01));
      v1.pin('+').connect(l1.pin('1'));
      v1.pin('-').connect(l1.pin('2'));
      v1.pin('-').connect(tb.gnd);
    });
    expect(diags.some(d => d.code === 'F104')).toBe(true);
  });

  it('F104: flags a shorted source', () => {
    const diags = lint((tb) => {
      const v1 = tb.add('V1', new VoltageSource(5));
      const r1 = tb.add('R1', new Resistor(100));
      v1.pin('+').connect(v1.pin('-'));
      v1.pin('+').connect(r1.pin('1'));
      r1.pin('2').connect(tb.gnd);
      v1.pin('-').connect(tb.gnd);
    });
    const f104 = diags.find(d => d.code === 'F104');
    expect(f104).toBeDefined();
    expect(f104!.slug).toBe('voltage-source-short');
  });

  it('F105: flags a forward LED straight across the supply, but not a reversed one', () => {
    const forward = lint((tb) => {
      const v1 = tb.add('V1', new VoltageSource(5));
      const d1 = tb.add('D1', new LED());
      v1.pin('+').connect(d1.pin('anode'));
      d1.pin('cathode').connect(tb.gnd);
      v1.pin('-').connect(tb.gnd);
    });
    expect(forward.some(d => d.code === 'F105' && d.severity === 'error')).toBe(true);

    const reversed = lint((tb) => {
      const v1 = tb.add('V1', new VoltageSource(5));
      const d1 = tb.add('D1', new LED());
      v1.pin('+').connect(d1.pin('cathode'));
      d1.pin('anode').connect(tb.gnd);
      v1.pin('-').connect(tb.gnd);
    });
    expect(reversed.some(d => d.code === 'F105')).toBe(false);
  });

  it('F106: warns on dangling pins without blocking', () => {
    const diags = lint((tb) => {
      const v1 = tb.add('V1', new VoltageSource(5));
      const r1 = tb.add('R1', new Resistor(100));
      const r2 = tb.add('R2', new Resistor(100));
      v1.pin('+').connect(r1.pin('1'));
      r1.pin('2').connect(tb.gnd);
      v1.pin('-').connect(tb.gnd);
      r2.pin('1').connect(r1.pin('1')); // r2.pin('2') dangles
    });
    const f106 = diags.find(d => d.code === 'F106');
    expect(f106).toBeDefined();
    expect(f106!.severity).toBe('warning');
    expect(f106!.subject?.pins).toEqual(['R2.2']);
    expect(diags.filter(d => d.severity === 'error')).toEqual([]);
  });
});
