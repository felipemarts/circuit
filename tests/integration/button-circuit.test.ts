import { describe, it, expect } from 'vitest';
import { Circuit, VoltageSource, Resistor, Button } from '../../src/index';

/** V1(5V) → Button → R(1k) → GND */
function buildButtonCircuit(pressed: boolean) {
  const circuit = new Circuit();
  const v1 = new VoltageSource(5);
  const btn = new Button(pressed);
  const r1 = new Resistor(1000);

  v1.pin('+').connect(btn.pin('1'));
  btn.pin('2').connect(r1.pin('1'));
  r1.pin('2').connect(circuit.ground);
  v1.pin('-').connect(circuit.ground);

  return { circuit, v1, btn, r1 };
}

describe('Button', () => {
  it('blocks current while released', () => {
    const { circuit, btn, r1 } = buildButtonCircuit(false);
    circuit.analyze('dc');

    expect(Math.abs(r1.current)).toBeLessThan(1e-9);
    // The full source voltage drops across the open button
    expect(btn.voltage).toBeCloseTo(5, 3);
  });

  it('conducts while pressed', () => {
    const { circuit, btn, r1 } = buildButtonCircuit(true);
    circuit.analyze('dc');

    expect(r1.current).toBeCloseTo(0.005, 5);
    expect(btn.current).toBeCloseTo(0.005, 5);
    // Nearly zero drop across the closed contact
    expect(Math.abs(btn.voltage)).toBeLessThan(1e-3);
  });

  it('responds to press/release between analyses', () => {
    const { circuit, btn, r1 } = buildButtonCircuit(false);

    circuit.analyze('dc');
    expect(Math.abs(r1.current)).toBeLessThan(1e-9);

    btn.pressed = true;
    circuit.analyze('dc');
    expect(r1.current).toBeCloseTo(0.005, 5);

    btn.pressed = false;
    circuit.analyze('dc');
    expect(Math.abs(r1.current)).toBeLessThan(1e-9);
  });
});
