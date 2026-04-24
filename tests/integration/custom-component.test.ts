import { describe, it, expect } from 'vitest';
import { Circuit, defineComponent, Resistor, VoltageSource, LED } from '../../src/index';
import type { TransientConfig, ProbeSpec } from '../../src/index';

describe('Custom Components (defineComponent)', () => {
  it('custom resistor works with DC analysis', () => {
    const MyResistor = defineComponent({
      name: 'MyResistor',
      pins: ['a', 'b'],
      params: { R: { default: 1000, unit: 'Ω' } },
      stamp({ stampResistance, params }) {
        stampResistance('a', 'b', params.R);
      },
    });

    const circuit = new Circuit();
    const v1 = new VoltageSource(10);
    const r1 = new MyResistor({ R: 1000 });
    const r2 = new Resistor(1000);

    v1.pin('+').connect(r1.pin('a'));
    r1.pin('b').connect(r2.pin('1'));
    r2.pin('2').connect(circuit.ground);
    v1.pin('-').connect(circuit.ground);

    circuit.analyze('dc');

    // Voltage divider: each resistor gets 5V
    expect(r2.voltage).toBeCloseTo(5, 2);
    expect(r2.current).toBeCloseTo(0.005, 4);
  });

  it('custom component with default params', () => {
    const MyResistor = defineComponent({
      name: 'MyResistor',
      pins: ['a', 'b'],
      params: { R: { default: 2000, unit: 'Ω' } },
      stamp({ stampResistance, params }) {
        stampResistance('a', 'b', params.R);
      },
    });

    const circuit = new Circuit();
    const v1 = new VoltageSource(10);
    const r1 = new MyResistor(); // uses default R=2000
    const r2 = new Resistor(2000);

    v1.pin('+').connect(r1.pin('a'));
    r1.pin('b').connect(r2.pin('1'));
    r2.pin('2').connect(circuit.ground);
    v1.pin('-').connect(circuit.ground);

    circuit.analyze('dc');

    expect(r2.voltage).toBeCloseTo(5, 2);
  });

  it('custom current source works', () => {
    const MyCurrentSource = defineComponent({
      name: 'MyCurrentSource',
      pins: ['+', '-'],
      params: { I: { default: 0.01, unit: 'A' } },
      stamp({ stampCurrentSource, params }) {
        stampCurrentSource('+', '-', params.I);
      },
    });

    const circuit = new Circuit();
    const cs = new MyCurrentSource({ I: 0.005 }); // 5mA
    const r1 = new Resistor(1000);

    cs.pin('+').connect(r1.pin('1'));
    cs.pin('-').connect(circuit.ground);
    r1.pin('2').connect(circuit.ground);

    circuit.analyze('dc');

    // V = I * R = 0.005 * 1000 = 5V
    expect(r1.voltage).toBeCloseTo(5, 2);
  });

  it('4-pin VCCS (voltage-controlled current source) works', () => {
    const VCCS = defineComponent({
      name: 'VCCS',
      pins: ['in+', 'in-', 'out+', 'out-'],
      params: { gm: { default: 0.01, unit: 'S' } },
      nonlinear: true,
      stamp({ stampCurrentSource, voltage, params }) {
        const vin = voltage('in+') - voltage('in-');
        stampCurrentSource('out+', 'out-', params.gm * vin);
      },
    });

    const circuit = new Circuit();
    const v1 = new VoltageSource(2); // 2V input
    const vccs = new VCCS({ gm: 0.01 }); // gm = 10mS
    const rLoad = new Resistor(500);

    // Input: V1 drives the input pins
    v1.pin('+').connect(vccs.pin('in+'));
    v1.pin('-').connect(circuit.ground);
    vccs.pin('in-').connect(circuit.ground);

    // Output: VCCS drives current through load resistor
    vccs.pin('out+').connect(rLoad.pin('1'));
    vccs.pin('out-').connect(circuit.ground);
    rLoad.pin('2').connect(circuit.ground);

    circuit.analyze('dc');

    // Output current = gm * Vin = 0.01 * 2 = 20mA
    // Voltage across load = I * R = 0.02 * 500 = 10V
    expect(rLoad.voltage).toBeCloseTo(10, 1);
  });

  it('custom component pins are properly created', () => {
    const MyResistor = defineComponent({
      name: 'MyResistor',
      pins: ['a', 'b'],
      params: { R: { default: 1000, unit: 'Ω' } },
      stamp({ stampResistance, params }) {
        stampResistance('a', 'b', params.R);
      },
    });

    const r1 = new MyResistor({ R: 1000 });
    expect(r1.pin('a')).toBeDefined();
    expect(r1.pin('b')).toBeDefined();
    expect(r1.allPins()).toHaveLength(2);
  });

  it('isNonlinear() reflects the definition', () => {
    const Linear = defineComponent({
      name: 'Linear',
      pins: ['a', 'b'],
      stamp() {},
    });

    const Nonlinear = defineComponent({
      name: 'Nonlinear',
      pins: ['a', 'b'],
      nonlinear: true,
      stamp() {},
    });

    const linear = new Linear();
    const nonlinear = new Nonlinear();

    expect(linear.isNonlinear()).toBe(false);
    expect(nonlinear.isNonlinear()).toBe(true);
  });

  it('static _componentDef is accessible', () => {
    const def = {
      name: 'TestComp',
      pins: ['x', 'y'],
      params: { val: { default: 42 } },
      stamp() {},
    };
    const TestComp = defineComponent(def);

    expect(TestComp._componentDef).toBe(def);
    expect(TestComp._componentDef.name).toBe('TestComp');
    expect(TestComp._componentDef.pins).toEqual(['x', 'y']);
  });

  it('setup initializes state', () => {
    const Counter = defineComponent({
      name: 'Counter',
      pins: ['a', 'b'],
      setup(state) {
        state.count = 0;
        state.prevV = 0;
      },
      stamp({ stampResistance }) {
        stampResistance('a', 'b', 1000);
      },
    });

    const c = new Counter();
    expect((c as any)._state.count).toBe(0);
    expect((c as any)._state.prevV).toBe(0);
  });

  it('custom component with conductance stamp', () => {
    const MyConductor = defineComponent({
      name: 'MyConductor',
      pins: ['a', 'b'],
      params: { G: { default: 0.001, unit: 'S' } },
      stamp({ stampConductance, params }) {
        stampConductance('a', 'b', params.G);
      },
    });

    const circuit = new Circuit();
    const v1 = new VoltageSource(10);
    const g1 = new MyConductor({ G: 0.002 }); // 500 ohm equivalent

    v1.pin('+').connect(g1.pin('a'));
    g1.pin('b').connect(circuit.ground);
    v1.pin('-').connect(circuit.ground);

    circuit.analyze('dc');

    // Current = V * G = 10 * 0.002 = 20mA
    // Check via voltage source current
    expect(Math.abs(v1.current)).toBeCloseTo(0.02, 4);
  });
});

