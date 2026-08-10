import { createHash, randomUUID } from 'node:crypto';
import type { AgentCoordinator } from '../agents/coordinator.js';
import type { ActivityContext, BrainEngine } from '../brain/engine.js';
import type { Classification, PolicyRequest } from '../policy.js';
import type { SchemaRegistry } from '../schema.js';
import { AuthorizationDeniedError, type GovernedAuthorizer } from '../security/authorization.js';
import type { IdentityPrincipal } from '../security/identity.js';

export interface ToolProposal {
  proposal_id: string;
  tenant_id: string;
  brain_id: string;
  session_id: string;
  agent_id: string;
  action_key: string;
  resource: {
    id: string;
    tenant_id: string;
    classification: Classification;
  };
  argument_reference: string;
  argument_hash: string;
  idempotency_key?: string;
  verified_preconditions: string[];
  approval: PolicyRequest['approval'];
  purpose: string;
  proposed_at: string;
  expires_at: string;
}

export interface GuardDecision {
  decision_id: string;
  proposal_id: string;
  decision: 'allow' | 'deny';
  reasons: string[];
  obligations: string[];
  policy_version: string;
  policy_fingerprint: string;
  ontology_version: string;
  proposal_hash: string;
  verification_action: string | null;
  decided_at: string;
  expires_at: string;
  effect_executed: false;
  loop: {
    session_proposals: number;
    repeated_action_calls: number;
    maximum_steps: number;
    maximum_repeated_action_calls: number;
  };
}

export interface OntologyGuardOptions {
  maximumSteps?: number;
  maximumRepeatedActionCalls?: number;
  decisionLifetimeMs?: number;
}

