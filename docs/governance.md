# Governança e evolução

## Responsabilidades

- Steward do núcleo protege universalidade e identidade dos termos.
- Steward de módulo responde pela coerência do domínio.
- Especialista de segurança revisa shapes, ações e políticas.
- Dono do dado responde por fonte, classificação, retenção e qualidade.
- Dono da ação responde por risco, aprovação, compensação e verificação.

## Processo de mudança

Toda proposta inclui pergunta de competência, exemplos, impacto de segurança, compatibilidade e migração. Alterações no núcleo, policies, shapes e CI exigem revisão de CODEOWNERS. Não se aceita termo apenas porque apareceu em um prompt; deve haver significado estável e caso de negócio reproduzível.

## Versionamento

- patch: correção de documentação ou constraint que restaura intenção já declarada;
- minor: termo ou módulo aditivo e compatível;
- major: remoção, mudança de domínio/range ou significado incompatível.

Depreciação mantém IRI, marca substituto e suporta pelo menos um ciclo major. Dados históricos não são reescritos sem change set e proveniência.

## Gate de qualidade

Antes de merge: Turtle parseia, contratos compilam em modo estrito, fixtures positivas passam, negativas falham, política nega casos adversariais, TypeScript compila, testes passam e documentação explica migração. Uma release registra hash dos artefatos e resultados de conformance.

Mudanças cognitivas também demonstram que capacidade é limitada, IDs e ordenação são determinísticos, confiança é comparada com resultado, previsão é separada de observação, abstenção é possível e consolidação não escreve memória confiável sem revisão. Claims de equivalência humana ou consciência exigiriam evidência hoje inexistente e não são aceitos como descrição de release.
