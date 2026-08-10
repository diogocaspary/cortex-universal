import type { Classification } from '../policy.js';

export type WorkforceRecordType = 'goal' | 'work_item' | 'routine' | 'heartbeat' | 'evaluation';

export interface WorkforceRecordBase {
  id: string;
  tenant_id: string;
  brain_id: string;
  record_type: WorkforceRecordType;
  classification: Classification;
  revision: number;
  created_at: string;
  updated_at: string;
}

export interface SuccessCriterion {
  id: string;
  description: string;
  verification_method: 'evidence' | 'test' | 'human-approval';
  required: boolean;
}

export interface WorkforceGoal extends WorkforceRecordBase {
  record_type: 'goal';
  parent_goal_id: string | null;
  title: string;
  description: string;
  status: 'active' | 'achieved' | 'paused' | 'cancelled';
  success_criteria: SuccessCriterion[];
  owner_agent_id: string;
  idempotency_key: string;
  request_hash: string;
}

export interface WorkBudget {
  max_total_tokens: number;
  max_cost_microusd: number;
  max_duration_ms: number;
}

export type WorkItemStatus =
  | 'ready'
  | 'in_progress'
  | 'blocked'
  | 'review'
  | 'approved'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface WorkLease {
  checkout_id: string;
  agent_id: string;
  acquired_at: string;
  expires_at: string;
}

export interface WorkReview {
  required: boolean;
  reviewer_agent_id: string | null;
  status: 'not_required' | 'pending' | 'approved' | 'changes_requested';
  evidence_ids: string[];
  reviewed_at: string | null;
}

export interface WorkItem extends WorkforceRecordBase {
  record_type: 'work_item';
  goal_id: string;
  parent_work_item_id: string | null;
  title: string;
  description: string;
  status: WorkItemStatus;
  priority: 1 | 2 | 3 | 4 | 5;
  assigned_agent_id: string;
  required_capabilities: string[];
  acceptance_criteria: SuccessCriterion[];
  evidence_ids: string[];
  blocked_by: string[];
  budget: WorkBudget;
  lease: WorkLease | null;
  review: WorkReview;
  source: 'human' | 'routine' | 'agent-proposal';
  source_routine_id: string | null;
  scheduled_for: string | null;
  idempotency_key: string;
  request_hash: string;
}

export interface WorkforceRoutine extends WorkforceRecordBase {
  record_type: 'routine';
  name: string;
  status: 'active' | 'paused' | 'cancelled';
  goal_id: string;
  assigned_agent_id: string;
  interval_seconds: number;
  next_run_at: string;
  template: {
    title: string;
    description: string;
    priority: 1 | 2 | 3 | 4 | 5;
    required_capabilities: string[];
    acceptance_criteria: SuccessCriterion[];
    budget: WorkBudget;
    review_required: boolean;
  };
  idempotency_key: string;
  request_hash: string;
}

export interface WorkforceEvaluation extends WorkforceRecordBase {
  record_type: 'evaluation';
  agent_id: string;
  work_item_id: string;
  evaluator_id: string;
  quality: number;
  correctness: number;
  efficiency: number;
  policy_compliance: number;
  evidence_ids: string[];
  notes_reference: string | null;
  idempotency_key: string;
  request_hash: string;
}

export interface WorkforceHeartbeat extends WorkforceRecordBase {
  record_type: 'heartbeat';
  agent_id: string;
  status: 'idle' | 'working' | 'blocked' | 'degraded' | 'offline';
  current_work_item_id: string | null;
  observed_at: string;
  evidence_reference: string;
  idempotency_key: string;
  request_hash: string;
}

export interface WorkforceCostEvent {
  id: string;
  tenant_id: string;
  brain_id: string;
  agent_id: string;
  goal_id: string;
  work_item_id: string;
  provider: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cached_input_tokens: number;
  cost_microusd: number;
  measurement_status: 'provider-reported' | 'subscription-allocated';
  evidence_reference: string;
  occurred_at: string;
  idempotency_key: string;
}

export interface WorkforceCostSummary {
  input_tokens: number;
  output_tokens: number;
  cached_input_tokens: number;
  total_tokens: number;
  cost_microusd: number;
  event_count: number;
}

export type WorkforceRecord =
  WorkforceGoal | WorkItem | WorkforceRoutine | WorkforceHeartbeat | WorkforceEvaluation;

export interface WorkItemCheckout {
  tenant_id: string;
  brain_id: string;
  work_item_id: string;
  agent_id: string;
  checkout_id: string;
  acquired_at: string;
  expires_at: string;
}

export interface WorkforceSnapshot {
  tenant_id: string;
  brain_id: string;
  generated_at: string;
  goals: WorkforceGoal[];
  work_items: WorkItem[];
  routines: WorkforceRoutine[];
  heartbeats: WorkforceHeartbeat[];
  evaluations: WorkforceEvaluation[];
  costs: WorkforceCostSummary;
}
