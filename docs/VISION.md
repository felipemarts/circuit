# Visão: código vira circuito, e o agente fecha o loop

> **A tese**: o que fez o "vibecoding" funcionar para software não foi o modelo — foi o
> **loop de feedback**: compilador, testes, erros estruturados, terminal. Eletrônica nunca
> teve isso. O SPICE cospe `singular matrix` sem dizer onde, por quê, nem como corrigir.
> Quem construir o loop de feedback da eletrônica define o padrão que os agentes LLM vão usar.

## Por que agora (o que a pesquisa mostra)

Uma varredura profunda do estado da arte (2024–2026) mostra a brecha com precisão:

- **tscircuit** (React→PCB, 2.3k stars): compila código para fabricação, mas a simulação é
  rasa (ngspice-WASM, sem asserções, sem pass/fail). O loop não fecha — a documentação manda
  o humano verificar manualmente.
- **atopile** (DSL .ato→KiCad, YC W24): asserções algébricas, mas **zero simulação**. Os
  próprios fundadores admitem que não escrevem mais .ato à mão — o Claude escreve.
- **JITX** (Sequoia, $12M): abandonou publicamente a própria DSL em 2025 — *"any advantage
  of a custom DSL is completely blown out of the water by modern toolchains; modern AIs are
  really good at writing Python"*.
- **Wokwi**: o único loop de agente real (CLI headless, asserções, MCP) — mas só firmware
  digital, engine fechada, nuvem paga.
- **Papers de LLM×EDA**: SPICEAssistant (Bosch) elevou a taxa de acerto de 15%→**91%** só
  com feedback de simulação; AnalogCoder provou a escada de verificação em estágios;
  AnalogAgent identificou o "context attrition" — o agente perde os detalhes dos diagnósticos
  ao longo do debug, então o histórico precisa viver **fora** do contexto. Todos os papers
  constroem harnesses PySpice descartáveis. **Ninguém empacotou a infraestrutura.**

O território não reclamado, confirmado por todas as frentes: **"vitest para circuitos"** —
compile → simule → assert → diagnóstico estruturado, local-first, sem token de nuvem.

## Os cinco contratos da plataforma

Tudo no circuit-forge deriva de cinco contratos, pensados para que um agente LLM convirja
para um circuito funcional em ≤5 iterações:

### 1. TypeScript é a fonte da verdade
Nada de DSL própria (lição JITX). O circuito é código TS com pinos nomeados
(`anode`/`cathode`, `+`/`-` — pesquisa mostra que pinos semânticos eliminam a classe de erro
mais comum dos LLMs). O canvas é uma *projeção* do código, nunca o contrário.

### 2. Todo erro tem código estável, localização e correção
Estilo rustc: `F101 net n3 has no DC path to ground` + `at bench/led.bench.ts:14` +
nota com a física + fix com **rótulo de confiança**:
- `verified` — a plataforma **simulou** a correção e ela passa. Aplique direto.
- `mechanical` — transformação determinística.
- `suggested` — heurística; raciocine antes.

Regra dura: nunca emitir um fix que referencia capacidade que não existe, nunca emitir
valor numérico não simulado como se fosse certeza.

### 3. O lint roda antes do solver
`singular matrix` **nunca** chega ao agente. A topologia é analisada como grafo antes da
matriz existir: net flutuante (F101), componente solto (F103), loop de fontes ideais (F104),
LED grampeado na fonte (F105). Cada um com nome, culpado e correção.

### 4. Exit codes que dizem qual loop você está
- `0` — passou tudo.
- `1` — asserção falhou: o circuito é válido, o spec não foi atingido → **ajuste valores**
  (use o hint verificado) ou topologia.
- `2` — circuito inválido/insolúvel → **conserte a estrutura primeiro**.
- `3` — erro de ferramenta/bancada → conserte o código da bancada.

O agente ramifica sem parsear nada.

### 5. O agente não chuta números
LLMs são bons em topologia e ruins em dimensionamento contínuo (consenso de toda a
pesquisa). `tb.param('R1', {min:'100', max:'10k', scale:'log'})` declara o parâmetro livre;
quando uma asserção falha, a plataforma varre a faixa, **simula** cada ponto e devolve a
faixa que passa — `hint (verified): R1 in [261, 316]`. Determinismo: mesma bancada, mesmos
números, sempre; saída sem timestamps para que dois runs façam diff limpo.

## A escada de verificação (o produto)

```
bench/led-driver.bench.ts
        │  elaboração (código → netlist canônico + hash)
        ▼
  L0 lint    grafo puro, sem solver      F1xx  ──┐
  L1 op      ponto de operação DC        S2xx    │ fail-fast:
             asserções + hints           A301    │ estágio falhou,
  L3 tran    transiente + medições       A301    │ próximos pulam
             (settle/ripple/overshoot)         ──┘
        ▼
  RunRecord (JSON) ── renderizador humano ── ledger (.forge/runs.jsonl)
```