export class InvalidToolProposalError extends Error {
  constructor(readonly details: unknown) {
    super('Tool proposal does not conform to the trusted contract.');
    this.name = 'InvalidToolProposalError';
  }
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
    .join(',')}}`;
}

export function hashToolProposal(proposal: ToolProposal): string {
  return `sha256:${createHash('sha256').update(canonical(proposal), 'utf8').digest('hex')}`;
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const candidate = value ?? fallback;
  if (!Number.isInteger(candidate) || candidate < minimum || candidate > maximum) {
    throw new Error(`Guard budget must be an integer from ${minimum} to ${maximum}.`);
  }
  return candidate;
}

export class OntologyGuard {
  readonly #schemas: SchemaRegistry;
  readonly #agents: AgentCoordinator;
  readonly #brain: BrainEngine;
  readonly #authorizer: GovernedAuthorizer;
  readonly #ontologyVersion: string;
  readonly #maximumSteps: number;
  readonly #maximumRepeatedActionCalls: number;
  readonly #decisionLifetimeMs: number;

  constructor(
    schemas: SchemaRegistry,
    agents: AgentCoordinator,
    brain: BrainEngine,
    authorizer: GovernedAuthorizer,
    ontologyVersion: string,
    options: OntologyGuardOptions = {},
  ) {
    this.#schemas = schemas;
    this.#agents = agents;
    this.#brain = brain;
    this.#authorizer = authorizer;
    this.#ontologyVersion = ontologyVersion;
    this.#maximumSteps = boundedInteger(options.maximumSteps, 32, 1, 100);
    this.#maximumRepeatedActionCalls = boundedInteger(options.maximumRepeatedActionCalls, 3, 1, 10);
    this.#decisionLifetimeMs = boundedInteger(options.decisionLifetimeMs, 60_000, 1_000, 300_000);
  }

  async evaluate(
    value: unknown,
    principal: IdentityPrincipal,
    now = new Date(),
    activityContext?: ActivityContext,
  ): Promise<GuardDecision> {
    const report = this.#schemas.validate('tool-proposal', value);
    if (!report.valid) throw new InvalidToolProposalError(report.errors);
    const proposal = value as ToolProposal;
    const decidedAt = now.toISOString();
    const proposedAt = Date.parse(proposal.proposed_at);
    const proposalExpiresAt = Date.parse(proposal.expires_at);
    if (
      proposedAt > now.getTime() + 30_000 ||
      proposalExpiresAt <= now.getTime() ||
      proposalExpiresAt <= proposedAt ||
      proposalExpiresAt - proposedAt > 5 * 60_000
    ) {
      throw new InvalidToolProposalError([
        { message: 'Proposal timestamps are expired or outside the five-minute validity window.' },
      ]);
    }
    if (
      proposal.resource.tenant_id !== proposal.tenant_id ||
      proposal.argument_reference.startsWith('data:')
    ) {
      throw new InvalidToolProposalError([
        {
          message: 'Resource scope must match and arguments must remain behind a secure reference.',
        },
      ]);
    }

    this.#authorizer.authorize(principal, 'guard.evaluate', proposal.resource, {
      request_id: proposal.proposal_id.replace(/^proposal:/u, 'request:'),
      purpose: proposal.purpose,
      verified_preconditions: [
        'identity.authenticated',
        'tenant.resolved',
        'schema.validated',
        'agent.registered',
      ],
    });

    const session = await this.#agents.get(
      proposal.session_id,
      proposal.tenant_id,
      proposal.brain_id,
    );
    if (
      !session ||
      session.status !== 'active' ||
      session.tenant_id !== proposal.tenant_id ||
      session.brain_id !== proposal.brain_id ||
      session.active_agent !== proposal.agent_id
    ) {
      throw new InvalidToolProposalError([
        { message: 'The active agent session does not match the proposal scope.' },
      ]);
    }

    const action = this.#authorizer.policy.action(proposal.action_key);
    let agentCapabilityDenied = false;
    if (action) {
      try {
        this.#agents.assertCapability(proposal.agent_id, action.capability, [
          proposal.resource.classification,
        ]);
      } catch {
        agentCapabilityDenied = true;
      }
    }

    const reservation = await this.#brain.reserveGuardProposal({
      proposal_id: proposal.proposal_id,
      tenant_id: proposal.tenant_id,
      brain_id: proposal.brain_id,
      session_id: proposal.session_id,
      action_key: proposal.action_key,
      idempotency_key: proposal.idempotency_key ?? null,
    });
    if (reservation.duplicate) {
      const existingReport = this.#schemas.validate(
        'guard-decision',
        reservation.existing_decision,
      );
      if (!existingReport.valid) {
        throw new Error(
          'A duplicate guard proposal is pending or has an invalid persisted decision.',
        );
      }
      return reservation.existing_decision as GuardDecision;
    }

    const loop = {
      session_proposals: reservation.session_proposals,
      repeated_action_calls: reservation.repeated_action_calls,
      maximum_steps: this.#maximumSteps,
      maximum_repeated_action_calls: this.#maximumRepeatedActionCalls,
    };
    const staticReasons: string[] = [];
    if (reservation.session_proposals > this.#maximumSteps)
      staticReasons.push('loop_step_budget_exceeded');
    if (reservation.repeated_action_calls > this.#maximumRepeatedActionCalls) {
      staticReasons.push('repeated_action_budget_exceeded');
    }
    if (!action) staticReasons.push('unknown_action');
    if (agentCapabilityDenied) staticReasons.push('agent_capability_denied');
    if (action?.idempotency_required && !proposal.idempotency_key) {
      staticReasons.push('idempotency_key_required');
    }

    let decision: GuardDecision;
    if (staticReasons.length > 0) {
      decision = this.#decision(
        proposal,
        'deny',
        staticReasons,
        ['audit.authorization_decision', 'effect.not_executed'],
        action?.verification_action ?? null,
        decidedAt,
        proposalExpiresAt,
        loop,
      );
    } else {
      try {
        const policyDecision = this.#authorizer.authorize(
          principal,
          proposal.action_key,
          proposal.resource,
          {
            request_id: proposal.proposal_id.replace(/^proposal:/u, 'request:'),
            purpose: proposal.purpose,
            verified_preconditions: proposal.verified_preconditions,
            approval: proposal.approval,
          },
        );
        decision = this.#decision(
          proposal,
          'allow',
          policyDecision.reasons,
          [...new Set([...policyDecision.obligations, 'effect.verify_after_execution'])],
          policyDecision.verification_action,
          decidedAt,
          proposalExpiresAt,
          loop,
        );
      } catch (error) {
        if (!(error instanceof AuthorizationDeniedError)) throw error;
        decision = this.#decision(
          proposal,
          'deny',
          error.decision.reasons,
          [...new Set([...error.decision.obligations, 'effect.not_executed'])],
          error.decision.verification_action,
          decidedAt,
          proposalExpiresAt,
          loop,
        );
      }
    }

    const decisionReport = this.#schemas.validate('guard-decision', decision);
    if (!decisionReport.valid) {
      throw new Error(
        `Ontology Guard emitted an invalid decision: ${JSON.stringify(decisionReport.errors)}`,
      );
    }
    await this.#brain.completeGuardProposal(
      proposal.proposal_id,
      proposal.tenant_id,
      proposal.brain_id,
      decision,
    );
    await this.#brain.recordActivity(
      proposal.tenant_id,
      proposal.brain_id,
      'guard',
      decision.decision === 'allow' ? 'accepted' : 'rejected',
      decision.decision_id,
      `Ontology Guard ${decision.decision} decision; no effect executed.`,
      {
        actor_id: principal.id,
        request_id:
          activityContext?.request_id ?? proposal.proposal_id.replace(/^proposal:/u, 'request:'),
        ...(activityContext?.trace_id ? { trace_id: activityContext.trace_id } : {}),
        ...(activityContext?.correlation_id
          ? { correlation_id: activityContext.correlation_id }
          : {}),
        causation_id: activityContext?.causation_id ?? proposal.proposal_id,
        operation: activityContext?.operation ?? 'guard.evaluate',
        details_hash: decision.proposal_hash,
        policy_fingerprint: decision.policy_fingerprint,
      },
    );
    return decision;
  }

  #decision(
    proposal: ToolProposal,
    effect: 'allow' | 'deny',
    reasons: string[],
    obligations: string[],
    verificationAction: string | null,
    decidedAt: string,
    proposalExpiresAt: number,
    loop: GuardDecision['loop'],
  ): GuardDecision {
    return {
      decision_id: `guard:${randomUUID()}`,
      proposal_id: proposal.proposal_id,
      decision: effect,
      reasons: [...new Set(reasons)],
      obligations: [...new Set(obligations)],
      policy_version: this.#authorizer.policy.version,
      policy_fingerprint: this.#authorizer.policy.fingerprint,
      ontology_version: this.#ontologyVersion,
      proposal_hash: hashToolProposal(proposal),
      verification_action: verificationAction,
      decided_at: decidedAt,
      expires_at: new Date(
        Math.min(proposalExpiresAt, Date.parse(decidedAt) + this.#decisionLifetimeMs),
      ).toISOString(),
      effect_executed: false,
      loop,
    };
  }
}
