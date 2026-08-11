import { createHash, createHmac, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import type { CortexGraphSnapshot } from '../graph.js';
import {
  detectKnowledgeGaps,
  queryTokens,
  reciprocalRankFusion,
  vectorMaximumDistance,
} from '../retrieval.js';
import type { Classification } from '../policy.js';
import type { AgentSession } from '../agents/coordinator.js';
import type {
  WorkforceCostEvent,
  WorkforceCostSummary,
  WorkforceRecord,
  WorkforceRecordType,
  WorkItem,
  WorkItemCheckout,
} from '../workforce/contracts.js';
import type {
  BrainActivity,
  BrainEngine,
  BrainIngestion,
  ActivityContext,
  AuditIntegrityReport,
  GuardProposalReservation,
  GuardReservationResult,
  EngineHealth,
  RetrievalHit,
  RetrievalRequest,
  RetrievalResponse,
} from './engine.js';

interface DocumentRow {
  document_pk: number;
  id: string;
  brain_id: string;
  classification: Classification;
  source_id: string;
  content_reference: string;
  text_content: string;
  embedding_json: string | null;
  citations_json: string;
  contradicts_json: string;
  valid_from: string;
  valid_until: string | null;
}

interface ActivityRow extends BrainActivity {}

interface RankedRow {
  document_pk: number;
}

function finiteVector(value: number[] | undefined, label: string): number[] | null {
  if (value === undefined) return null;
  if (value.length < 1 || value.length > 4_096 || value.some((entry) => !Number.isFinite(entry))) {
    throw new Error(`${label} must contain 1 to 4096 finite numbers.`);
  }
  return value;
}

function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length !== right.length)
    throw new Error('Query and document embeddings differ in size.');
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    dot += leftValue * rightValue;
    leftMagnitude += leftValue * leftValue;
    rightMagnitude += rightValue * rightValue;
  }
  if (leftMagnitude === 0 || rightMagnitude === 0) return 0;
  return Math.max(0, dot / Math.sqrt(leftMagnitude * rightMagnitude));
}

/**
 * Terms are combined with OR so a natural-language question still reaches the channel; bm25
 * ranks documents that match more, and rarer, terms first. Requiring every term would make the
 * highest-weighted channel silent for any query carrying ordinary sentence words.
 */
function ftsExpression(query: string): string | null {
  const tokens = queryTokens(query);
  return tokens.length === 0
    ? null
    : tokens.map((token) => `"${token.replaceAll('"', '""')}"*`).join(' OR ');
}

