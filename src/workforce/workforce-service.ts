import { createHash, randomUUID } from 'node:crypto';
import type { AgentCoordinator } from '../agents/coordinator.js';
import type { ActivityContext, BrainEngine } from '../brain/engine.js';
import type { Classification } from '../policy.js';
import type {
  SuccessCriterion,
  WorkBudget,
  WorkforceCostEvent,
  WorkforceEvaluation,
  WorkforceGoal,
  WorkforceHeartbeat,
  WorkforceRecord,
  WorkforceRecordType,
  WorkforceRoutine,
  WorkforceSnapshot,
  WorkItem,
  WorkItemStatus,
} from './contracts.js';

const TERMINAL = new Set<WorkItemStatus>(['completed', 'failed', 'cancelled']);
const TRANSITIONS: Record<WorkItemStatus, WorkItemStatus[]> = {
  ready: ['blocked', 'cancelled'],
  in_progress: ['blocked', 'review', 'failed', 'cancelled'],
  blocked: ['ready', 'cancelled'],
  review: ['approved', 'in_progress', 'failed'],
  approved: ['completed', 'in_progress'],
  completed: [],
  failed: [],
  cancelled: [],
};

export class WorkforceError extends Error {
  constructor(
    readonly code:
      | 'goal_not_found'
      | 'work_item_not_found'
      | 'routine_not_found'
      | 'record_conflict'
      | 'invalid_transition'
      | 'work_item_blocked'
      | 'work_item_already_checked_out'
      | 'budget_exhausted'
      | 'review_required'
      | 'evidence_required'
      | 'self_review_denied',
    message: string,
  ) {
    super(message);
    this.name = 'WorkforceError';
  }
}

interface ScopedInput {
  tenant_id: string;
  brain_id: string;
  classification: Classification;
}

function deterministicId(prefix: string, ...values: string[]): string {
  return `${prefix}:${createHash('sha256').update(values.join('\n')).digest('hex').slice(0, 32)}`;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
    .join(',')}}`;
}

function requestHash(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonical(value), 'utf8').digest('hex')}`;
}

