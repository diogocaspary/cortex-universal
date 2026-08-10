# Revisão técnica da versão 0.4.1

Data: 2026-08-09

> Documento histórico. Os limites de adapter, identidade, autorização e auditoria abaixo foram
> tratados na versão 0.5.0; consulte `MANUAL-COMPLETO.md` para o estado atual.

## Resultado

A ontologia continua no centro. Nenhuma decisão de armazenamento, MCP, agente ou visualização ganhou
autoridade para redefinir significado ou permissão. A versão transforma os contratos de memória em um
runtime local executável e mantém as fronteiras de efeito da 0.3.

## Entregue e verificado

- SQLite/FTS5 persistente, transacional, idempotente e com permissões locais restritas;
- hash SHA-256 do texto, proveniência, classificação, validade, citações e contradições;
- busca real keyword, cosseno vetorial e entidades do grafo, combinada por RRF;
- filtros de tenant/brain/classificação dentro de cada consulta de candidatos;
- dimensão de embedding consistente por tenant/brain;
- atividade e sessões/handoffs de agentes persistentes;
- registro confiável com quatro papéis sem executor externo;
- APIs OpenAPI para ingestão, retrieval, atividade e agentes;
- MCP v2 em stdio e Streamable HTTP com bearer, Host/Origin e ferramentas limitadas;
- G6 2D e mapa ontológico 3D agrupado por módulo, sem sinais ou dados simulados;
- atividade operacional exibida somente quando recuperada do SQLite por tenant/brain explícitos;
- perfil ontológico fictício removido do manifesto e diretório de perfis validado por allowlist;
- volume Docker persistente e caminho local `runtime/cortex.db`;
- migração PostgreSQL/pgvector com FTS, HNSW e RLS forçada;
- 23 schemas, 32 módulos, 4 agentes registrados e 71 testes automatizados.

## Limites que permanecem intencionais

- `node:sqlite` é experimental e single-node;
- migração PostgreSQL não equivale a um adapter de runtime testado;
- embedding é entrada contratada, não gerado pelo kernel;
- bearer estático não substitui identidade corporativa;
- atividade local não é log imutável/assinado;
- coordenação de agentes não inicia LLM nem ação externa;
- projeção 3D não é anatomia, consciência, atividade ou rede neural aprendida;
- não há shell, SQL/SPARQL livre, executor genérico ou autoaprovação.

## Critério de aceite

O release só é aceitável quando `npm run check`, `npm run build`, `npm audit --omit=dev` e um smoke
test da API compilada passam; artefatos locais devem ser gerados a partir do commit verificado.
