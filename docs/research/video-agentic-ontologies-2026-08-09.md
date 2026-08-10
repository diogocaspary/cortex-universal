# Síntese aplicada — “Por que sistemas agênticos precisam de ontologias”

Fonte analisada: [vídeo no YouTube](https://youtu.be/Sir59K8ZDPU), apresentação de Frank Coyle,
UC Berkeley. Este arquivo é uma síntese técnica com marcação temática, não uma reprodução integral
da transcrição protegida.

## Ideias centrais aproveitadas

1. Sistemas agênticos combinam probabilidade e estrutura simbólica. O modelo pode interpretar uma
   intenção, mas tipos, relações e regras precisam existir fora da resposta probabilística.
2. A ontologia funciona como ledger semântico compartilhado: agentes diferentes usam o mesmo
   significado para entidades, ações e resultados.
3. O tipo deve ser validado na fronteira. Dado ou resultado de ferramenta não entra no estado
   confiável apenas porque um agente o produziu.
4. RDFS/OWL acrescentam inferência; SHACL aplica restrições operacionais de mundo fechado.
5. Loops de agente precisam de orçamento e condição de parada.
6. A proposta do agente deve ser separada da autorização e do efeito.

## Alterações implementadas no Cortex 0.5.0

| Aprendizado                     | Implementação                                                                  |
| ------------------------------- | ------------------------------------------------------------------------------ |
| ledger semântico                | ontologia permanece autoridade; storage é projeção                             |
| tipos na fronteira              | JSON Schema, SHACL, source registry e identidade assinada                      |
| validar resultado de ferramenta | `EffectObserver` relê sistema de registro e valida `effect-outcome`            |
| separar intenção e ação         | `ToolProposal` → `GuardDecision` → `EffectExecution` → observação              |
| orçamento de loop               | limite total e repetição por sessão, persistidos antes da decisão              |
| inferência explícita            | reasoner limitado com regra, suporte, diagnóstico e truncamento                |
| depuração                       | IDs causais, registro de operações, falha sanitizada e cadeia HMAC append-only |

## O que não foi copiado

Nenhuma demonstração, dado de negócio, framework autônomo ou executor genérico foi importado. O
projeto adotou o princípio arquitetural e o implementou nos próprios contratos versionados. O Cortex
continua sem afirmar consciência, raciocínio humano completo ou execução empresarial pronta sem
conectores reais.
