import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ActivityContext, BrainEngine } from '../brain/engine.js';
import type { Classification } from '../policy.js';
import type { SchemaRegistry } from '../schema.js';

export interface AgentDefinition {
  id: string;
  name: string;
  purpose: string;
  role: string;
  department: string;
  reports_to: string | null;
  persona: {
    principles: string[];
    prohibited_behaviors: string[];
    success_criteria: string[];
  };
  capabilities: string[];
  skill_ids: string[];
  budget: {
    max_total_tokens: number;
    max_cost_microusd: number;
    max_run_duration_ms: number;
  };
  heartbeat: {
    enabled: boolean;
    minimum_interval_seconds: number;
  };
  allowed_classifications: Classification[];
}

export interface AgentRegistry {
  version: string;
  agents: AgentDefinition[];
}

export interface AgentHandoff {
  id: string;
  from_agent: string;
  to_agent: string;
  reason: string;
  evidence_ids: string[];
  proposed_at: string;
}

export interface AgentSession {
  id: string;
  tenant_id: string;
  brain_id: string;
  objective: string;
  status: 'active' | 'completed' | 'abstained';
  active_agent: string;
  allowed_classifications: Classification[];
  created_at: string;
  updated_at: string;
  handoffs: AgentHandoff[];
}

/** Governed coordination only: no LLM invocation and no external tool execution. */
export class AgentCoordinator {
  readonly registry: AgentRegistry;
  readonly #engine: BrainEngine;

  private constructor(registry: AgentRegistry, engine: BrainEngine) {
    this.registry = registry;
    this.#engine = engine;
  }

  static async create(
    root: string,
    schemas: SchemaRegistry,
    engine: BrainEngine,
  ): Promise<AgentCoordinator> {
    const registry = JSON.parse(
      await readFile(join(root, 'policies', 'agent-registry.json'), 'utf8'),
    ) as AgentRegistry;
    const report = schemas.validate('agent-registry', registry);
    if (!report.valid) throw new Error(`Invalid agent registry: ${JSON.stringify(report.errors)}`);
    return new AgentCoordinator(registry, engine);
  }

  async create(input: {
    tenant_id: string;
    brain_id: string;
    objective: string;
    initial_agent: string;
    allowed_classifications?: Classification[];
    activity_context?: ActivityContext;
  }): Promise<AgentSession> {
    const initialAgent = this.#agent(input.initial_agent);
    const allowedClassifications =
      input.allowed_classifications ?? initialAgent.allowed_classifications;
    this.assertCapability(input.initial_agent, 'handoff.propose', allowedClassifications);
    const now = new Date().toISOString();
    const session: AgentSession = {
      id: `session:${randomUUID()}`,
      tenant_id: input.tenant_id,
      brain_id: input.brain_id,
      objective: input.objective,
      status: 'active',
      active_agent: input.initial_agent,
      allowed_classifications: [...new Set(allowedClassifications)],
      created_at: now,
      updated_at: now,
      handoffs: [],
    };
    await this.#engine.saveAgentSession(session);
    await this.#engine.recordActivity(
      session.tenant_id,
      session.brain_id,
      'agent_session',
      'accepted',
      session.id,
      `Governed session assigned to ${session.active_agent}.`,
      input.activity_context,
    );
    return session;
  }

  async get(sessionId: string, tenantId?: string, brainId?: string): Promise<AgentSession | null> {
    return this.#engine.getAgentSession(sessionId, tenantId, brainId);
  }

  async handoff(
    sessionId: string,
    input: {
      tenant_id: string;
      brain_id: string;
      from_agent: string;
      to_agent: string;
      reason: string;
      evidence_ids: string[];
      activity_context?: ActivityContext;
    },
  ): Promise<AgentSession> {
    this.assertCapability(input.from_agent, 'handoff.propose');
    const targetAgent = this.#agent(input.to_agent);
    const session = await this.get(sessionId, input.tenant_id, input.brain_id);
    if (!session) throw new Error('Agent session was not found.');
    if (session.tenant_id !== input.tenant_id || session.brain_id !== input.brain_id) {
      throw new Error('Agent session was not found.');
    }
    if (session.status !== 'active') throw new Error('Only active sessions can be handed off.');
    if (session.active_agent !== input.from_agent) {
      throw new Error('from_agent is not the active agent for this session.');
    }
    if (input.from_agent === input.to_agent) throw new Error('A handoff must change the agent.');
    const unsupportedClassification = session.allowed_classifications.find(
      (classification) => !targetAgent.allowed_classifications.includes(classification),
    );
    if (unsupportedClassification) {
      throw new Error(
        `Agent '${input.to_agent}' cannot receive session classification '${unsupportedClassification}'.`,
      );
    }
    const handoff: AgentHandoff = {
      id: `handoff:${randomUUID()}`,
      from_agent: input.from_agent,
      to_agent: input.to_agent,
      reason: input.reason,
      evidence_ids: [...new Set(input.evidence_ids)],
      proposed_at: new Date().toISOString(),
    };
    const updated: AgentSession = {
      ...session,
      active_agent: input.to_agent,
      updated_at: handoff.proposed_at,
      handoffs: [...session.handoffs, handoff],
    };
    await this.#engine.saveAgentSession(updated);
    await this.#engine.recordActivity(
      updated.tenant_id,
      updated.brain_id,
      'agent_handoff',
      'proposed',
      handoff.id,
      `Handoff from ${handoff.from_agent} to ${handoff.to_agent}; no external action executed.`,
      input.activity_context,
    );
    return updated;
  }

  assertCapability(
    agentId: string,
    capability: string,
    classifications: Classification[] = [],
  ): AgentDefinition {
    const agent = this.#agent(agentId);
    if (!agent.capabilities.includes(capability)) {
      throw new Error(`Agent '${agentId}' does not have capability '${capability}'.`);
    }
    const denied = classifications.find(
      (classification) => !agent.allowed_classifications.includes(classification),
    );
    if (denied) {
      throw new Error(`Agent '${agentId}' cannot access classification '${denied}'.`);
    }
    return agent;
  }

  definition(agentId: string): AgentDefinition {
    return structuredClone(this.#agent(agentId));
  }

  #agent(agentId: string): AgentDefinition {
    const agent = this.registry.agents.find((candidate) => candidate.id === agentId);
    if (!agent) throw new Error(`Agent '${agentId}' is not in the trusted registry.`);
    return agent;
  }
}
