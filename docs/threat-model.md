# Modelo de ameaças

## Ativos e fronteiras

Ativos principais: ontologia confiável, políticas, registro de ações, identidades, dados de tenants, evidências, decisões, credenciais e sistemas de registro. Fronteiras: usuário/gateway, ingestão, retrieval/LLM, policy service, executor, armazenamento e observabilidade.

## Ameaças prioritárias

| Ameaça                  | Caminho                                  | Controles presentes                                               | Controles externos necessários                       | Risco residual            |
| ----------------------- | ---------------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------- | ------------------------- |
| prompt injection        | documento convence agente a executar     | RAG não altera política; serviço não executa                      | sandbox, allowlist de tools, avaliações adversariais | médio                     |
| acesso cruzado          | filtro de tenant ausente                 | negação estrutural não pública                                    | isolamento no grafo/vetor/cache e testes canário     | médio                     |
| elevação de privilégio  | cliente declara papel/aprovação          | contrato + decisão determinística                                 | gateway deriva claims e aprovação assinada           | alto sem gateway          |
| poisoning               | fonte cria claims falsas                 | proveniência, status e quarentena conceitual                      | reputação de fonte, revisão e reconciliação          | médio                     |
| vazamento de segredo    | chave entra no grafo/log/LLM             | shape fechado de referência e logs redigidos                      | secret scanner, DLP, rotação e egress control        | médio                     |
| replay/duplicidade      | comando repetido                         | ações declaram idempotência                                       | store de chaves e idempotência no executor           | médio                     |
| política adulterada     | runtime reescreve bundle                 | artefatos locais e container read-only                            | assinatura, branch protection e deploy verificado    | baixo/médio               |
| artefato não declarado  | arquivo extra é carregado no startup     | allowlist do manifesto, schema e realpath                         | revisão e assinatura do pacote                       | baixo                     |
| negação de serviço      | payload/volume abusivo                   | body limit e rate limit                                           | WAF, quota por tenant e autoscaling                  | médio                     |
| falsa confirmação       | comando tratado como evento              | ontologia separa comando/evento                                   | verificação contra sistema de registro               | médio                     |
| repúdio                 | ação sem trilha                          | obrigações e IDs no contrato                                      | audit log imutável e identidade forte                | médio                     |
| exfiltração no painel   | script ou URL captura token/grafo        | mesmo origin, CSP, `textContent`, token em memória, `no-store`    | gateway, TLS, navegador gerenciado                   | baixo local/médio em rede |
| vazamento por embedding | índice revela presença/semelhança        | contrato exige tenant e classificação                             | filtro pré-busca no engine, criptografia e testes    | médio                     |
| drift de consolidação   | resumo vira “fato” sem evidência         | consolidação modelada como job/proposta                           | aprovação, avaliação, versionamento e rollback       | médio                     |
| contradição omitida     | síntese esconde evidências incompatíveis | lacuna explícita e relação `contradicts`                          | política de resposta e revisão de domínio            | médio                     |
| checkout duplicado      | dois agentes assumem o mesmo trabalho    | transação imediata/lock de linha, lease e revisão otimista        | teste de carga e relógio confiável                   | baixo/médio               |
| autoaprovação           | executor confirma o próprio resultado    | identidade distinta, capacidade de review e gate obrigatório      | aprovação humana assinada para alto risco            | médio                     |
| custo ou liveness falso | estimativa é apresentada como observação | schema fechado, evidência, coerência de lease e custo append-only | atestação do provedor e reconciliação externa        | médio                     |
| skill adulterada        | código remoto muda após revisão          | commit fixo, SHA-256, assinatura Ed25519 e chave confiável        | sandbox, SBOM, scanner e egress control              | médio                     |
| objetivo aberto         | agente otimiza sem limite                | meta ativa, critérios, orçamento, estados terminais e política    | limites no provedor/executor e intervenção humana    | médio                     |

## Casos de abuso que precisam permanecer em teste

- Um tenant solicita recurso confidencial de outro tenant.
- Um documento contém instrução para mudar papel ou política.
- O sujeito possui papel, mas não a permissão exigida.
- O sujeito possui permissão, mas falta precondição verificável.
- Uma aprovação humana tem zero aprovadores ou controle duplo repete a mesma identidade.
- Uma aprovação é futura, expirou ou foi emitida pelo próprio solicitante.
- Ação desconhecida ou R5 é solicitada.
- Uma credencial contém valor secreto além da referência permitida.
- Um evento não tem proveniência; uma claim não tem fonte.
- Um payload tenta propriedade extra, path traversal ou tamanho excessivo.
- Um RDF pequeno excede a quantidade máxima de quads ou duas validações concorrentes se contaminam.
- Uma busca vetorial tenta filtrar tenant somente depois de ranquear candidatos.
- Um nó contém HTML ou script e o painel precisa exibi-lo como texto inerte.
- Uma consolidação não citada tenta substituir memória validada.
- Dois checkouts concorrentes tentam adquirir a mesma tarefa.
- Um agente tenta concluir trabalho com revisão pendente ou aprovar o próprio trabalho.
- Um heartbeat `working` não possui tarefa/lease ativa ou aponta para outro agente.
- Um custo é estimado, futuro, duplicado com conteúdo divergente ou possui contagem incoerente.
- Uma skill Git está sem assinatura, usa chave revogada ou muda de conteúdo após o hash.

## Revisão antes de produção

Responsáveis de segurança, privacidade e domínio devem aceitar riscos residuais. Faça teste de isolamento com dois tenants sintéticos, revisão das permissões do gateway, rotação de segredo, restauração de backup, falha do provedor de política, simulação de executor comprometido e resposta a incidente. Atualize este documento quando surgir nova ação, fonte de dados ou fronteira de confiança.
