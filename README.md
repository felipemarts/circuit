# Circuit Forge

Forje circuitos eletrônicos com código — editor visual e simulador no navegador.

## Visão geral

Circuit Forge é um simulador de circuitos **baseado em código**: você programa seus componentes e circuitos via uma API TypeScript simples (`defineComponent`) — ideal para gerar circuitos com ajuda de AI — e visualiza o resultado em um editor de esquemáticos com canvas, probes e osciloscópio. O motor numérico usa Modified Nodal Analysis + Newton-Raphson e roda 100% no navegador, sem backend.

## Funcionalidades

**Editor visual**
- Canvas com pan, zoom, grid e drag-and-drop
- Rotação de componentes (0°, 90°, 180°, 270°)
- Roteamento automático de fios com A* (desvia de obstáculos)
- Ground colocado como símbolo explícito ligado por fios

**Componentes integrados**
- Resistor, Capacitor, Inductor
- VoltageSource (DC e AC), CurrentSource
- Diode, LED (modelos não-lineares)

**Simulação**
- Análise DC: Modified Nodal Analysis com solver LU
- Análise transiente: passo no tempo com Euler implícito
- Newton-Raphson para componentes não-lineares (diodo, LED)
- Probes de tensão/corrente com cores configuráveis
- Overlay de osciloscópio com estatísticas (max, min, RMS, frequência)
- Gráficos de formas de onda do resultado transiente

**Componentes customizados**
- Editor de código multi-arquivo com syntax highlighting e numeração de linhas
- API `defineComponent({ pins, params, stamp, onStep, ... })` para definir componentes via código
- Suporte a estado interno (capacitância, indutância, etc.) e flag `nonlinear`

**Gerenciamento de projetos**
- Salvar / abrir / renomear / excluir projetos em `localStorage`
- Auto-save em alterações
- Exportar e importar circuitos como JSON

## `forge` — o loop de verificação para agentes (e humanos)

O circuit-forge está evoluindo para **a plataforma onde código vira circuito e um agente
LLM itera até funcionar** — compile → simule → assert → diagnóstico estruturado, como o
loop de um compilador moderno. A visão completa está em [docs/VISION.md](docs/VISION.md);
a taxonomia de erros em [docs/DIAGNOSTICS.md](docs/DIAGNOSTICS.md).

Uma *bancada* (`.bench.ts`) descreve circuito + spec:

```ts
import { bench, VoltageSource, Resistor, LED } from 'circuit-forge';

export default bench('led-driver', (tb) => {
  const v1 = tb.add('V1', new VoltageSource(5));
  const r1 = tb.add('R1', new Resistor('330'));
  const d1 = tb.add('D1', new LED());
  v1.pin('+').connect(r1.pin('1'));
  r1.pin('2').connect(d1.pin('anode'));
  d1.pin('cathode').connect(tb.gnd);
  v1.pin('-').connect(tb.gnd);

  tb.param('R1', { min: '100', max: '10k', scale: 'log' }); // sizing é da plataforma
  tb.expect.op('D1.i').toBeWithin('8m', '12m');             // spec como teste
});
```

```bash
npm run forge -- verify bench/led-driver.bench.ts          # humano
npm run forge -- verify bench/led-driver.bench.ts --json   # agente (RunRecord completo)
npm run forge -- explain F101                              # física + correção de cada erro
npm run forge -- catalog                                   # "datasheet" dos componentes
npm run forge -- log list                                  # histórico de runs (.forge/)
```

- **Erros com código estável, localização no código-fonte e correção** — `F105 D1 is
  forward-clamped directly across V1 … at bench/led.bench.ts:10`, detectado por lint de
  grafo **antes** do solver rodar.
- **Hints verificados por simulação** — em falha de asserção com `tb.param`, a plataforma
  varre a faixa e devolve `hint (verified): R1 in [261, 316]`; aplique com `--set R1=280`.
- **Exit codes com semântica** — `0` passou · `1` spec não atingido (ajuste valores) ·
  `2` circuito inválido (conserte topologia) · `3` erro de bancada.
- Exemplos em [bench/](bench/) — incluindo quebrados de propósito em
  [bench/broken/](bench/broken/) para ver cada diagnóstico em ação.

