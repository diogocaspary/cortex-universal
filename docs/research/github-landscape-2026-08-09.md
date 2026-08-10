# Pesquisa GitHub — cérebro semântico, memória e visualização

Pesquisa revisada em **2026-08-09**. Estrelas são um retrato daquele momento, não uma medida de segurança ou garantia de qualidade. Licença, aderência arquitetural, atividade, portabilidade e superfície de risco tiveram peso maior que popularidade isolada. Nenhum código dos projetos de referência foi copiado; AntV G6 entrou como dependência npm sob MIT e está identificado nos avisos de terceiros.

## Sistemas de memória e GraphRAG

| Projeto                                                     |           Estrelas observadas | Licença    | O que foi aproveitado como padrão                                                                                                                                  | O que não foi incorporado                                                            |
| ----------------------------------------------------------- | ----------------------------: | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| [GBrain](https://github.com/garrytan/gbrain)                |                        28.026 | MIT        | contrato `BrainEngine`, arquivos versionados como fonte, índices derivados, eixos brain/source, recuperação keyword+vector+graph, citações e lacunas, schema packs | PGLite/Postgres e ciclo autônomo não foram importados; consolidação exige governança |
| [Mem0](https://github.com/mem0ai/mem0)                      |                        62.853 | Apache-2.0 | camada explícita de memória de longo prazo, separar remember/recall do modelo                                                                                      | SDK/backend não foi adotado para preservar neutralidade                              |
| [LightRAG](https://github.com/HKUDS/LightRAG)               |             cerca de 35,9 mil | MIT        | recuperação local/global sobre grafo e texto                                                                                                                       | pipeline próprio e storage adapters não foram incorporados                           |
| [Microsoft GraphRAG](https://github.com/microsoft/graphrag) |             cerca de 33,7 mil | MIT        | comunidades, resumos, consultas local/global/DRIFT e atenção a responsible AI                                                                                      | custo e pipeline de extração não cabem no kernel portátil                            |
| [Graphiti](https://github.com/getzep/graphiti)              | consultado sem fixar contagem | Apache-2.0 | episódios, validade temporal, proveniência incremental e contradições                                                                                              | banco e modelo temporal concretos ficam para adapter                                 |
| [Cognee](https://github.com/topoteretes/cognee)             |             cerca de 17,5 mil | Apache-2.0 | grounding ontológico, rastreabilidade e controle de memória                                                                                                        | control plane próprio não foi adotado                                                |
| [Letta](https://github.com/letta-ai/letta)                  |               cerca de 23 mil | Apache-2.0 | memória em camadas para agentes stateful                                                                                                                           | runtime de agente não faz parte deste kernel                                         |

### Síntese arquitetural

Os projetos convergem em quatro ideias úteis: memória é um subsistema versionado, não o prompt; recuperação forte combina canais; todo resultado precisa de origem/tempo; consolidação é uma transformação que pode introduzir erro. O Cortex transforma essas ideias em ontologia, shapes e contratos independentes de fornecedor. A RRF incluída é determinística e testável, mas não substitui um índice ou reranker de produção.

## Painéis e engines de grafo

| Projeto                                                                 | Estrelas observadas | Perfil                                                           | Decisão                                                                                                                |
| ----------------------------------------------------------------------- | ------------------: | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| [Understand Anything](https://github.com/Egonex-AI/Understand-Anything) |   cerca de 78,2 mil | aplicação completa de exploração de código/conhecimento          | maior referência de UX: busca, detalhes, exploração guiada e servidor local; formato especializado não foi reutilizado |
| [AntV G6](https://github.com/antvis/G6)                                 |   cerca de 12,2 mil | engine TypeScript Canvas/SVG/WebGL, múltiplos layouts/interações | **selecionado** pela aderência, maturidade, licença MIT e versão estável 5.1.1                                         |
| [Sigma.js](https://github.com/jacomyal/sigma.js)                        |   cerca de 12,1 mil | engine WebGL eficiente para milhares de nós                      | excelente alternativa de escala; v4 ainda estava em alpha no retrato pesquisado                                        |
| [Cytoscape.js](https://github.com/cytoscape/cytoscape.js)               |   cerca de 11,1 mil | visualização e análise madura de grafos                          | alternativa forte; G6 ofereceu melhor combinação pronta de layouts e interação para este painel                        |
| [Netron](https://github.com/lutzroeder/netron)                          |   cerca de 33,3 mil | visualizador de modelos ONNX/TensorFlow/PyTorch e outros         | maior referência pesquisada para pesos/camadas; complementar, não substitui o grafo semântico                          |
| [3D Force Graph](https://github.com/vasturiano/3d-force-graph)          |          consultado | Three.js/WebGL, partículas direcionais e interação orbital       | **selecionado** para a projeção cortical 3D; versão npm 1.80.0, MIT                                                    |
| [Neuroglancer](https://github.com/google/neuroglancer)                  |          consultado | volumes, meshes e skeletons de anatomia/connectômica             | referência para dados biológicos reais; não representa ontologia empresarial                                           |
| [brainrender](https://github.com/brainglobe/brainrender)                |          consultado | atlas e cenas neuroanatômicas 3D em Python                       | referência anatômica; stack e finalidade não servem ao dashboard web portátil                                          |
| [Cosmos.gl Graph](https://github.com/cosmosgl/graph)                    |    cerca de 1,1 mil | renderização GPU para centenas de milhares de elementos          | opção futura se o snapshot deixar de caber no modo local atual                                                         |

## Critério final do painel

O repositório mais estrelado relacionado, Understand Anything, é uma aplicação opinativa para código e produz seu próprio modelo de dados. Incorporá-lo inteiro criaria acoplamento e superfície de atualização desnecessários. O Cortex adotou suas boas ideias de navegação, manteve G6 para a visão exata e incorporou 3D Force Graph como uma segunda projeção dos mesmos nós e relações declarados. A revisão 0.4.1 retirou sinais simulados. Netron continua a escolha mais popular encontrada para arquivos de modelos neurais reais. Assim, não há a falsa equivalência entre ontologia, anatomia e pesos aprendidos.

## MCP oficial

O runtime usa o [SDK TypeScript oficial do Model Context Protocol](https://github.com/modelcontextprotocol/typescript-sdk), linha v2 estável, com `@modelcontextprotocol/server`, transporte Web Standard Streamable HTTP e stdio. A implementação usa uma instância stateless por requisição HTTP. O adaptador Node opcional foi removido depois que a auditoria encontrou uma dependência transitiva vulnerável não usada. MCP não recebe autoridade adicional: as ferramentas chamam contratos e políticas já existentes e não incluem executor genérico.

## Evolução recomendada

1. Implementar primeiro um adapter embedded reconstruível para desenvolvimento e um adapter PostgreSQL/pgvector com isolamento por tenant para produção.
2. Medir recall e precisão separadamente para keyword, vector e graph; só então ajustar pesos da RRF.
3. Adicionar avaliação de respostas com cobertura de citação, atualidade, contradição e vazamento entre tenants.
4. Criar expansão de vizinhança paginada quando o grafo passar de alguns milhares de nós.
5. Manter modelo neural e grafo semântico como observabilidades complementares: Netron para computação aprendida, painel Cortex para significado e governança.
