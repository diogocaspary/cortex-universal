# Pesquisa: arquitetura computacional mais próxima da cognição humana

Revisão realizada em **2026-08-09**. O objetivo não é declarar consciência, senciência ou equivalência com um cérebro biológico. É identificar mecanismos computacionais testáveis que aproximem o Cortex de propriedades funcionais da cognição humana sem abandonar a ontologia, a segurança ou a auditabilidade.

## Conclusão executiva

Não existe uma teoria única e aceita de “como o pensamento humano funciona”. O ponto de maior convergência entre arquiteturas cognitivas, psicologia e neurociência computacional é uma organização em módulos interligados por ciclos:

1. percepção produz representações situadas;
2. atenção seleciona um conjunto de trabalho limitado;
3. memória episódica e semântica recuperam contexto;
4. informação selecionada fica globalmente disponível a processadores especializados;
5. um modelo do mundo prevê resultados e simula alternativas;
6. memória procedural/política propõe ação;
7. o resultado observado é comparado com a previsão;
8. metacognição mede confiança, conflito e desempenho;
9. replay e consolidação propõem aprendizado gradual.

O Cortex 0.3 implementa a estrutura semântica e primitivas determinísticas para esses passos. Ele não implementa percepção multimodal treinada, um simulador neural de larga escala, aprendizagem autônoma de pesos ou execução de ações.

## Como as fontes foram avaliadas

- **A — consenso ou evidência convergente:** múltiplas arquiteturas ou décadas de resultados comportamentais/neurocomputacionais.
- **B — evidência relevante, mas interpretação ou implementação ainda aberta:** bom fundamento para experimentar com métricas e reversibilidade.
- **C — hipótese ativa ou projeto nascente:** documentar e criar pontos de extensão, sem transformar em axioma do produto.
- Popularidade em GitHub foi usada apenas para alcance. Licença, maturidade, documentação, testes, aderência e risco tiveram mais peso que estrelas.
- Projetos foram consultados em seus repositórios e sites oficiais; artigos em editoras, DOI, PubMed, AAAI ou páginas institucionais.

## Grandes arquiteturas e projetos

