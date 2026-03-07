import { describe, it, expect } from 'vitest';
import { Circuit, VoltageSource, Resistor } from '../../src/index';

describe('Voltage Divider', () => {
  it('computes correct output voltage for 10V with 1k/2k divider', () => {
    const circuit = new Circuit();
    const v1 = new VoltageSource(10);
    const r1 = new Resistor(1000);
    const r2 = new Resistor(2000);

    // V1+ -> R1(1) -> R1(2)/R2(1) -> R2(2) -> GND
    // V1- -> GND
    v1.pin('+').connect(r1.pin('1'));
    r1.pin('2').connect(r2.pin('1'));
    r2.pin('2').connect(circuit.ground);
    v1.pin('-').connect(circuit.ground);

    circuit.analyze('dc');

    // V_out = V * R2/(R1+R2) = 10 * 2000/3000 = 6.667V
    expect(r2.voltage).toBeCloseTo(6.667, 2);

    // Total current = V/(R1+R2) = 10/3000 = 3.333mA
    expect(r1.current).toBeCloseTo(0.003333, 4);
    expect(r2.current).toBeCloseTo(0.003333, 4);

    // R1 voltage = I * R1 = 0.003333 * 1000 = 3.333V
    expect(r1.voltage).toBeCloseTo(3.333, 2);
  });

  it('computes correct values with equal resistors', () => {
    const circuit = new Circuit();
    const v1 = new VoltageSource(12);
    const r1 = new Resistor(1000);
    const r2 = new Resistor(1000);

    v1.pin('+').connect(r1.pin('1'));
    r1.pin('2').connect(r2.pin('1'));
    r2.pin('2').connect(circuit.ground);
    v1.pin('-').connect(circuit.ground);

    circuit.analyze('dc');

    expect(r1.voltage).toBeCloseTo(6, 2);
    expect(r2.voltage).toBeCloseTo(6, 2);
  });

  it('works with multiple voltage sources in series', () => {
    const circuit = new Circuit();
    const v1 = new VoltageSource(5);
    const v2 = new VoltageSource(3);
    const r1 = new Resistor(1000);

    // V1+ -> V2+ -> R1(1) -> R1(2) -> GND
    // V1- -> GND, V2- -> V1+
    v1.pin('+').connect(v2.pin('-'));
    v2.pin('+').connect(r1.pin('1'));
    r1.pin('2').connect(circuit.ground);
    v1.pin('-').connect(circuit.ground);

    circuit.analyze('dc');

    // Total voltage = 5 + 3 = 8V across R1
    expect(r1.voltage).toBeCloseTo(8, 2);
    expect(r1.current).toBeCloseTo(0.008, 4); // 8mA
  });
});