function assertIdempotent(existingHash: string, expectedHash: string): void {
  if (existingHash !== expectedHash) {
    throw new WorkforceError(
      'record_conflict',
      'Idempotency key already exists with a different contracted request.',
    );
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function ensureDate(value: string, label: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be a valid date-time.`);
  return parsed;
}

function evidenceRequired(criteria: SuccessCriterion[]): boolean {
  return criteria.some((criterion) => criterion.required);
}

function assertCriteria(criteria: SuccessCriterion[], reviewRequired?: boolean): void {
  if (new Set(criteria.map((criterion) => criterion.id)).size !== criteria.length) {
    throw new Error('Success and acceptance criterion identifiers must be unique.');
  }
  if (
    reviewRequired === false &&
    criteria.some(
      (criterion) => criterion.required && criterion.verification_method === 'human-approval',
    )
  ) {
    throw new Error('A required human-approval criterion requires independent review.');
  }
}

export class WorkforceService {
  readonly #engine: BrainEngine;
  readonly #agents: AgentCoordinator;

  constructor(engine: BrainEngine, agents: AgentCoordinator) {
    this.#engine = engine;
    this.#agents = agents;
  }

  async createGoal(
    input: ScopedInput & {
      parent_goal_id?: string | null;
      title: string;
      description: string;
      success_criteria: SuccessCriterion[];
      owner_agent_id: string;
      idempotency_key: string;
    },
    context?: ActivityContext,
  ): Promise<WorkforceGoal> {
    this.#agents.assertCapability(input.owner_agent_id, 'goal.manage', [input.classification]);
    assertCriteria(input.success_criteria);
    if (input.parent_goal_id) {
      const parent = await this.#record<WorkforceGoal>(
        input.parent_goal_id,
        input.tenant_id,
        input.brain_id,
        'goal',
      );
      if (!parent) throw new WorkforceError('goal_not_found', 'Parent goal was not found.');
      if (parent.classification !== input.classification) {
        throw new Error('Parent goal classification must match the new goal.');
      }
    }
    const now = new Date().toISOString();
    const inputHash = requestHash(input);
    const goal: WorkforceGoal = {
      id: deterministicId('goal', input.tenant_id, input.brain_id, input.idempotency_key),
      tenant_id: input.tenant_id,
      brain_id: input.brain_id,
      record_type: 'goal',
      classification: input.classification,
      revision: 1,
      created_at: now,
      updated_at: now,
      parent_goal_id: input.parent_goal_id ?? null,
      title: input.title,
      description: input.description,
      status: 'active',
      success_criteria: input.success_criteria,
      owner_agent_id: input.owner_agent_id,
      idempotency_key: input.idempotency_key,
      request_hash: inputHash,
    };
    const created = await this.#engine.createWorkforceRecord(goal);
    const result = created
      ? goal
      : await this.#requiredRecord<WorkforceGoal>(
          goal.id,
          goal.tenant_id,
          goal.brain_id,
          'goal',
          'goal_not_found',
        );
    if (!created) assertIdempotent(result.request_hash, inputHash);
    if (created) await this.#activity(result, 'proposed', 'Workforce goal created.', context);
    return result;
  }

  async createWorkItem(
    input: ScopedInput & {
      goal_id: string;
      parent_work_item_id?: string | null;
      title: string;
      description: string;
      priority: 1 | 2 | 3 | 4 | 5;
      assigned_agent_id: string;
      required_capabilities: string[];
      acceptance_criteria: SuccessCriterion[];
      blocked_by: string[];
      budget: WorkBudget;
      review_required: boolean;
      source?: 'human' | 'routine' | 'agent-proposal';
      source_routine_id?: string | null;
      scheduled_for?: string | null;
      idempotency_key: string;
      id?: string;
    },
    context?: ActivityContext,
  ): Promise<WorkItem> {
    const goal = await this.#record<WorkforceGoal>(
      input.goal_id,
      input.tenant_id,
      input.brain_id,
      'goal',
    );
    if (!goal || goal.status !== 'active') {
      throw new WorkforceError('goal_not_found', 'An active goal is required.');
    }
    if (goal.classification !== input.classification) {
      throw new Error('Work-item classification must match its goal.');
    }
    assertCriteria(input.acceptance_criteria, input.review_required);
    const agent = this.#agents.assertCapability(input.assigned_agent_id, 'work.execute', [
      input.classification,
    ]);
    for (const capability of input.required_capabilities) {
      if (!agent.capabilities.includes(capability)) {
        throw new Error(`Agent '${agent.id}' lacks required capability '${capability}'.`);
      }
    }
    if (input.parent_work_item_id) {
      const parent = await this.#record<WorkItem>(
        input.parent_work_item_id,
        input.tenant_id,
        input.brain_id,
        'work_item',
      );
      if (!parent)
        throw new WorkforceError('work_item_not_found', 'Parent work item was not found.');
      if (parent.classification !== input.classification) {
        throw new Error('Parent work-item classification must match the new work item.');
      }
    }
    const blockers = await Promise.all(
      unique(input.blocked_by).map((id) =>
        this.#record<WorkItem>(id, input.tenant_id, input.brain_id, 'work_item'),
      ),
    );
    if (blockers.some((blocker) => !blocker)) {
      throw new WorkforceError('work_item_not_found', 'A blocking work item was not found.');
    }
    if (blockers.some((blocker) => blocker?.classification !== input.classification)) {
      throw new Error('Blocking work-item classifications must match the new work item.');
    }
    const now = new Date().toISOString();
    const inputHash = requestHash(input);
    const workItem: WorkItem = {
      id:
        input.id ?? deterministicId('work', input.tenant_id, input.brain_id, input.idempotency_key),
      tenant_id: input.tenant_id,
      brain_id: input.brain_id,
      record_type: 'work_item',
      classification: input.classification,
      revision: 1,
      created_at: now,
      updated_at: now,
      goal_id: input.goal_id,
      parent_work_item_id: input.parent_work_item_id ?? null,
      title: input.title,
      description: input.description,
      status: blockers.some((blocker) => blocker?.status !== 'completed') ? 'blocked' : 'ready',
      priority: input.priority,
      assigned_agent_id: input.assigned_agent_id,
      required_capabilities: unique(input.required_capabilities),
      acceptance_criteria: input.acceptance_criteria,
      evidence_ids: [],
      blocked_by: unique(input.blocked_by),
      budget: input.budget,
      lease: null,
      review: {
        required: input.review_required,
        reviewer_agent_id: null,
        status: input.review_required ? 'pending' : 'not_required',
        evidence_ids: [],
        reviewed_at: null,
      },
      source: input.source ?? 'human',
      source_routine_id: input.source_routine_id ?? null,
      scheduled_for: input.scheduled_for ?? null,
      idempotency_key: input.idempotency_key,
      request_hash: inputHash,
    };
    const created = await this.#engine.createWorkforceRecord(workItem);
    const result = created
      ? workItem
      : await this.#requiredRecord<WorkItem>(
          workItem.id,
          workItem.tenant_id,
          workItem.brain_id,
          'work_item',
          'work_item_not_found',
        );
    if (!created) assertIdempotent(result.request_hash, inputHash);
    if (created) await this.#activity(result, 'proposed', 'Work item created.', context);
    return result;
  }

  async checkout(
    input: {
      tenant_id: string;
      brain_id: string;
      classification: Classification;
      work_item_id: string;
      agent_id: string;
      lease_seconds: number;
    },
    context?: ActivityContext,
  ): Promise<WorkItem> {
    const item = await this.#requiredRecord<WorkItem>(
      input.work_item_id,
      input.tenant_id,
      input.brain_id,
      'work_item',
      'work_item_not_found',
    );
    if (input.classification !== item.classification) {
      throw new Error('Checkout classification does not match the governed work item.');
    }
    this.#agents.assertCapability(input.agent_id, 'work.execute', [item.classification]);
    if (item.assigned_agent_id !== input.agent_id) {
      throw new Error('Only the assigned agent can check out this work item.');
    }
    const unresolved = await this.#unresolvedBlockers(item);
    if (unresolved.length > 0) {
      throw new WorkforceError(
        'work_item_blocked',
        `Work item has unresolved blockers: ${unresolved.join(', ')}.`,
      );
    }
    const [itemCosts, agentCosts] = await Promise.all([
      this.#engine.workforceCostSummary(input.tenant_id, input.brain_id, {
        work_item_id: item.id,
      }),
      this.#engine.workforceCostSummary(input.tenant_id, input.brain_id, {
        agent_id: input.agent_id,
      }),
    ]);
    const agentBudget = this.#agents.definition(input.agent_id).budget;
    const requestedLeaseMs = input.lease_seconds * 1_000;
    if (
      requestedLeaseMs > item.budget.max_duration_ms ||
      requestedLeaseMs > agentBudget.max_run_duration_ms
    ) {
      throw new WorkforceError(
        'budget_exhausted',
        'Requested lease exceeds the work-item or agent duration budget.',
      );
    }
    if (
      itemCosts.total_tokens >= item.budget.max_total_tokens ||
      itemCosts.cost_microusd >= item.budget.max_cost_microusd ||
      agentCosts.total_tokens >= agentBudget.max_total_tokens ||
      agentCosts.cost_microusd >= agentBudget.max_cost_microusd
    ) {
      throw new WorkforceError('budget_exhausted', 'A work-item or agent budget is exhausted.');
    }
    const acquiredAt = new Date();
    const checkedOut = await this.#engine.checkoutWorkItem({
      tenant_id: input.tenant_id,
      brain_id: input.brain_id,
      work_item_id: item.id,
      agent_id: input.agent_id,
      checkout_id: `checkout:${randomUUID()}`,
      acquired_at: acquiredAt.toISOString(),
      expires_at: new Date(acquiredAt.getTime() + input.lease_seconds * 1_000).toISOString(),
    });
    if (!checkedOut) {
      throw new WorkforceError(
        'work_item_already_checked_out',
        'Work item is not ready or has an active lease.',
      );
    }
    await this.#activity(checkedOut, 'accepted', 'Work item checked out atomically.', context);
    return checkedOut;
  }

  async transition(
    input: {
      tenant_id: string;
      brain_id: string;
      classification: Classification;
      work_item_id: string;
      actor_agent_id: string;
      target_status: WorkItemStatus;
      evidence_ids: string[];
      reviewer_agent_id?: string | null;
    },
    context?: ActivityContext,
  ): Promise<WorkItem> {
    const item = await this.#requiredRecord<WorkItem>(
      input.work_item_id,
      input.tenant_id,
      input.brain_id,
      'work_item',
      'work_item_not_found',
    );
    if (input.classification !== item.classification) {
      throw new Error('Transition classification does not match the governed work item.');
    }
    if (!TRANSITIONS[item.status].includes(input.target_status)) {
      throw new WorkforceError(
        'invalid_transition',
        `Transition from ${item.status} to ${input.target_status} is not allowed.`,
      );
    }
    const evidenceIds = unique([...item.evidence_ids, ...input.evidence_ids]);
    let review = structuredClone(item.review);
    const independentReviewAction =
      item.status === 'review' &&
      item.review.required &&
      (input.target_status === 'approved' || input.target_status === 'in_progress');
    if (independentReviewAction) {
      this.#agents.assertCapability(input.actor_agent_id, 'work.review', [item.classification]);
    } else if (
      input.target_status === 'cancelled' &&
      input.actor_agent_id !== item.assigned_agent_id
    ) {
      this.#agents.assertCapability(input.actor_agent_id, 'work.plan', [item.classification]);
    } else {
      this.#agents.assertCapability(input.actor_agent_id, 'work.execute', [item.classification]);
      if (input.actor_agent_id !== item.assigned_agent_id) {
        throw new Error('Only the assigned agent can transition execution state.');
      }
    }
    if (item.status === 'in_progress' && input.target_status === 'review') {
      if (evidenceRequired(item.acceptance_criteria) && evidenceIds.length === 0) {
        throw new WorkforceError('evidence_required', 'Review submission requires evidence.');
      }
      review.status = item.review.required ? 'pending' : 'not_required';
    }
    if (item.status === 'review' && input.target_status === 'approved') {
      if (item.review.required) {
        const reviewer = input.reviewer_agent_id ?? input.actor_agent_id;
        if (reviewer !== input.actor_agent_id) {
          throw new Error('reviewer_agent_id must match the acting agent.');
        }
        if (reviewer === item.assigned_agent_id) {
          throw new WorkforceError(
            'self_review_denied',
            'The executing agent cannot self-approve.',
          );
        }
        this.#agents.assertCapability(reviewer, 'work.review', [item.classification]);
        review = {
          ...review,
          reviewer_agent_id: reviewer,
          status: 'approved',
          evidence_ids: unique([...review.evidence_ids, ...input.evidence_ids]),
          reviewed_at: new Date().toISOString(),
        };
      }
    }
    if (item.status === 'review' && input.target_status === 'in_progress') {
      const reviewer = input.reviewer_agent_id ?? input.actor_agent_id;
      if (!item.review.required) {
        throw new WorkforceError(
          'invalid_transition',
          'Changes can only be requested when independent review is required.',
        );
      }
      if (reviewer !== input.actor_agent_id) {
        throw new Error('reviewer_agent_id must match the acting agent.');
      }
      if (reviewer === item.assigned_agent_id) {
        throw new WorkforceError('self_review_denied', 'The executing agent cannot self-review.');
      }
      this.#agents.assertCapability(reviewer, 'work.review', [item.classification]);
      review = {
        ...review,
        reviewer_agent_id: reviewer,
        status: 'changes_requested',
        evidence_ids: unique([...review.evidence_ids, ...input.evidence_ids]),
        reviewed_at: new Date().toISOString(),
      };
    }
    if (
      input.target_status === 'completed' &&
      item.review.required &&
      review.status !== 'approved'
    ) {
      throw new WorkforceError('review_required', 'Approved review is required before completion.');
    }
    const updated: WorkItem = {
      ...item,
      status: input.target_status,
      evidence_ids: evidenceIds,
      review,
      lease:
        TERMINAL.has(input.target_status) || input.target_status !== 'in_progress'
          ? null
          : item.lease,
      revision: item.revision + 1,
      updated_at: new Date().toISOString(),
    };
    const replaced = await this.#engine.updateWorkforceRecord(updated, item.revision);
    if (!replaced)
      throw new WorkforceError('record_conflict', 'Work item changed concurrently; retry.');
    await this.#activity(
      updated,
      input.target_status === 'completed' ? 'completed' : 'accepted',
      `Work item transitioned to ${input.target_status}.`,
      context,
    );
    return updated;
  }

  async createRoutine(
    input: ScopedInput & {
      name: string;
      goal_id: string;
      assigned_agent_id: string;
      interval_seconds: number;
      next_run_at: string;
      template: WorkforceRoutine['template'];
      idempotency_key: string;
    },
    context?: ActivityContext,
  ): Promise<WorkforceRoutine> {
    const goal = await this.#requiredRecord<WorkforceGoal>(
      input.goal_id,
      input.tenant_id,
      input.brain_id,
      'goal',
      'goal_not_found',
    );
    if (goal.status !== 'active') {
      throw new WorkforceError('goal_not_found', 'An active goal is required.');
    }
    if (goal.classification !== input.classification) {
      throw new Error('Routine classification must match its goal.');
    }
    assertCriteria(input.template.acceptance_criteria, input.template.review_required);
    this.#agents.assertCapability(input.assigned_agent_id, 'work.execute', [input.classification]);
    this.#agents.assertCapability(input.assigned_agent_id, 'routine.execute', [
      input.classification,
    ]);
    ensureDate(input.next_run_at, 'next_run_at');
    const now = new Date().toISOString();
    const inputHash = requestHash(input);
    const routine: WorkforceRoutine = {
      id: deterministicId('routine', input.tenant_id, input.brain_id, input.idempotency_key),
      tenant_id: input.tenant_id,
      brain_id: input.brain_id,
      record_type: 'routine',
      classification: input.classification,
      revision: 1,
      created_at: now,
      updated_at: now,
      name: input.name,
      status: 'active',
      goal_id: input.goal_id,
      assigned_agent_id: input.assigned_agent_id,
      interval_seconds: input.interval_seconds,
      next_run_at: input.next_run_at,
      template: input.template,
      idempotency_key: input.idempotency_key,
      request_hash: inputHash,
    };
    const created = await this.#engine.createWorkforceRecord(routine);
    const result = created
      ? routine
      : await this.#requiredRecord<WorkforceRoutine>(
          routine.id,
          routine.tenant_id,
          routine.brain_id,
          'routine',
          'routine_not_found',
        );
    if (!created) assertIdempotent(result.request_hash, inputHash);
    if (created) await this.#activity(result, 'proposed', 'Workforce routine created.', context);
    return result;
  }

  async materializeDueRoutines(
    tenantId: string,
    brainId: string,
    classification: Classification,
    nowValue: string,
    context?: ActivityContext,
  ): Promise<{ materialized: WorkItem[]; checked_at: string }> {
    const now = ensureDate(nowValue, 'now');
    const routines = await this.#list<WorkforceRoutine>(tenantId, brainId, 'routine', 500);
    const materialized: WorkItem[] = [];
    for (const routine of routines
      .filter(
        (candidate) =>
          candidate.status === 'active' &&
          candidate.classification === classification &&
          Date.parse(candidate.next_run_at) <= now,
      )
      .sort((left, right) => left.next_run_at.localeCompare(right.next_run_at))
      .slice(0, 100)) {
      const scheduledFor = routine.next_run_at;
      const idempotencyKey = `routine:${routine.id}:${scheduledFor}`;
      const item = await this.createWorkItem(
        {
          tenant_id: tenantId,
          brain_id: brainId,
          classification: routine.classification,
          goal_id: routine.goal_id,
          title: routine.template.title,
          description: routine.template.description,
          priority: routine.template.priority,
          assigned_agent_id: routine.assigned_agent_id,
          required_capabilities: routine.template.required_capabilities,
          acceptance_criteria: routine.template.acceptance_criteria,
          blocked_by: [],
          budget: routine.template.budget,
          review_required: routine.template.review_required,
          source: 'routine',
          source_routine_id: routine.id,
          scheduled_for: scheduledFor,
          idempotency_key: idempotencyKey,
          id: deterministicId('work', tenantId, brainId, idempotencyKey),
        },
        context,
      );
      materialized.push(item);
      let next = Date.parse(scheduledFor);
      do next += routine.interval_seconds * 1_000;
      while (next <= now);
      const advanced: WorkforceRoutine = {
        ...routine,
        next_run_at: new Date(next).toISOString(),
        updated_at: new Date().toISOString(),
        revision: routine.revision + 1,
      };
      const replaced = await this.#engine.updateWorkforceRecord(advanced, routine.revision);
      if (!replaced)
        throw new WorkforceError('record_conflict', 'Routine changed concurrently; retry.');
    }
    return { materialized, checked_at: new Date(now).toISOString() };
  }

  async recordCost(
    input: Omit<WorkforceCostEvent, 'id'> & { classification: Classification },
    context?: ActivityContext,
  ): Promise<{
    event: WorkforceCostEvent;
    summary: Awaited<ReturnType<BrainEngine['workforceCostSummary']>>;
  }> {
    const item = await this.#requiredRecord<WorkItem>(
      input.work_item_id,
      input.tenant_id,
      input.brain_id,
      'work_item',
      'work_item_not_found',
    );
    if (input.classification !== item.classification) {
      throw new Error('Cost classification does not match the governed work item.');
    }
    if (item.goal_id !== input.goal_id || item.assigned_agent_id !== input.agent_id) {
      throw new Error('Cost event scope does not match the governed work item.');
    }
    const occurredAt = ensureDate(input.occurred_at, 'occurred_at');
    if (occurredAt > Date.now() + 30_000) {
      throw new Error('occurred_at cannot be more than 30 seconds in the future.');
    }
    if (input.cached_input_tokens > input.input_tokens) {
      throw new Error('cached_input_tokens cannot exceed input_tokens.');
    }
    const event: WorkforceCostEvent = {
      tenant_id: input.tenant_id,
      brain_id: input.brain_id,
      agent_id: input.agent_id,
      goal_id: input.goal_id,
      work_item_id: input.work_item_id,
      provider: input.provider,
      model: input.model,
      input_tokens: input.input_tokens,
      output_tokens: input.output_tokens,
      cached_input_tokens: input.cached_input_tokens,
      cost_microusd: input.cost_microusd,
      measurement_status: input.measurement_status,
      evidence_reference: input.evidence_reference,
      occurred_at: input.occurred_at,
      idempotency_key: input.idempotency_key,
      id: deterministicId('cost', input.tenant_id, input.brain_id, input.idempotency_key),
    };
    const created = await this.#engine.recordWorkforceCost(event);
    if (!created) {
      const existing = await this.#engine.getWorkforceCostEvent(
        event.id,
        event.tenant_id,
        event.brain_id,
      );
      if (!existing || canonical(existing) !== canonical(event)) {
        throw new WorkforceError(
          'record_conflict',
          'Cost idempotency key already exists with a different measured event.',
        );
      }
      return {
        event: existing,
        summary: await this.#engine.workforceCostSummary(existing.tenant_id, existing.brain_id, {
          work_item_id: existing.work_item_id,
        }),
      };
    }
    await this.#engine.recordActivity(
      event.tenant_id,
      event.brain_id,
      'workforce',
      'accepted',
      event.id,
      'Provider-metered workforce cost recorded.',
      context,
    );
    return {
      event,
      summary: await this.#engine.workforceCostSummary(event.tenant_id, event.brain_id, {
        work_item_id: event.work_item_id,
      }),
    };
  }

  async evaluate(
    input: ScopedInput & {
      agent_id: string;
      work_item_id: string;
      evaluator_id: string;
      quality: number;
      correctness: number;
      efficiency: number;
      policy_compliance: number;
      evidence_ids: string[];
      notes_reference?: string | null;
      idempotency_key: string;
    },
    context?: ActivityContext,
  ): Promise<WorkforceEvaluation> {
    const item = await this.#requiredRecord<WorkItem>(
      input.work_item_id,
      input.tenant_id,
      input.brain_id,
      'work_item',
      'work_item_not_found',
    );
    if (item.assigned_agent_id !== input.agent_id) {
      throw new Error('Evaluation agent does not match the work item assignee.');
    }
    if (item.classification !== input.classification) {
      throw new Error('Evaluation classification does not match the governed work item.');
    }
    if (input.evaluator_id === input.agent_id) {
      throw new WorkforceError('self_review_denied', 'An agent cannot evaluate itself.');
    }
    this.#agents.assertCapability(input.evaluator_id, 'agent.evaluate', [input.classification]);
    const now = new Date().toISOString();
    const inputHash = requestHash(input);
    const evaluation: WorkforceEvaluation = {
      id: deterministicId('evaluation', input.tenant_id, input.brain_id, input.idempotency_key),
      tenant_id: input.tenant_id,
      brain_id: input.brain_id,
      record_type: 'evaluation',
      classification: input.classification,
      revision: 1,
      created_at: now,
      updated_at: now,
      agent_id: input.agent_id,
      work_item_id: input.work_item_id,
      evaluator_id: input.evaluator_id,
      quality: input.quality,
      correctness: input.correctness,
      efficiency: input.efficiency,
      policy_compliance: input.policy_compliance,
      evidence_ids: unique(input.evidence_ids),
      notes_reference: input.notes_reference ?? null,
      idempotency_key: input.idempotency_key,
      request_hash: inputHash,
    };
    const created = await this.#engine.createWorkforceRecord(evaluation);
    if (!created) {
      const existing = await this.#requiredRecord<WorkforceEvaluation>(
        evaluation.id,
        evaluation.tenant_id,
        evaluation.brain_id,
        'evaluation',
        'record_conflict',
      );
      assertIdempotent(existing.request_hash, inputHash);
      return existing;
    }
    await this.#activity(evaluation, 'completed', 'Agent evaluation recorded.', context);
    return evaluation;
  }

  async recordHeartbeat(
    input: ScopedInput & {
      agent_id: string;
      status: WorkforceHeartbeat['status'];
      current_work_item_id: string | null;
      observed_at: string;
      evidence_reference: string;
      idempotency_key: string;
    },
    context?: ActivityContext,
  ): Promise<WorkforceHeartbeat> {
    this.#agents.assertCapability(input.agent_id, 'heartbeat.report', [input.classification]);
    ensureDate(input.observed_at, 'observed_at');
    if (Date.parse(input.observed_at) > Date.now() + 30_000) {
      throw new Error('observed_at cannot be more than 30 seconds in the future.');
    }
    if (input.status === 'working' && !input.current_work_item_id) {
      throw new Error('A working heartbeat requires current_work_item_id.');
    }
    if ((input.status === 'idle' || input.status === 'offline') && input.current_work_item_id) {
      throw new Error(`${input.status} heartbeat cannot reference current work.`);
    }
    if (input.current_work_item_id) {
      const item = await this.#requiredRecord<WorkItem>(
        input.current_work_item_id,
        input.tenant_id,
        input.brain_id,
        'work_item',
        'work_item_not_found',
      );
      if (
        item.assigned_agent_id !== input.agent_id ||
        item.classification !== input.classification
      ) {
        throw new Error('Heartbeat work-item scope does not match the reporting agent.');
      }
      if (input.status === 'working') {
        const activeLease =
          item.status === 'in_progress' &&
          item.lease?.agent_id === input.agent_id &&
          Date.parse(item.lease.expires_at) > Date.parse(input.observed_at);
        if (!activeLease) {
          throw new Error('A working heartbeat requires an active lease on the work item.');
        }
      }
      if (input.status === 'blocked' && item.status !== 'blocked') {
        throw new Error('A blocked heartbeat requires a blocked work item.');
      }
    }
    const now = new Date().toISOString();
    const inputHash = requestHash(input);
    const heartbeat: WorkforceHeartbeat = {
      id: deterministicId('heartbeat', input.tenant_id, input.brain_id, input.idempotency_key),
      tenant_id: input.tenant_id,
      brain_id: input.brain_id,
      record_type: 'heartbeat',
      classification: input.classification,
      revision: 1,
      created_at: now,
      updated_at: now,
      agent_id: input.agent_id,
      status: input.status,
      current_work_item_id: input.current_work_item_id,
      observed_at: input.observed_at,
      evidence_reference: input.evidence_reference,
      idempotency_key: input.idempotency_key,
      request_hash: inputHash,
    };
    const created = await this.#engine.createWorkforceRecord(heartbeat);
    const result = created
      ? heartbeat
      : await this.#requiredRecord<WorkforceHeartbeat>(
          heartbeat.id,
          heartbeat.tenant_id,
          heartbeat.brain_id,
          'heartbeat',
          'record_conflict',
        );
    if (!created) assertIdempotent(result.request_hash, inputHash);
    if (created)
      await this.#activity(
        result,
        'accepted',
        'Evidence-backed agent heartbeat recorded.',
        context,
      );
    return result;
  }

  async snapshot(tenantId: string, brainId: string): Promise<WorkforceSnapshot> {
    const [goals, workItems, routines, heartbeats, evaluations, costs] = await Promise.all([
      this.#list<WorkforceGoal>(tenantId, brainId, 'goal', 500),
      this.#list<WorkItem>(tenantId, brainId, 'work_item', 500),
      this.#list<WorkforceRoutine>(tenantId, brainId, 'routine', 500),
      this.#list<WorkforceHeartbeat>(tenantId, brainId, 'heartbeat', 500),
      this.#list<WorkforceEvaluation>(tenantId, brainId, 'evaluation', 500),
      this.#engine.workforceCostSummary(tenantId, brainId, {}),
    ]);
    return {
      tenant_id: tenantId,
      brain_id: brainId,
      generated_at: new Date().toISOString(),
      goals,
      work_items: workItems,
      routines,
      heartbeats,
      evaluations,
      costs,
    };
  }

  async #unresolvedBlockers(item: WorkItem): Promise<string[]> {
    const blockers = await Promise.all(
      item.blocked_by.map((id) =>
        this.#record<WorkItem>(id, item.tenant_id, item.brain_id, 'work_item'),
      ),
    );
    return item.blocked_by.filter((_id, index) => blockers[index]?.status !== 'completed');
  }

  async #activity(
    record: WorkforceRecord,
    status: 'accepted' | 'completed' | 'proposed',
    summary: string,
    context?: ActivityContext,
  ): Promise<void> {
    await this.#engine.recordActivity(
      record.tenant_id,
      record.brain_id,
      'workforce',
      status,
      record.id,
      summary,
      context,
    );
  }

  async #list<T extends WorkforceRecord>(
    tenantId: string,
    brainId: string,
    type: WorkforceRecordType,
    limit: number,
  ): Promise<T[]> {
    return (await this.#engine.listWorkforceRecords(tenantId, brainId, type, limit)) as T[];
  }

  async #record<T extends WorkforceRecord>(
    id: string,
    tenantId: string,
    brainId: string,
    type: WorkforceRecordType,
  ): Promise<T | null> {
    const record = await this.#engine.getWorkforceRecord(id, tenantId, brainId);
    return record?.record_type === type ? (record as T) : null;
  }

  async #requiredRecord<T extends WorkforceRecord>(
    id: string,
    tenantId: string,
    brainId: string,
    type: WorkforceRecordType,
    code: WorkforceError['code'],
  ): Promise<T> {
    const record = await this.#record<T>(id, tenantId, brainId, type);
    if (!record) throw new WorkforceError(code, `${type} record was not found.`);
    return record;
  }
}