// ============================================================
// Microcontroller + 2 LEDs example
// ============================================================

function createMCU() {
  return defineComponent({
    name: 'MCU',
    pins: ['gnd', 'gpio0', 'gpio1'],
    params: { Vcc: { default: 5, unit: 'V' }, Rout: { default: 100, unit: 'Ω' } },
    nonlinear: true,
    setup(state) {
      state.gpio0 = 0;
      state.gpio1 = 0;
    },
    onStep(ctx) {
      // Default program: alternate LEDs every 1ms (period = 2ms)
      const period = 0.002;
      const phase = (ctx.time % period) / period;
      ctx.state.gpio0 = phase < 0.5 ? 1 : 0;
      ctx.state.gpio1 = phase >= 0.5 ? 1 : 0;
    },
    stamp({ stampConductance, stampCurrentSource, params, state }) {
      const G = 1 / params.Rout;
      // GPIO0: Norton equivalent (conductance + current source for HIGH)
      stampConductance('gpio0', 'gnd', G);
      if (state.gpio0) {
        stampCurrentSource('gpio0', 'gnd', params.Vcc * G);
      }
      // GPIO1: same
      stampConductance('gpio1', 'gnd', G);
      if (state.gpio1) {
        stampCurrentSource('gpio1', 'gnd', params.Vcc * G);
      }
    },
  });
}

