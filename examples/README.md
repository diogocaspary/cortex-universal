# Fixtures de conformidade — nunca são dados operacionais

Os arquivos desta pasta são entradas controladas para testes automatizados de schemas, SHACL e
controles de segurança. Eles não são carregados pelo runtime, não pertencem ao manifesto ontológico,
não são indexados no SQLite e não aparecem no painel.

- `valid/` verifica que os contratos aceitam estruturas conhecidas.
- `invalid/` verifica que estruturas inseguras ou incompletas são rejeitadas.

Não copie identificadores, hashes, timestamps ou conteúdo destas fixtures para ambientes reais.
