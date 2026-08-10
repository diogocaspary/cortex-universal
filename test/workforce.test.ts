import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AgentCoordinator } from '../src/agents/coordinator.js';
import { EmbeddedBrainEngine } from '../src/brain/embedded-engine.js';
import { createCortexGraphSnapshot, type CortexGraphSnapshot } from '../src/graph.js';
import { repositoryRoot } from '../src/paths.js';
import { SchemaRegistry } from '../src/schema.js';
import { WorkforceService } from '../src/workforce/workforce-service.js';

describe('governed agent workforce', () => {
  const root = repositoryRoot();
  const tenantId = 'tenant:workforce';
  const brainId = 'brain:workforce';
  let schemas: SchemaRegistry;
  let graph: CortexGraphSnapshot;
  let engine: EmbeddedBrainEngine;
  let workforce: WorkforceService;

  beforeAll(async () => {
    [schemas, graph] = await Promise.all([
      SchemaRegistry.create(root),
      createCortexGraphSnapshot(root),
    ]);
  });

  beforeEach(async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cortex-workforce-test-'));
    engine = new EmbeddedBrainEngine(
      join(directory, 'cortex.db'),
      graph,
      'workforce-audit-secret-longer-than-thirty-two-bytes',
    );
    workforce = new WorkforceService(engine, await AgentCoordinator.create(root, schemas, engine));
  });

  afterEach(async () => engine.close());

  async function goal() {
    return workforce.createGoal({
      tenant_id: tenantId,
      brain_id: brainId,
      classification: 'internal',
      title: 'Validate a governed workforce flow',
      description: 'Complete one real, evidence-bearing task through independent review.',
      success_criteria: [
        {
          id: 'flow_verified',
          description: 'The complete state machine is verified by automated tests.',
          verification_method: 'test',
          required: true,
        },
      ],
      owner_agent_id: 'orchestrator',
      idempotency_key: 'goal-workforce-flow-0001',
    });
  }

  async function workItem(goalId: string, idempotencyKey = 'workforce-item-0001') {
    return workforce.createWorkItem({
      tenant_id: tenantId,
      brain_id: brainId,
      classification: 'internal',
      goal_id: goalId,
      title: 'Validate workforce contracts',
      description: 'Run the contracted checks and attach the persisted test evidence.',
      priority: 2,
      assigned_agent_id: 'ontologist',
      required_capabilities: ['ontology.validate'],
      acceptance_criteria: [
        {
          id: 'tests_pass',
          description: 'The repository test report is attached as evidence.',
          verification_method: 'test',
          required: true,
        },
      ],
      blocked_by: [],
      budget: {
        max_total_tokens: 10_000,
        max_cost_microusd: 2_000_000,
        max_duration_ms: 120_000,
      },
      review_required: true,
      source: 'human',
      idempotency_key: idempotencyKey,
    });
  }

  it('runs atomic checkout, independent review, real cost, heartbeat, and evaluation', async () => {
    const createdGoal = await goal();
    expect((await goal()).id).toBe(createdGoal.id);
    const item = await workItem(createdGoal.id);

    const attempts = await Promise.allSettled([
      workforce.checkout({
        tenant_id: tenantId,
        brain_id: brainId,
        classification: 'internal',
        work_item_id: item.id,
        agent_id: 'ontologist',
        lease_seconds: 60,
      }),
      workforce.checkout({
        tenant_id: tenantId,
        brain_id: brainId,
        classification: 'internal',
        work_item_id: item.id,
        agent_id: 'ontologist',
        lease_seconds: 60,
      }),
    ]);
    expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === 'rejected')).toHaveLength(1);

    const submitted = await workforce.transition({
      tenant_id: tenantId,
      brain_id: brainId,
      classification: 'internal',
      work_item_id: item.id,
      actor_agent_id: 'ontologist',
      target_status: 'review',
      evidence_ids: ['urn:cortex:test-report:workforce-0001'],
    });
    expect(submitted.status).toBe('review');

    await expect(
      workforce.transition({
        tenant_id: tenantId,
        brain_id: brainId,
        classification: 'internal',
        work_item_id: item.id,
        actor_agent_id: 'ontologist',
        target_status: 'approved',
        evidence_ids: ['urn:cortex:self-review:denied'],
      }),
    ).rejects.toMatchObject({ code: 'self_review_denied' });

    const approved = await workforce.transition({
      tenant_id: tenantId,
      brain_id: brainId,
      classification: 'internal',
      work_item_id: item.id,
      actor_agent_id: 'verifier',
      reviewer_agent_id: 'verifier',
      target_status: 'approved',
      evidence_ids: ['urn:cortex:review:workforce-0001'],
    });
    expect(approved.review).toMatchObject({
      reviewer_agent_id: 'verifier',
      status: 'approved',
    });

    const completed = await workforce.transition({
      tenant_id: tenantId,
      brain_id: brainId,
      classification: 'internal',
      work_item_id: item.id,
      actor_agent_id: 'ontologist',
      target_status: 'completed',
      evidence_ids: [],
    });
    expect(completed.status).toBe('completed');

    const costInput = {
      tenant_id: tenantId,
      brain_id: brainId,
      classification: 'internal' as const,
      agent_id: 'ontologist',
      goal_id: createdGoal.id,
      work_item_id: item.id,
      provider: 'provider-under-test',
      model: 'model-under-test',
      input_tokens: 120,
      output_tokens: 40,
      cached_input_tokens: 20,
      cost_microusd: 375,
      measurement_status: 'provider-reported' as const,
      evidence_reference: 'urn:cortex:provider-meter:workforce-0001',
      occurred_at: new Date().toISOString(),
      idempotency_key: 'cost-workforce-item-0001',
    };
    const cost = await workforce.recordCost(costInput);
    expect(cost.summary).toMatchObject({
      total_tokens: 160,
      cost_microusd: 375,
      event_count: 1,
    });
    expect((await workforce.recordCost(costInput)).event.id).toBe(cost.event.id);

    const heartbeat = await workforce.recordHeartbeat({
      tenant_id: tenantId,
      brain_id: brainId,
      classification: 'internal',
      agent_id: 'ontologist',
      status: 'idle',
      current_work_item_id: null,
      observed_at: new Date().toISOString(),
      evidence_reference: 'urn:cortex:heartbeat-observation:workforce-0001',
      idempotency_key: 'heartbeat-workforce-0001',
    });
    expect(heartbeat.status).toBe('idle');

    const evaluation = await workforce.evaluate({
      tenant_id: tenantId,
      brain_id: brainId,
      classification: 'internal',
      agent_id: 'ontologist',
      work_item_id: item.id,
      evaluator_id: 'verifier',
      quality: 0.9,
      correctness: 1,
      efficiency: 0.8,
      policy_compliance: 1,
      evidence_ids: ['urn:cortex:test-report:workforce-0001'],
      notes_reference: 'urn:cortex:evaluation:workforce-0001',
      idempotency_key: 'evaluation-workforce-0001',
    });
    expect(evaluation.evaluator_id).toBe('verifier');

    const snapshot = await workforce.snapshot(tenantId, brainId);
    expect(snapshot).toMatchObject({
      goals: [{ id: createdGoal.id }],
      work_items: [{ id: item.id, status: 'completed' }],
      heartbeats: [{ id: heartbeat.id }],
      evaluations: [{ id: evaluation.id }],
      costs: { event_count: 1, total_tokens: 160, cost_microusd: 375 },
    });
    expect((await workforce.snapshot('tenant:other', brainId)).goals).toEqual([]);
  });

  it('materializes due routines once and enforces duration budgets', async () => {
    const createdGoal = await goal();
    const now = new Date();
    const routine = await workforce.createRoutine({
      tenant_id: tenantId,
      brain_id: brainId,
      classification: 'internal',
      name: 'Periodic ontology verification',
      goal_id: createdGoal.id,
      assigned_agent_id: 'ontologist',
      interval_seconds: 3600,
      next_run_at: new Date(now.getTime() - 1_000).toISOString(),
      template: {
        title: 'Verify ontology package',
        description: 'Run the bounded repository ontology verification suite.',
        priority: 3,
        required_capabilities: ['ontology.validate'],
        acceptance_criteria: [
          {
            id: 'ontology_valid',
            description: 'The validation report is attached.',
            verification_method: 'test',
            required: true,
          },
        ],
        budget: {
          max_total_tokens: 1_000,
          max_cost_microusd: 100_000,
          max_duration_ms: 60_000,
        },
        review_required: true,
      },
      idempotency_key: 'routine-workforce-0001',
    });
    expect(routine.status).toBe('active');

    const first = await workforce.materializeDueRoutines(
      tenantId,
      brainId,
      'internal',
      now.toISOString(),
    );
    expect(first.materialized).toHaveLength(1);
    const second = await workforce.materializeDueRoutines(
      tenantId,
      brainId,
      'internal',
      now.toISOString(),
    );
    expect(second.materialized).toHaveLength(0);

    await expect(
      workforce.checkout({
        tenant_id: tenantId,
        brain_id: brainId,
        classification: 'internal',
        work_item_id: first.materialized[0]!.id,
        agent_id: 'ontologist',
        lease_seconds: 61,
      }),
    ).rejects.toMatchObject({ code: 'budget_exhausted' });
  });

  it('rejects semantically inconsistent evidence, heartbeat and metering claims', async () => {
    const createdGoal = await goal();
    await expect(
      workforce.createWorkItem({
        tenant_id: tenantId,
        brain_id: brainId,
        classification: 'internal',
        goal_id: createdGoal.id,
        title: 'Require a human decision',
        description: 'This work cannot complete without an independent human approval gate.',
        priority: 1,
        assigned_agent_id: 'ontologist',
        required_capabilities: [],
        acceptance_criteria: [
          {
            id: 'human_decision',
            description: 'An authorized human records the decision.',
            verification_method: 'human-approval',
            required: true,
          },
        ],
        blocked_by: [],
        budget: {
          max_total_tokens: 100,
          max_cost_microusd: 1_000,
          max_duration_ms: 60_000,
        },
        review_required: false,
        idempotency_key: 'human-review-bypass-denied-0001',
      }),
    ).rejects.toThrow('requires independent review');

    await expect(
      workforce.recordHeartbeat({
        tenant_id: tenantId,
        brain_id: brainId,
        classification: 'internal',
        agent_id: 'ontologist',
        status: 'working',
        current_work_item_id: null,
        observed_at: new Date().toISOString(),
        evidence_reference: 'urn:cortex:heartbeat-observation:invalid-working',
        idempotency_key: 'heartbeat-invalid-working-0001',
      }),
    ).rejects.toThrow('requires current_work_item_id');

    const item = await workItem(createdGoal.id, 'future-cost-item-0001');
    await expect(
      workforce.recordCost({
        tenant_id: tenantId,
        brain_id: brainId,
        classification: 'internal',
        agent_id: 'ontologist',
        goal_id: createdGoal.id,
        work_item_id: item.id,
        provider: 'provider-under-test',
        model: 'model-under-test',
        input_tokens: 1,
        output_tokens: 0,
        cached_input_tokens: 2,
        cost_microusd: 1,
        measurement_status: 'provider-reported',
        evidence_reference: 'urn:cortex:provider-meter:invalid-cache-count',
        occurred_at: new Date().toISOString(),
        idempotency_key: 'cost-invalid-cache-count-0001',
      }),
    ).rejects.toThrow('cannot exceed input_tokens');
  });
});