describe('Microcontroller + 2 LEDs', () => {
  it('GPIO HIGH drives ~5V open circuit, LOW drives ~0V', () => {
    const MCU = defineComponent({
      name: 'MCU_DC',
      pins: ['gnd', 'gpio0', 'gpio1'],
      params: { Vcc: { default: 5 }, Rout: { default: 100 } },
      setup(state) {
        state.gpio0 = 1; // HIGH
        state.gpio1 = 0; // LOW
      },
      stamp({ stampConductance, stampCurrentSource, params, state }) {
        const G = 1 / params.Rout;
        stampConductance('gpio0', 'gnd', G);
        if (state.gpio0) stampCurrentSource('gpio0', 'gnd', params.Vcc * G);
        stampConductance('gpio1', 'gnd', G);
        if (state.gpio1) stampCurrentSource('gpio1', 'gnd', params.Vcc * G);
      },
    });

    const circuit = new Circuit();
    const mcu = new MCU();
    // Small load resistors to measure voltage
    const r0 = new Resistor(10000); // 10kΩ — high impedance load
    const r1 = new Resistor(10000);

    mcu.pin('gnd').connect(circuit.ground);
    mcu.pin('gpio0').connect(r0.pin('1'));
    r0.pin('2').connect(circuit.ground);
    mcu.pin('gpio1').connect(r1.pin('1'));
    r1.pin('2').connect(circuit.ground);

    circuit.analyze('dc');

    // GPIO0 HIGH: V ≈ Vcc * Rload/(Rout+Rload) = 5 * 10000/10100 ≈ 4.95V
    expect(r0.voltage).toBeCloseTo(4.95, 1);
    // GPIO1 LOW: V ≈ 0V
    expect(r1.voltage).toBeCloseTo(0, 2);
  });

  it('MCU drives two LEDs with current-limiting resistors (DC)', () => {
    const MCU = defineComponent({
      name: 'MCU_LED',
      pins: ['gnd', 'gpio0', 'gpio1'],
      params: { Vcc: { default: 5 }, Rout: { default: 100 } },
      setup(state) {
        state.gpio0 = 1; // ON
        state.gpio1 = 1; // ON
      },
      nonlinear: true,
      stamp({ stampConductance, stampCurrentSource, params, state }) {
        const G = 1 / params.Rout;
        stampConductance('gpio0', 'gnd', G);
        if (state.gpio0) stampCurrentSource('gpio0', 'gnd', params.Vcc * G);
        stampConductance('gpio1', 'gnd', G);
        if (state.gpio1) stampCurrentSource('gpio1', 'gnd', params.Vcc * G);
      },
    });

    const circuit = new Circuit();
    const mcu = new MCU();
    const r1 = new Resistor(330);
    const r2 = new Resistor(330);
    const led1 = new LED();
    const led2 = new LED();

    mcu.pin('gnd').connect(circuit.ground);

    // GPIO0 -> R1 -> LED1 -> GND
    mcu.pin('gpio0').connect(r1.pin('1'));
    r1.pin('2').connect(led1.pin('anode'));
    led1.pin('cathode').connect(circuit.ground);

    // GPIO1 -> R2 -> LED2 -> GND
    mcu.pin('gpio1').connect(r2.pin('1'));
    r2.pin('2').connect(led2.pin('anode'));
    led2.pin('cathode').connect(circuit.ground);

    circuit.analyze('dc');

    // LED forward voltage ~1.8-2.2V (LED with Is=1e-20, n=2)
    // Current ≈ (Vcc - Vled) / (Rout + R) ≈ (5 - 2) / 430 ≈ 7mA
    expect(led1.voltage).toBeGreaterThan(1.5);
    expect(led1.voltage).toBeLessThan(2.5);
    expect(led1.current).toBeGreaterThan(0.003);
    expect(led1.current).toBeLessThan(0.015);

    // Both LEDs should have same values (symmetric circuit)
    expect(led2.voltage).toBeCloseTo(led1.voltage, 2);
    expect(led2.current).toBeCloseTo(led1.current, 4);
  });

  it('transient: MCU alternates LEDs over time', () => {
    const MCU = createMCU();

    const circuit = new Circuit();
    const mcu = new MCU();
    const r1 = new Resistor(330);
    const r2 = new Resistor(330);
    const led1 = new LED();
    const led2 = new LED();

    mcu.pin('gnd').connect(circuit.ground);
    mcu.pin('gpio0').connect(r1.pin('1'));
    r1.pin('2').connect(led1.pin('anode'));
    led1.pin('cathode').connect(circuit.ground);
    mcu.pin('gpio1').connect(r2.pin('1'));
    r2.pin('2').connect(led2.pin('anode'));
    led2.pin('cathode').connect(circuit.ground);

    const config: TransientConfig = {
      timeStep: 0.0001, // 100µs
      duration: 0.004,  // 4ms = 2 full periods
    };

    const probes: ProbeSpec[] = [
      { label: 'LED1', color: '#f00', component: led1, type: 'voltage' },
      { label: 'LED2', color: '#0f0', component: led2, type: 'voltage' },
    ];

    const result = circuit.analyze('transient', config, probes);

    // At t=0.0002 (200µs): gpio0=HIGH (phase<0.5), gpio1=LOW
    // step index = 0.0002 / 0.0001 = 2
    const led1_at_200us = result.probes[0].values[2];
    const led2_at_200us = result.probes[1].values[2];
    expect(led1_at_200us).toBeGreaterThan(1.0); // LED1 on
    expect(led2_at_200us).toBeLessThan(0.5);    // LED2 off

    // At t=0.0012 (1.2ms): gpio0=LOW (phase>0.5), gpio1=HIGH
    // step index = 0.0012 / 0.0001 = 12
    const led1_at_1200us = result.probes[0].values[12];
    const led2_at_1200us = result.probes[1].values[12];
    expect(led1_at_1200us).toBeLessThan(0.5);    // LED1 off
    expect(led2_at_1200us).toBeGreaterThan(1.0);  // LED2 on
  });

  it('MCU with custom program via onStep', () => {
    // A "programmable" MCU where the user defines behavior
    const ProgrammableMCU = defineComponent({
      name: 'ProgrammableMCU',
      pins: ['gnd', 'gpio0', 'gpio1'],
      params: { Vcc: { default: 5 }, Rout: { default: 100 } },
      nonlinear: true,
      setup(state) {
        state.gpio0 = 0;
        state.gpio1 = 0;
        state.counter = 0;
      },
      onStep(ctx) {
        // Custom program: both LEDs on after 1ms, both off before
        ctx.state.counter++;
        if (ctx.time >= 0.001) {
          ctx.state.gpio0 = 1;
          ctx.state.gpio1 = 1;
        } else {
          ctx.state.gpio0 = 0;
          ctx.state.gpio1 = 0;
        }
      },
      stamp({ stampConductance, stampCurrentSource, params, state }) {
        const G = 1 / params.Rout;
        stampConductance('gpio0', 'gnd', G);
        if (state.gpio0) stampCurrentSource('gpio0', 'gnd', params.Vcc * G);
        stampConductance('gpio1', 'gnd', G);
        if (state.gpio1) stampCurrentSource('gpio1', 'gnd', params.Vcc * G);
      },
    });

    const circuit = new Circuit();
    const mcu = new ProgrammableMCU();
    const r1 = new Resistor(330);
    const r2 = new Resistor(330);
    const led1 = new LED();
    const led2 = new LED();

    mcu.pin('gnd').connect(circuit.ground);
    mcu.pin('gpio0').connect(r1.pin('1'));
    r1.pin('2').connect(led1.pin('anode'));
    led1.pin('cathode').connect(circuit.ground);
    mcu.pin('gpio1').connect(r2.pin('1'));
    r2.pin('2').connect(led2.pin('anode'));
    led2.pin('cathode').connect(circuit.ground);

    const config: TransientConfig = { timeStep: 0.0002, duration: 0.002 };
    const probes: ProbeSpec[] = [
      { label: 'LED1', color: '#f00', component: led1, type: 'voltage' },
      { label: 'LED2', color: '#0f0', component: led2, type: 'voltage' },
    ];

    const result = circuit.analyze('transient', config, probes);

    // At t=0.0004 (step 2): both LEDs off (time < 1ms)
    expect(result.probes[0].values[2]).toBeLessThan(0.5);
    expect(result.probes[1].values[2]).toBeLessThan(0.5);

    // At t=0.0016 (step 8): both LEDs on (time >= 1ms)
    expect(result.probes[0].values[8]).toBeGreaterThan(1.0);
    expect(result.probes[1].values[8]).toBeGreaterThan(1.0);
  });
});
