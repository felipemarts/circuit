import { describe, it, expect } from 'vitest';
import { Circuit, VoltageSource, Resistor, Capacitor, Switch } from '../../src/index';
import { TransientSession } from '../../src/analysis/TransientSession';

describe('TransientSession (interactive stepping used by the visual editor)', () => {
  it('shows the DC operating point first, then steps the zero-state transient with BE', () => {
    const circuit = new Circuit();
    const v1 = new VoltageSource(5);
    const sw = new Switch(false); // com–a: the source drives R1; com–b: R1 to ground
    const r1 = new Resistor(1000);
    const c1 = new Capacitor(1e-6);
    v1.pin('+').connect(sw.pin('a'));
    sw.pin('com').connect(r1.pin('1'));
    r1.pin('2').connect(c1.pin('1'));
    c1.pin('2').connect(circuit.ground);
    sw.pin('b').connect(circuit.ground);
    v1.pin('-').connect(circuit.ground);

    const session = new TransientSession(circuit, [{ label: 'vc', color: '', component: c1, type: 'voltage' }]);
    expect(c1.voltage).toBeCloseTo(5, 6); // DC readout before the first step
    for (let k = 0; k < 100; k++) session.step(1e-5);
    expect(session.time).toBeCloseTo(1e-3, 12);
    const vc = session.probeValues[0];
    expect(vc.length).toBe(100);
    // BE with h = τ/100: within 1 % of 5(1 − e^-1) at t = τ.
    expect(Math.abs(vc[99] - 5 * (1 - Math.exp(-1)))).toBeLessThan(0.05 * 5 * (1 - Math.exp(-1)));
    // Flip the switch mid-run: R1 now goes to ground and the capacitor discharges.
    sw.toggle();
    for (let k = 0; k < 50; k++) session.step(1e-5);
    expect(vc[149]).toBeLessThan(vc[99] * Math.exp(-0.5) * 1.02);
    expect(vc[149]).toBeGreaterThan(vc[99] * Math.exp(-0.5) * 0.98);
    session.end();
    // A DC analysis afterwards sees the capacitor as open again.
    circuit.analyze('dc');
    expect(Math.abs(r1.current)).toBeLessThan(1e-9);
  });
});
