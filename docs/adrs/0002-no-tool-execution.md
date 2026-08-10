# ADR 0002: o serviço de referência não executa ferramentas

Status: aceito em 2026-08-08.

Misturar validação, autorização e execução amplia privilégio e permite que entrada não confiável atravesse todas as fronteiras. A API limita-se a manifest, conformance e decisão. Um executor separado recebe somente ações autorizadas, usa credencial por capacidade, aplica idempotência e verifica o efeito no sistema de registro.
