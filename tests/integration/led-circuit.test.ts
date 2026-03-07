import { describe, it, expect } from 'vitest';
import { Circuit, VoltageSource, Resistor, LED } from '../../src/index';

describe('LED Circuit', () => {
  it('computes LED forward voltage with series resistor', () => {
    const circuit = new Circuit();
    const v1 = new VoltageSource(5);
    const r1 = new Resistor(1000);
    const led = new LED();

    v1.pin('+').connect(r1.pin('1'));
    r1.pin('2').connect(led.anode);
    led.cathode.connect(circuit.ground);
    v1.pin('-').connect(circuit.ground);

    circuit.analyze('dc');

    // LED has higher forward voltage than regular diode (~1.5-2.5V due to Is=1e-20, n=2)
    expect(led.voltage).toBeGreaterThan(1.0);
    expect(led.voltage).toBeLessThan(3.0);

    // Current through the series circuit
    const expectedCurrent = (5 - led.voltage) / 1000;
    expect(r1.current).toBeCloseTo(expectedCurrent, 4);
  });

  it('works in the full example from the spec', () => {
    const circuit = new Circuit();
    const v1 = new VoltageSource(5);
    const r1 = new Resistor(1000);
    const r2 = new Resistor(2000);
    const led = new LED();

    v1.pin('+').connect(r1.pin('1'));
    r1.pin('2').connect(r2.pin('1'));
    r2.pin('2').connect(led.anode);
    led.cathode.connect(circuit.ground);
    v1.pin('-').connect(circuit.ground);

    circuit.analyze('dc');

    // Verify all results are consistent
    const totalVoltage = r1.voltage + r2.voltage + led.voltage;
    expect(totalVoltage).toBeCloseTo(5, 2);

    // Same current through all series components
    expect(r1.current).toBeCloseTo(r2.current, 6);
  });
});
