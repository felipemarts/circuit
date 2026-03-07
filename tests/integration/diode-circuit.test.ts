import { describe, it, expect } from 'vitest';
import { Circuit, VoltageSource, Resistor, Diode } from '../../src/index';

describe('Diode Circuit', () => {
  it('computes ~0.7V drop across a diode with 1k resistor', () => {
    const circuit = new Circuit();
    const v1 = new VoltageSource(5);
    const r1 = new Resistor(1000);
    const d1 = new Diode();

    // V1+ -> R1(1) -> R1(2)/D1(anode) -> D1(cathode) -> GND
    v1.pin('+').connect(r1.pin('1'));
    r1.pin('2').connect(d1.anode);
    d1.cathode.connect(circuit.ground);
    v1.pin('-').connect(circuit.ground);

    circuit.analyze('dc');

    // Diode forward voltage should be approximately 0.6-0.7V
    expect(d1.voltage).toBeGreaterThan(0.55);
    expect(d1.voltage).toBeLessThan(0.75);

    // Resistor voltage should be approximately 5 - Vd
    expect(r1.voltage).toBeCloseTo(5 - d1.voltage, 2);

    // Current should be (5 - Vd) / 1000
    expect(r1.current).toBeCloseTo((5 - d1.voltage) / 1000, 4);
  });

  it('conducts negligible current when reverse biased', () => {
    const circuit = new Circuit();
    const v1 = new VoltageSource(5);
    const r1 = new Resistor(1000);
    const d1 = new Diode();

    // Reverse biased: cathode at high voltage
    v1.pin('+').connect(d1.cathode);
    d1.anode.connect(r1.pin('1'));
    r1.pin('2').connect(circuit.ground);
    v1.pin('-').connect(circuit.ground);

    circuit.analyze('dc');

    // Current should be essentially zero (leakage only)
    expect(Math.abs(r1.current)).toBeLessThan(1e-10);
  });
});
