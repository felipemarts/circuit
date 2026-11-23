import { describe, it, expect } from 'vitest';
import { DigitalCircuit, DigitalSim, Behavioral, Stimulus, Const, registerBehavior, hasBehavior, lintDigital } from '../../src/digital';
import type { Host, ModelCtx, JsonValue } from '../../src/digital';

// The generic behavioral hook: a Behavioral part's model comes from a
// registered factory; its params stay plain JSON.

/** y = a XOR b after `config.delay` ps (explicit per-transaction delay). */
function xorFactory(config: JsonValue, ctx: ModelCtx) {
  const delay = (config as { delay: number }).delay;
  return {
    reset(h: Host) {
      h.out(ctx.outputs.y, 8); // strong 0
    },
    evaluate(h: Host) {
      const a = h.read(ctx.inputs.a);
      const b = h.read(ctx.inputs.b);
      const v = a > 1 || b > 1 ? 2 : a ^ b;
      h.out(ctx.outputs.y, v | 8, delay);
    },
  };
}
registerBehavior('test-xor', xorFactory);

/** Drives its single output to config.value forever (strong). */
registerBehavior('test-const', (config, ctx) => ({
  reset(h: Host) {
    h.out(ctx.outputs.y, ((config as { value: number }).value) | 8);
  },
  evaluate() {},
}));

describe('Behavioral parts', () => {
  it('evaluates a registered model with an explicit per-transaction delay', () => {
    expect(hasBehavior('test-xor')).toBe(true);
    const c = new DigitalCircuit();
    c.add('SA', new Stimulus({ changes: [['10n', 1], ['30n', 0]] }), { y: 'A' });
    c.add('SB', new Stimulus({ changes: [['20n', 1]] }), { y: 'B' });
    c.add('U1', new Behavioral({ behavior: 'test-xor', inputs: ['a', 'b'], outputs: ['y'], config: { delay: 3000 } }), { a: 'A', b: 'B', y: 'Y' });
    const sim = c.build();
    sim.advanceTo('100n');
    const y = sim.trace('Y');
    // a^b: 1 from 10n, 0 from 20n, 1 from 30n — each 3 ns later.
    expect(y.v).toEqual([0, 1, 0, 1]);
    expect(y.t.map(t => Math.round(t * 1e12))).toEqual([0, 13000, 23000, 33000]);
  });

  it('serializes to plain JSON and rebuilds the identical simulation', () => {
    const c = new DigitalCircuit();
    c.add('SA', new Stimulus({ pattern: '0110', step: '10n' }), { y: 'A' });
    c.add('K', new Const(1), { y: 'B' });
    c.add('U1', new Behavioral({ behavior: 'test-xor', inputs: ['a', 'b'], outputs: ['y'], config: { delay: 0 } }), { a: 'A', b: 'B', y: 'Y' });
    const json = JSON.parse(JSON.stringify(c.netlist()));
    expect(json.components.find((x: { id: string }) => x.id === 'U1').params).toEqual({
      behavior: 'test-xor',
      inputs: ['a', 'b'],
      outputs: ['y'],
      combPaths: [],
      config: { delay: 0 },
    });
    const a = c.build();
    const b = new DigitalSim(json);
    a.advanceTo('50n');
    b.advanceTo('50n');
    expect(b.recording()).toEqual(a.recording());
    expect(DigitalCircuit.fromJSON(json).netlist()).toEqual(c.netlist());
  });

  it('declared comb paths feed the zero-delay loop lint (F133)', () => {
    const c = new DigitalCircuit();
    c.add('K', new Const(1), { y: 'B' });
    c.add('U1', new Behavioral({ behavior: 'test-xor', inputs: ['a', 'b'], outputs: ['y'], combPaths: [['a', 'y', 0]], config: { delay: 0 } }), {
      a: 'Y',
      b: 'B',
      y: 'Y',
    });
    const codes = lintDigital(c.netlist()).map(d => d.code);
    expect(codes).toContain('F133');
    // With a non-zero path delay the loop is not zero-delay.
    const d = new DigitalCircuit();
    d.add('K', new Const(1), { y: 'B' });
    d.add('U1', new Behavioral({ behavior: 'test-xor', inputs: ['a', 'b'], outputs: ['y'], combPaths: [['a', 'y', '1n']], config: { delay: 1000 } }), {
      a: 'Y',
      b: 'B',
      y: 'Y',
    });
    expect(lintDigital(d.netlist()).map(x => x.code)).not.toContain('F133');
  });

  it('several behavioral drivers on a net are not F131, but runtime contention is D501', () => {
    const c = new DigitalCircuit();
    c.add('P', new Behavioral({ behavior: 'test-const', outputs: ['y'], config: { value: 0 } }), { y: 'N' });
    c.add('Q', new Behavioral({ behavior: 'test-const', outputs: ['y'], config: { value: 1 } }), { y: 'N' });
    expect(c.lint().map(d => d.code)).not.toContain('F131');
    const sim = c.build();
    expect(sim.value('N')).toBe('X');
    expect(sim.diagnostics().map(d => d.code)).toEqual(['D501']);
  });

  it('rejects bad params and unknown behaviors with actionable errors', () => {
    expect(() => new Behavioral({ behavior: 'x', inputs: ['a'], outputs: ['a'] })).toThrow(/both an input and an output/);
    expect(() => new Behavioral({ behavior: 'x', outputs: ['a.b'] })).toThrow(/invalid pin name/);
    expect(() => new Behavioral({ behavior: 'x', inputs: ['a'], outputs: ['y'], combPaths: [['y', 'a', 0]] })).toThrow(/comb path/);
    const c = new DigitalCircuit();
    c.add('U1', new Behavioral({ behavior: 'never-registered', outputs: ['y'] }));
    expect(() => c.build()).toThrow(/unknown behavior 'never-registered'.*registerBehavior/);
    expect(() => registerBehavior('bad name', xorFactory)).toThrow(/invalid behavior name/);
  });

  it('rejects an invalid explicit delay', () => {
    registerBehavior('test-bad-delay', (_config, ctx) => ({
      reset() {},
      evaluate(h: Host) {
        h.out(ctx.outputs.y, 9, 1.5);
      },
    }));
    const c = new DigitalCircuit();
    c.add('S', new Stimulus({ changes: [['1n', 1]] }), { y: 'A' });
    c.add('U1', new Behavioral({ behavior: 'test-bad-delay', inputs: ['a'], outputs: ['y'] }), { a: 'A' });
    expect(() => c.build()).toThrow(/non-negative integer/);
  });
});
