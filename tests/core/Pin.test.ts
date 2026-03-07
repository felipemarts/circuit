import { describe, it, expect } from 'vitest';
import { Circuit, Resistor, VoltageSource } from '../../src/index';

describe('Pin', () => {
  it('creates a node lazily on first access', () => {
    const r = new Resistor(100);
    const node = r.pin('1').node;
    expect(node).toBeDefined();
    expect(node.pins.size).toBe(1);
  });

  it('merges nodes when connecting two pins', () => {
    const r1 = new Resistor(100);
    const r2 = new Resistor(200);

    r1.pin('2').connect(r2.pin('1'));

    // Both pins should share the same node
    expect(r1.pin('2').node).toBe(r2.pin('1').node);
    expect(r1.pin('2').node.pins.size).toBe(2);
  });

  it('handles connecting already-connected pins (idempotent)', () => {
    const r1 = new Resistor(100);
    const r2 = new Resistor(200);

    r1.pin('2').connect(r2.pin('1'));
    r1.pin('2').connect(r2.pin('1'));

    expect(r1.pin('2').node).toBe(r2.pin('1').node);
    expect(r1.pin('2').node.pins.size).toBe(2);
  });

  it('returns the other pin for chaining', () => {
    const r1 = new Resistor(100);
    const r2 = new Resistor(200);
    const r3 = new Resistor(300);

    const result = r1.pin('2').connect(r2.pin('1'));
    expect(result).toBe(r2.pin('1'));
  });

  it('merges three pins into one node via transitive connects', () => {
    const r1 = new Resistor(100);
    const r2 = new Resistor(200);
    const r3 = new Resistor(300);

    r1.pin('2').connect(r2.pin('1'));
    r2.pin('1').connect(r3.pin('1'));

    const sharedNode = r1.pin('2').node;
    expect(r2.pin('1').node).toBe(sharedNode);
    expect(r3.pin('1').node).toBe(sharedNode);
    expect(sharedNode.pins.size).toBe(3);
  });

  it('throws on invalid pin name', () => {
    const r = new Resistor(100);
    expect(() => r.pin('3')).toThrow('no pin "3"');
  });
});
