# Diagnósticos — taxonomia de códigos e formato do RunRecord

Códigos são **permanentes**: parsers e agentes podem depender deles; nunca são renumerados.
`forge explain <código>` traz a explicação longa de cada um.

## Faixas

| Faixa | Fase | Significado |
|-------|------|-------------|
| `F1xx` | lint (pré-solver) | topologia estrutural |
| `S1xx` | solver linear | sistema insolúvel |
| `S2xx` | solver não-linear | Newton-Raphson |
| `A3xx` | asserções | spec não atingido |
| `T0xx` | ferramenta | erro de autoria da bancada |

## Códigos ativos

| Código | Slug | Severidade | Quando dispara |
|--------|------|-----------|----------------|
| `F101` | floating-net | error | net sem caminho DC até o ground (isolada por capacitor/fonte de corrente) |
| `F103` | unreached-component | error | componente (ou ilha) sem conexão com o circuito aterrado — seria silenciosamente ignorado pelo solver |
| `F104` | voltage-source-short / voltage-source-loop | error | fonte ideal em curto, ou loop de fontes ideais (indutor conta como fonte 0 V em DC) |
| `F105` | source-clamped-diode | error | diodo/LED polarizado direto grampeado numa fonte ideal sem resistência em série |
| `F106` | dangling-pin | warning | pino sem nenhuma conexão |
| `S101` | unsolvable-system | error | matriz singular que o lint não modelou (raro; reportar) |
| `S201` | nr-nonconvergence | error | NR não convergiu no ponto DC — carrega componente culpado, ΔV e histórico de oscilação |
| `S202` | nr-nonconvergence | error | NR não convergiu num passo do transiente |
| `A301` | assertion-failed | fail | asserção falhou — carrega medido, esperado, margem e hint verificado quando há `tb.param` |
| `T001` | bench-error | error | a própria bancada lançou exceção na elaboração |

## Contrato de confiança dos fixes

Todo fix carrega `confidence`:

- **`verified`** — a plataforma **simulou** a correção e ela passa em todas as asserções do
  estágio. O agente deve aplicar diretamente.
- **`mechanical`** — transformação determinística (não simulada, mas sem julgamento).
- **`suggested`** — heurística; o agente deve raciocinar antes de aplicar.

Invariantes (aplicados em code review): nunca emitir fix que referencia flag/capacidade que
não existe; nunca emitir número não simulado sem rótulo `suggested`.

## Exit codes

| Código | Significado | Ação do agente |
|--------|-------------|----------------|
| `0` | todos os estágios pedidos passaram | pronto |
| `1` | asserção falhou (circuito válido) | ajustar valores (hint!) ou topologia |
| `2` | circuito inválido/insolúvel (F/S com severidade error) | consertar estrutura antes de tudo |
| `3` | erro de ferramenta (uso incorreto, bancada lançou) | consertar a bancada/invocação |

## RunRecord (`forge verify --json`)

```jsonc
{
  "runId": "cb4f1e998fc8-001",        // presente quando gravado no ledger
  "schema": "forge-run/0.1",
  "bench": "led-overcurrent",
  "engine": "circuit-forge@0.1.0",
  "netlist": {
    "hash": "cb4f1e998fc8…",          // FNV-1a 64 do netlist canônico (identidade)
    "components": [
      { "id": "D1", "type": "LED", "params": { "Is": 1e-20, "n": 2, "Vt": 0.02585 },
        "pins": { "anode": "n2", "cathode": "gnd" }, "at": "bench/….bench.ts:14" },
      { "id": "R1", "type": "Resistor", "params": { "r": 100 },
        "pins": { "1": "n1", "2": "n2" },
        "free": { "min": 100, "max": 10000, "scale": "log" } }
    ],
    "nets": { "gnd": ["D1.cathode", "V1.-"], "n1": ["R1.1", "V1.+"], "n2": ["D1.anode", "R1.2"] }
  },
  "overrides": { "R1": 280 },          // quando --set / micro-sweep
  "stages": {
    "lint": { "verdict": "pass" },
    "op": {
      "verdict": "fail",
      "probes": { "D1.i": 0.028039 },
      "solver": { "method": "newton-raphson" },
      "assertions": [{
        "id": "a1", "stage": "op", "probe": "D1.i",
        "check": { "op": "within", "min": 0.008, "max": 0.012 },
        "verdict": "fail", "measured": 0.028039,
        "margin": { "outsideBy": 0.016039, "ratio": 2.34 },
        "at": "bench/broken/led-overcurrent.bench.ts:22",
        "hint": {
          "kind": "verified-param-range", "param": "R1",
          "passingRange": [261.016, 316.228], "suggestedValue": 261.016,
          "passingSamples": [261, 316.2],
          "note": "25-point log sweep …; every listed value passes ALL op assertions (simulated)"
        }
      }]
    },
    "tran": { "verdict": "skipped", "reason": "op assertions failed" }
  },
  "diagnostics": [],                    // objetos Diagnostic (código/subject/note/fixes/at)
  "verdict": "fail",
  "firstFailure": "a1",
  "exitCode": 1
}
```

Determinismo: a saída não contém timestamps (só o ledger adiciona `at` na gravação); dois
runs idênticos produzem registros byte-idênticos — o diff entre iterações do agente fica
trivial.

## Gramática de sondas

```
'<id>.i'    corrente no componente     ex.: 'D1.i'
'<id>.v'    tensão sobre o componente  ex.: 'R1.v'
'<net>'     tensão do net nomeado via tb.name(...)   (apenas estágio op)
```

Nets automáticos (`n1`, `n2`, …) não são endereçáveis de propósito — nomeie com
`tb.name('out', pin)` para garantir estabilidade entre edições.