Uma bancada é o artefato completo: circuito + parâmetros livres + asserções.

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

  tb.param('R1', { min: '100', max: '10k', scale: 'log' });   // sizing é da plataforma
  tb.expect.op('D1.i').toBeWithin('8m', '12m');               // spec como teste
  tb.expect.tran({ tstop: '5m', dt: '10u' })
    .probe('D1.i').toNeverExceed('25m');
});
```

```
$ forge verify bench/led-driver.bench.ts        # humano
$ forge verify bench/led-driver.bench.ts --json # agente (RunRecord completo)
$ forge verify ... --set R1=280                 # aplica hint sem editar código
$ forge log list                                # o que já foi tentado (anti context-attrition)
$ forge explain F101                            # física + correção de cada código
$ forge catalog                                 # datasheet dos componentes p/ o agente
```

## Estado atual (v0.1 — o loop existe)

- ✅ Motor MNA correto (DC + transiente Backward-Euler, Newton-Raphson) — validado contra
  soluções analíticas; 91 testes.
- ✅ DSL `bench()` com unidades (`'4.7k'`), pinos nomeados, netlist canônico com hash,
  localização fonte por componente/asserção ("sourcemaps de circuitos").
- ✅ Lint estrutural F101/F103/F104/F105/F106 antes do solver.
- ✅ Estágio DC com sondas (`D1.i`, `R1.v`, nets nomeados), asserções, hints **verificados
  por simulação** e telemetria de não-convergência (componente culpado + oscilação).
- ✅ Estágio transiente com kernel de medição (settle, neverExceed, stayAbove/Below,
  ripple, valor final) + trecho da forma de onda na primeira violação.
- ✅ CLI `forge` (verify/log/explain/catalog), exit codes 0/1/2/3, `--json`, `--set`,
  ledger JSONL.
- ✅ UI canvas existente continua funcionando (o motor é o mesmo).

## Roadmap

| Fase | Entrega | Por quê |
|------|---------|---------|
| v0.2 | Estágio L2 (sweep/curvas de transferência), `forge sweep`, `forge probe` sobre o ledger | completa a escada AnalogCoder |
| v0.3 | Relatório com orçamento de tokens (failures-only + ponteiros de drill-down), `--watch` com timeout duro de solve | iteração sub-segundo; nunca travar o tool call do agente |
| v0.4 | **Servidor MCP** (`forge mcp`): verify/sweep/probe/history/catalog/explain com o MESMO schema do CLI | o agente usa como ferramenta nativa |
| v0.5 | `forge optimize` (Nelder-Mead sobre a escada como função objetivo), gmin/source stepping no NR | agente nunca mais escolhe resistor na mão |
| v0.6 | UI = viewer do RunRecord: chips de asserção no schematic, bandas no osciloscópio, timeline do ledger | humano e agente veem o mesmo artefato |
| v0.7 | Determinismo forte (ordenação por ref na matriz), export SPICE + cross-check ngspice em CI com tabela de tolerâncias | credibilidade numérica pública |
| v0.8 | MOSFET nível 1, BJT Ebers-Moll, fontes comportamentais; macro-modelo de op-amp | destrava specs reais |
| v1.0 | **CircuitBench**: eval público de "iterações-até-verde" por modelo, tarefas com asserções ocultas; freeze do schema `forge-run/1.0` | o padrão vence porque os agentes comprovadamente convergem nele |

Regras de sequenciamento (dos juízes do painel de arquitetura): o loop de terminal fica de
pé sozinho **antes** de MCP e UI; o spec é extraído da ferramenta funcionando, nunca
publicado antes; nenhuma claim de benchmark além do que a biblioteca de componentes cobre.

## Decisões registradas

- **Sem monorepo por enquanto** — um pacote até os schemas estabilizarem (v0.7).
- **Identidade de componente por tag `kind`**, nunca `instanceof` — o CLI e a bancada podem
  carregar cópias distintas das classes (dois bundles); identidade estrutural é o contrato.
- **Determinismo v0.1 = mesma fonte, mesmos números** (JS Sets iteram em ordem de inserção).
  Hash igual ⇒ resultados idem exige o patch de ordenação por ref (v0.7); até lá a claim é
  escopada honestamente.
- **Caminho batch é o contrato do agente** — o caminho "live" da UI estica `dt` sob carga
  (dependente da máquina) e nunca deve alimentar asserções.
- **`.forge/` no `.gitignore`** — o ledger é artefato local, não fonte.
