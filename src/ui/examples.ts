import type { ProjectData } from './types';

/**
 * Example project with deep-link metadata.
 *
 * `slug` is the stable identifier used in the URL (`app.html?example=<slug>`)
 * and is a contract with the landing page — do not rename it without updating the links.
 * `description` is the short text shown in listings.
 *
 * `ExampleProject` extends `ProjectData`, so everything that consumes
 * `ProjectData` (e.g. projectManager, which only uses `.name` and the default
 * fields) keeps working without changes.
 */
export interface ExampleProject extends ProjectData {
  slug: string;
  description: string;
}

const VOLTAGE_DIVIDER: ExampleProject = {
  version: 1,
  name: 'Voltage Divider',
  slug: 'divisor-tensao',
  description: 'Two resistors in series dividing 10 V — the most fundamental circuit in electronics.',
  files: [
    {
      name: 'main.js',
      content: `const circuit = new Circuit();
const gnd = new Ground();

const v1 = new VoltageSource(10);
const r1 = new Resistor(1000);
const r2 = new Resistor(2000);

v1.pin('+').connect(r1.pin('1'));
r1.pin('2').connect(r2.pin('1'));
r2.pin('2').connect(gnd.pin('1'));
v1.pin('-').connect(gnd.pin('1'));

circuit.analyze('dc');

console.log('V_out (R2):', r2.voltage.toFixed(3), 'V');
console.log('Current:', (r1.current * 1000).toFixed(3), 'mA');`,
    },
  ],
  canvas: { components: [], wires: [], grounds: [], probes: [] },
  settings: { simDt: '1e-6', simDuration: '5e-3' },
};

const RC_LOWPASS: ExampleProject = {
  version: 1,
  name: 'RC Low-Pass Filter',
  slug: 'rc-lowpass',
  description: 'A 5 V step charging a capacitor through a resistor — the classic exponential curve.',
  files: [
    {
      name: 'main.js',
      content: `// 1st-order RC low-pass filter
//
//   5V ──[ R 1k ]──┬── Vout
//                  │
//                [ C 1u ]
//                  │
//                 GND
//
// When the 5 V step is applied, the capacitor charges exponentially:
//   Vc(t) = 5 * (1 - e^(-t/tau)),  with tau = R*C = 1k * 1u = 1 ms.
// After 5*tau (5 ms), Vc has reached ~99.3% of its final value.

const circuit = new Circuit();
const gnd = new Ground();

const v1 = new VoltageSource(5);     // 5 V step at t = 0
const r1 = new Resistor(1000);       // 1 kOhm
const c1 = new Capacitor(0.000001);  // 1 uF

v1.pin('+').connect(r1.pin('1'));
r1.pin('2').connect(c1.pin('1'));
c1.pin('2').connect(gnd.pin('1'));
v1.pin('-').connect(gnd.pin('1'));

// Voltage probe on the capacitor — the charge curve shows up in the chart
circuit.probe(c1, 'voltage');

// Transient: 5 ms duration with a 10 us step
const result = circuit.analyze('transient', {
  timeStep: 0.00001,
  duration: 0.005,
});

// Theory vs simulation: last point of the capacitor probe
const curve = result.probes[0].values;
const vcFinal = curve[curve.length - 1];
const tau = 1000 * 0.000001; // R * C = 1 ms
console.log('Theoretical tau (R*C):', (tau * 1000).toFixed(2), 'ms');
console.log('Vc after 5*tau:', vcFinal.toFixed(3), 'V (theory ~4.966 V)');`,
    },
  ],
  canvas: { components: [], wires: [], grounds: [], probes: [] },
  settings: { simDt: '1e-5', simDuration: '5e-3' },
};

const RLC_TRANSIENT: ExampleProject = {
  version: 1,
  name: 'RLC Transient',
  slug: 'rlc-ressonante',
  description: 'Underdamped series RLC circuit — resonant oscillation visible in the chart.',
  files: [
    {
      name: 'main.js',
      content: `// Series RLC circuit — step response
//
//   10V ──[ R 1 ]──[ L 1m ]──┬── Vout
//                            │
//                         [ C 10u ]
//                            │
//                           GND
//
// With low R the circuit is UNDERDAMPED: the capacitor voltage
// oscillates around 10 V before settling (ringing).
//
//   f0 = 1 / (2*pi*sqrt(L*C)) ≈ 1.59 kHz   (resonant frequency)
//   Q  = (1/R) * sqrt(L/C)    = 10          (quality factor)
//
// Try raising R to 20 (critical damping ~ 2*sqrt(L/C))
// and watch the oscillation disappear.

const circuit = new Circuit();
const gnd = new Ground();

const v1 = new VoltageSource(10);   // 10 V step at t = 0
const r1 = new Resistor(1);         // 1 Ohm — deliberately low, so it oscillates
const l1 = new Inductor(0.001);     // 1 mH
const c1 = new Capacitor(0.00001);  // 10 uF

v1.pin('+').connect(r1.pin('1'));
r1.pin('2').connect(l1.pin('1'));
l1.pin('2').connect(c1.pin('1'));
c1.pin('2').connect(gnd.pin('1'));
v1.pin('-').connect(gnd.pin('1'));

// Probe on the capacitor — the ringing shows up in the chart
circuit.probe(c1, 'voltage');

// 5 ms covers ~8 oscillation cycles (T = 1/f0 ≈ 0.63 ms)
circuit.analyze('transient', {
  timeStep: 1e-6,
  duration: 5e-3,
});`,
    },
  ],
  canvas: { components: [], wires: [], grounds: [], probes: [] },
  settings: { simDt: '1e-6', simDuration: '5e-3' },
};

