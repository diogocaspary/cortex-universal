# MCP do Cortex Universal

O repositório usa o SDK TypeScript oficial do Model Context Protocol v2. API e MCP compartilham
ontologia, contratos, política, memória e coordenador de agentes; portanto um canal não contorna os
controles do outro.

## Transportes

| Transporte      | Como iniciar                   | Controle mínimo                                               |
| --------------- | ------------------------------ | ------------------------------------------------------------- |
| stdio local     | `npm run build && npm run mcp` | conta do sistema operacional, arquivos `0600`, processo local |
| Streamable HTTP | `POST /mcp`                    | bearer token, rate limit, allowlist de Host e Origin          |

Exemplo de configuração de cliente local, substituindo os caminhos absolutos:

```json
{
  "mcpServers": {
    "cortex-universal": {
      "command": "node",
      "args": ["/CAMINHO/cortex-universal/dist/mcp/stdio.js"],
      "env": {
        "CORTEX_ROOT": "/CAMINHO/cortex-universal",
        "CORTEX_DB_PATH": "/CAMINHO/cortex-universal/runtime/cortex.db"
      }
    }
  }
}
```

## Recursos

- `cortex://ontology/manifest`: catálogo autoritativo de módulos, shapes e contratos;
- `cortex://ontology/graph`: projeção somente leitura do cérebro semântico.

## Ferramentas

| Ferramenta                       | Efeito permitido                                  |
| -------------------------------- | ------------------------------------------------- |
| `cortex_manifest`                | ler inventário semântico                          |
| `cortex_explore_graph`           | ler subgrafo limitado                             |
| `cortex_reasoning_report`        | ler o relatório RDFS/OWL-RL limitado              |
| `cortex_ingest_evidence`         | indexar evidência validada e idempotente          |
| `cortex_retrieve_memory`         | consultar canais autorizados                      |
| `cortex_select_attention`        | calcular conjunto de trabalho                     |
| `cortex_evaluate_predictions`    | comparar previsão e observação                    |
| `cortex_evaluate_metacognition`  | medir calibração                                  |
| `cortex_propose_consolidation`   | gerar proposta com revisão obrigatória            |
| `cortex_evaluate_policy`         | avaliar política, sem executar a decisão          |
| `cortex_evaluate_tool_proposal`  | julgar proposta de ferramenta, sem efeito algum   |
| `cortex_start_agent_session`     | criar coordenação auditável, sem iniciar executor |
| `cortex_get_agent_session`       | ler uma sessão no escopo tenant/brain             |
| `cortex_handoff_agent`           | transferir responsabilidade com evidência         |
| `cortex_read_activity`           | ler atividade operacional no escopo               |
| `cortex_workforce_snapshot`      | ler a força de trabalho persistida no escopo      |
| `cortex_create_goal`             | criar meta ontologicamente vinculada              |
| `cortex_create_work_item`        | criar trabalho com orçamento e critérios          |
| `cortex_checkout_work_item`      | adquirir lease atômica e limitada                 |
| `cortex_transition_work_item`    | aplicar estado, evidência e revisão independente  |
| `cortex_create_routine`          | criar agenda limitada sem executar efeito         |
| `cortex_materialize_routines`    | criar tarefas vencidas de forma idempotente       |
| `cortex_record_cost`             | registrar custo medido e imutável                 |
| `cortex_record_heartbeat`        | registrar observação de agente com evidência      |
| `cortex_record_agent_evaluation` | registrar avaliação independente                  |

Não existe `execute_tool`, shell, SQL livre, SPARQL livre ou alteração do registro de ações. Rotina
materializada é somente uma tarefa persistida; heartbeat é somente uma observação comprovada. Uma
integração futura de efeitos deve usar capacidades mínimas, identidade derivada por gateway,
aprovação externa quando exigida, idempotência e verificação posterior.

## HTTP

Defina `CORTEX_API_TOKEN` com pelo menos 32 bytes. A allowlist padrão aceita somente
`localhost,127.0.0.1,[::1]`; para um proxy autorizado, configure
`CORTEX_ALLOWED_MCP_HOSTS` com hostnames, nunca curingas. Em produção, TLS e autenticação de usuário
continuam responsabilidade do gateway.
