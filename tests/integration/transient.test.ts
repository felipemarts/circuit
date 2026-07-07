import { describe, it, expect } from 'vitest';
import { Circuit, VoltageSource, Resistor, Capacitor, Inductor } from '../../src/index';

describe('Transient Analysis', () => {
  it('RC charging follows v(t) = V·(1 − e^(−t/τ))', () => {
    // 5V → R(1k) → C(1µF) → GND, τ = 1ms
    const circuit = new Circuit();
    const v1 = new VoltageSource(5);
    const r1 = new Resistor(1000);
    const c1 = new Capacitor(1e-6);

    v1.pin('+').connect(r1.pin('1'));
    r1.pin('2').connect(c1.pin('1'));
    c1.pin('2').connect(circuit.ground);
    v1.pin('-').connect(circuit.ground);

    const tau = 1e-3;
    const dt = tau / 100;
    const result = circuit.analyze(
      'transient',
      { timeStep: dt, duration: 5 * tau },
      [{ label: 'Vc', color: '#0f0', component: c1, type: 'voltage' }],
    );

    const vc = result.probes[0].values;
    expect(result.timePoints.length).toBe(vc.length);

    // Starts near zero (cold start)
    expect(vc[0]).toBeLessThan(0.2);

    // Monotonically non-decreasing charge curve
    for (let i = 1; i < vc.length; i++) {
      expect(vc[i]).toBeGreaterThanOrEqual(vc[i - 1] - 1e-9);
    }

    // At t = τ the capacitor should be at ~63.2% of the source voltage.
    // Tolerance covers Backward Euler discretization error at dt = τ/100.
    const iTau = result.timePoints.findIndex(t => t >= tau);
    expect(vc[iTau]).toBeCloseTo(5 * (1 - Math.exp(-1)), 1);

    // Fully charged after 5τ
    expect(vc[vc.length - 1]).toBeCloseTo(5, 1);
  });

  it('RL current rise follows i(t) = (V/R)·(1 − e^(−t/τ))', () => {
    // 5V → R(100Ω) → L(10mH) → GND, τ = L/R = 0.1ms, i_final = 50mA
    const circuit = new Circuit();
    const v1 = new VoltageSource(5);
    const r1 = new Resistor(100);
    const l1 = new Inductor(10e-3);

    v1.pin('+').connect(r1.pin('1'));
    r1.pin('2').connect(l1.pin('1'));
    l1.pin('2').connect(circuit.ground);
    v1.pin('-').connect(circuit.ground);

    const tau = 10e-3 / 100;
    const dt = tau / 100;
    // Probe the resistor: its current is computed directly from the solved
    // node voltages, so it tracks the inductor current without lag.
    const result = circuit.analyze(
      'transient',
      { timeStep: dt, duration: 5 * tau },
      [{ label: 'I', color: '#f00', component: r1, type: 'current' }],
    );

    const iR = result.probes[0].values;

    // Starts near zero (inductor resists sudden current change)
    expect(iR[0]).toBeLessThan(0.002);

    // Monotonically non-decreasing rise
    for (let i = 1; i < iR.length; i++) {
      expect(iR[i]).toBeGreaterThanOrEqual(iR[i - 1] - 1e-9);
    }

    // At t = τ the current should be at ~63.2% of V/R
    const iTau = result.timePoints.findIndex(t => t >= tau);
    expect(iR[iTau]).toBeCloseTo(0.05 * (1 - Math.exp(-1)), 3);

    // Settled at V/R after 5τ
    expect(iR[iR.length - 1]).toBeCloseTo(0.05, 3);
  });

  it('resets components to DC mode after the run', () => {
    const circuit = new Circuit();
    const v1 = new VoltageSource(5);
    const r1 = new Resistor(1000);
    const c1 = new Capacitor(1e-6);

    v1.pin('+').connect(r1.pin('1'));
    r1.pin('2').connect(c1.pin('1'));
    c1.pin('2').connect(circuit.ground);
    v1.pin('-').connect(circuit.ground);

    circuit.analyze('transient', { timeStep: 1e-5, duration: 1e-3 }, []);

    // A DC analysis right after must still see the capacitor as an open
    // circuit: no current flows, full source voltage across the cap.
    circuit.analyze('dc');
    expect(Math.abs(r1.current)).toBeLessThan(1e-9);
    expect(c1.voltage).toBeCloseTo(5, 3);
  });
});
