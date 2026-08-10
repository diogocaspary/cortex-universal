# ADR 0005 — Memória governada, recuperação híbrida e painel semântico

**Status:** aceito em 2026-08-09.

## Contexto

Uma ontologia universal define significado, mas um “córtex” operacional também precisa representar memória temporal, recuperar evidência por mecanismos complementares, declarar incerteza e permitir inspeção humana. Vincular isso diretamente a um banco ou SDK tornaria o núcleo difícil de replicar. Chamar o grafo ontológico de rede neural também criaria uma afirmação tecnicamente falsa.

## Decisão

- Adicionar módulos OWL separados para memória, recuperação e cognição, mais shapes e contratos JSON estritos.
- Introduzir `BrainEngine` como fronteira contrato-primeiro, sem declarar um backend de produção implementado.
- Tratar arquivos/versionamento como fonte confiável e índices como projeções reconstruíveis.
- Fornecer Reciprocal Rank Fusion determinística e detecção explícita de lacunas como primitivas puras.
- Modelar consolidação como job governado que gera proposta com origem, nunca como mutação autônoma confiável.
- Gerar um snapshot determinístico, somente leitura, validado por schema, combinando ontologia, SHACL, ações e políticas.
- Usar AntV G6 5.1.1 como engine visual empacotado localmente; não copiar código de dashboards pesquisados.
- Documentar Netron como visualizador complementar somente quando existirem modelos neurais reais.

## Consequências

O pacote ganha uma arquitetura cognitiva portável e auditável, um painel útil offline e um ponto de integração estável. Um backend concreto ainda precisa implementar persistência, isolamento pré-busca, embeddings, grafo e operação. A visualização cresce com o snapshot atual; grafos de escala muito maior exigirão paginação/expansão por vizinhança ou renderização GPU especializada.

Dependências de visualização aumentam o artefato do navegador. O build registra avisos de terceiros, retém comentários legais e falha se encontrar licença ainda não revisada.
