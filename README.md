# Cortex Universal

> Manual técnico completo em português: [entenda, instale, opere e evolua o Cortex Universal](docs/MANUAL-COMPLETO.md).
>
> Introdução conceitual: [como a ontologia contribui para um córtex de IA](docs/guia-pt-BR.md).

Cortex Universal is a vendor-neutral, modular business ontology and a secure semantic-kernel reference implementation. It provides a stable core for representing organizations, people, offers, agreements, commerce, finance, processes, communications, knowledge, AI agents, governed agent workforces, policies, risk, metrics, integrations, tenancy, audit events, governed memory, hybrid retrieval, attention, world models, metacognition, and governed learning.

The repository deliberately separates meaning from execution:

- RDF/OWL defines vocabulary and inference semantics.
- SHACL validates operational data.
- JSON Schema validates API contracts.
- The policy service returns deterministic allow/deny decisions.
- The reference API never executes business tools.
- Transactional systems remain the source of truth.

## Security invariants

1. Deny by default.
2. An LLM may propose an action but cannot authorize or execute it.
3. Policies and action definitions come from versioned trusted files, never retrieved content.
4. Cross-tenant access is denied unless the resource is explicitly public and policy allows it.
5. Secrets are referenced, never stored in the ontology, graph, examples, or logs.
6. Operational claims require provenance, validity, verification status, and tenant scope.
7. Commands and observed events are different records.
8. High-risk actions require an approval recorded outside the LLM.

## Repository map

- `ontology/core`: stable universal primitives.
- `ontology/modules`: 34 optional reusable business, cognitive, workforce, and tool-governance modules.
- `ontology/context`: protected JSON-LD context.
- `shapes`: SHACL validation rules.
- `schemas`: JSON Schema contracts.
- `policies`: trusted action registry and default-deny policy bundle.
- `src`: validation, policy, persistent brain engine, agents, API and MCP runtime.
- `dashboard`: 2D and 3D projections of the same declared ontology graph, without simulated activity.
- `storage`: production PostgreSQL/pgvector baseline with forced row-level security.
- `examples`: valid and invalid conformance fixtures.
- `test`: automated conformance and security tests.
- `docs`: architecture, modeling, replication, and threat-model documentation.
- `openapi.yaml`: portable API contract.
- `local`: one-click Windows launchers and Unix helpers.

## Run on a Windows PC

Download and extract the release ZIP, then double-click `INSTALAR-NO-WINDOWS.cmd`. The installer generates a cryptographically random local token, uses Docker Desktop when available with Node.js 22.13+ as a fallback, and opens `http://127.0.0.1:8080/dashboard/`. Select the generated `.env` to connect; the browser keeps the token only in memory. See the [local computer guide](local/README.md).

## Quick start

Requirements: Node.js 22.13 or newer (with `node:sqlite`).

```bash
npm ci
npm run check
cp .env.example .env
# Fill CORTEX_API_TOKEN with at least 32 random bytes.
npm run dev
```

Generate a development token with `openssl rand -base64 48`; never commit it. To run the hardened container:

```bash
export CORTEX_API_TOKEN="$(openssl rand -base64 48)"
export CORTEX_AUDIT_HMAC_SECRET="$(openssl rand -base64 48)"
docker compose up --build
```

For production, set `NODE_ENV=production`, a strong `CORTEX_API_TOKEN`, a distinct
`CORTEX_AUDIT_HMAC_SECRET`, and either explicit static subject/tenant/permission/classification
settings or signed gateway identity mode. Wildcard tenancy is rejected. Place the service behind an
identity-aware gateway using OIDC or mTLS; the static token is only a service-level minimum control.

## API endpoints

