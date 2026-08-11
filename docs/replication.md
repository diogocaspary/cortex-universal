# Guia de replicação

## Escolha de compatibilidade

Para interoperar com o Cortex Universal, preserve as IRIs do núcleo e crie termos próprios em outro namespace. Só renomeie todas as IRIs ao criar uma ontologia incompatível; uma troca textual parcial quebra dados e shapes.

## Criar um perfil de negócio

1. Liste de 10 a 30 perguntas de competência reais.
2. Selecione módulos existentes que respondem a essas perguntas.
3. Crie `ontology/profiles/<perfil>.ttl` importando os módulos.
4. Adicione termos exclusivos em namespace controlado pela organização.
5. Crie SHACL para obrigatoriedade operacional.
6. Adicione fixtures válidas e inválidas.
7. Acrescente ações com risco, precondições, permissões e verificação.
8. Acrescente regras explícitas; mantenha `default_effect: deny`.
9. Rode `npm run check` e revisão humana de domínio e segurança.

## Desenvolvimento local

```bash
npm ci
npm run check
cp .env.example .env
npm run dev
```

No Windows, a rota recomendada é extrair o pacote e executar `INSTALAR-NO-WINDOWS.cmd`. Docker Desktop é usado quando estiver ativo; Node.js 22.16+ com `node:sqlite` é o fallback. O instalador não baixa programas, não exige credencial em texto e mantém o bind em loopback.

O painel fica em `http://127.0.0.1:8080/dashboard/`. Selecione o `.env` local para autenticar sem copiar a chave para URL, cookie ou armazenamento do navegador.

O token deve ter no mínimo 32 bytes aleatórios. Em desenvolvimento, a API pode iniciar sem token e deve permanecer ligada apenas a loopback. Não use esse modo em rede compartilhada.

## Container endurecido

```bash
export CORTEX_API_TOKEN="$(openssl rand -base64 48)"
docker compose up --build
curl http://127.0.0.1:8080/healthz
```

O Compose executa como usuário sem privilégio, remove capabilities, usa filesystem somente leitura e publica apenas em loopback. TLS, autenticação de usuário e persistência de auditoria pertencem à plataforma de implantação.

## Integração em produção

1. Gateway autentica usuário e workload.
2. PEP deriva sujeito, tenant, papéis, permissões e propósito.
3. Dados passam por JSON Schema/SHACL antes da gravação.
4. Retrieval filtra tenant e classificação antes de recuperar.
5. LLM produz somente proposta estruturada.
6. PDP avalia a proposta contra artefatos confiáveis.
7. Serviço externo registra aprovação quando necessária.
8. Executor com credencial específica realiza a capacidade.
9. Sistema de registro confirma o resultado.
10. Auditoria correlaciona intenção, decisão, execução e evento.

## Implementar um backend de cérebro

Use `EmbeddedBrainEngine` para single-node ou `PostgresBrainEngine` com a migração pgvector/RLS para
produção distribuída. Outros adapters podem implementar `BrainEngine` sem alterar contratos
públicos. Em qualquer opção:

- a fonte versionada e os sistemas de registro permanecem autoritativos; índices podem ser reconstruídos;
- ingestão é idempotente e valida hash, tenant, `brain_id`, classificação e proveniência;
- tenant/classificação são filtrados antes de keyword/vector/graph produzirem candidatos;
- a resposta preserva componentes de score, referências e janelas de validade;
- consolidação grava proposta versionada, não sobrescreve silenciosamente a memória anterior;
- health check expõe degradação por componente sem revelar dado ou segredo;
- testes com dois tenants provam ausência de vazamento, inclusive por cache e timing observável.

## Atualizações e rollback

Empacote ontologia, shapes, schemas e políticas na mesma versão imutável. Faça deploy canário com fixtures e consultas de competência. Mudanças aditivas compatíveis incrementam minor; correções sem mudança de contrato incrementam patch; remoção ou semântica incompatível exige major e migração. Rollback volta todo o bundle, não arquivos isolados.
