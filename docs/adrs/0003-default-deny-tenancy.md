# ADR 0003: negação padrão e tenant como invariante estrutural

Status: aceito em 2026-08-08.

Regras incompletas não podem resultar em permissão. A ausência de ação conhecida, regra allow, permissão, precondição, aprovação ou classificação válida produz deny. Recursos não públicos não atravessam tenants. Esse bloqueio acontece antes da regra de papel para impedir que uma regra ampla contorne isolamento.
