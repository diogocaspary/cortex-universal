# Revisão da evolução cognitiva 0.3

Data: **2026-08-09**

## Resultado

A ontologia permanece como plano semântico e passou a governar também atenção, modelo do mundo, metacognição, ciclo cognitivo e aprendizagem. Algoritmos TypeScript calculam resultados derivados, mas não definem significado, concedem autorização, executam ferramentas ou escrevem memória confiável.

## Escopo entregue

- 32 módulos ontológicos, incluindo `attention`, `world-model`, `metacognition` e `learning`;
- 6 conjuntos SHACL, com shapes cognitivos;
- 19 contratos JSON Schema estritos;
- ciclo `perceive → attend → retrieve → broadcast → simulate → propose_action → evaluate → propose_consolidation` com abstenção;
- seleção de atenção com capacidade configurável e desempate determinístico;
- avaliação normalizada de previsão contra observação;
- Brier score, Expected Calibration Error, viés, acurácia e confiança média;
- gate rápido/deliberativo baseado em risco, incerteza, conflito e erro;
- replay ranqueado que retorna `review_required` e `writes_performed: 0`;
- cinco endpoints cognitivos autenticados e sem efeitos externos;
- pesquisa científica com distinção entre consenso, evidência promissora e hipótese.

## Verificações executadas

- Prettier: aprovado;
- TypeScript estrito: aprovado;
- Vitest: **67/67 testes aprovados**;
- RDF/Turtle: **42 arquivos analisados** após a remoção do perfil fictício na versão 0.4.1;
- JSON Schema: **19 schemas compilados**;
- manifesto: **32 módulos e 6 shapes**;
- build servidor e dashboard: aprovado;
- `npm audit`: **0 vulnerabilidades conhecidas**;
- smoke test real: todos os endpoints cognitivos retornaram HTTP 200 para entradas válidas;
- grafo real: **749 nós, 1.686 relações e 36 agrupamentos projetados**;
- metacognição adversarial: confiança 0,9 em resultado falso gerou Brier 0,81;
- previsão adversarial: erro 0,6 ultrapassou limiar e recomendou deliberação;
- consolidação: zero escritas e revisão obrigatória confirmadas.

## Limites honestos

Esta versão melhora a semelhança **funcional** com processos cognitivos estudados. Não demonstra pensamento humano, consciência, compreensão, emoção ou equivalência neural. Não há ainda banco persistente, percepção multimodal, execução de ferramentas, world model treinado, aprendizagem online ou avaliação comportamental longitudinal. Esses itens permanecem integrações/experimentos futuros.
