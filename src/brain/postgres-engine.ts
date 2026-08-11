import { createHash, createHmac, randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import type { AgentSession } from '../agents/coordinator.js';
import type { CortexGraphSnapshot } from '../graph.js';
import type { Classification } from '../policy.js';
import {
  detectKnowledgeGaps,
  queryTokens,
  reciprocalRankFusion,
  vectorMaximumDistance,
} from '../retrieval.js';
import type {
  WorkforceCostEvent,
  WorkforceCostSummary,
  WorkforceRecord,
  WorkforceRecordType,
  WorkItem,
  WorkItemCheckout,
} from '../workforce/contracts.js';
import type {
  ActivityContext,
  AuditIntegrityReport,
  BrainActivity,
  BrainEngine,
  BrainIngestion,
  EngineHealth,
  GuardProposalReservation,
  GuardReservationResult,
  IngestionResult,
  RetrievalHit,
  RetrievalRequest,
  RetrievalResponse,
} from './engine.js';

interface DocumentRow {
  document_pk: string;
  id: string;
  brain_id: string;
  classification: Classification;
  source_id: string;
  content_reference: string;
  text_content: string;
  citations: string[];
  contradicts: string[];
  valid_from: Date | string;
  valid_until: Date | string | null;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function finiteVector(value: number[] | undefined, label: string): number[] | null {
  if (value === undefined) return null;
  if (value.length < 1 || value.length > 4_096 || value.some((entry) => !Number.isFinite(entry))) {
    throw new Error(`${label} must contain 1 to 4096 finite numbers.`);
  }
  return value;
}

function vectorLiteral(value: number[]): string {
  return `[${value.join(',')}]`;
}

/**
 * Monta a tsquery a partir dos termos já filtrados de stopwords.
 *
 * Termos ligados por OR e com prefixo (`:*`) para acompanhar o adaptador incorporado, que usa
 * FTS5 com a mesma semântica. `websearch_to_tsquery` não serve aqui porque liga os termos com
 * AND, o que faria o canal de maior peso emudecer diante de qualquer pergunta em linguagem
 * natural. Cada termo vai entre aspas simples para que nenhum caractere seja lido como operador.
 */
function tsQuery(tokens: string[]): string {
  return tokens.map((token) => `'${token.replaceAll("'", "''")}':*`).join(' | ');
}

function likePattern(value: string): string {
  return `%${value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
}

function excerpt(value: string, query: string): string {
  const normalized = value.replace(/\s+/gu, ' ').trim();
  const token = queryTokens(query)[0];
  const match = token ? normalized.toLocaleLowerCase('pt-BR').indexOf(token) : -1;
  const start = Math.max(0, match < 0 ? 0 : match - 80);
  const selection = normalized.slice(start, start + 360);
  return `${start > 0 ? '…' : ''}${selection}${start + selection.length < normalized.length ? '…' : ''}`;
}

function normalizeActivity(row: Record<string, unknown>): BrainActivity {
  return {
    ...(row as unknown as BrainActivity),
    sequence: Number(row.sequence),
    occurred_at: iso(row.occurred_at as Date | string),
  };
}

function safeCostInteger(value: string | undefined): number {
  const parsed = BigInt(value ?? '0');
  if (parsed < 0n || parsed > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('Workforce cost aggregate exceeds the exact integer range.');
  }
  return Number(parsed);
}

/**
 * Production PostgreSQL/pgvector adapter. Every tenant query runs in a transaction with RLS
 * settings; callers must use a non-owner, non-BYPASSRLS database role.
 */
export class PostgresBrainEngine implements BrainEngine {
  readonly id = 'postgresql-pgvector-hybrid';
  readonly #pool: Pool;
  readonly #graph: CortexGraphSnapshot;
  readonly #auditSecret: string | undefined;
  readonly #integrityMethod: BrainActivity['integrity_method'];

  constructor(connectionString: string, graph: CortexGraphSnapshot, auditSecret?: string) {
    if (
      !connectionString.startsWith('postgres://') &&
      !connectionString.startsWith('postgresql://')
    ) {
      throw new Error('CORTEX_DATABASE_URL must use postgres:// or postgresql://.');
    }
    this.#pool = new Pool({
      connectionString,
      max: Number(process.env.CORTEX_POSTGRES_POOL_MAX ?? '10'),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      application_name: 'cortex-universal',
    });
    this.#graph = structuredClone(graph);
    this.#auditSecret = auditSecret;
    this.#integrityMethod = auditSecret ? 'hmac-sha256-chain' : 'sha256-chain';
  }

  async ingest(input: BrainIngestion): Promise<IngestionResult> {
    if (!input.source_verification) {
      throw new Error('Evidence must pass the trusted source verifier before persistence.');
    }
    const { envelope, projection } = input;
    const embedding = finiteVector(projection.embedding, 'embedding');
    const expectedHash = `sha256:${createHash('sha256').update(projection.text, 'utf8').digest('hex')}`;
    if (expectedHash !== envelope.content_hash) {
      throw new Error('content_hash does not match the UTF-8 projection text.');
    }
    const validFrom = projection.valid_from ?? envelope.captured_at;
    if (projection.valid_until && Date.parse(projection.valid_until) <= Date.parse(validFrom)) {
      throw new Error('valid_until must be later than valid_from.');
    }
    const citations = [...new Set(projection.citations ?? [envelope.content_reference])];
    return this.#scoped(
      envelope.tenant_id,
      envelope.brain_id,
      [envelope.classification],
      async (client) => {
        const existing = await client.query<{ id: string }>(
          `SELECT id FROM cortex.documents
           WHERE tenant_id = $1 AND brain_id = $2 AND idempotency_key = $3`,
          [envelope.tenant_id, envelope.brain_id, envelope.idempotency_key],
        );
        if (existing.rows[0]) {
          return {
            id: existing.rows[0].id,
            accepted: false,
            status: 'duplicate',
            source_assurance: input.source_verification!.status,
          };
        }
        const inserted = await client.query<{ document_pk: string }>(
          `INSERT INTO cortex.documents (
             id, tenant_id, brain_id, source_id, captured_at, classification, content_hash,
             media_type, content_reference, idempotency_key, provenance, extensions,
             source_verification, text_content, embedding, citations, contradicts,
             valid_from, valid_until
           ) VALUES (
             $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13::jsonb,$14,
             $15::vector,$16::jsonb,$17::jsonb,$18,$19
           ) RETURNING document_pk::text`,
          [
            envelope.id,
            envelope.tenant_id,
            envelope.brain_id,
            envelope.source_id,
            envelope.captured_at,
            envelope.classification,
            envelope.content_hash,
            envelope.media_type,
            envelope.content_reference,
            envelope.idempotency_key,
            JSON.stringify(envelope.provenance),
            JSON.stringify(envelope.extensions ?? {}),
            JSON.stringify(input.source_verification),
            projection.text,
            embedding ? vectorLiteral(embedding) : null,
            JSON.stringify(citations),
            JSON.stringify([...new Set(projection.contradicts ?? [])]),
            validFrom,
            projection.valid_until ?? null,
          ],
        );
        const documentPk = inserted.rows[0]?.document_pk;
        if (!documentPk) throw new Error('PostgreSQL did not return the inserted evidence key.');
        for (const entity of projection.entities ?? []) {
          await client.query(
            `INSERT INTO cortex.document_entities
               (document_pk, tenant_id, brain_id, entity_id, label, module)
             VALUES ($1,$2,$3,$4,$5,$6)`,
            [
              documentPk,
              envelope.tenant_id,
              envelope.brain_id,
              entity.id,
              entity.label ?? null,
              entity.module ?? null,
            ],
          );
        }
        for (const relation of projection.relations ?? []) {
          await client.query(
            `INSERT INTO cortex.semantic_relations
               (document_pk, tenant_id, brain_id, subject, predicate, object)
             VALUES ($1,$2,$3,$4,$5,$6)`,
            [
              documentPk,
              envelope.tenant_id,
              envelope.brain_id,
              relation.subject,
              relation.predicate,
              relation.object,
            ],
          );
        }
        await this.#recordActivityInTransaction(
          client,
          envelope.tenant_id,
          envelope.brain_id,
          'ingestion',
          'accepted',
          envelope.id,
          `Evidence indexed from ${envelope.source_id}.`,
          {
            actor_id: envelope.provenance.actor_id,
            request_id: input.activity_context?.request_id ?? envelope.provenance.correlation_id,
            ...(input.activity_context?.trace_id
              ? { trace_id: input.activity_context.trace_id }
              : {}),
            correlation_id:
              input.activity_context?.correlation_id ?? envelope.provenance.correlation_id,
            causation_id: input.activity_context?.causation_id ?? null,
            operation: input.activity_context?.operation ?? 'brain.ingest',
            details_hash: envelope.content_hash,
            policy_fingerprint: input.activity_context?.policy_fingerprint ?? null,
          },
        );
        return {
          id: envelope.id,
          accepted: true,
          status: 'indexed',
          source_assurance: input.source_verification!.status,
        };
      },
    );
  }

  async retrieve(request: RetrievalRequest): Promise<RetrievalResponse> {
    const queryEmbedding = finiteVector(request.query_embedding, 'query_embedding');
    if (request.modes.includes('vector') && !queryEmbedding) {
      throw new Error('query_embedding is required when vector mode is requested.');
    }
    const tokens = queryTokens(request.query);
    const maximumDistance = vectorMaximumDistance();
    const rows = await this.#scoped(
      request.tenant_id,
      request.brain_id,
      request.allowed_classifications,
      async (client) => {
        const parameters: unknown[] = [request.tenant_id, request.brain_id];
        const conditions = ['tenant_id = $1', 'brain_id = $2'];
        const add = (value: unknown): string => {
          parameters.push(value);
          return `$${parameters.length}`;
        };
        if (request.filters?.source_ids?.length) {
          conditions.push(`source_id = ANY(${add(request.filters.source_ids)}::text[])`);
        }
        if (request.filters?.valid_at) {
          const at = add(request.filters.valid_at);
          conditions.push(`valid_from <= ${at} AND (valid_until IS NULL OR valid_until > ${at})`);
        }
        if (request.filters?.modules?.length) {
          conditions.push(
            `EXISTS (SELECT 1 FROM cortex.document_entities e WHERE e.document_pk = cortex.documents.document_pk AND e.module = ANY(${add(request.filters.modules)}::text[]))`,
          );
        }
        if (request.filters?.entity_ids?.length) {
          conditions.push(
            `EXISTS (SELECT 1 FROM cortex.document_entities e WHERE e.document_pk = cortex.documents.document_pk AND e.entity_id = ANY(${add(request.filters.entity_ids)}::text[]))`,
          );
        }
        const where = conditions.join(' AND ');

        // Profundidade por canal. A fusão precisa de ordenação, não do acervo inteiro: cada
        // canal devolve seus melhores e o corte final é do `limit` pedido. Buscar tudo e
        // ordenar em memória impunha um teto silencioso — passado ele, a evidência mais antiga
        // desaparecia sem lacuna e sem aviso.
        const depth = Math.min(500, Math.max(50, request.limit * 10));
        const channels: Array<{ name: string; weight: number; items: Array<{ id: string }> }> = [];

        if (request.modes.includes('keyword') && tokens.length > 0) {
          const values = [...parameters, tsQuery(tokens), depth];
          const query = `$${values.length - 1}`;
          const limit = `$${values.length}`;
          const matched = await client.query<{ document_pk: string }>(
            `SELECT document_pk::text
               FROM cortex.documents
              WHERE ${where}
                AND search_vector @@ to_tsquery('simple', cortex.immutable_unaccent(${query}))
              ORDER BY ts_rank_cd(
                         search_vector,
                         to_tsquery('simple', cortex.immutable_unaccent(${query}))
                       ) DESC,
                       document_pk DESC
              LIMIT ${limit}`,
            values,
          );
          channels.push({
            name: 'keyword',
            weight: 1,
            items: matched.rows.map((row) => ({ id: row.document_pk })),
          });
        }

        if (request.modes.includes('vector') && queryEmbedding) {
          const values = [...parameters, vectorLiteral(queryEmbedding), maximumDistance, depth];
          const vector = `$${values.length - 2}`;
          const ceiling = `$${values.length - 1}`;
          const limit = `$${values.length}`;
          // `<=>` é distância de cosseno: casa com o operador do índice HNSW da migração.
          // O teto transforma "nada parecido o bastante" em ausência de resultado, e a lacuna
          // explícita nasce daí — em vez de devolver o vizinho menos ruim como se fosse resposta.
          const matched = await client.query<{ document_pk: string }>(
            `SELECT document_pk::text
               FROM cortex.documents
              WHERE ${where} AND embedding IS NOT NULL
                AND embedding <=> ${vector}::vector < ${ceiling}
              ORDER BY embedding <=> ${vector}::vector, document_pk DESC
              LIMIT ${limit}`,
            values,
          );
          channels.push({
            name: 'vector',
            weight: 0.9,
            items: matched.rows.map((row) => ({ id: row.document_pk })),
          });
        }

        if (request.modes.includes('graph')) {
          const entityIds = request.filters?.entity_ids ?? [];
          const patterns = tokens.map(likePattern);
          if (entityIds.length > 0 || patterns.length > 0) {
            const values = [...parameters, entityIds, patterns, depth];
            const ids = `$${values.length - 2}`;
            const like = `$${values.length - 1}`;
            const limit = `$${values.length}`;
            const matched = await client.query<{ document_pk: string }>(
              `SELECT hit.document_pk::text AS document_pk
                 FROM (
                   SELECT e.document_pk
                     FROM cortex.document_entities e
                    WHERE e.document_pk IN (SELECT document_pk FROM cortex.documents WHERE ${where})
                      AND (e.entity_id = ANY(${ids}::text[])
                           OR e.entity_id ILIKE ANY(${like}::text[])
                           OR e.label ILIKE ANY(${like}::text[]))
                   UNION ALL
                   SELECT r.document_pk
                     FROM cortex.semantic_relations r
                    WHERE r.document_pk IN (SELECT document_pk FROM cortex.documents WHERE ${where})
                      AND (r.subject ILIKE ANY(${like}::text[])
                           OR r.predicate ILIKE ANY(${like}::text[])
                           OR r.object ILIKE ANY(${like}::text[]))
                 ) hit
                GROUP BY hit.document_pk
                ORDER BY count(*) DESC, hit.document_pk DESC
                LIMIT ${limit}`,
              values,
            );
            channels.push({
              name: 'graph',
              weight: 0.8,
              items: matched.rows.map((row) => ({ id: row.document_pk })),
            });
          }
        }

        // Hidrata só o que sobreviveu à fusão. O `embedding` fica de fora de propósito: são
        // milhares de floats por linha que o chamador nunca usa.
        const fused = reciprocalRankFusion(channels, { limit: request.limit });
        const keys = fused.map((result) => result.id);
        const documents =
          keys.length === 0
            ? []
            : (
                await client.query<DocumentRow>(
                  `SELECT document_pk::text, id, brain_id, classification, source_id,
                          content_reference, text_content, citations, contradicts,
                          valid_from, valid_until
                     FROM cortex.documents WHERE document_pk = ANY($1::bigint[])`,
                  [keys],
                )
              ).rows;
        return { fused, documents };
      },
    );
    const { fused } = rows;
    const byPk = new Map(rows.documents.map((row) => [row.document_pk, row]));
    const byDocumentId = new Map(rows.documents.map((row) => [row.id, row]));
    const hits: RetrievalHit[] = fused.flatMap((result) => {
      const row = byPk.get(result.id);
      return row
        ? [
            {
              id: row.id,
              score: result.score,
              brain_id: row.brain_id,
              classification: row.classification,
              source_id: row.source_id,
              content_reference: row.content_reference,
              excerpt: excerpt(row.text_content, request.query),
              citations: row.citations,
              valid_from: iso(row.valid_from),
              valid_until: row.valid_until ? iso(row.valid_until) : null,
              score_components: Object.fromEntries(
                result.contributions.map((entry) => [entry.channel, entry.contribution]),
              ),
            },
          ]
        : [];
    });
    const gaps = detectKnowledgeGaps(
      hits.map((hit) => ({
        id: hit.id,
        citations: hit.citations,
        valid_until: hit.valid_until,
        contradicts: byDocumentId.get(hit.id)?.contradicts ?? [],
      })),
      request.as_of,
    );
    const traceId = request.activity_context?.trace_id ?? `trace:${randomUUID()}`;
    await this.recordActivity(
      request.tenant_id,
      request.brain_id,
      'retrieval',
      'completed',
      traceId,
      `${hits.length} authorized evidence item(s) retrieved using ${request.modes.join(', ')}.`,
      {
        actor_id: request.requester_id,
        request_id: request.activity_context?.request_id ?? request.request_id,
        trace_id: traceId,
        correlation_id: request.activity_context?.correlation_id ?? request.request_id,
        causation_id: request.activity_context?.causation_id ?? null,
        operation: request.activity_context?.operation ?? 'brain.retrieve',
        details_hash: `sha256:${createHash('sha256').update(request.query, 'utf8').digest('hex')}`,
        policy_fingerprint: request.activity_context?.policy_fingerprint ?? null,
      },
    );
    return { request_id: request.request_id, trace_id: traceId, hits, gaps };
  }

  async activity(tenantId: string, brainId: string, limit: number): Promise<BrainActivity[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new Error('Activity limit must be an integer from 1 to 500.');
    }
    return this.#scoped(
      tenantId,
      brainId,
      ['public', 'internal', 'confidential', 'restricted'],
      async (client) => {
        const result = await client.query(
          `SELECT * FROM cortex.brain_activity
         WHERE tenant_id = $1 AND brain_id = $2 ORDER BY sequence DESC LIMIT $3`,
          [tenantId, brainId, limit],
        );
        return result.rows.map(normalizeActivity);
      },
    );
  }

  async recordActivity(
    tenantId: string,
    brainId: string,
    kind: BrainActivity['kind'],
    status: BrainActivity['status'],
    subjectId: string,
    summary: string,
    context?: ActivityContext,
  ): Promise<void> {
    await this.#scoped(
      tenantId,
      brainId,
      ['public', 'internal', 'confidential', 'restricted'],
      async (client) =>
        this.#recordActivityInTransaction(
          client,
          tenantId,
          brainId,
          kind,
          status,
          subjectId,
          summary,
          context,
        ),
    );
  }

  async verifyAuditChain(tenantId: string, brainId: string): Promise<AuditIntegrityReport> {
    const rows = await this.#scoped(
      tenantId,
      brainId,
      ['public', 'internal', 'confidential', 'restricted'],
      async (client) => {
        const result = await client.query(
          `SELECT * FROM cortex.brain_activity
           WHERE tenant_id = $1 AND brain_id = $2 ORDER BY sequence ASC`,
          [tenantId, brainId],
        );
        return result.rows.map(normalizeActivity);
      },
    );
    let previous: string | null = null;
    let legacyEvents = 0;
    for (const row of rows) {
      if (!row.trace_id || !row.correlation_id || !row.operation || !row.event_hash) {
        legacyEvents += 1;
        previous = null;
        continue;
      }
      const expected = this.#activityHash({ ...row, previous_hash: previous });
      if (row.previous_hash !== previous || row.event_hash !== expected) {
        return {
          tenant_id: tenantId,
          brain_id: brainId,
          valid: false,
          checked_events: rows.length - legacyEvents,
          legacy_events: legacyEvents,
          first_invalid_sequence: row.sequence,
          integrity_method: this.#integrityMethod,
        };
      }
      previous = row.event_hash;
    }
    return {
      tenant_id: tenantId,
      brain_id: brainId,
      valid: true,
      checked_events: rows.length - legacyEvents,
      legacy_events: legacyEvents,
      first_invalid_sequence: null,
      integrity_method: this.#integrityMethod,
    };
  }

  async saveAgentSession(session: AgentSession): Promise<void> {
    await this.#scoped(
      session.tenant_id,
      session.brain_id,
      session.allowed_classifications,
      async (client) => {
        await client.query(
          `INSERT INTO cortex.agent_sessions (id, tenant_id, brain_id, session_json, updated_at)
         VALUES ($1,$2,$3,$4::jsonb,$5)
         ON CONFLICT (id) DO UPDATE SET session_json = EXCLUDED.session_json,
           updated_at = EXCLUDED.updated_at
         WHERE cortex.agent_sessions.tenant_id = EXCLUDED.tenant_id
           AND cortex.agent_sessions.brain_id = EXCLUDED.brain_id`,
          [
            session.id,
            session.tenant_id,
            session.brain_id,
            JSON.stringify(session),
            session.updated_at,
          ],
        );
      },
    );
  }

  async getAgentSession(
    sessionId: string,
    tenantId?: string,
    brainId?: string,
  ): Promise<AgentSession | null> {
    if (!tenantId || !brainId) {
      throw new Error('PostgreSQL session reads require explicit tenant and brain scope.');
    }
    return this.#scoped(
      tenantId,
      brainId,
      ['public', 'internal', 'confidential', 'restricted'],
      async (client) => {
        const result = await client.query<{ session_json: AgentSession }>(
          `SELECT session_json FROM cortex.agent_sessions
         WHERE id = $1 AND tenant_id = $2 AND brain_id = $3`,
          [sessionId, tenantId, brainId],
        );
        return result.rows[0]?.session_json ?? null;
      },
    );
  }

  async createWorkforceRecord(record: WorkforceRecord): Promise<boolean> {
    return this.#scoped(
      record.tenant_id,
      record.brain_id,
      ['public', 'internal', 'confidential', 'restricted'],
      async (client) => {
        const result = await client.query(
          `INSERT INTO cortex.workforce_records (
             id, tenant_id, brain_id, record_type, record_json, revision, created_at, updated_at
           ) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8)
           ON CONFLICT DO NOTHING`,
          [
            record.id,
            record.tenant_id,
            record.brain_id,
            record.record_type,
            JSON.stringify(record),
            record.revision,
            record.created_at,
            record.updated_at,
          ],
        );
        return result.rowCount === 1;
      },
    );
  }

  async updateWorkforceRecord(record: WorkforceRecord, expectedRevision: number): Promise<boolean> {
    if (record.revision !== expectedRevision + 1) {
      throw new Error('Workforce record revision must increase exactly once.');
    }
    return this.#scoped(
      record.tenant_id,
      record.brain_id,
      ['public', 'internal', 'confidential', 'restricted'],
      async (client) => {
        const result = await client.query(
          `UPDATE cortex.workforce_records SET record_json = $1::jsonb,
             revision = $2, updated_at = $3
           WHERE id = $4 AND tenant_id = $5 AND brain_id = $6
             AND record_type = $7 AND revision = $8`,
          [
            JSON.stringify(record),
            record.revision,
            record.updated_at,
            record.id,
            record.tenant_id,
            record.brain_id,
            record.record_type,
            expectedRevision,
          ],
        );
        return result.rowCount === 1;
      },
    );
  }

  async getWorkforceRecord(
    recordId: string,
    tenantId: string,
    brainId: string,
  ): Promise<WorkforceRecord | null> {
    return this.#scoped(
      tenantId,
      brainId,
      ['public', 'internal', 'confidential', 'restricted'],
      async (client) => {
        const result = await client.query<{ record_json: WorkforceRecord }>(
          `SELECT record_json FROM cortex.workforce_records
           WHERE id = $1 AND tenant_id = $2 AND brain_id = $3`,
          [recordId, tenantId, brainId],
        );
        return result.rows[0]?.record_json ?? null;
      },
    );
  }

  async listWorkforceRecords(
    tenantId: string,
    brainId: string,
    type: WorkforceRecordType,
    limit: number,
  ): Promise<WorkforceRecord[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new Error('Workforce record limit must be an integer from 1 to 500.');
    }
    return this.#scoped(
      tenantId,
      brainId,
      ['public', 'internal', 'confidential', 'restricted'],
      async (client) => {
        const result = await client.query<{ record_json: WorkforceRecord }>(
          `SELECT record_json FROM cortex.workforce_records
           WHERE tenant_id = $1 AND brain_id = $2 AND record_type = $3
           ORDER BY updated_at DESC, id ASC LIMIT $4`,
          [tenantId, brainId, type, limit],
        );
        return result.rows.map((row) => row.record_json);
      },
    );
  }

  async checkoutWorkItem(input: WorkItemCheckout): Promise<WorkItem | null> {
    return this.#scoped(
      input.tenant_id,
      input.brain_id,
      ['public', 'internal', 'confidential', 'restricted'],
      async (client) => {
        const result = await client.query<{ record_json: WorkItem; revision: number }>(
          `SELECT record_json, revision FROM cortex.workforce_records
           WHERE id = $1 AND tenant_id = $2 AND brain_id = $3 AND record_type = 'work_item'
           FOR UPDATE`,
          [input.work_item_id, input.tenant_id, input.brain_id],
        );
        const row = result.rows[0];
        if (!row) return null;
        const item = row.record_json;
        const activeLease =
          item.lease !== null && Date.parse(item.lease.expires_at) > Date.parse(input.acquired_at);
        if (
          item.assigned_agent_id !== input.agent_id ||
          (item.status !== 'ready' && !(item.status === 'in_progress' && !activeLease)) ||
          activeLease
        ) {
          return null;
        }
        const updated: WorkItem = {
          ...item,
          status: 'in_progress',
          lease: {
            checkout_id: input.checkout_id,
            agent_id: input.agent_id,
            acquired_at: input.acquired_at,
            expires_at: input.expires_at,
          },
          revision: Number(row.revision) + 1,
          updated_at: input.acquired_at,
        };
        const changed = await client.query(
          `UPDATE cortex.workforce_records SET record_json = $1::jsonb,
             revision = $2, updated_at = $3
           WHERE id = $4 AND tenant_id = $5 AND brain_id = $6 AND revision = $7`,
          [
            JSON.stringify(updated),
            updated.revision,
            updated.updated_at,
            input.work_item_id,
            input.tenant_id,
            input.brain_id,
            row.revision,
          ],
        );
        if (changed.rowCount !== 1) throw new Error('Atomic work checkout conflict.');
        return updated;
      },
    );
  }

  async recordWorkforceCost(event: WorkforceCostEvent): Promise<boolean> {
    return this.#scoped(
      event.tenant_id,
      event.brain_id,
      ['public', 'internal', 'confidential', 'restricted'],
      async (client) => {
        const result = await client.query(
          `INSERT INTO cortex.workforce_cost_events (
             id, tenant_id, brain_id, agent_id, goal_id, work_item_id, provider, model,
             input_tokens, output_tokens, cached_input_tokens, cost_microusd,
             measurement_status, evidence_reference, occurred_at, idempotency_key
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
           ON CONFLICT DO NOTHING`,
          [
            event.id,
            event.tenant_id,
            event.brain_id,
            event.agent_id,
            event.goal_id,
            event.work_item_id,
            event.provider,
            event.model,
            event.input_tokens,
            event.output_tokens,
            event.cached_input_tokens,
            event.cost_microusd,
            event.measurement_status,
            event.evidence_reference,
            event.occurred_at,
            event.idempotency_key,
          ],
        );
        return result.rowCount === 1;
      },
    );
  }

  async getWorkforceCostEvent(
    eventId: string,
    tenantId: string,
    brainId: string,
  ): Promise<WorkforceCostEvent | null> {
    return this.#scoped(
      tenantId,
      brainId,
      ['public', 'internal', 'confidential', 'restricted'],
      async (client) => {
        const result = await client.query<
          Omit<
            WorkforceCostEvent,
            'input_tokens' | 'output_tokens' | 'cached_input_tokens' | 'cost_microusd'
          > & {
            input_tokens: string;
            output_tokens: string;
            cached_input_tokens: string;
            cost_microusd: string;
          }
        >(
          `SELECT id, tenant_id, brain_id, agent_id, goal_id, work_item_id, provider, model,
                  input_tokens::text, output_tokens::text, cached_input_tokens::text,
                  cost_microusd::text, measurement_status, evidence_reference,
                  occurred_at::text, idempotency_key
           FROM cortex.workforce_cost_events
           WHERE id = $1 AND tenant_id = $2 AND brain_id = $3`,
          [eventId, tenantId, brainId],
        );
        const row = result.rows[0];
        return row
          ? {
              ...row,
              input_tokens: safeCostInteger(row.input_tokens),
              output_tokens: safeCostInteger(row.output_tokens),
              cached_input_tokens: safeCostInteger(row.cached_input_tokens),
              cost_microusd: safeCostInteger(row.cost_microusd),
              occurred_at: new Date(row.occurred_at).toISOString(),
            }
          : null;
      },
    );
  }

  async workforceCostSummary(
    tenantId: string,
    brainId: string,
    filters: { agent_id?: string; goal_id?: string; work_item_id?: string },
  ): Promise<WorkforceCostSummary> {
    return this.#scoped(
      tenantId,
      brainId,
      ['public', 'internal', 'confidential', 'restricted'],
      async (client) => {
        const result = await client.query<Record<keyof WorkforceCostSummary, string>>(
          `SELECT COALESCE(SUM(input_tokens), 0)::text AS input_tokens,
                  COALESCE(SUM(output_tokens), 0)::text AS output_tokens,
                  COALESCE(SUM(cached_input_tokens), 0)::text AS cached_input_tokens,
                  COALESCE(SUM(input_tokens + output_tokens), 0)::text AS total_tokens,
                  COALESCE(SUM(cost_microusd), 0)::text AS cost_microusd,
                  COUNT(*)::text AS event_count
           FROM cortex.workforce_cost_events
           WHERE tenant_id = $1 AND brain_id = $2
             AND ($3::text IS NULL OR agent_id = $3)
             AND ($4::text IS NULL OR goal_id = $4)
             AND ($5::text IS NULL OR work_item_id = $5)`,
          [
            tenantId,
            brainId,
            filters.agent_id ?? null,
            filters.goal_id ?? null,
            filters.work_item_id ?? null,
          ],
        );
        const row = result.rows[0];
        return {
          input_tokens: safeCostInteger(row?.input_tokens),
          output_tokens: safeCostInteger(row?.output_tokens),
          cached_input_tokens: safeCostInteger(row?.cached_input_tokens),
          total_tokens: safeCostInteger(row?.total_tokens),
          cost_microusd: safeCostInteger(row?.cost_microusd),
          event_count: safeCostInteger(row?.event_count),
        };
      },
    );
  }

  async reserveGuardProposal(input: GuardProposalReservation): Promise<GuardReservationResult> {
    return this.#scoped(
      input.tenant_id,
      input.brain_id,
      ['public', 'internal', 'confidential', 'restricted'],
      async (client) => {
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
          input.session_id,
        ]);
        const existing = await client.query<{ decision_json: unknown | null }>(
          `SELECT decision_json FROM cortex.guard_proposals
         WHERE proposal_id = $1 OR (
           tenant_id = $2 AND brain_id = $3 AND session_id = $4 AND action_key = $5
           AND idempotency_key IS NOT NULL AND idempotency_key = $6
         ) LIMIT 1`,
          [
            input.proposal_id,
            input.tenant_id,
            input.brain_id,
            input.session_id,
            input.action_key,
            input.idempotency_key,
          ],
        );
        const counts = await client.query<{ session_count: string; action_count: string }>(
          `SELECT COUNT(*)::text AS session_count,
           COUNT(*) FILTER (WHERE action_key = $4)::text AS action_count
         FROM cortex.guard_proposals WHERE tenant_id = $1 AND brain_id = $2 AND session_id = $3`,
          [input.tenant_id, input.brain_id, input.session_id, input.action_key],
        );
        const sessionCount = Number(counts.rows[0]?.session_count ?? 0);
        const actionCount = Number(counts.rows[0]?.action_count ?? 0);
        if (existing.rows[0]) {
          return {
            duplicate: true,
            session_proposals: sessionCount,
            repeated_action_calls: actionCount,
            existing_decision: existing.rows[0].decision_json,
          };
        }
        await client.query(
          `INSERT INTO cortex.guard_proposals
           (proposal_id, tenant_id, brain_id, session_id, action_key, idempotency_key)
         VALUES ($1,$2,$3,$4,$5,$6)`,
          [
            input.proposal_id,
            input.tenant_id,
            input.brain_id,
            input.session_id,
            input.action_key,
            input.idempotency_key,
          ],
        );
        return {
          duplicate: false,
          session_proposals: sessionCount + 1,
          repeated_action_calls: actionCount + 1,
          existing_decision: null,
        };
      },
    );
  }

  async completeGuardProposal(
    proposalId: string,
    tenantId: string,
    brainId: string,
    decision: unknown,
  ): Promise<void> {
    await this.#scoped(
      tenantId,
      brainId,
      ['public', 'internal', 'confidential', 'restricted'],
      async (client) => {
        const result = await client.query(
          `UPDATE cortex.guard_proposals SET decision_json = $1::jsonb
         WHERE proposal_id = $2 AND tenant_id = $3 AND brain_id = $4 AND decision_json IS NULL`,
          [JSON.stringify(decision), proposalId, tenantId, brainId],
        );
        if (result.rowCount !== 1)
          throw new Error('Guard proposal reservation is absent or completed.');
      },
    );
  }

  async reserveEffectExecution(
    proposalId: string,
    decisionId: string,
    tenantId: string,
    brainId: string,
  ): Promise<boolean> {
    return this.#scoped(
      tenantId,
      brainId,
      ['public', 'internal', 'confidential', 'restricted'],
      async (client) => {
        const result = await client.query(
          `INSERT INTO cortex.effect_executions
           (proposal_id, tenant_id, brain_id, decision_id)
         VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
          [proposalId, tenantId, brainId, decisionId],
        );
        return result.rowCount === 1;
      },
    );
  }

  async completeEffectExecution(
    proposalId: string,
    tenantId: string,
    brainId: string,
    outcome: unknown,
  ): Promise<void> {
    await this.#scoped(
      tenantId,
      brainId,
      ['public', 'internal', 'confidential', 'restricted'],
      async (client) => {
        const result = await client.query(
          `UPDATE cortex.effect_executions SET outcome_json = $1::jsonb,
           completed_at = statement_timestamp()
         WHERE proposal_id = $2 AND tenant_id = $3 AND brain_id = $4 AND outcome_json IS NULL`,
          [JSON.stringify(outcome), proposalId, tenantId, brainId],
        );
        if (result.rowCount !== 1)
          throw new Error('Effect execution is absent or was already completed.');
      },
    );
  }

  async graphSnapshot(
    _tenantId: string,
    _brainId: string,
    _classifications: Classification[],
  ): Promise<CortexGraphSnapshot> {
    return structuredClone(this.#graph);
  }

  async health(): Promise<EngineHealth> {
    try {
      const result = await this.#pool.query<{
        documents: string | null;
        vector_installed: boolean;
      }>(
        `SELECT to_regclass('cortex.documents')::text AS documents,
                EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') AS vector_installed`,
      );
      const ready =
        result.rows[0]?.documents === 'cortex.documents' && result.rows[0].vector_installed;
      return {
        status: ready ? 'ready' : 'unavailable',
        engine: this.id,
        details: {
          schema_installed: result.rows[0]?.documents === 'cortex.documents',
          pgvector: result.rows[0]?.vector_installed ?? false,
          rls_required: true,
        },
      };
    } catch {
      return {
        status: 'unavailable',
        engine: this.id,
        details: { schema_installed: false, pgvector: false, rls_required: true },
      };
    }
  }

  async close(): Promise<void> {
    await this.#pool.end();
  }

  async #scoped<T>(
    tenantId: string,
    brainId: string,
    classifications: Classification[],
    operation: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    if (classifications.length === 0) throw new Error('At least one classification is required.');
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `SELECT set_config('app.tenant_id', $1, true),
                set_config('app.brain_id', $2, true),
                set_config('app.allowed_classifications', $3, true)`,
        [tenantId, brainId, classifications.join(',')],
      );
      const result = await operation(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async #recordActivityInTransaction(
    client: PoolClient,
    tenantId: string,
    brainId: string,
    kind: BrainActivity['kind'],
    status: BrainActivity['status'],
    subjectId: string,
    summary: string,
    context?: ActivityContext,
  ): Promise<void> {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `${tenantId}\n${brainId}\naudit`,
    ]);
    const previous = await client.query<{ event_hash: string }>(
      `SELECT event_hash FROM cortex.brain_activity
       WHERE tenant_id = $1 AND brain_id = $2 ORDER BY sequence DESC LIMIT 1`,
      [tenantId, brainId],
    );
    const event = {
      occurred_at: new Date().toISOString(),
      tenant_id: tenantId,
      brain_id: brainId,
      kind,
      status,
      subject_id: subjectId,
      summary,
      actor_id: context?.actor_id ?? 'service:cortex-kernel',
      request_id: context?.request_id ?? `request:${randomUUID()}`,
      trace_id: context?.trace_id ?? `trace:${randomUUID()}`,
      correlation_id:
        context?.correlation_id ?? context?.request_id ?? `correlation:${randomUUID()}`,
      causation_id: context?.causation_id ?? null,
      operation: context?.operation ?? `kernel.${kind}`,
      details_hash:
        context?.details_hash ?? `sha256:${createHash('sha256').update(summary).digest('hex')}`,
      policy_fingerprint: context?.policy_fingerprint ?? null,
      previous_hash: previous.rows[0]?.event_hash ?? null,
      integrity_method: this.#integrityMethod,
    };
    const eventHash = this.#activityHash(event);
    await client.query(
      `INSERT INTO cortex.brain_activity (
         occurred_at, tenant_id, brain_id, kind, status, subject_id, summary, actor_id,
         request_id, trace_id, correlation_id, causation_id, operation, details_hash,
         policy_fingerprint, previous_hash, event_hash, integrity_method
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
      [
        event.occurred_at,
        tenantId,
        brainId,
        kind,
        status,
        subjectId,
        summary,
        event.actor_id,
        event.request_id,
        event.trace_id,
        event.correlation_id,
        event.causation_id,
        event.operation,
        event.details_hash,
        event.policy_fingerprint,
        event.previous_hash,
        eventHash,
        event.integrity_method,
      ],
    );
  }

  #activityHash(event: Omit<BrainActivity, 'sequence' | 'event_hash'>): string {
    const serialized = [
      'cortex-audit-event-v2',
      event.occurred_at,
      event.tenant_id,
      event.brain_id,
      event.kind,
      event.status,
      event.subject_id,
      event.summary,
      event.actor_id,
      event.request_id,
      event.trace_id,
      event.correlation_id,
      event.causation_id ?? '',
      event.operation,
      event.details_hash,
      event.policy_fingerprint ?? '',
      event.previous_hash ?? '',
      event.integrity_method,
    ].join('\n');
    const digest = this.#auditSecret
      ? createHmac('sha256', this.#auditSecret).update(serialized, 'utf8').digest('hex')
      : createHash('sha256').update(serialized, 'utf8').digest('hex');
    return `${this.#integrityMethod}:${digest}`;
  }
}
