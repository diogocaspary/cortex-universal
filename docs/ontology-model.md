# Modelo ontológico

## Duas camadas de semântica

A TBox (ontologia) define classes, propriedades e hierarquia. A ABox (dados) contém instâncias operacionais. O repositório versiona a TBox e exemplos; dados reais ficam fora do Git. OWL usa a premissa de mundo aberto: ausência de um fato não significa que ele é falso. SHACL cria o contrato operacional fechado onde completude é obrigatória.

## Regras de identidade

- Cada conceito público recebe IRI permanente.
- Rótulos podem mudar; o significado de uma IRI não pode ser trocado.
- Termos removidos são depreciados, não reutilizados.
- IDs externos são literais ou mapeamentos, não a identidade canônica por si só.
- Forks compatíveis preservam IRIs do núcleo e criam namespace próprio para extensões.

## Padrões centrais

### Entidade e contexto

`Entity` é a raiz de identidade. `Context`, `Role`, `State` e relações reificadas permitem dizer não apenas que A se relaciona a B, mas em qual papel, tenant, período e fonte.

### Claim com proveniência

Use uma claim quando duas fontes podem discordar, quando há confiança ou quando o fato expira. O shape exige tenant, assunto, fonte, instante observado, início de validade, estado de verificação e classificação. Evidência suporta a claim; não é automaticamente a claim.

### Temporalidade

`occurredAt` é quando o evento aconteceu. `observedAt` é quando o sistema o recebeu. `validFrom`/`validUntil` delimitam validade do conhecimento. Essa separação permite dados atrasados, correções e reconstrução histórica.

### Relações com atributos

Uma tripla simples é adequada para relações permanentes sem metadados. Para emprego, participação, consentimento ou vínculo contratual, crie uma entidade de relação com agente, papel, contexto, período e proveniência.

### Classificação e tenant

Todo dado operacional sensível deve carregar tenant e classificação. Não dependa apenas de filtros na aplicação: banco de grafo, índice vetorial, cache, logs e backups repetem a mesma fronteira.

### Artefatos cognitivos também são dados governados

Seleções de atenção, previsões, observações, erros, julgamentos de confiança, passos cognitivos e propostas de consolidação possuem IRI, tenant, classificação, tempo e evidência. Eles não são uma camada informal acima da ontologia. O algoritmo pode calcular um score, mas seu significado e seus limites vêm dos termos OWL, shapes SHACL e contratos JSON.

`GlobalWorkspace` significa que uma representação selecionada fica disponível a vários módulos. Não significa consciência. `CounterfactualScenario` é hipótese simulada, não evento observado. `ConsolidationProposal` é candidata a aprendizado, não memória promovida.

## Núcleo, módulo, perfil e extensão

- **Núcleo:** primitivas intersetoriais, ciclo de mudança lento.
- **Módulo:** domínio reutilizável como finance ou process.
- **Perfil:** seleção e restrições para um tipo de negócio.
- **Extensão de tenant:** termos realmente particulares, em namespace próprio.

Antes de adicionar um termo, escreva uma pergunta que ele precisa responder. Exemplo: “Qual evidência sustenta o estágio atual deste cliente e até quando ela é válida?” Depois modele a menor estrutura capaz de responder, adicione exemplos positivos/negativos e SHACL.

## Exemplo de extensão

```turtle
@prefix cubo: <https://github.com/diogocaspary/cortex-universal/ontology/core#> .
@prefix offering: <https://github.com/diogocaspary/cortex-universal/ontology/offering#> .
@prefix my: <https://example.com/ontology/my-business#> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .

my:ManagedService a owl:Class ;
  rdfs:subClassOf offering:Service ;
  rdfs:label "Managed service"@en .

my:requiresOnCallPolicy a owl:ObjectProperty ;
  rdfs:domain my:ManagedService ;
  rdfs:range cubo:Policy .
```

Não copie classes do núcleo para o namespace local. Importe e especialize. Veja as [perguntas de competência](competency-questions.md) e a [governança](governance.md).
