import { describe, it, expect } from 'vitest';
import { Circuit, VoltageSource, Resistor, Switch } from '../../src/index';

/**
 * SPDT switch routing:
 *
 *   V1+ ── com ─┬─ a ── R1(1k) ── GND
 *               └─ b ── R2(2k) ── GND
 *   V1- ── GND
 */
function buildSpdtCircuit(closed: boolean) {
  const circuit = new Circuit();
  const v1 = new VoltageSource(10);
  const sw = new Switch(closed);
  const r1 = new Resistor(1000);
  const r2 = new Resistor(2000);

  v1.pin('+').connect(sw.pin('com'));
  sw.pin('a').connect(r1.pin('1'));
  sw.pin('b').connect(r2.pin('1'));
  r1.pin('2').connect(circuit.ground);
  r2.pin('2').connect(circuit.ground);
  v1.pin('-').connect(circuit.ground);

  return { circuit, v1, sw, r1, r2 };
}

describe('SPDT Switch', () => {
  it('routes current through channel A when open (closed=false)', () => {
    const { circuit, r1, r2 } = buildSpdtCircuit(false);
    circuit.analyze('dc');

    // R1 sees the full 10V (minus the ~1mΩ contact resistance)
    expect(r1.current).toBeCloseTo(0.01, 5);
    expect(r1.voltage).toBeCloseTo(10, 3);

    // R2 path goes through the open channel (1TΩ) — effectively no current
    expect(Math.abs(r2.current)).toBeLessThan(1e-9);
  });

  it('routes current through channel B when closed', () => {
    const { circuit, r1, r2 } = buildSpdtCircuit(true);
    circuit.analyze('dc');

    expect(r2.current).toBeCloseTo(0.005, 5);
    expect(r2.voltage).toBeCloseTo(10, 3);
    expect(Math.abs(r1.current)).toBeLessThan(1e-9);
  });

  it('toggle() switches the active channel between analyses', () => {
    const { circuit, sw, r1, r2 } = buildSpdtCircuit(false);

    circuit.analyze('dc');
    expect(r1.current).toBeCloseTo(0.01, 5);

    sw.toggle();
    expect(sw.closed).toBe(true);

    circuit.analyze('dc');
    expect(r2.current).toBeCloseTo(0.005, 5);
    expect(Math.abs(r1.current)).toBeLessThan(1e-9);
  });

  it('reports its own current through the active channel after DC analysis', () => {
    const { circuit, sw } = buildSpdtCircuit(false);
    circuit.analyze('dc');

    // Same current that flows through R1
    expect(sw.current).toBeCloseTo(0.01, 5);

    sw.toggle();
    circuit.analyze('dc');
    expect(sw.current).toBeCloseTo(0.005, 5);
  });
});