function likePattern(value: string): string {
  return `%${value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
}

function parseStringArray(value: string): string[] {
  const parsed = JSON.parse(value) as unknown;
  return Array.isArray(parsed) && parsed.every((entry) => typeof entry === 'string') ? parsed : [];
}

function excerpt(value: string, query: string): string {
  const normalized = value.replace(/\s+/gu, ' ').trim();
  const token = queryTokens(query)[0];
  const match = token ? normalized.toLocaleLowerCase('pt-BR').indexOf(token) : -1;
  const start = Math.max(0, match < 0 ? 0 : match - 80);
  const selection = normalized.slice(start, start + 360);
  return `${start > 0 ? '…' : ''}${selection}${start + selection.length < normalized.length ? '…' : ''}`;
}

function safeCostSummary(row: Record<keyof WorkforceCostSummary, number>): WorkforceCostSummary {
  const summary = Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key, Number(value)]),
  ) as unknown as WorkforceCostSummary;
  if (Object.values(summary).some((value) => !Number.isSafeInteger(value) || value < 0)) {
    throw new Error('Workforce cost aggregate exceeds the exact integer range.');
  }
  return summary;
}

/**
 * Local single-node engine. SQLite is a replaceable projection of the ontology,
 * never the semantic authority or a source of permissions.
 */
export class EmbeddedBrainEngine implements BrainEngine {
  readonly id = 'sqlite-fts5-hybrid';
  readonly #database: DatabaseSync;
  readonly #graph: CortexGraphSnapshot;
  readonly #auditSecret: string | undefined;
  readonly #integrityMethod: BrainActivity['integrity_method'];
  #closed = false;

  constructor(databasePath: string, graph: CortexGraphSnapshot, auditSecret?: string) {
    if (databasePath !== ':memory:')
      mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
    this.#database = new DatabaseSync(databasePath);
    this.#graph = structuredClone(graph);
    this.#auditSecret = auditSecret;
    this.#integrityMethod = auditSecret ? 'hmac-sha256-chain' : 'sha256-chain';
    this.#database.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA busy_timeout = 5000;
      PRAGMA trusted_schema = OFF;
      CREATE TABLE IF NOT EXISTS documents (
        document_pk INTEGER PRIMARY KEY,
        id TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        brain_id TEXT NOT NULL,
        source_id TEXT NOT NULL,
        captured_at TEXT NOT NULL,
        classification TEXT NOT NULL CHECK (classification IN ('public','internal','confidential','restricted')),
        content_hash TEXT NOT NULL,
        media_type TEXT NOT NULL,
        content_reference TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        provenance_system TEXT NOT NULL,
        correlation_id TEXT NOT NULL,
        extensions_json TEXT NOT NULL DEFAULT '{}',
        source_verification_json TEXT NOT NULL DEFAULT '{}',
        text_content TEXT NOT NULL,
        embedding_json TEXT,
        citations_json TEXT NOT NULL,
        contradicts_json TEXT NOT NULL,
        valid_from TEXT NOT NULL,
        valid_until TEXT,
        created_at TEXT NOT NULL,
        UNIQUE (tenant_id, brain_id, id),
        UNIQUE (tenant_id, brain_id, idempotency_key)
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
        text_content,
        document_pk UNINDEXED,
        tenant_id UNINDEXED,
        brain_id UNINDEXED,
        tokenize = 'unicode61 remove_diacritics 2'
      );
      CREATE TABLE IF NOT EXISTS document_entities (
        document_pk INTEGER NOT NULL REFERENCES documents(document_pk) ON DELETE CASCADE,
        entity_id TEXT NOT NULL,
        label TEXT,
        module TEXT,
        PRIMARY KEY (document_pk, entity_id)
      );
      CREATE INDEX IF NOT EXISTS document_entities_lookup
        ON document_entities(entity_id, module, document_pk);
      CREATE TABLE IF NOT EXISTS brain_embedding_dimensions (
        tenant_id TEXT NOT NULL,
        brain_id TEXT NOT NULL,
        dimensions INTEGER NOT NULL CHECK (dimensions BETWEEN 1 AND 4096),
        PRIMARY KEY (tenant_id, brain_id)
      );
      CREATE TABLE IF NOT EXISTS semantic_relations (
        document_pk INTEGER NOT NULL REFERENCES documents(document_pk) ON DELETE CASCADE,
        subject TEXT NOT NULL,
        predicate TEXT NOT NULL,
        object TEXT NOT NULL,
        PRIMARY KEY (document_pk, subject, predicate, object)
      );
      CREATE TABLE IF NOT EXISTS brain_activity (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        occurred_at TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        brain_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        subject_id TEXT NOT NULL,
        summary TEXT NOT NULL,
        actor_id TEXT NOT NULL DEFAULT '',
        request_id TEXT NOT NULL DEFAULT '',
        trace_id TEXT NOT NULL DEFAULT '',
        correlation_id TEXT NOT NULL DEFAULT '',
        causation_id TEXT,
        operation TEXT NOT NULL DEFAULT '',
        details_hash TEXT NOT NULL DEFAULT '',
        policy_fingerprint TEXT,
        previous_hash TEXT,
        event_hash TEXT NOT NULL DEFAULT '',
        integrity_method TEXT NOT NULL DEFAULT 'sha256-chain'
      );
      CREATE INDEX IF NOT EXISTS brain_activity_scope
        ON brain_activity(tenant_id, brain_id, sequence DESC);
      CREATE TABLE IF NOT EXISTS agent_sessions (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        brain_id TEXT NOT NULL,
        session_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS agent_sessions_scope
        ON agent_sessions(tenant_id, brain_id, updated_at DESC);
      CREATE TABLE IF NOT EXISTS workforce_records (
        id TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        brain_id TEXT NOT NULL,
        record_type TEXT NOT NULL CHECK (record_type IN ('goal','work_item','routine','heartbeat','evaluation')),
        record_json TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK (revision >= 1),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (tenant_id, brain_id, id)
      );
      CREATE INDEX IF NOT EXISTS workforce_records_scope
        ON workforce_records(tenant_id, brain_id, record_type, updated_at DESC);
      CREATE TABLE IF NOT EXISTS workforce_cost_events (
        id TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        brain_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        goal_id TEXT NOT NULL,
        work_item_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        input_tokens INTEGER NOT NULL CHECK (input_tokens >= 0),
        output_tokens INTEGER NOT NULL CHECK (output_tokens >= 0),
        cached_input_tokens INTEGER NOT NULL CHECK (cached_input_tokens >= 0),
        cost_microusd INTEGER NOT NULL CHECK (cost_microusd >= 0),
        measurement_status TEXT NOT NULL CHECK (measurement_status IN ('provider-reported','subscription-allocated')),
        evidence_reference TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        PRIMARY KEY (tenant_id, brain_id, id),
        UNIQUE (tenant_id, brain_id, idempotency_key)
      );
      CREATE INDEX IF NOT EXISTS workforce_cost_scope
        ON workforce_cost_events(tenant_id, brain_id, agent_id, goal_id, work_item_id, occurred_at);
      CREATE TABLE IF NOT EXISTS guard_proposals (
        proposal_id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        brain_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        action_key TEXT NOT NULL,
        idempotency_key TEXT,
        decision_json TEXT,
        created_at TEXT NOT NULL,
        UNIQUE (tenant_id, brain_id, session_id, action_key, idempotency_key)
      );
      CREATE INDEX IF NOT EXISTS guard_proposals_session
        ON guard_proposals(tenant_id, brain_id, session_id, created_at);
      CREATE TABLE IF NOT EXISTS effect_executions (
        proposal_id TEXT PRIMARY KEY REFERENCES guard_proposals(proposal_id),
        tenant_id TEXT NOT NULL,
        brain_id TEXT NOT NULL,
        decision_id TEXT NOT NULL UNIQUE,
        outcome_json TEXT,
        created_at TEXT NOT NULL,
        completed_at TEXT
      );
    `);
    this.#ensureColumn('documents', 'extensions_json', "TEXT NOT NULL DEFAULT '{}'");
    this.#ensureColumn('documents', 'source_verification_json', "TEXT NOT NULL DEFAULT '{}'");
    this.#ensureColumn('brain_activity', 'actor_id', "TEXT NOT NULL DEFAULT ''");
    this.#ensureColumn('brain_activity', 'request_id', "TEXT NOT NULL DEFAULT ''");
    this.#ensureColumn('brain_activity', 'trace_id', "TEXT NOT NULL DEFAULT ''");
    this.#ensureColumn('brain_activity', 'correlation_id', "TEXT NOT NULL DEFAULT ''");
    this.#ensureColumn('brain_activity', 'causation_id', 'TEXT');
    this.#ensureColumn('brain_activity', 'operation', "TEXT NOT NULL DEFAULT ''");
    this.#ensureColumn('brain_activity', 'details_hash', "TEXT NOT NULL DEFAULT ''");
    this.#ensureColumn('brain_activity', 'policy_fingerprint', 'TEXT');
    this.#ensureColumn('brain_activity', 'previous_hash', 'TEXT');
    this.#ensureColumn('brain_activity', 'event_hash', "TEXT NOT NULL DEFAULT ''");
    this.#ensureColumn(
      'brain_activity',
      'integrity_method',
      "TEXT NOT NULL DEFAULT 'sha256-chain'",
    );
    this.#ensureColumn('effect_executions', 'tenant_id', 'TEXT');
    this.#ensureColumn('effect_executions', 'brain_id', 'TEXT');
    this.#database.exec(`
      CREATE TRIGGER IF NOT EXISTS brain_activity_no_update
      BEFORE UPDATE ON brain_activity BEGIN
        SELECT RAISE(ABORT, 'brain_activity is append-only');
      END;
      CREATE TRIGGER IF NOT EXISTS brain_activity_no_delete
      BEFORE DELETE ON brain_activity BEGIN
        SELECT RAISE(ABORT, 'brain_activity is append-only');
      END;
      CREATE TRIGGER IF NOT EXISTS workforce_cost_no_update
      BEFORE UPDATE ON workforce_cost_events BEGIN
        SELECT RAISE(ABORT, 'workforce_cost_events is append-only');
      END;
      CREATE TRIGGER IF NOT EXISTS workforce_cost_no_delete
      BEFORE DELETE ON workforce_cost_events BEGIN
        SELECT RAISE(ABORT, 'workforce_cost_events is append-only');
      END;
    `);
    if (databasePath !== ':memory:') {
      try {
        chmodSync(databasePath, 0o600);
      } catch {
        this.closeSync();
        throw new Error('The Cortex database permissions could not be restricted to its owner.');
      }
    }
  }

  async ingest(input: BrainIngestion): Promise<import('./engine.js').IngestionResult> {
    this.#ensureOpen();
    const { envelope, projection } = input;
    if (!input.source_verification) {
      throw new Error('Evidence must pass the trusted source verifier before persistence.');
    }
    const embedding = finiteVector(projection.embedding, 'embedding');
    const expectedHash = `sha256:${createHash('sha256').update(projection.text, 'utf8').digest('hex')}`;
    if (expectedHash !== envelope.content_hash) {
      throw new Error('content_hash does not match the UTF-8 projection text.');
    }
    if (
      projection.valid_until &&
      Date.parse(projection.valid_until) <=
        Date.parse(projection.valid_from ?? envelope.captured_at)
    ) {
      throw new Error('valid_until must be later than valid_from.');
    }
    if (
      new Set((projection.entities ?? []).map((entity) => entity.id)).size !==
      (projection.entities ?? []).length
    ) {
      throw new Error('Entity identifiers must be unique within an ingestion projection.');
    }
    const existing = this.#database
      .prepare(
        'SELECT id FROM documents WHERE tenant_id = ? AND brain_id = ? AND idempotency_key = ?',
      )
      .get(envelope.tenant_id, envelope.brain_id, envelope.idempotency_key) as
      { id: string } | undefined;
    if (existing) {
      return {
        id: existing.id,
        accepted: false,
        status: 'duplicate',
        source_assurance: input.source_verification.status,
      };
    }

    const validFrom = projection.valid_from ?? envelope.captured_at;
    const citations = [...new Set(projection.citations ?? [envelope.content_reference])];
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      if (embedding) {
        const existingDimensions = this.#database
          .prepare(
            'SELECT dimensions FROM brain_embedding_dimensions WHERE tenant_id = ? AND brain_id = ?',
          )
          .get(envelope.tenant_id, envelope.brain_id) as { dimensions: number } | undefined;
        if (existingDimensions && Number(existingDimensions.dimensions) !== embedding.length) {
          throw new Error('embedding size differs from the configured brain embedding dimension.');
        }
        this.#database
          .prepare(
            `
            INSERT OR IGNORE INTO brain_embedding_dimensions (tenant_id, brain_id, dimensions)
            VALUES (?, ?, ?)
          `,
          )
          .run(envelope.tenant_id, envelope.brain_id, embedding.length);
      }
      const result = this.#database
        .prepare(
          `
          INSERT INTO documents (
            id, tenant_id, brain_id, source_id, captured_at, classification, content_hash,
            media_type, content_reference, idempotency_key, actor_id, provenance_system,
            correlation_id, extensions_json, source_verification_json, text_content, embedding_json,
            citations_json, contradicts_json, valid_from, valid_until, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        )
        .run(
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
          envelope.provenance.actor_id,
          envelope.provenance.system,
          envelope.provenance.correlation_id,
          JSON.stringify(envelope.extensions ?? {}),
          JSON.stringify(input.source_verification),
          projection.text,
          embedding ? JSON.stringify(embedding) : null,
          JSON.stringify(citations),
          JSON.stringify([...new Set(projection.contradicts ?? [])]),
          validFrom,
          projection.valid_until ?? null,
          new Date().toISOString(),
        );
      const documentPk = Number(result.lastInsertRowid);
      this.#database
        .prepare(
          'INSERT INTO documents_fts (rowid, text_content, document_pk, tenant_id, brain_id) VALUES (?, ?, ?, ?, ?)',
        )
        .run(documentPk, projection.text, documentPk, envelope.tenant_id, envelope.brain_id);

      const insertEntity = this.#database.prepare(
        'INSERT INTO document_entities (document_pk, entity_id, label, module) VALUES (?, ?, ?, ?)',
      );
      for (const entity of projection.entities ?? []) {
        insertEntity.run(documentPk, entity.id, entity.label ?? null, entity.module ?? null);
      }
      const insertRelation = this.#database.prepare(
        'INSERT INTO semantic_relations (document_pk, subject, predicate, object) VALUES (?, ?, ?, ?)',
      );
      for (const relation of projection.relations ?? []) {
        insertRelation.run(documentPk, relation.subject, relation.predicate, relation.object);
      }
      this.#recordActivity(
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
        },
      );
      this.#database.exec('COMMIT');
      return {
        id: envelope.id,
        accepted: true,
        status: 'indexed',
        source_assurance: input.source_verification.status,
      };
    } catch (error) {
      this.#database.exec('ROLLBACK');
      throw error;
    }
  }

  async retrieve(request: RetrievalRequest): Promise<RetrievalResponse> {
    this.#ensureOpen();
    const queryEmbedding = finiteVector(request.query_embedding, 'query_embedding');
    if (request.modes.includes('vector') && !queryEmbedding) {
      throw new Error('query_embedding is required when vector mode is requested.');
    }
    if (queryEmbedding) {
      const configured = this.#database
        .prepare(
          'SELECT dimensions FROM brain_embedding_dimensions WHERE tenant_id = ? AND brain_id = ?',
        )
        .get(request.tenant_id, request.brain_id) as { dimensions: number } | undefined;
      if (configured && Number(configured.dimensions) !== queryEmbedding.length) {
        throw new Error(
          'query_embedding size differs from the configured brain embedding dimension.',
        );
      }
    }
    const { sql: scopeSql, parameters: scopeParameters } = this.#scopeWhere(request);
    const candidates = this.#database
      .prepare(`SELECT * FROM documents d WHERE ${scopeSql} ORDER BY d.document_pk DESC LIMIT 5000`)
      .all(...scopeParameters) as unknown as DocumentRow[];
    const byPrimaryKey = new Map(candidates.map((row) => [row.document_pk, row]));
    const channelRows = new Map<string, RankedRow[]>();

    if (request.modes.includes('keyword')) {
      const match = ftsExpression(request.query);
      const rows = match
        ? (this.#database
            .prepare(
              `
              SELECT d.document_pk
              FROM documents_fts f
              JOIN documents d ON d.document_pk = f.document_pk
              WHERE documents_fts MATCH ? AND ${scopeSql}
              ORDER BY bm25(documents_fts), d.document_pk DESC
              LIMIT 500
            `,
            )
            .all(match, ...scopeParameters) as unknown as RankedRow[])
        : [];
      channelRows.set('keyword', rows);
    }

    if (request.modes.includes('vector') && queryEmbedding) {
      // Mesmo teto do adaptador PostgreSQL, expresso em similaridade: distância = 1 - similaridade.
      // Sem ele o canal devolveria o vizinho menos ruim como se fosse resposta, e a lacuna
      // explícita nunca apareceria.
      const minimumSimilarity = 1 - vectorMaximumDistance();
      const ranked = candidates
        .flatMap((row) => {
          if (!row.embedding_json) return [];
          const vector = JSON.parse(row.embedding_json) as number[];
          const similarity = cosineSimilarity(queryEmbedding, vector);
          return similarity > minimumSimilarity
            ? [{ document_pk: row.document_pk, similarity }]
            : [];
        })
        .sort(
          (left, right) =>
            right.similarity - left.similarity || right.document_pk - left.document_pk,
        )
        .slice(0, 500);
      channelRows.set('vector', ranked);
    }

    if (request.modes.includes('graph')) {
      const graphConditions: string[] = [];
      const relationConditions: string[] = [];
      const entityParameters: SQLInputValue[] = [];
      const relationParameters: SQLInputValue[] = [];
      for (const entityId of request.filters?.entity_ids ?? []) {
        graphConditions.push("(e.entity_id = ? OR e.label LIKE ? ESCAPE '\\')");
        entityParameters.push(entityId, likePattern(entityId));
        relationConditions.push('(r.subject = ? OR r.object = ?)');
        relationParameters.push(entityId, entityId);
      }
      if (graphConditions.length === 0) {
        for (const token of queryTokens(request.query).slice(0, 8)) {
          graphConditions.push("(e.entity_id LIKE ? ESCAPE '\\' OR e.label LIKE ? ESCAPE '\\')");
          entityParameters.push(likePattern(token), likePattern(token));
          relationConditions.push(
            "(r.subject LIKE ? ESCAPE '\\' OR r.predicate LIKE ? ESCAPE '\\' OR r.object LIKE ? ESCAPE '\\')",
          );
          relationParameters.push(likePattern(token), likePattern(token), likePattern(token));
        }
      }
      const rows =
        graphConditions.length === 0
          ? []
          : (this.#database
              .prepare(
                `
                SELECT d.document_pk, COUNT(*) AS match_count
                FROM documents d
                LEFT JOIN document_entities e ON d.document_pk = e.document_pk
                LEFT JOIN semantic_relations r ON d.document_pk = r.document_pk
                WHERE ${scopeSql} AND ((${graphConditions.join(' OR ')}) OR (${relationConditions.join(' OR ')}))
                GROUP BY d.document_pk
                ORDER BY match_count DESC, d.document_pk DESC
                LIMIT 500
              `,
              )
              .all(
                ...scopeParameters,
                ...entityParameters,
                ...relationParameters,
              ) as unknown as RankedRow[]);
      channelRows.set('graph', rows);
    }

    const fused = reciprocalRankFusion(
      [...channelRows.entries()].map(([name, rows]) => ({
        name,
        weight: name === 'keyword' ? 1 : name === 'vector' ? 0.9 : 0.8,
        items: rows
          .filter((row) => byPrimaryKey.has(row.document_pk))
          .map((row) => ({ id: String(row.document_pk) })),
      })),
      { limit: request.limit },
    );
    const hits: RetrievalHit[] = fused.flatMap((result) => {
      const row = byPrimaryKey.get(Number(result.id));
      if (!row) return [];
      return [
        {
          id: row.id,
          score: result.score,
          brain_id: row.brain_id,
          classification: row.classification,
          source_id: row.source_id,
          content_reference: row.content_reference,
          excerpt: excerpt(row.text_content, request.query),
          citations: parseStringArray(row.citations_json),
          valid_from: row.valid_from,
          valid_until: row.valid_until,
          score_components: Object.fromEntries(
            result.contributions.map((entry) => [entry.channel, entry.contribution]),
          ),
        },
      ];
    });
    const gaps = detectKnowledgeGaps(
      hits.map((hit) => {
        const row = candidates.find((candidate) => candidate.id === hit.id);
        return {
          id: hit.id,
          citations: hit.citations,
          valid_until: hit.valid_until,
          contradicts: row ? parseStringArray(row.contradicts_json) : [],
        };
      }),
      request.as_of,
    );
    const traceId = request.activity_context?.trace_id ?? `trace:${randomUUID()}`;
    this.#recordActivity(
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
      },
    );
    return { request_id: request.request_id, trace_id: traceId, hits, gaps };
  }

  async activity(tenantId: string, brainId: string, limit: number): Promise<BrainActivity[]> {
    this.#ensureOpen();
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new Error('Activity limit must be an integer from 1 to 500.');
    }
    return this.#database
      .prepare(
        `
        SELECT sequence, occurred_at, tenant_id, brain_id, kind, status, subject_id, summary,
               actor_id, request_id, trace_id, correlation_id, causation_id, operation,
               details_hash, policy_fingerprint, previous_hash, event_hash, integrity_method
        FROM brain_activity
        WHERE tenant_id = ? AND brain_id = ?
        ORDER BY sequence DESC
        LIMIT ?
      `,
      )
      .all(tenantId, brainId, limit) as unknown as BrainActivity[];
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
    this.#ensureOpen();
    this.#recordActivity(tenantId, brainId, kind, status, subjectId, summary, context);
  }

  async verifyAuditChain(tenantId: string, brainId: string): Promise<AuditIntegrityReport> {
    this.#ensureOpen();
    const rows = this.#database
      .prepare(
        `SELECT sequence, occurred_at, tenant_id, brain_id, kind, status, subject_id, summary,
                actor_id, request_id, trace_id, correlation_id, causation_id, operation,
                details_hash, policy_fingerprint, previous_hash, event_hash, integrity_method
         FROM brain_activity WHERE tenant_id = ? AND brain_id = ? ORDER BY sequence ASC`,
      )
      .all(tenantId, brainId) as unknown as ActivityRow[];
    let previous: string | null = null;
    let legacyEvents = 0;
    for (const row of rows) {
      if (
        !row.event_hash ||
        !row.actor_id ||
        !row.request_id ||
        !row.trace_id ||
        !row.correlation_id ||
        !row.operation
      ) {
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
    this.#ensureOpen();
    this.#database
      .prepare(
        `
        INSERT INTO agent_sessions (id, tenant_id, brain_id, session_json, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          session_json = excluded.session_json,
          updated_at = excluded.updated_at
        WHERE agent_sessions.tenant_id = excluded.tenant_id
          AND agent_sessions.brain_id = excluded.brain_id
      `,
      )
      .run(
        session.id,
        session.tenant_id,
        session.brain_id,
        JSON.stringify(session),
        session.updated_at,
      );
  }

  async getAgentSession(
    sessionId: string,
    tenantId?: string,
    brainId?: string,
  ): Promise<AgentSession | null> {
    this.#ensureOpen();
    const row = this.#database
      .prepare(
        `SELECT session_json FROM agent_sessions WHERE id = ?
         AND (? IS NULL OR tenant_id = ?) AND (? IS NULL OR brain_id = ?)`,
      )
      .get(sessionId, tenantId ?? null, tenantId ?? null, brainId ?? null, brainId ?? null) as
      { session_json: string } | undefined;
    return row ? (JSON.parse(row.session_json) as AgentSession) : null;
  }

  async createWorkforceRecord(record: WorkforceRecord): Promise<boolean> {
    this.#ensureOpen();
    const result = this.#database
      .prepare(
        `INSERT OR IGNORE INTO workforce_records (
           id, tenant_id, brain_id, record_type, record_json, revision, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.tenant_id,
        record.brain_id,
        record.record_type,
        JSON.stringify(record),
        record.revision,
        record.created_at,
        record.updated_at,
      );
    return Number(result.changes) === 1;
  }

  async updateWorkforceRecord(record: WorkforceRecord, expectedRevision: number): Promise<boolean> {
    this.#ensureOpen();
    if (record.revision !== expectedRevision + 1) {
      throw new Error('Workforce record revision must increase exactly once.');
    }
    const result = this.#database
      .prepare(
        `UPDATE workforce_records SET record_json = ?, revision = ?, updated_at = ?
         WHERE id = ? AND tenant_id = ? AND brain_id = ? AND record_type = ? AND revision = ?`,
      )
      .run(
        JSON.stringify(record),
        record.revision,
        record.updated_at,
        record.id,
        record.tenant_id,
        record.brain_id,
        record.record_type,
        expectedRevision,
      );
    return Number(result.changes) === 1;
  }

  async getWorkforceRecord(
    recordId: string,
    tenantId: string,
    brainId: string,
  ): Promise<WorkforceRecord | null> {
    this.#ensureOpen();
    const row = this.#database
      .prepare(
        `SELECT record_json FROM workforce_records
         WHERE id = ? AND tenant_id = ? AND brain_id = ?`,
      )
      .get(recordId, tenantId, brainId) as { record_json: string } | undefined;
    return row ? (JSON.parse(row.record_json) as WorkforceRecord) : null;
  }

  async listWorkforceRecords(
    tenantId: string,
    brainId: string,
    type: WorkforceRecordType,
    limit: number,
  ): Promise<WorkforceRecord[]> {
    this.#ensureOpen();
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new Error('Workforce record limit must be an integer from 1 to 500.');
    }
    const rows = this.#database
      .prepare(
        `SELECT record_json FROM workforce_records
         WHERE tenant_id = ? AND brain_id = ? AND record_type = ?
         ORDER BY updated_at DESC, id ASC LIMIT ?`,
      )
      .all(tenantId, brainId, type, limit) as unknown as Array<{ record_json: string }>;
    return rows.map((row) => JSON.parse(row.record_json) as WorkforceRecord);
  }

  async checkoutWorkItem(input: WorkItemCheckout): Promise<WorkItem | null> {
    this.#ensureOpen();
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      const row = this.#database
        .prepare(
          `SELECT record_json, revision FROM workforce_records
           WHERE id = ? AND tenant_id = ? AND brain_id = ? AND record_type = 'work_item'`,
        )
        .get(input.work_item_id, input.tenant_id, input.brain_id) as
        { record_json: string; revision: number } | undefined;
      if (!row) {
        this.#database.exec('COMMIT');
        return null;
      }
      const item = JSON.parse(row.record_json) as WorkItem;
      const activeLease =
        item.lease !== null && Date.parse(item.lease.expires_at) > Date.parse(input.acquired_at);
      if (
        item.assigned_agent_id !== input.agent_id ||
        (item.status !== 'ready' && !(item.status === 'in_progress' && !activeLease)) ||
        activeLease
      ) {
        this.#database.exec('COMMIT');
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
      const result = this.#database
        .prepare(
          `UPDATE workforce_records SET record_json = ?, revision = ?, updated_at = ?
           WHERE id = ? AND tenant_id = ? AND brain_id = ? AND revision = ?`,
        )
        .run(
          JSON.stringify(updated),
          updated.revision,
          updated.updated_at,
          input.work_item_id,
          input.tenant_id,
          input.brain_id,
          row.revision,
        );
      if (Number(result.changes) !== 1) throw new Error('Atomic work checkout conflict.');
      this.#database.exec('COMMIT');
      return updated;
    } catch (error) {
      this.#database.exec('ROLLBACK');
      throw error;
    }
  }

  async recordWorkforceCost(event: WorkforceCostEvent): Promise<boolean> {
    this.#ensureOpen();
    const result = this.#database
      .prepare(
        `INSERT OR IGNORE INTO workforce_cost_events (
           id, tenant_id, brain_id, agent_id, goal_id, work_item_id, provider, model,
           input_tokens, output_tokens, cached_input_tokens, cost_microusd,
           measurement_status, evidence_reference, occurred_at, idempotency_key
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
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
      );
    return Number(result.changes) === 1;
  }

  async getWorkforceCostEvent(
    eventId: string,
    tenantId: string,
    brainId: string,
  ): Promise<WorkforceCostEvent | null> {
    this.#ensureOpen();
    const row = this.#database
      .prepare(
        `SELECT id, tenant_id, brain_id, agent_id, goal_id, work_item_id, provider, model,
                input_tokens, output_tokens, cached_input_tokens, cost_microusd,
                measurement_status, evidence_reference, occurred_at, idempotency_key
         FROM workforce_cost_events WHERE id = ? AND tenant_id = ? AND brain_id = ?`,
      )
      .get(eventId, tenantId, brainId) as WorkforceCostEvent | undefined;
    return row ? structuredClone(row) : null;
  }

  async workforceCostSummary(
    tenantId: string,
    brainId: string,
    filters: { agent_id?: string; goal_id?: string; work_item_id?: string },
  ): Promise<WorkforceCostSummary> {
    this.#ensureOpen();
    const conditions = ['tenant_id = ?', 'brain_id = ?'];
    const parameters: SQLInputValue[] = [tenantId, brainId];
    for (const [column, value] of [
      ['agent_id', filters.agent_id],
      ['goal_id', filters.goal_id],
      ['work_item_id', filters.work_item_id],
    ] as const) {
      if (value) {
        conditions.push(`${column} = ?`);
        parameters.push(value);
      }
    }
    const row = this.#database
      .prepare(
        `SELECT COALESCE(SUM(input_tokens), 0) AS input_tokens,
                COALESCE(SUM(output_tokens), 0) AS output_tokens,
                COALESCE(SUM(cached_input_tokens), 0) AS cached_input_tokens,
                COALESCE(SUM(input_tokens + output_tokens), 0) AS total_tokens,
                COALESCE(SUM(cost_microusd), 0) AS cost_microusd,
                COUNT(*) AS event_count
         FROM workforce_cost_events WHERE ${conditions.join(' AND ')}`,
      )
      .get(...parameters) as Record<keyof WorkforceCostSummary, number>;
    return safeCostSummary(row);
  }

  async reserveGuardProposal(input: GuardProposalReservation): Promise<GuardReservationResult> {
    this.#ensureOpen();
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.#database
        .prepare(
          `SELECT decision_json FROM guard_proposals
           WHERE (proposal_id = ? AND tenant_id = ? AND brain_id = ?) OR (
             tenant_id = ? AND brain_id = ? AND session_id = ? AND action_key = ?
             AND idempotency_key IS NOT NULL AND idempotency_key = ?
           ) LIMIT 1`,
        )
        .get(
          input.proposal_id,
          input.tenant_id,
          input.brain_id,
          input.tenant_id,
          input.brain_id,
          input.session_id,
          input.action_key,
          input.idempotency_key,
        ) as { decision_json: string | null } | undefined;
      const sessionCount = this.#database
        .prepare(
          `SELECT COUNT(*) AS count FROM guard_proposals
           WHERE tenant_id = ? AND brain_id = ? AND session_id = ?`,
        )
        .get(input.tenant_id, input.brain_id, input.session_id) as { count: number };
      const actionCount = this.#database
        .prepare(
          `SELECT COUNT(*) AS count FROM guard_proposals
           WHERE tenant_id = ? AND brain_id = ? AND session_id = ? AND action_key = ?`,
        )
        .get(input.tenant_id, input.brain_id, input.session_id, input.action_key) as {
        count: number;
      };
      if (existing) {
        this.#database.exec('COMMIT');
        return {
          duplicate: true,
          session_proposals: Number(sessionCount.count),
          repeated_action_calls: Number(actionCount.count),
          existing_decision: existing.decision_json ? JSON.parse(existing.decision_json) : null,
        };
      }
      this.#database
        .prepare(
          `INSERT INTO guard_proposals (
             proposal_id, tenant_id, brain_id, session_id, action_key, idempotency_key, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.proposal_id,
          input.tenant_id,
          input.brain_id,
          input.session_id,
          input.action_key,
          input.idempotency_key,
          new Date().toISOString(),
        );
      this.#database.exec('COMMIT');
      return {
        duplicate: false,
        session_proposals: Number(sessionCount.count) + 1,
        repeated_action_calls: Number(actionCount.count) + 1,
        existing_decision: null,
      };
    } catch (error) {
      this.#database.exec('ROLLBACK');
      throw error;
    }
  }

  async completeGuardProposal(
    proposalId: string,
    tenantId: string,
    brainId: string,
    decision: unknown,
  ): Promise<void> {
    this.#ensureOpen();
    const result = this.#database
      .prepare(
        `UPDATE guard_proposals SET decision_json = ?
         WHERE proposal_id = ? AND tenant_id = ? AND brain_id = ? AND decision_json IS NULL`,
      )
      .run(JSON.stringify(decision), proposalId, tenantId, brainId);
    if (Number(result.changes) !== 1) {
      const existing = this.#database
        .prepare(
          'SELECT 1 AS found FROM guard_proposals WHERE proposal_id = ? AND tenant_id = ? AND brain_id = ?',
        )
        .get(proposalId, tenantId, brainId);
      if (!existing) throw new Error('Guard proposal reservation was not found.');
    }
  }

  async reserveEffectExecution(
    proposalId: string,
    decisionId: string,
    tenantId: string,
    brainId: string,
  ): Promise<boolean> {
    this.#ensureOpen();
    const result = this.#database
      .prepare(
        `INSERT OR IGNORE INTO effect_executions (
           proposal_id, tenant_id, brain_id, decision_id, created_at
         ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(proposalId, tenantId, brainId, decisionId, new Date().toISOString());
    return Number(result.changes) === 1;
  }

  async completeEffectExecution(
    proposalId: string,
    tenantId: string,
    brainId: string,
    outcome: unknown,
  ): Promise<void> {
    this.#ensureOpen();
    const result = this.#database
      .prepare(
        `UPDATE effect_executions SET outcome_json = ?, completed_at = ?
         WHERE proposal_id = ? AND tenant_id = ? AND brain_id = ? AND outcome_json IS NULL`,
      )
      .run(JSON.stringify(outcome), new Date().toISOString(), proposalId, tenantId, brainId);
    if (Number(result.changes) !== 1) {
      throw new Error('Effect execution is absent or was already completed.');
    }
  }

  async graphSnapshot(
    _tenantId: string,
    _brainId: string,
    _classifications: Classification[],
  ): Promise<CortexGraphSnapshot> {
    return structuredClone(this.#graph);
  }

  async health(): Promise<EngineHealth> {
    this.#ensureOpen();
    const row = this.#database.prepare('SELECT COUNT(*) AS count FROM documents').get() as {
      count: number;
    };
    return {
      status: 'ready',
      engine: this.id,
      details: { documents: Number(row.count), fts5: true, persistence: true },
    };
  }

  async close(): Promise<void> {
    this.closeSync();
  }

  private closeSync(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#database.close();
  }

  #ensureOpen(): void {
    if (this.#closed) throw new Error('The embedded brain engine is closed.');
  }

  #recordActivity(
    tenantId: string,
    brainId: string,
    kind: BrainActivity['kind'],
    status: BrainActivity['status'],
    subjectId: string,
    summary: string,
    context?: ActivityContext,
  ): void {
    const occurredAt = new Date().toISOString();
    const previousRow = this.#database
      .prepare(
        `SELECT event_hash FROM brain_activity
         WHERE tenant_id = ? AND brain_id = ? AND event_hash <> ''
         ORDER BY sequence DESC LIMIT 1`,
      )
      .get(tenantId, brainId) as { event_hash: string } | undefined;
    const event = {
      occurred_at: occurredAt,
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
      previous_hash: previousRow?.event_hash ?? null,
      integrity_method: this.#integrityMethod,
    };
    const eventHash = this.#activityHash(event);
    this.#database
      .prepare(
        `
        INSERT INTO brain_activity (
          occurred_at, tenant_id, brain_id, kind, status, subject_id, summary, actor_id,
          request_id, trace_id, correlation_id, causation_id, operation, details_hash,
          policy_fingerprint, previous_hash, event_hash, integrity_method
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
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
      );
  }

  #activityHash(event: Omit<ActivityRow, 'sequence' | 'event_hash'>): string {
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

  #ensureColumn(
    table: 'documents' | 'brain_activity' | 'effect_executions',
    column: string,
    declaration: string,
  ): void {
    const columns = this.#database
      .prepare(`PRAGMA table_info(${table})`)
      .all() as unknown as Array<{
      name: string;
    }>;
    if (!columns.some((candidate) => candidate.name === column)) {
      this.#database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${declaration}`);
    }
  }

  #scopeWhere(request: RetrievalRequest): { sql: string; parameters: SQLInputValue[] } {
    const conditions = ['d.tenant_id = ?', 'd.brain_id = ?'];
    const parameters: SQLInputValue[] = [request.tenant_id, request.brain_id];
    conditions.push(
      `d.classification IN (${request.allowed_classifications.map(() => '?').join(',')})`,
    );
    parameters.push(...request.allowed_classifications);
    if (request.filters?.source_ids?.length) {
      conditions.push(`d.source_id IN (${request.filters.source_ids.map(() => '?').join(',')})`);
      parameters.push(...request.filters.source_ids);
    }
    const validAt = request.filters?.valid_at;
    if (validAt) {
      conditions.push('d.valid_from <= ?', '(d.valid_until IS NULL OR d.valid_until > ?)');
      parameters.push(validAt, validAt);
    }
    if (request.filters?.modules?.length) {
      conditions.push(`EXISTS (
        SELECT 1 FROM document_entities scoped_entity
        WHERE scoped_entity.document_pk = d.document_pk
          AND scoped_entity.module IN (${request.filters.modules.map(() => '?').join(',')})
      )`);
      parameters.push(...request.filters.modules);
    }
    if (request.filters?.entity_ids?.length) {
      conditions.push(`EXISTS (
        SELECT 1 FROM document_entities scoped_entity
        WHERE scoped_entity.document_pk = d.document_pk
          AND scoped_entity.entity_id IN (${request.filters.entity_ids.map(() => '?').join(',')})
      )`);
      parameters.push(...request.filters.entity_ids);
    }
    return { sql: conditions.join(' AND '), parameters };
  }
}
