# ADR 0006 — ciclo cognitivo ontológico, limitado e governado

- Status: aceito
- Data: 2026-08-09

## Contexto

Memória, recuperação e lacunas já estavam representadas, mas não existia um ciclo explícito ligando percepção, atenção, recuperação, simulação, proposta, avaliação e consolidação. Isso impedia testar invariantes cognitivos e distinguir confiança de desempenho.

## Decisão

Adicionar módulos `attention`, `world-model`, `metacognition` e `learning`, conectados pelo `CognitiveCycle`. Implementar primitivas determinísticas para seleção de atenção, erro de previsão, calibração e replay. Todos os contratos mantêm tenant, cérebro, classificação, fonte/evidência e limites. Consolidação produz apenas proposta revisável.

`GlobalWorkspace` significa disponibilidade compartilhada de informação entre módulos. Não implica consciência. A trilha registra transições, referências e resultados estruturados; não exige armazenar chain-of-thought privada.

## Consequências

- O sistema pode medir atenção, previsão, confiança e aprendizagem em vez de apenas descrever esses conceitos.
- Adapters neurais, LLMs e modelos do mundo continuam substituíveis.
- A ontologia permanece a autoridade semântica; algoritmos operam sobre contratos derivados dela.
- Existem mais schemas, shapes e endpoints para manter e testar.
- Nenhum mecanismo novo autoriza ferramenta, ação externa ou promoção autônoma de memória.
