# ADR 0007: projeções executáveis, MCP compartilhado e córtex 3D

Status: amended by 0.5.0 — 2026-08-09

## Contexto

Os contratos 0.3 descreviam memória e recuperação, mas não mantinham um índice persistente. Agentes
precisavam de um protocolo de consulta comum. O painel 2D era semanticamente exato, porém não
comunicava visualmente regiões e fluxo como o conceito de córtex solicitado.

## Decisão

1. A ontologia permanece a autoridade. Bancos, índices, sessões e layouts são projeções
   reconstruíveis.
2. O adapter local usa SQLite/FTS5, transações, hash, idempotência e filtro por tenant/classificação
   antes do ranking. Vetores são fornecidos pelo chamador e têm dimensão fixa por tenant/brain.
3. PostgreSQL/pgvector possui adapter executável, migração com RLS forçada e teste de integração
   em serviço real no CI. A qualificação da infraestrutura continua responsabilidade da implantação.
4. MCP v2 e HTTP chamam os mesmos serviços. Nenhum deles oferece executor genérico.
5. O painel mantém G6 2D e acrescenta 3D Force Graph. Os mesmos nós e relações declarados são
   agrupados por módulo. A versão 0.4.1 removeu partículas para impedir que layout fosse confundido
   com atividade observada; eventos reais aparecem apenas a partir do banco persistente.
6. Netron é a ferramenta complementar para futuros artefatos ONNX/PyTorch/TensorFlow; não será
   embutido sem um modelo real para inspecionar.

## Consequências

O computador local passa a ter memória real, busca híbrida e coordenação persistente. O custo é
assumir a superfície experimental de `node:sqlite`, WebGL e o SDK MCP, todos fixados por versão e
cobertos por testes/avisos de licença. Deploy distribuído, geração de embedding, identidade de usuário
e execução de efeitos continuam explícitos e separados.