## Stack

- TypeScript 5.4 (strict mode)
- Vite 6 (dev server e build)
- Vitest 2 (testes)
- Canvas 2D API (sem framework de UI, sem dependências de runtime)
- Sem backend — persistência via `localStorage`

## Como rodar

Pré-requisito: Node.js LTS.

```bash
npm install
npm run dev          # http://localhost:5173
npm run build        # bundle de produção em dist/
npm test             # roda os testes uma vez (Vitest)
npm run test:watch   # modo watch
```

## Estrutura do projeto

```
src/
├── core/         # Abstrações: Circuit, Component, Pin, Node, CustomComponent
├── components/   # Componentes built-in (Resistor, Capacitor, Inductor,
│                 #   VoltageSource, CurrentSource, Diode, LED)
├── analysis/     # DCAnalysis e TransientAnalysis
├── solver/       # MNAMatrix, LUSolver, NewtonRaphson
├── ui/           # main, renderer, codeEditor, projectManager,
│                 #   projectStore, chartRenderer, scopeOverlay, examples
└── index.ts      # ponto de entrada da biblioteca

tests/
├── core/         # testes unitários de Pin e Node
├── solver/       # testes da matriz MNA e LU
└── integration/  # circuitos ponta-a-ponta:
                  #   voltage-divider, diode, led, custom-component
```

Arquivos de referência:
- [src/core/Circuit.ts](src/core/Circuit.ts) — orquestração da análise
- [src/analysis/DCAnalysis.ts](src/analysis/DCAnalysis.ts) — ponto de operação DC
- [src/analysis/TransientAnalysis.ts](src/analysis/TransientAnalysis.ts) — análise no domínio do tempo
- [src/solver/MNAMatrix.ts](src/solver/MNAMatrix.ts) — montagem da matriz `Ax = b`
- [src/solver/NewtonRaphson.ts](src/solver/NewtonRaphson.ts) — solver iterativo para não-lineares
- [src/core/CustomComponent.ts](src/core/CustomComponent.ts) — API de extensibilidade
- [src/ui/main.ts](src/ui/main.ts) — estado da aplicação e laço de eventos
- [src/ui/renderer.ts](src/ui/renderer.ts) — desenho do canvas e roteamento A*

## Como funciona a simulação

A `MNAMatrix` monta o sistema linear `Ax = b` a partir das contribuições (`stamp`) de cada componente. Para circuitos lineares, o `LUSolver` resolve o sistema diretamente. Para componentes não-lineares (diodo, LED), o `NewtonRaphson` reconstrói e resolve o sistema iterativamente até convergir. A análise transiente parte do ponto de operação DC e avança no tempo em passos `dt`, atualizando o estado de capacitores e indutores a cada iteração.

## Componentes customizados

Componentes são definidos pela interface `ComponentDef` em [src/core/CustomComponent.ts](src/core/CustomComponent.ts):

```ts
import { defineComponent } from './core/CustomComponent';

const MyResistor = defineComponent({
  name: 'MyResistor',
  pins: ['a', 'b'],
  params: { R: { default: 1000, unit: 'Ω' } },
  stamp(ctx) {
    ctx.stampResistance('a', 'b', ctx.params.R);
  },
});
```

O contexto (`StampContext`) expõe helpers para condutâncias, fontes de tensão/corrente, leitura de tensões e acesso direto à matriz para casos avançados. Componentes não-lineares marcam `nonlinear: true` e usam `voltage(pin)` dentro do `stamp` para linearizar o ponto de operação.

## Testes

Configuração em [vitest.config.ts](vitest.config.ts). A suíte cobre:
- Núcleo: pinos e nós ([tests/core/](tests/core/))
- Solver: matriz MNA e decomposição LU ([tests/solver/](tests/solver/))
- Integração: divisor de tensão, diodo, LED e componente customizado ([tests/integration/](tests/integration/))

```bash
npm test
```

## Status e limitações

- Apenas análises DC e transiente — sem AC / domínio da frequência, sem sweep paramétrico
- Sem importação ou exportação de netlists SPICE
- Componentes customizados são criados apenas via código (não há biblioteca visual ainda)
- Otimizado para desktop; sem versão mobile dedicada
