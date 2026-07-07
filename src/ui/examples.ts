import type { ProjectData } from './types';

/**
 * Projeto de exemplo com metadados de deep link.
 *
 * `slug` é o identificador estável usado na URL (`app.html?example=<slug>`)
 * e é um contrato com a landing page — não renomeie sem atualizar os links.
 * `description` é o texto curto exibido nas listagens.
 *
 * `ExampleProject` estende `ProjectData`, então tudo que consome
 * `ProjectData` (ex.: projectManager, que usa apenas `.name` e os campos
 * padrão) continua funcionando sem alterações.
 */
export interface ExampleProject extends ProjectData {
  slug: string;
  description: string;
}

const VOLTAGE_DIVIDER: ExampleProject = {
  version: 1,
  name: 'Divisor de Tensao',
  slug: 'divisor-tensao',
  description: 'Dois resistores em serie dividindo 10 V — o circuito mais fundamental da eletronica.',
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

const RC_LOWPASS: ExampleProject = {
  version: 1,
  name: 'Filtro RC Passa-Baixa',
  slug: 'rc-lowpass',
  description: 'Degrau de 5 V carregando um capacitor atraves de um resistor — a curva exponencial classica.',
  files: [
    {
      name: 'main.js',
      content: `// Filtro RC passa-baixa de 1a ordem
//
//   5V ──[ R 1k ]──┬── Vout
//                  │
//                [ C 1u ]
//                  │
//                 GND
//
// Ao aplicar o degrau de 5 V, o capacitor carrega exponencialmente:
//   Vc(t) = 5 * (1 - e^(-t/tau)),  com tau = R*C = 1k * 1u = 1 ms.
// Apos 5*tau (5 ms), Vc ja alcancou ~99.3% do valor final.

const circuit = new Circuit();
const gnd = new Ground();

const v1 = new VoltageSource(5);     // degrau de 5 V em t = 0
const r1 = new Resistor(1000);       // 1 kOhm
const c1 = new Capacitor(0.000001);  // 1 uF

v1.pin('+').connect(r1.pin('1'));
r1.pin('2').connect(c1.pin('1'));
c1.pin('2').connect(gnd.pin('1'));
v1.pin('-').connect(gnd.pin('1'));

// Sonda de tensao no capacitor — a curva de carga aparece no grafico
circuit.probe(c1, 'voltage');

// Transiente: 5 ms de duracao com passo de 10 us
const result = circuit.analyze('transient', {
  timeStep: 0.00001,
  duration: 0.005,
});

// Confronto teoria x simulacao: ultimo ponto da sonda no capacitor
const curva = result.probes[0].values;
const vcFinal = curva[curva.length - 1];
const tau = 1000 * 0.000001; // R * C = 1 ms
console.log('Tau teorico (R*C):', (tau * 1000).toFixed(2), 'ms');
console.log('Vc apos 5*tau:', vcFinal.toFixed(3), 'V (teorico ~4.966 V)');`,
    },
  ],
  canvas: { components: [], wires: [], grounds: [], probes: [] },
  settings: { simDt: '1e-5', simDuration: '5e-3' },
};

const RLC_TRANSIENT: ExampleProject = {
  version: 1,
  name: 'RLC Transiente',
  slug: 'rlc-ressonante',
  description: 'Circuito RLC serie subamortecido — oscilacao ressonante visivel no grafico.',
  files: [
    {
      name: 'main.js',
      content: `// Circuito RLC serie — resposta ao degrau
//
//   10V ──[ R 1 ]──[ L 1m ]──┬── Vout
//                            │
//                         [ C 10u ]
//                            │
//                           GND
//
// Com R baixo o circuito e SUBAMORTECIDO: a tensao no capacitor
// oscila em torno de 10 V antes de assentar (ringing).
//
//   f0 = 1 / (2*pi*sqrt(L*C)) ≈ 1.59 kHz   (frequencia de ressonancia)
//   Q  = (1/R) * sqrt(L/C)    = 10          (fator de qualidade)
//
// Experimente aumentar R para 20 (amortecimento critico ~ 2*sqrt(L/C))
// e veja a oscilacao desaparecer.

const circuit = new Circuit();
const gnd = new Ground();

const v1 = new VoltageSource(10);   // degrau de 10 V em t = 0
const r1 = new Resistor(1);         // 1 Ohm — baixo de proposito, para oscilar
const l1 = new Inductor(0.001);     // 1 mH
const c1 = new Capacitor(0.00001);  // 10 uF

v1.pin('+').connect(r1.pin('1'));
r1.pin('2').connect(l1.pin('1'));
l1.pin('2').connect(c1.pin('1'));
c1.pin('2').connect(gnd.pin('1'));
v1.pin('-').connect(gnd.pin('1'));

// Sonda no capacitor — o ringing aparece no grafico
circuit.probe(c1, 'voltage');

// 5 ms cobre ~8 ciclos de oscilacao (T = 1/f0 ≈ 0.63 ms)
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
  name: 'Chave SPDT + 2 LEDs',
  slug: 'switch-spdt',
  description: 'Chave de 1 polo e 2 posicoes alternando a corrente entre dois LEDs.',
  files: [
    {
      name: 'main.js',
      content: `// Chave SPDT (1 polo, 2 posicoes) alternando dois LEDs
//
//          ┌─ a ──[ R 330 ]──▶|── GND    (canal A -> LED1)
//   5V ── com
//          └─ b ──[ R 330 ]──▶|── GND    (canal B -> LED2)
//
// A chave conecta 'com' ao canal A (padrao) ou ao canal B.
// So o LED do canal ativo recebe corrente: ~(5 - Vf) / 330 ≈ 9 mA.

const circuit = new Circuit();
const gnd = new Ground();

const v1 = new VoltageSource(5);
const sw = new Switch();       // posicao A por padrao (closed = false)
const ra = new Resistor(330);  // limita a corrente do LED1
const rb = new Resistor(330);  // limita a corrente do LED2
const led1 = new LED();
const led2 = new LED();

v1.pin('+').connect(sw.pin('com'));

// Canal A: com ─ a ─ R ─ LED1 ─ GND
sw.pin('a').connect(ra.pin('1'));
ra.pin('2').connect(led1.pin('anode'));
led1.pin('cathode').connect(gnd.pin('1'));

// Canal B: com ─ b ─ R ─ LED2 ─ GND
sw.pin('b').connect(rb.pin('1'));
rb.pin('2').connect(led2.pin('anode'));
led2.pin('cathode').connect(gnd.pin('1'));

v1.pin('-').connect(gnd.pin('1'));

// Sondas de corrente nos dois LEDs
circuit.probe(led1, 'current');
circuit.probe(led2, 'current');

circuit.analyze('dc');

const i1 = led1.current * 1000; // mA
const i2 = led2.current * 1000; // mA
console.log('LED1:', i1.toFixed(2), 'mA | LED2:', i2.toFixed(2), 'mA');
console.log('Aceso agora:', i1 > i2 ? 'LED1 (canal A)' : 'LED2 (canal B)');
console.log('Dica: clique na chave no canvas e rode Play para alternar.');`,
    },
  ],
  canvas: { components: [], wires: [], grounds: [], probes: [] },
  settings: { simDt: '1e-6', simDuration: '5e-3' },
};

const MCU_LEDS: ExampleProject = {
  version: 1,
  name: 'MCU + 2 LEDs',
  slug: 'mcu-leds',
  description: 'Componente customizado com defineComponent: um microcontrolador piscando dois LEDs.',
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

export const EXAMPLE_PROJECTS: ExampleProject[] = [
  VOLTAGE_DIVIDER,
  RC_LOWPASS,
  RLC_TRANSIENT,
  SWITCH_SPDT,
  MCU_LEDS,
];
