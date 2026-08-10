import type { CortexGraphSnapshot } from '../graph.js';
import type { Classification } from '../policy.js';
import type { SourceAttestation, SourceVerification } from '../security/source-registry.js';
import type { AgentSession } from '../agents/coordinator.js';
import type {
  WorkforceCostEvent,
  WorkforceCostSummary,
  WorkforceRecord,
  WorkforceRecordType,
  WorkItem,
  WorkItemCheckout,
} from '../workforce/contracts.js';

export interface IngestionEnvelope {
  id: string;
  tenant_id: string;
  brain_id: string;
  source_id: string;
  captured_at: string;
  classification: Classification;
  content_hash: string;
  media_type: string;
  content_reference: string;
  idempotency_key: string;
  provenance: {
    actor_id: string;
    system: string;
    correlation_id: string;
  };
  attestation?: SourceAttestation;
  extensions?: Record<string, unknown>;
}

export interface IngestionProjection {
  text: string;
  embedding?: number[];
  entities?: Array<{
    id: string;
    label?: string;
    module?: string;
  }>;
  relations?: Array<{
    subject: string;
    predicate: string;
    object: string;
  }>;
  citations?: string[];
  contradicts?: string[];
  valid_from?: string;
  valid_until?: string | null;
}

export interface BrainIngestion {
  envelope: IngestionEnvelope;
  projection: IngestionProjection;
  /** Added only by the trusted source verifier after public contract validation. */
  source_verification?: SourceVerification;
  /** Added only by a trusted transport after public contract validation. */
  activity_context?: ActivityContext;
}

export interface IngestionResult {
  id: string;
  accepted: boolean;
  status: 'indexed' | 'duplicate';
  source_assurance: SourceVerification['status'];
}

export interface RetrievalRequest {
  request_id: string;
  tenant_id: string;
  brain_id: string;
  requester_id: string;
  query: string;
  purpose: string;
  modes: Array<'keyword' | 'vector' | 'graph'>;
  allowed_classifications: Classification[];
  limit: number;
  as_of: string;
  filters?: {
    source_ids?: string[];
    entity_ids?: string[];
    modules?: string[];
    valid_at?: string;
  };
  query_embedding?: number[];
  /** Added only by a trusted transport after public contract validation. */
  activity_context?: ActivityContext;
}

export interface RetrievalHit {
  id: string;
  score: number;
  brain_id: string;
  classification: Classification;
  source_id: string;
  content_reference: string;
  excerpt: string;
  citations: string[];
  valid_from: string;
  valid_until: string | null;
  score_components: Partial<Record<'keyword' | 'vector' | 'graph' | 'reranker', number>>;
}

export interface RetrievalResponse {
  request_id: string;
  trace_id: string;
  hits: RetrievalHit[];
  gaps: Array<{
    code: 'no_results' | 'uncited_result' | 'stale_result' | 'contradictory_results';
    message: string;
    related_ids: string[];
  }>;
}

export interface EngineHealth {
  status: 'ready' | 'degraded' | 'unavailable';
  engine: string;
  details: Record<string, string | number | boolean>;
}

export interface BrainActivity {
  sequence: number;
  occurred_at: string;
  tenant_id: string;
  brain_id: string;
  kind:
    | 'ingestion'
    | 'retrieval'
    | 'agent_session'
    | 'agent_handoff'
    | 'guard'
    | 'effect'
    | 'mcp'
    | 'authorization'
    | 'failure'
    | 'workforce';
  status: 'accepted' | 'completed' | 'rejected' | 'proposed';
  subject_id: string;
  summary: string;
  actor_id: string;
  request_id: string;
  trace_id: string;
  correlation_id: string;
  causation_id: string | null;
  operation: string;
  details_hash: string;
  policy_fingerprint: string | null;
  previous_hash: string | null;
  event_hash: string;
  integrity_method: 'sha256-chain' | 'hmac-sha256-chain';
}

export interface ActivityContext {
  actor_id: string;
  request_id: string;
  trace_id?: string;
  correlation_id?: string;
  causation_id?: string | null;
  operation?: string;
  details_hash?: string;
  policy_fingerprint?: string | null;
}

export interface AuditIntegrityReport {
  tenant_id: string;
  brain_id: string;
  valid: boolean;
  checked_events: number;
  legacy_events: number;
  first_invalid_sequence: number | null;
  integrity_method: 'sha256-chain' | 'hmac-sha256-chain';
}

export interface GuardProposalReservation {
  proposal_id: string;
  tenant_id: string;
  brain_id: string;
  session_id: string;
  action_key: string;
  idempotency_key: string | null;
}

export interface GuardReservationResult {
  duplicate: boolean;
  session_proposals: number;
  repeated_action_calls: number;
  existing_decision: unknown | null;
}

/**
 * Contract-first seam for embedded, PostgreSQL, graph-database, or remote engines.
 * Implementations must enforce tenant/classification filters before retrieval.
 */
export interface BrainEngine {
  readonly id: string;
  ingest(input: BrainIngestion): Promise<IngestionResult>;
  retrieve(request: RetrievalRequest): Promise<RetrievalResponse>;
  activity(tenantId: string, brainId: string, limit: number): Promise<BrainActivity[]>;
  recordActivity(
    tenantId: string,
    brainId: string,
    kind: BrainActivity['kind'],
    status: BrainActivity['status'],
    subjectId: string,
    summary: string,
    context?: ActivityContext,
  ): Promise<void>;
  verifyAuditChain(tenantId: string, brainId: string): Promise<AuditIntegrityReport>;
  saveAgentSession(session: AgentSession): Promise<void>;
  getAgentSession(
    sessionId: string,
    tenantId?: string,
    brainId?: string,
  ): Promise<AgentSession | null>;
  createWorkforceRecord(record: WorkforceRecord): Promise<boolean>;
  updateWorkforceRecord(record: WorkforceRecord, expectedRevision: number): Promise<boolean>;
  getWorkforceRecord(
    recordId: string,
    tenantId: string,
    brainId: string,
  ): Promise<WorkforceRecord | null>;
  listWorkforceRecords(
    tenantId: string,
    brainId: string,
    type: WorkforceRecordType,
    limit: number,
  ): Promise<WorkforceRecord[]>;
  checkoutWorkItem(input: WorkItemCheckout): Promise<WorkItem | null>;
  recordWorkforceCost(event: WorkforceCostEvent): Promise<boolean>;
  getWorkforceCostEvent(
    eventId: string,
    tenantId: string,
    brainId: string,
  ): Promise<WorkforceCostEvent | null>;
  workforceCostSummary(
    tenantId: string,
    brainId: string,
    filters: { agent_id?: string; goal_id?: string; work_item_id?: string },
  ): Promise<WorkforceCostSummary>;
  reserveGuardProposal(input: GuardProposalReservation): Promise<GuardReservationResult>;
  completeGuardProposal(
    proposalId: string,
    tenantId: string,
    brainId: string,
    decision: unknown,
  ): Promise<void>;
  reserveEffectExecution(
    proposalId: string,
    decisionId: string,
    tenantId: string,
    brainId: string,
  ): Promise<boolean>;
  completeEffectExecution(
    proposalId: string,
    tenantId: string,
    brainId: string,
    outcome: unknown,
  ): Promise<void>;
  graphSnapshot(
    tenantId: string,
    brainId: string,
    classifications: Classification[],
  ): Promise<CortexGraphSnapshot>;
  health(): Promise<EngineHealth>;
  close(): Promise<void>;
}
