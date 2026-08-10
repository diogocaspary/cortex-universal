# Modelo de segurança

## Invariantes

1. Negar por padrão.
2. O LLM propõe; nunca autoriza a si próprio.
3. Papéis, permissões, tenant e aprovação vêm de fontes autenticadas.
4. Conteúdo recuperado é dado não confiável, mesmo quando parece uma instrução.
5. Políticas e ações vêm de bundle versionado e somente leitura.
6. Acesso entre tenants é negado, salvo recurso explicitamente público e regra que permita.
7. Segredos são referências para um secret manager, nunca valores no grafo.
8. Uma permissão não prova que precondições foram satisfeitas.
9. Um comando aceito não prova que o efeito ocorreu.
10. Decisão, execução e verificação geram registros correlacionados.
11. Aprovações de alto risco têm referência, aprovadores independentes, início e expiração.
12. A decisão registra a fingerprint criptográfica exata das políticas avaliadas.
13. Recuperação aplica tenant e classificação antes de gerar candidatos, inclusive no índice vetorial.
14. Consolidação de memória produz proposta validável; não altera conhecimento confiável sozinha.
15. Trabalho de agente exige meta, responsável, critérios, orçamento e checkout exclusivo.
16. Critério obrigatório de aprovação humana não pode desativar revisão independente.
17. Custo e heartbeat são fatos com evidência; configuração ou estimativa nunca vira atividade.
18. Skill externa só entra por revisão fixa, hash e assinatura Ed25519 verificada por chave confiável.

## Cadeia de decisão

O gateway autentica. O policy enforcement point monta contexto confiável. O motor valida o contrato, encontra a ação, aplica bloqueios estruturais, verifica tenant, classificação, permissões, precondições, aprovação e regras. Regras de negação têm precedência; ausência de regra resulta em `deny`.

O campo `approval.approved_by` é uma representação de entrada para a referência. Em produção, o chamador não pode preenchê-lo livremente: um serviço de aprovação assina ou confirma a referência e o enforcement point deriva os aprovadores. O mesmo vale para papéis e permissões.

O kernel recusa autoaprovação, aprovação futura, expirada ou com intervalo temporal invertido. A fingerprint na resposta permite correlacionar a decisão ao bundle exato, mas não é uma assinatura digital. A atividade v2 é encadeada por SHA-256 ou HMAC-SHA-256 e protegida contra `UPDATE`/`DELETE`; produção ainda deve ancorar hashes em armazenamento WORM separado quando o risco exigir resistência ao administrador.

## Níveis de risco de ação

| Nível | Exemplo                                  | Controle mínimo                                     |
| ----- | ---------------------------------------- | --------------------------------------------------- |
| R0    | cálculo local sem dado sensível          | contrato e limites                                  |
| R1    | leitura/validação                        | autenticação, escopo e auditoria proporcional       |
| R2    | escrita reversível                       | permissão, precondições, idempotência e compensação |
| R3    | efeito financeiro ou comunicação externa | aprovação humana e verificação                      |
| R4    | exportação em massa ou alto impacto      | controle duplo, minimização e auditoria forte       |
| R5    | destruição irreversível sistêmica        | proibido no kernel de referência                    |

## Isolamento multitenant

O motor bloqueia recurso não público cujo tenant difere do sujeito. Esse controle precisa ser repetido no armazenamento com políticas de linha/grafo, credenciais por tenant ou instâncias separadas conforme o risco. Índices vetoriais devem filtrar antes da busca, não apenas depois. Chaves de cache incluem tenant e classificação. Logs evitam payload; backups mantêm a mesma classificação e retenção.

## Prompt injection e poisoning

Documento, mensagem, resultado de busca e saída de ferramenta não alteram system prompt, action registry ou policy bundle. A ingestão preserva origem e hash, roda em quarentena e cria claims propostas. Retrieval usa allowlist por tenant/classificação/finalidade. Qualquer texto dizendo “ignore regras” permanece conteúdo, não comando.

Resultados híbridos precisam preservar canal, score, origem, janela temporal e citação. Embeddings são derivados sensíveis: podem revelar presença ou semelhança de conteúdo e recebem o mesmo isolamento, retenção e backup do dado original. Resumos de comunidade e memórias consolidadas são novos claims, sujeitos a proveniência, avaliação e possibilidade de reversão.

## Segurança do painel local

O HTML do painel é público apenas no loopback, mas os dados do grafo permanecem em `/v1/graph`, protegido por bearer token e `no-store`. A pessoa seleciona `.env` localmente ou cola a chave; o JavaScript mantém a chave somente em memória, não usa `localStorage`, cookie, query string ou log. Todo texto do grafo entra no DOM via `textContent`. Scripts, estilos e conexões são limitados ao próprio origin por CSP; dependências são empacotadas e as licenças permitidas são verificadas no build.

Isso reduz exposição acidental, mas o token ainda fica acessível a qualquer script que execute na página. Por isso o painel não carrega CDN, analytics, extensões próprias ou conteúdo remoto, e a implantação em rede continua exigindo gateway de identidade e TLS.

## Segredos e dados pessoais

Use URI de referência como `vault://...`; resolva o segredo somente no executor autorizado e pelo menor tempo possível. Nunca envie segredo ao LLM. Minimize PII no grafo, prefira identificadores pseudônimos e referência ao registro protegido. Defina finalidade, base, retenção, eliminação e acesso com revisão jurídica aplicável; este projeto não concede certificação LGPD ou regulatória.

## Persistência, MCP e limites da API

Bearer token estático é um controle mínimo de workload. Produção exige gateway com OIDC/mTLS, rotação e credenciais curtas. O modo gateway-HMAC aceita somente identidades curtas e assinadas; o source registry exige Ed25519 para fontes operacionais. A API não assina decisões como autoridade legal, não inclui conectores empresariais universais e não substitui PDP/PEP corporativo. MCP HTTP usa o mesmo bearer e também restringe Host/Origin; MCP stdio é bloqueado em produção. Use TLS no proxy, rede privada, volume cifrado e imagem raiz somente leitura.

O `GovernedEffectBroker` não aceita o recibo do executor como prova. Ele exige um `EffectObserver`
que releia o sistema de registro, valide o outcome e confirme os efeitos esperados do action registry.
Reservas incompletas falham fechadas; a reconciliação deve investigar antes de qualquer retry.

No modo local, o instalador gera 48 bytes aleatórios, grava `.env` fora do Git e liga somente em loopback. O limite por body e por número de quads, rate limit e validação concorrente isolada reduzem abuso de recursos; não tornam seguro expor a porta diretamente à internet.

## Força de trabalho e cadeia de skills

Metas, trabalho, blockers, leases, rotinas e avaliações passam pelos mesmos controles de identidade,
tenant, classificação e política de HTTP/MCP. Checkout usa transação e lease expirada; transições usam
revisão otimista. Aprovação obrigatória precisa ser feita por agente distinto com capacidade de
review. Heartbeat `working` precisa apontar para trabalho do agente com lease ativa. Eventos de custo
são append-only e só aceitam medição do provedor ou alocação comprovada.

O registro de skills distribuído começa vazio. Skill `bundled` precisa existir dentro da raiz
permitida e coincidir com o SHA-256 declarado. Skill Git exige commit fixo, manifesto assinado e chave
Ed25519 ativa em `skill-trust-registry.json`; o validador verifica criptograficamente a assinatura da
serialização canônica sem o campo `signature`. Isso valida o manifesto, não torna seguro executar
código: sandbox, permissões do sistema, egress e segredos mínimos continuam obrigatórios no executor.
