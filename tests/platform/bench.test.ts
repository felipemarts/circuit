import { describe, it, expect } from 'vitest';
import { bench, elaborate, VoltageSource, Resistor, LED } from '../../src/forge';

describe('bench elaboration', () => {
  it('derives a canonical netlist with named pins and nets', () => {
    const desc = bench('divider', (tb) => {
      const v1 = tb.add('V1', new VoltageSource(10));
      const r1 = tb.add('R1', new Resistor(1000));
      const r2 = tb.add('R2', new Resistor(2000));
      v1.pin('+').connect(r1.pin('1'));
      r1.pin('2').connect(r2.pin('1'));
      r2.pin('2').connect(tb.gnd);
      v1.pin('-').connect(tb.gnd);
      tb.name('out', r2.pin('1'));
    });
    const elab = elaborate(desc);
    const doc = elab.netlist;

    expect(doc.components.map(c => c.id)).toEqual(['R1', 'R2', 'V1']);
    const v1 = doc.components.find(c => c.id === 'V1')!;
    expect(v1.type).toBe('VoltageSource');
    expect(v1.params).toEqual({ v: 10 });
    expect(Object.keys(v1.pins).sort()).toEqual(['+', '-']);
    expect(v1.pins['-']).toBe('gnd');

    expect(doc.nets['out']).toContain('R2.1');
    expect(doc.nets['gnd']).toEqual(expect.arrayContaining(['R2.2', 'V1.-']));
    expect(doc.hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it('produces the same hash regardless of statement order', () => {
    const a = bench('x', (tb) => {
      const v1 = tb.add('V1', new VoltageSource(5));
      const r1 = tb.add('R1', new Resistor(100));
      v1.pin('+').connect(r1.pin('1'));
      r1.pin('2').connect(tb.gnd);
      v1.pin('-').connect(tb.gnd);
    });
    const b = bench('x', (tb) => {
      const r1 = tb.add('R1', new Resistor(100));
      const v1 = tb.add('V1', new VoltageSource(5));
      v1.pin('-').connect(tb.gnd);
      r1.pin('2').connect(tb.gnd);
      v1.pin('+').connect(r1.pin('1'));
    });
    expect(elaborate(a).netlist.hash).toBe(elaborate(b).netlist.hash);
  });

  it('changes the hash when a value changes', () => {
    const make = (r: number) =>
      bench('x', (tb) => {
        const v1 = tb.add('V1', new VoltageSource(5));
        const r1 = tb.add('R1', new Resistor(r));
        v1.pin('+').connect(r1.pin('1'));
        r1.pin('2').connect(tb.gnd);
        v1.pin('-').connect(tb.gnd);
      });
    expect(elaborate(make(100)).netlist.hash).not.toBe(elaborate(make(200)).netlist.hash);
  });

  it('rejects duplicate ids', () => {
    const desc = bench('dup', (tb) => {
      tb.add('R1', new Resistor(100));
      tb.add('R1', new Resistor(200));
    });
    expect(() => elaborate(desc)).toThrow(/duplicate component id 'R1'/);
  });

  it('rejects probes that reference nothing', () => {
    const desc = bench('bad-probe', (tb) => {
      const v1 = tb.add('V1', new VoltageSource(5));
      const r1 = tb.add('R1', new Resistor(100));
      v1.pin('+').connect(r1.pin('1'));
      r1.pin('2').connect(tb.gnd);
      v1.pin('-').connect(tb.gnd);
      tb.expect.op('R9.i').toBeAbove(0);
    });
    expect(() => elaborate(desc)).toThrow(/unknown probe 'R9.i'/);
  });

  it('rejects probes on unstable auto-generated net names', () => {
    const desc = bench('auto-net', (tb) => {
      const v1 = tb.add('V1', new VoltageSource(5));
      const r1 = tb.add('R1', new Resistor(100));
      v1.pin('+').connect(r1.pin('1'));
      r1.pin('2').connect(tb.gnd);
      v1.pin('-').connect(tb.gnd);
      tb.expect.op('n1').toBeAbove(0);
    });
    expect(() => elaborate(desc)).toThrow(/tb.name/);
  });

  it('applies overrides by rebuilding the component', () => {
    const desc = bench('ovr', (tb) => {
      const v1 = tb.add('V1', new VoltageSource(5));
      const r1 = tb.add('R1', new Resistor(100));
      v1.pin('+').connect(r1.pin('1'));
      r1.pin('2').connect(tb.gnd);
      v1.pin('-').connect(tb.gnd);
    });
    const elab = elaborate(desc, { R1: 470 });
    expect(elab.netlist.components.find(c => c.id === 'R1')!.params).toEqual({ r: 470 });
  });

  it('rejects overrides for unknown ids', () => {
    const desc = bench('ovr2', (tb) => {
      const v1 = tb.add('V1', new VoltageSource(5));
      const r1 = tb.add('R1', new Resistor(100));
      v1.pin('+').connect(r1.pin('1'));
      r1.pin('2').connect(tb.gnd);
      v1.pin('-').connect(tb.gnd);
    });
    expect(() => elaborate(desc, { R9: 470 })).toThrow(/unknown component id 'R9'/);
  });

  it('captures source locations for components and assertions', () => {
    const desc = bench('loc', (tb) => {
      const v1 = tb.add('V1', new VoltageSource(5));
      const d1 = tb.add('D1', new LED());
      const r1 = tb.add('R1', new Resistor(330));
      v1.pin('+').connect(r1.pin('1'));
      r1.pin('2').connect(d1.pin('anode'));
      d1.pin('cathode').connect(tb.gnd);
      v1.pin('-').connect(tb.gnd);
      tb.expect.op('D1.i').toBeAbove('1m');
    });
    const elab = elaborate(desc);
    expect(elab.locOf.get('D1')).toMatch(/bench\.test\.ts:\d+/);
    expect(elab.assertions[0].at).toMatch(/bench\.test\.ts:\d+/);
  });
});
