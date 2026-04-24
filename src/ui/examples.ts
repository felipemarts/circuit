import type { ProjectData } from './types';

const VOLTAGE_DIVIDER: ProjectData = {
  version: 1,
  name: 'Divisor de Tensao',
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
console.log('Corrente:', (r1.current * 1000).toFixed(3), 'mA');`,
    },
  ],
  canvas: { components: [], wires: [], grounds: [], probes: [] },
  settings: { simDt: '1e-6', simDuration: '5e-3' },
};

const MCU_LEDS: ProjectData = {
  version: 1,
  name: 'MCU + 2 LEDs',
  files: [
    {
      name: 'components.js',
      content: `// Microcontrolador customizado com 2 GPIOs
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
    // Programa: alterna LEDs a cada 1ms
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

// Conectar MCU ground
mcu.pin('gnd').connect(gnd.pin('1'));

// GPIO0 -> R1 -> LED1 -> GND
mcu.pin('gpio0').connect(r1.pin('1'));
r1.pin('2').connect(led1.pin('anode'));
led1.pin('cathode').connect(gnd.pin('1'));

// GPIO1 -> R2 -> LED2 -> GND
mcu.pin('gpio1').connect(r2.pin('1'));
r2.pin('2').connect(led2.pin('anode'));
led2.pin('cathode').connect(gnd.pin('1'));

// Probes nos LEDs
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

const RLC_TRANSIENT: ProjectData = {
  version: 1,
  name: 'RLC Transiente',
  files: [
    {
      name: 'main.js',
      content: `const circuit = new Circuit();
const gnd = new Ground();

const v1 = new VoltageSource(10);
const r1 = new Resistor(1);
const l1 = new Inductor(0.001);
const c1 = new Capacitor(0.00001);

v1.pin('+').connect(r1.pin('1'));
r1.pin('2').connect(l1.pin('1'));
l1.pin('2').connect(c1.pin('1'));
c1.pin('2').connect(gnd.pin('1'));
v1.pin('-').connect(gnd.pin('1'));

circuit.probe(c1, 'voltage');

circuit.analyze('transient', {
  timeStep: 1e-6,
  duration: 5e-3,
});`,
    },
  ],
  canvas: { components: [], wires: [], grounds: [], probes: [] },
  settings: { simDt: '1e-6', simDuration: '5e-3' },
};

export const EXAMPLE_PROJECTS: ProjectData[] = [
  VOLTAGE_DIVIDER,
  MCU_LEDS,
  RLC_TRANSIENT,
];
