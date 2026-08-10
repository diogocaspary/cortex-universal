import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresBrainEngine } from '../src/brain/postgres-engine.js';
import type { BrainIngestion } from '../src/brain/engine.js';
import { createCortexGraphSnapshot } from '../src/graph.js';
import { repositoryRoot } from '../src/paths.js';
import type {
  WorkforceCostEvent,
  WorkforceGoal,
  WorkforceHeartbeat,
  WorkItem,
} from '../src/workforce/contracts.js';

const connectionString = process.env.CORTEX_TEST_POSTGRES_URL;
const integration = connectionString ? describe : describe.skip;

integration('PostgreSQL/pgvector BrainEngine integration', () => {
  let engine: PostgresBrainEngine;
  const scope = randomUUID();
  const tenantId = `tenant:test:${scope}`;
  const brainId = `brain:test:${scope}`;

  beforeAll(async () => {
    engine = new PostgresBrainEngine(
      connectionString!,
      await createCortexGraphSnapshot(repositoryRoot()),
      'integration-audit-secret-longer-than-thirty-two-bytes',
    );
    expect(await engine.health()).toMatchObject({ status: 'ready', details: { pgvector: true } });
  });

  afterAll(async () => engine?.close());

  it('persists, retrieves, scopes and verifies an audit chain under RLS', async () => {
    const text = 'Registro real criado somente pelo teste de integração PostgreSQL.';
    const ingestion: BrainIngestion = {
      envelope: {
        id: `evidence:${scope}`,
        tenant_id: tenantId,
        brain_id: brainId,
        source_id: 'integration-attested-source',
        captured_at: new Date().toISOString(),
        classification: 'internal',
        content_hash: `sha256:${createHash('sha256').update(text).digest('hex')}`,
        media_type: 'text/plain',
        content_reference: `urn:cortex:integration:${scope}`,
        idempotency_key: `integration:${scope}`,
        provenance: {
          actor_id: 'service:postgres-integration-test',
          system: 'integration-suite',
          correlation_id: `correlation:${scope}`,
        },
      },
      projection: { text, citations: [`urn:cortex:integration:${scope}`] },
      source_verification: {
        source_id: 'integration-attested-source',
        registry_version: 'integration-test',
        status: 'cryptographically-attested',
        verified_at: new Date().toISOString(),
        key_id: 'integration-key',
        signed_payload_hash: `sha256:${'a'.repeat(64)}`,
      },
    };
    expect(await engine.ingest(ingestion)).toMatchObject({ accepted: true, status: 'indexed' });
    const response = await engine.retrieve({
      request_id: `request:${scope}`,
      tenant_id: tenantId,
      brain_id: brainId,
      requester_id: 'service:postgres-integration-test',
      query: 'integração PostgreSQL',
      purpose: 'integration-test',
      modes: ['keyword'],
      allowed_classifications: ['internal'],
      limit: 10,
      as_of: new Date().toISOString(),
    });
    expect(response.hits).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: ingestion.envelope.id })]),
    );
    expect(await engine.verifyAuditChain(tenantId, brainId)).toMatchObject({ valid: true });
    const isolated = await engine.retrieve({
      request_id: `request:isolated:${scope}`,
      tenant_id: `${tenantId}:other`,
      brain_id: brainId,
      requester_id: 'service:postgres-integration-test',
      query: 'integração PostgreSQL',
      purpose: 'integration-test-isolation',
      modes: ['keyword'],
      allowed_classifications: ['internal'],
      limit: 10,
      as_of: new Date().toISOString(),
    });
    expect(isolated.hits).toEqual([]);
  });

  it('enforces scoped workforce records, atomic checkout, and immutable measured costs', async () => {
    const now = new Date().toISOString();
    const goal: WorkforceGoal = {
      id: `goal:${scope.replaceAll('-', '').slice(0, 32)}`,
      tenant_id: tenantId,
      brain_id: brainId,
      record_type: 'goal',
      classification: 'internal',
      revision: 1,
      created_at: now,
      updated_at: now,
      parent_goal_id: null,
      title: 'PostgreSQL integration goal',
      description: 'Exercise the production workforce projection under forced RLS.',
      status: 'active',
      success_criteria: [
        {
          id: 'postgres_verified',
          description: 'The pgvector job passes.',
          verification_method: 'test',
          required: true,
        },
      ],
      owner_agent_id: 'orchestrator',
      idempotency_key: `goal:${scope}`,
      request_hash: `sha256:${'a'.repeat(64)}`,
    };
    const item: WorkItem = {
      id: `work:${scope.replaceAll('-', '').slice(0, 32)}`,
      tenant_id: tenantId,
      brain_id: brainId,
      record_type: 'work_item',
      classification: 'internal',
      revision: 1,
      created_at: now,
      updated_at: now,
      goal_id: goal.id,
      parent_work_item_id: null,
      title: 'Verify PostgreSQL workforce projection',
      description: 'Acquire exactly one lease and record one provider-metered cost.',
      status: 'ready',
      priority: 2,
      assigned_agent_id: 'ontologist',
      required_capabilities: ['ontology.validate'],
      acceptance_criteria: goal.success_criteria,
      evidence_ids: [],
      blocked_by: [],
      budget: { max_total_tokens: 1_000, max_cost_microusd: 10_000, max_duration_ms: 60_000 },
      lease: null,
      review: {
        required: true,
        reviewer_agent_id: null,
        status: 'pending',
        evidence_ids: [],
        reviewed_at: null,
      },
      source: 'human',
      source_routine_id: null,
      scheduled_for: null,
      idempotency_key: `work:${scope}`,
      request_hash: `sha256:${'b'.repeat(64)}`,
    };
    expect(await engine.createWorkforceRecord(goal)).toBe(true);
    expect(await engine.createWorkforceRecord(item)).toBe(true);

    const acquired = new Date();
    const attempts = await Promise.all([
      engine.checkoutWorkItem({
        tenant_id: tenantId,
        brain_id: brainId,
        work_item_id: item.id,
        agent_id: 'ontologist',
        checkout_id: `checkout:a:${scope}`,
        acquired_at: acquired.toISOString(),
        expires_at: new Date(acquired.getTime() + 30_000).toISOString(),
      }),
      engine.checkoutWorkItem({
        tenant_id: tenantId,
        brain_id: brainId,
        work_item_id: item.id,
        agent_id: 'ontologist',
        checkout_id: `checkout:b:${scope}`,
        acquired_at: acquired.toISOString(),
        expires_at: new Date(acquired.getTime() + 30_000).toISOString(),
      }),
    ]);
    expect(attempts.filter(Boolean)).toHaveLength(1);

    const heartbeat: WorkforceHeartbeat = {
      id: `heartbeat:${scope.replaceAll('-', '').slice(0, 32)}`,
      tenant_id: tenantId,
      brain_id: brainId,
      record_type: 'heartbeat',
      classification: 'internal',
      revision: 1,
      created_at: now,
      updated_at: now,
      agent_id: 'ontologist',
      status: 'working',
      current_work_item_id: item.id,
      observed_at: now,
      evidence_reference: `urn:cortex:postgres-heartbeat:${scope}`,
      idempotency_key: `heartbeat:${scope}`,
      request_hash: `sha256:${'c'.repeat(64)}`,
    };
    expect(await engine.createWorkforceRecord(heartbeat)).toBe(true);

    const cost: WorkforceCostEvent = {
      id: `cost:${scope.replaceAll('-', '').slice(0, 32)}`,
      tenant_id: tenantId,
      brain_id: brainId,
      agent_id: 'ontologist',
      goal_id: goal.id,
      work_item_id: item.id,
      provider: 'postgres-integration-provider',
      model: 'postgres-integration-model',
      input_tokens: 10,
      output_tokens: 5,
      cached_input_tokens: 2,
      cost_microusd: 25,
      measurement_status: 'provider-reported',
      evidence_reference: `urn:cortex:postgres-meter:${scope}`,
      occurred_at: now,
      idempotency_key: `cost:${scope}`,
    };
    expect(await engine.recordWorkforceCost(cost)).toBe(true);
    expect(await engine.getWorkforceCostEvent(cost.id, tenantId, brainId)).toEqual(cost);
    expect(await engine.workforceCostSummary(tenantId, brainId, {})).toMatchObject({
      total_tokens: 15,
      cost_microusd: 25,
      event_count: 1,
    });
    expect(await engine.listWorkforceRecords(`${tenantId}:other`, brainId, 'goal', 10)).toEqual([]);
  });
});