- `GET /healthz`: liveness check.
- `GET /`: local service information.
- `GET /readyz`: readiness check.
- `GET /dashboard/`: local read-only graph dashboard.
- `GET /v1/manifest`: ontology package manifest.
- `GET /v1/graph`: deterministic ontology, SHACL, action, and policy graph snapshot.
- `GET /v1/ontology/reasoning`: bounded explainable RDFS/OWL-RL-subset report.
- `GET /v1/brain/health`: persistent embedded engine health.
- `POST /v1/brain/ingest`: hash-verified, idempotent evidence ingestion.
- `POST /v1/brain/retrieve`: keyword + vector + graph retrieval with citations and gaps.
- `GET /v1/brain/activity`: tenant/brain-scoped operational activity.
- `GET /v1/agents/registry`: trusted agents and bounded capabilities.
- `POST /v1/guard/evaluate`: persist a no-effect Ontology Guard decision.
- `POST /v1/agents/sessions`: start an auditable coordination session.
- `POST /v1/agents/sessions/:id/handoffs`: record an evidence-bearing handoff.
- `POST /v1/validate/json/:schema`: validate a JSON contract.
- `POST /v1/validate/shacl`: validate Turtle data against the bundled shapes.
- `POST /v1/policies/evaluate`: evaluate a trusted action definition and policy bundle.
- `POST /v1/cognition/attention/select`: select a bounded working set.
- `POST /v1/cognition/prediction/evaluate`: compare predictions with observations.
- `POST /v1/cognition/metacognition/evaluate`: measure confidence calibration.
- `POST /v1/cognition/consolidation/propose`: propose replay with zero trusted-memory writes.
- `POST /v1/cognition/cycle/validate`: validate an auditable cognitive event sequence.
- `GET /v1/workforce/snapshot`: read persisted goals, work, routines, heartbeats, evaluations, and measured costs.
- `POST /v1/workforce/goals`: create an ontology-bound goal.
- `POST /v1/workforce/work-items`: create budgeted, evidence-bearing work.
- `POST /v1/workforce/work-items/:id/checkout`: acquire an atomic expiring lease.
- `POST /v1/workforce/work-items/:id/transitions`: apply the governed state and review machine.
- `POST /v1/workforce/routines`: create a bounded recurring work template.
- `POST /v1/workforce/routines/materialize`: materialize due work without executing it.
- `POST /v1/workforce/cost-events`: append provider-metered or evidence-backed allocated costs.
- `POST /v1/workforce/heartbeats`: append an evidence-backed observed agent status.
- `POST /v1/workforce/evaluations`: append an independent evidence-based evaluation.
- `GET /v1/audit/integrity`: verify the tenant/brain append-only hash chain.
- `GET /v1/observability/metrics`: read payload-free runtime aggregates.
- `GET /v1/observability/failures`: read bounded sanitized failure metadata.
- `POST /mcp`: authenticated stateless MCP Streamable HTTP endpoint.

All `/v1` endpoints require `Authorization: Bearer <token>` when `CORTEX_API_TOKEN` is configured.

The official MCP v2 server is also available over stdio with `npm run mcp`. See the [MCP guide](docs/mcp.md).

## Verifiable ontology and operational maps

The dashboard has two ontology modes and one scoped operational mode. AntV G6 shows the exact 2D graph; 3D Force Graph renders the same declared nodes and directional relations with deterministic grouping by module. “Rede operacional real” connects only persisted agents, goals, work, blockers, routines, heartbeats, and evaluations for an explicit tenant and brain. It does not generate particles, activations, neurons, weights, traffic, costs, or demonstration data. If an adapter produces ONNX, PyTorch, TensorFlow, or similar files, use Netron alongside this dashboard.

## Scope of version 0.6

This release keeps the ontology as the semantic authority and adds a governed agent-workforce control plane: organizational roles and personas, goal ancestry, budgeted work, blockers, atomic checkout, routines, evidence-backed heartbeats, immutable measured costs, independent review, evaluations, API/MCP parity, and a real-data-only operational graph. It does not embed an unrestricted agent runner, fabricate liveness or costs, download skills automatically, or execute business effects. SQLite remains the local/single-node option. PostgreSQL requires a real migrated pgvector service and a non-owner runtime role. This is not consciousness, a biological neural network, an identity provider, a secrets manager, or legal certification.

See the [Paperclip-inspired integration guide](docs/PAPERCLIP-INTEGRATION.md), [complete observability and architecture map](docs/MAPEAMENTO-COMPLETO-OBSERVABILIDADE.md), [Architecture](docs/architecture.md), [data integrity](docs/data-integrity.md), [runtime organization](docs/runtime-organization.md), [MCP guide](docs/mcp.md), [video synthesis](docs/research/video-agentic-ontologies-2026-08-09.md), [human-like cognition research](docs/research/human-like-cognition-2026-08-09.md), [GitHub research](docs/research/github-landscape-2026-08-09.md), [Security model](docs/security-model.md), and [Replication guide](docs/replication.md).
