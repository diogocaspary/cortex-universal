# Integridade dos dados exibidos

## Regra operacional

O Cortex não cria atividade de demonstração, não simula sinais e não apresenta inferências visuais
como fatos. Há três fontes exibíveis e elas permanecem separadas:

1. **Estrutura declarada:** o mapa 2D/3D é uma projeção determinística dos arquivos registrados no
   manifesto — RDF/OWL, SHACL, ações e políticas. Posição, cor e agrupamento são apenas layout; não
   representam anatomia, intensidade, ativação, peso aprendido ou consciência.
2. **Atividade persistida:** a lista de atividade consulta `/v1/brain/activity` com `tenant_id` e
   `brain_id` explícitos. Cada item vem da tabela `brain_activity` do engine local e inclui sequência,
   horário, tipo, status, sujeito e resumo gravados.
3. **Operação da força de trabalho:** a rede operacional consulta `/v1/workforce/snapshot` no mesmo
   escopo. Metas, trabalhos, rotinas, heartbeats e avaliações vêm de `workforce_records`; custos vêm
   de eventos append-only. Configurar um agente ou heartbeat não cria execução, liveness ou custo.

O painel inicia sem tenant, cérebro ou eventos predefinidos. Escopo inexistente retorna uma lista
vazia. A interface não preenche a ausência com exemplos.

## Dados de teste

`examples/` contém somente fixtures de conformidade usadas pelo conjunto automatizado de testes.
Elas não são dados do negócio, não fazem parte do manifesto, não são ingeridas pelo engine e não são
servidas pelo painel. A validação do repositório impede que um perfil ontológico não declarado seja
ativado silenciosamente.

## Invariantes verificadas

- o manifesto não declara perfis fictícios;
- todos os arquivos em `ontology/profiles/` precisam estar explicitamente declarados;
- o snapshot não contém o antigo namespace de exemplo;
- o HTML distribuído não oferece simulação de pulsos;
- atividade requer autenticação e escopo explícito;
- heartbeat exige horário, agente, estado coerente e URI de evidência; `working` exige lease ativa;
- custo estimado e custo futuro são rejeitados; tokens em cache não podem exceder tokens de entrada;
- agregados numéricos falham fechados se excederem a faixa inteira exata do runtime;
- o runtime não possui rotina de seed ou fallback de demonstração.
