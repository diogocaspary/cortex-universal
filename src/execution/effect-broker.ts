import { createHash } from 'node:crypto';
import type { BrainEngine } from '../brain/engine.js';
import type { GuardDecision, ToolProposal } from '../guard/ontology-guard.js';
import { hashToolProposal } from '../guard/ontology-guard.js';
import type { PolicyEngine } from '../policy.js';
import type { SchemaRegistry } from '../schema.js';

export interface ExecutionCommand {
  proposal_id: string;
  decision_id: string;
  tenant_id: string;
  action_key: string;
  argument_reference: string;
  argument_hash: string;
  idempotency_key: string | null;
}

export interface ExecutionReceipt {
  execution_id: string;
  accepted_at: string;
  system_of_record: string;
  receipt_reference: string;
}

export interface EffectOutcome {
  execution_id: string;
  proposal_id: string;
  tenant_id: string;
  action_key: string;
  status: 'succeeded' | 'failed' | 'indeterminate';
  system_of_record: string;
  observation_reference: string;
  observation_hash: string;
  observed_at: string;
  expected_effects: string[];
  observed_effects: string[];
  verification: 'verified' | 'mismatch' | 'unavailable';
  evidence_ids: string[];
}

/** Implemented by a separately deployed, capability-specific connector. */
export interface EffectExecutor {
  readonly actionKeys: string[];
  execute(command: ExecutionCommand): Promise<ExecutionReceipt>;
}

/** Re-reads the system of record; an executor receipt is never accepted as proof of outcome. */
export interface EffectObserver {
  observe(command: ExecutionCommand, receipt: ExecutionReceipt): Promise<EffectOutcome>;
}

export class EffectExecutionError extends Error {}

export class GovernedEffectBroker {
  readonly #schemas: SchemaRegistry;
  readonly #policy: PolicyEngine;
  readonly #brain: BrainEngine;

  constructor(schemas: SchemaRegistry, policy: PolicyEngine, brain: BrainEngine) {
    this.#schemas = schemas;
    this.#policy = policy;
    this.#brain = brain;
  }

  async executeAndVerify(
    proposal: ToolProposal,
    decision: GuardDecision,
    executor: EffectExecutor,
    observer: EffectObserver,
    now = new Date(),
  ): Promise<EffectOutcome> {
    if (
      decision.decision !== 'allow' ||
      decision.effect_executed ||
      decision.proposal_id !== proposal.proposal_id ||
      decision.proposal_hash !== hashToolProposal(proposal) ||
      Date.parse(decision.expires_at) <= now.getTime()
    ) {
      throw new EffectExecutionError('A current matching allow decision is required.');
    }
    if (!decision.obligations.includes('effect.verify_after_execution')) {
      throw new EffectExecutionError('The decision does not require post-effect verification.');
    }
    const action = this.#policy.action(proposal.action_key);
    if (!action) throw new EffectExecutionError('The action is not in the trusted registry.');
    if (!executor.actionKeys.includes(proposal.action_key)) {
      throw new EffectExecutionError('The isolated executor is not registered for this action.');
    }
    if (
      !(await this.#brain.reserveEffectExecution(
        proposal.proposal_id,
        decision.decision_id,
        proposal.tenant_id,
        proposal.brain_id,
      ))
    ) {
      throw new EffectExecutionError('This proposal already has an execution reservation.');
    }
    const command: ExecutionCommand = {
      proposal_id: proposal.proposal_id,
      decision_id: decision.decision_id,
      tenant_id: proposal.tenant_id,
      action_key: proposal.action_key,
      argument_reference: proposal.argument_reference,
      argument_hash: proposal.argument_hash,
      idempotency_key: proposal.idempotency_key ?? null,
    };
    try {
      const receipt = await executor.execute(command);
      const outcome = await observer.observe(command, receipt);
      const report = this.#schemas.validate('effect-outcome', outcome);
      if (!report.valid) {
        throw new EffectExecutionError(
          `Effect observer emitted an invalid outcome: ${JSON.stringify(report.errors)}`,
        );
      }
      if (
        outcome.execution_id !== receipt.execution_id ||
        outcome.proposal_id !== proposal.proposal_id ||
        outcome.tenant_id !== proposal.tenant_id ||
        outcome.action_key !== proposal.action_key ||
        outcome.system_of_record !== receipt.system_of_record
      ) {
        throw new EffectExecutionError('Observed outcome does not match the execution scope.');
      }
      const missingExpected = action.expected_effects.filter(
        (effect) => !outcome.expected_effects.includes(effect),
      );
      if (missingExpected.length > 0) {
        throw new EffectExecutionError('The observer omitted trusted expected effects.');
      }
      if (
        outcome.status === 'succeeded' &&
        (outcome.verification !== 'verified' ||
          action.expected_effects.some((effect) => !outcome.observed_effects.includes(effect)))
      ) {
        throw new EffectExecutionError(
          'A successful effect requires a matching system-of-record observation.',
        );
      }
      await this.#brain.completeEffectExecution(
        proposal.proposal_id,
        proposal.tenant_id,
        proposal.brain_id,
        outcome,
      );
      await this.#brain.recordActivity(
        proposal.tenant_id,
        proposal.brain_id,
        'effect',
        outcome.verification === 'verified' ? 'completed' : 'rejected',
        outcome.execution_id,
        `System-of-record effect verification: ${outcome.verification}.`,
        {
          actor_id: `executor:${outcome.system_of_record}`,
          request_id: proposal.proposal_id.replace(/^proposal:/u, 'request:'),
          causation_id: decision.decision_id,
          operation: 'effect.execute_and_verify',
          details_hash: outcome.observation_hash,
          policy_fingerprint: decision.policy_fingerprint,
        },
      );
      return outcome;
    } catch (error) {
      const message = error instanceof Error ? `${error.name}:${error.message}` : String(error);
      await this.#brain.recordActivity(
        proposal.tenant_id,
        proposal.brain_id,
        'failure',
        'rejected',
        proposal.proposal_id,
        'Reserved effect execution failed or could not be independently verified.',
        {
          actor_id: 'service:cortex-effect-broker',
          request_id: proposal.proposal_id.replace(/^proposal:/u, 'request:'),
          causation_id: decision.decision_id,
          operation: 'effect.execute_and_verify',
          details_hash: `sha256:${createHash('sha256').update(message, 'utf8').digest('hex')}`,
          policy_fingerprint: decision.policy_fingerprint,
        },
      );
      throw error;
    }
  }
}
