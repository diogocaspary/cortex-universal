# ADR 0004: allowlist de manifesto e fingerprint de política

Status: aceito em 2026-08-09.

Descoberta recursiva faria qualquer arquivo colocado em `ontology`, `shapes` ou `schemas` tornar-se ativo. O runtime agora carrega somente caminhos declarados, rejeita traversal e resolve symlinks antes do uso. O registro de ações e o bundle geram uma fingerprint SHA-256 incluída em cada decisão, permitindo identificar exatamente quais artefatos produziram o resultado. A fingerprint prova identidade do conteúdo, não autoria; assinatura e log imutável continuam sendo controles da plataforma.