const SWITCH_SPDT: ExampleProject = {
  version: 1,
  name: 'SPDT Switch + 2 LEDs',
  slug: 'switch-spdt',
  description: 'A single-pole double-throw switch routing current between two LEDs.',
  files: [
    {
      name: 'main.js',
      content: `// SPDT switch (1 pole, 2 positions) toggling two LEDs
//
//          ┌─ a ──[ R 330 ]──▶|── GND    (channel A -> LED1)
//   5V ── com
//          └─ b ──[ R 330 ]──▶|── GND    (channel B -> LED2)
//
// The switch connects 'com' to channel A (default) or channel B.
// Only the active channel's LED gets current: ~(5 - Vf) / 330 ≈ 9 mA.

const circuit = new Circuit();
const gnd = new Ground();

const v1 = new VoltageSource(5);
const sw = new Switch();       // position A by default (closed = false)
const ra = new Resistor(330);  // limits LED1 current
const rb = new Resistor(330);  // limits LED2 current
const led1 = new LED();
const led2 = new LED();

v1.pin('+').connect(sw.pin('com'));

// Channel A: com ─ a ─ R ─ LED1 ─ GND
sw.pin('a').connect(ra.pin('1'));
ra.pin('2').connect(led1.pin('anode'));
led1.pin('cathode').connect(gnd.pin('1'));

// Channel B: com ─ b ─ R ─ LED2 ─ GND
sw.pin('b').connect(rb.pin('1'));
rb.pin('2').connect(led2.pin('anode'));
led2.pin('cathode').connect(gnd.pin('1'));

v1.pin('-').connect(gnd.pin('1'));

// Current probes on both LEDs
circuit.probe(led1, 'current');
circuit.probe(led2, 'current');

circuit.analyze('dc');

const i1 = led1.current * 1000; // mA
const i2 = led2.current * 1000; // mA
console.log('LED1:', i1.toFixed(2), 'mA | LED2:', i2.toFixed(2), 'mA');
console.log('Lit now:', i1 > i2 ? 'LED1 (channel A)' : 'LED2 (channel B)');
console.log('Tip: click the switch on the canvas and hit Play to toggle.');`,
    },
  ],
  canvas: { components: [], wires: [], grounds: [], probes: [] },
  settings: { simDt: '1e-6', simDuration: '5e-3' },
};

const MCU_LEDS: ExampleProject = {
  version: 1,
  name: 'MCU + 2 LEDs',
  slug: 'mcu-leds',
  description: 'A custom component built with defineComponent: a microcontroller blinking two LEDs.',
  files: [
    {
      name: 'components.js',
      content: `// Custom microcontroller with 2 GPIOs
const MCU = defineComponent({
  name: 'MCU',
  pins: ['gnd', 'gpio0', 'gpio1'],
  params: {
    Vcc: { default: 5, unit: 'V' },
    Rout: { default: 100, unit: 'Ohm' },
  },
  nonlinear: true,
  setup(state) {
    state.gpio0 = 0;
    state.gpio1 = 0;
  },
  onStep(ctx) {
    // Program: toggle the LEDs every 1ms
    const period = 0.002;
    const phase = (ctx.time % period) / period;
    ctx.state.gpio0 = phase < 0.5 ? 1 : 0;
    ctx.state.gpio1 = phase >= 0.5 ? 1 : 0;
  },
  stamp({ stampConductance, stampCurrentSource, params, state }) {
    const G = 1 / params.Rout;
    // GPIO0: Norton equivalent
    stampConductance('gpio0', 'gnd', G);
    if (state.gpio0) {
      stampCurrentSource('gpio0', 'gnd', params.Vcc * G);
    }
    // GPIO1
    stampConductance('gpio1', 'gnd', G);
    if (state.gpio1) {
      stampCurrentSource('gpio1', 'gnd', params.Vcc * G);
    }
  },
});`,
    },
    {
      name: 'main.js',
      content: `const circuit = new Circuit();
const gnd = new Ground();

const mcu = new MCU();
const r1 = new Resistor(330);
const r2 = new Resistor(330);
const led1 = new LED();
const led2 = new LED();

// Connect MCU ground
mcu.pin('gnd').connect(gnd.pin('1'));

// GPIO0 -> R1 -> LED1 -> GND
mcu.pin('gpio0').connect(r1.pin('1'));
r1.pin('2').connect(led1.pin('anode'));
led1.pin('cathode').connect(gnd.pin('1'));

// GPIO1 -> R2 -> LED2 -> GND
mcu.pin('gpio1').connect(r2.pin('1'));
r2.pin('2').connect(led2.pin('anode'));
led2.pin('cathode').connect(gnd.pin('1'));

// Probes on the LEDs
circuit.probe(led1, 'voltage');
circuit.probe(led2, 'voltage');

circuit.analyze('transient', {
  timeStep: 0.0001,
  duration: 0.004,
});

console.log('LED1 voltage:', led1.voltage.toFixed(3), 'V');
console.log('LED2 voltage:', led2.voltage.toFixed(3), 'V');`,
    },
  ],
  canvas: { components: [], wires: [], grounds: [], probes: [] },
  settings: { simDt: '0.0001', simDuration: '0.004' },
};

export const EXAMPLE_PROJECTS: ExampleProject[] = [
  VOLTAGE_DIVIDER,
  RC_LOWPASS,
  RLC_TRANSIENT,
  SWITCH_SPDT,
  MCU_LEDS,
];