| Projeto                                                                                               | Contribuição relevante                                                                                                                        | Evidência/maturidade                                                     | Aplicação no Cortex                                                                           |
| ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| [Common Model of Cognition](https://ojs.aaai.org/aimagazine/index.php/aimagazine/article/view/2744/0) | consenso extraído de ACT-R, Soar e Sigma: percepção/ação, memória de trabalho global, memória declarativa e procedural, ciclos e aprendizagem | A como mapa arquitetural; não é uma implementação                        | ciclo cognitivo explícito e módulos especializados conectados por contratos                   |
| [ACT-R](https://act-r.psy.cmu.edu/)                                                                   | buffers limitados, memória declarativa, produções, ativação e tempos comparáveis aos humanos                                                  | A para modelagem cognitiva em tarefas delimitadas                        | conjunto de trabalho limitado, separação declarativa/procedural e seleção determinística      |
| [Soar](https://soar.eecs.umich.edu/)                                                                  | memória episódica/semântica, regras, impasses, chunking e reinforcement learning                                                              | A/B, arquitetura madura                                                  | lacunas provocam busca/abstenção; resultados podem virar propostas de consolidação            |
| [Rosie/Soar](https://soar.eecs.umich.edu/rosie/)                                                      | aprendizagem interativa situada; detecta conhecimento ausente e busca instrução                                                               | B, demonstrado em tarefas estruturadas                                   | lacuna explícita, entrada de evidência e nunca completar conhecimento ausente por invenção    |
| [Nengo/Spaun](https://www.nengo.ai/nengo-spa/v1.1.1/user-guide/spa-intro.html)                        | modelo funcional com neurônios pulsantes, controle, memória, visão e ação                                                                     | B; aproxima mecanismo neural e comportamento, mas não é cérebro completo | preserva uma fronteira futura para adapters neurais; não embute simulador no kernel semântico |
| [OpenCog Hyperon](https://github.com/trueagi-io/hyperon-experimental)                                 | metagrafo, reescrita, linguagem MeTTa e composição neuro-simbólica                                                                            | C; repositório declara estado pre-alpha                                  | grafo semântico extensível, inferências versionadas; não importar runtime imaturo             |
| [BrainCog](https://github.com/BrainCog-X/Brain-Cog)                                                   | plataforma de redes neurais pulsantes e algoritmos inspirados no cérebro                                                                      | B/C para pesquisa                                                        | possível adapter experimental, separado da autoridade ontológica                              |
| [Thousand Brains/Monty](https://arxiv.org/abs/2507.04494)                                             | aprendizagem sensório-motora modular, modelos por referência e votação                                                                        | C; teoria/projeto jovem                                                  | `WorldState`, cenários e futura fusão de hipóteses; nenhum axioma cortical rígido             |
| [Differentiable Neural Computer](https://www.nature.com/articles/nature20101)                         | rede neural com memória externa endereçável para estruturas e grafos                                                                          | B                                                                        | memória externa explícita e independente do LLM, sem copiar arquitetura neural específica     |
| [MuZero](https://www.nature.com/articles/s41586-020-03051-4)                                          | aprende somente aspectos do ambiente úteis para planejar                                                                                      | B em domínios com recompensa definida                                    | contrato de transição, previsão e simulação contrafactual                                     |
| [DreamerV3](https://www.nature.com/articles/s41586-025-08744-2)                                       | aprende comportamentos simulando futuros em um world model                                                                                    | B para agentes em ambientes observáveis                                  | cenário contrafactual auditável antes de proposta de ação                                     |
| [GBrain](https://github.com/garrytan/gbrain) e sistemas GraphRAG                                      | memória versionada, busca híbrida, citação, lacuna e visualização                                                                             | engenharia aplicada                                                      | continua sendo base para memória/recuperação; agora alimenta o ciclo cognitivo                |

### O que converge entre ACT-R, Soar e o Common Model

O artigo do Common Model descreve um consenso estrutural, não a descoberta final da mente. Os pontos úteis são:

- módulos perceptuais e motores especializados;
- memória de trabalho com conteúdo globalmente disponível;
- memória declarativa de longo prazo;
- memória procedural que seleciona operações;
- processamento em ciclos;
- aprendizagem em todos os tipos de memória.

O [artigo integrado de ACT-R](https://pubmed.ncbi.nlm.nih.gov/15482072/) acrescenta que módulos operam por buffers e que parâmetros subsimbólicos ajudam a reproduzir latência e erro humanos. O Cortex adota a separação e o ciclo, mas não finge reproduzir tempos cerebrais sem experimentos.

## Evidência científica que orientou a mudança

### 1. Memória de trabalho multicomponente e limitada — grau A

A revisão de [Baddeley](https://doi.org/10.1146/annurev-psych-120710-100422) sustenta uma memória de trabalho composta, usada para manter e manipular informação temporária. A capacidade varia com tarefa, estratégia e modalidade; por isso o Cortex usa capacidade configurável e limitada, sem canonizar “7 ± 2”.

**Decisão:** `attention:WorkingSet`, seleção ordenada e capacidade de 1 a 100 no contrato de referência.

### 2. Sistemas complementares de aprendizagem — grau A/B

O [Complementary Learning Systems atualizado](https://pubmed.ncbi.nlm.nih.gov/27315762/) distingue aprendizagem episódica rápida de aquisição lenta de estrutura estatística, com replay influenciado por objetivos. Modelos de [múltiplas escalas de consolidação](https://www.nature.com/articles/nn.4401) reforçam que alterações rápidas precisam ser estabilizadas gradualmente.

**Decisão:** episódio não vira verdade semântica diretamente. `ReplayBatch` produz `ConsolidationProposal`, sempre `review_required`, com zero escritas executadas pelo algoritmo.

### 3. Acesso global por processamento recorrente — grau B

A [Global Neuronal Workspace](https://pubmed.ncbi.nlm.nih.gov/21521609/) propõe que certos conteúdos sejam amplificados e disponibilizados globalmente por conexões recorrentes de longa distância. Isso é uma teoria de acesso consciente, não prova de que um software com broadcast é consciente.

**Decisão:** `GlobalWorkspace` e `WorkspaceBroadcast` modelam disponibilidade de informação entre módulos. A documentação proíbe inferir consciência desse mecanismo.

### 4. Previsão e erro de previsão — grau B

O [princípio de livre energia/predictive coding](https://www.nature.com/articles/nrn2787) oferece uma formulação influente para percepção, aprendizagem e ação, mas sua abrangência e correspondência neural são debatidas. Expectativa e atenção também são conceitos diferentes: probabilidade prevista não é igual a relevância para o objetivo.

**Decisão:** o Cortex implementa previsão falsificável, observação e erro normalizado como primitivas operacionais. Não adota a livre energia como verdade universal e mantém relevância, novidade, urgência e incerteza separadas.

### 5. Metacognição e calibração — grau A/B

[Fleming e Lau](https://www.frontiersin.org/journals/human-neuroscience/articles/10.3389/fnhum.2014.00443/full) mostram que viés de confiança, sensibilidade e eficiência metacognitiva precisam ser separados. Confiança média elevada não demonstra bom conhecimento.

**Decisão:** medir acurácia, confiança média, viés, Brier score e Expected Calibration Error. Alta confiança errada é penalizada; decisão de alto risco ou grande conflito recomenda processamento deliberativo ou abstenção.

### 6. Modelo do mundo e simulação — grau B

MuZero e Dreamer demonstram planejamento com modelos aprendidos em ambientes bem definidos. Evidência comportamental também mostra que humanos podem usar controle model-based quando têm um modelo adequado da tarefa.

**Decisão:** `WorldState`, `TransitionModel`, `Prediction`, `Observation`, `PredictionError` e `CounterfactualScenario`. O modelo é versionado e sua saída é hipótese, não fato.

### 7. Corporeidade e aprendizagem sensório-motora — grau B/C

O Common Model inclui percepção/ação; Monty enfatiza movimentos e múltiplos módulos que aprendem modelos de objetos. Isso é relevante para robótica, mas um córtex empresarial pode receber percepções de APIs, documentos e eventos em vez de sensores físicos.

**Decisão:** preservar interfaces de percepção/ação e estados do mundo, sem obrigar uma anatomia biológica ou um robô.

## Material audiovisual oficial consultado

Os catálogos, descrições, demonstrações e gravações oficiais abaixo foram usados para conferir como os projetos apresentam seus mecanismos. Nem toda palestra de cada catálogo foi assistida integralmente; vídeos promocionais não foram tratados como evidência científica.

- [ACT-R Workshops](https://act-r.psy.cmu.edu/workshops/): sessões sobre memória, arquitetura, modelos híbridos e futuro do ecossistema, com vídeos e transcrições quando disponíveis.
- [Rosie Videos](https://soar.eecs.umich.edu/rosie/): demonstrações de aprendizagem por instrução, puzzles e tarefas robóticas.
- [40th Soar Workshop](https://soar.eecs.umich.edu/workshops/40/): introdução à arquitetura, causalidade, atenção, eventos, linguagem e aprendizagem.
- [Nengo Videos](https://www.nengo.ai/videos/) e [introdução à Semantic Pointer Architecture](https://www.nengo.ai/nengo-spa/v1.1.1/user-guide/spa-intro.html): modelos neurais funcionais e exemplos de Spaun.
- [Thousand Brains Project overview](https://youtu.be/tbqZHVlK4sE), ligado pela [página oficial da Numenta](https://www.numenta.com/press/2024/11/20/thousand-brains-project/).
- [OpenCog Hyperon](https://hyperon.opencog.org/): apresentações e discussões oficiais sobre MeTTa e metagrafos; claims de AGI foram tratados como visão do projeto, não resultado estabelecido.

## Alterações implementadas no Cortex 0.3

| Lacuna anterior                               | Implementação 0.3                                  | Controle de segurança                                                  |
| --------------------------------------------- | -------------------------------------------------- | ---------------------------------------------------------------------- |
| memória existia, mas não havia ciclo formal   | `CognitiveCycle`, passos e transições verificáveis | registra apenas estados/evidências; não expõe chain-of-thought privada |
| atenção era apenas contexto                   | seleção multissinal e `WorkingSet` limitado        | limites, proveniência, classificação e desempate determinístico        |
| não havia broadcast entre módulos             | `GlobalWorkspace` e `WorkspaceBroadcast`           | mecanismo informacional; nenhum claim de consciência                   |
| hipóteses não fechavam o loop com observação  | `Prediction`, `Observation` e `PredictionError`    | escala, tempo e evidência validados                                    |
| confiança era um número isolado               | calibração por Brier, ECE, viés e acurácia         | não deixa autoconfiança substituir evidência                           |
| consolidação não tinha política computacional | replay ranqueado e proposta revisável              | `writes_performed: 0`, revisão obrigatória                             |
| decisão rápida/demorada era implícita         | gate conservador de risco/incerteza/conflito/erro  | heurística testável; alto risco não autoriza ação                      |

## O que deliberadamente não foi implementado

1. **Consciência, sentimentos ou identidade própria.** Não há teste aceito que autorize esse claim.
2. **Chain-of-thought persistida.** O ciclo guarda entradas, saídas, evidências, método e decisões estruturadas, não monólogo interno sensível.
3. **Livre energia como lei do sistema.** Erro de previsão é útil sem impor a teoria completa.
4. **Anatomia cortical rígida.** Negócios e modalidades diferentes precisam de módulos substituíveis.
5. **Aprendizagem autônoma em produção.** Replay gera proposta; promoção exige validação, política e, quando necessário, aprovação humana.
6. **Dependência direta de Hyperon, BrainCog, Nengo ou Monty.** São referências/adapters potenciais, não autoridades da ontologia.
7. **“Personalidade humana” como objetivo técnico.** Imitar estilo conversacional não equivale a raciocínio ou compreensão.

## Como medir se realmente melhorou

A proximidade funcional precisa ser avaliada por comportamento, não por nomes anatômicos:

- cobertura de evidência e taxa de citação correta;
- recuperação episódica temporal e recuperação semântica factual;
- taxa de contradições detectadas;
- Brier score e ECE por domínio, risco e horizonte temporal;
- precisão de previsão e qualidade de contrafactuais;
- taxa de abstenção correta em conhecimento ausente;
- transferência para tarefas novas sem destruir desempenho antigo;
- vazamento entre tenants igual a zero;
- nenhuma escrita consolidada sem decisão de política e trilha de auditoria;
- comparação controlada com baseline sem ciclo cognitivo.

## Próximas experiências recomendadas

1. Adapter episódico temporal e adapter semântico separados, ambos reconstruíveis.
2. Benchmark público com tarefas sequenciais, mudanças de regra e contradições.
3. Replay offline com conjunto de aprovação e medição de esquecimento catastrófico.
4. World model específico por domínio, com versão, validade e score de calibração.
5. Percepção multimodal plugável, mantendo observação bruta separada da interpretação.
6. Avaliação adversarial de falsa memória, excesso de confiança e injeção indireta.
7. Só depois, experimento opcional com arquitetura neural/spiking ou sensorimotora.
