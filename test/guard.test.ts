import { DatabaseSync } from 'node:sqlite';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentCoordinator } from '../src/agents/coordinator.js';
import { EmbeddedBrainEngine } from '../src/brain/embedded-engine.js';
import { GovernedEffectBroker } from '../src/execution/effect-broker.js';
import { createCortexGraphSnapshot } from '../src/graph.js';
import { OntologyGuard, type ToolProposal } from '../src/guard/ontology-guard.js';
import { repositoryRoot } from '../src/paths.js';
import { PolicyEngine } from '../src/policy.js';
import { SchemaRegistry } from '../src/schema.js';
import { GovernedAuthorizer } from '../src/security/authorization.js';
import { localStdioPrincipal } from '../src/security/identity.js';

describe('ontology guard, effects and append-only audit', () => {
  let engine: EmbeddedBrainEngine;
  let schemas: SchemaRegistry;
  let policy: PolicyEngine;
  let guard: OntologyGuard;
  let sessionId: string;
  let databasePath: string;

  beforeEach(async () => {
    const root = repositoryRoot();
    const directory = await mkdtemp(join(tmpdir(), 'cortex-guard-test-'));
    databasePath = join(directory, 'cortex.db');
    schemas = await SchemaRegistry.create(root);
    policy = await PolicyEngine.create(root, schemas);
    engine = new EmbeddedBrainEngine(
      databasePath,
      await createCortexGraphSnapshot(root),
      'audit-secret-that-is-longer-than-thirty-two-bytes',
    );
    const agents = await AgentCoordinator.create(root, schemas, engine);
    const session = await agents.create({
      tenant_id: 'tenant:guard',
      brain_id: 'brain:guard',
      objective: 'Validate a contracted result before any isolated effect is accepted.',
      initial_agent: 'ontologist',
      activity_context: {
        actor_id: 'service:test',
        request_id: 'request:guard-session',
        trace_id: 'trace:guard-session',
        correlation_id: 'correlation:guard-session',
        operation: 'test.agent.session.create',
      },
    });
    sessionId = session.id;
    guard = new OntologyGuard(schemas, agents, engine, new GovernedAuthorizer(policy), '0.5.0', {
      maximumSteps: 10,
      maximumRepeatedActionCalls: 3,
    });
  });

  afterEach(async () => engine.close());

  function proposal(id: string, proposedAt = new Date()): ToolProposal {
    return {
      proposal_id: `proposal:${id}`,
      tenant_id: 'tenant:guard',
      brain_id: 'brain:guard',
      session_id: sessionId,
      agent_id: 'ontologist',
      action_key: 'ontology.validate',
      resource: {
        id: 'graph:guarded',
        tenant_id: 'tenant:guard',
        classification: 'internal',
      },
      argument_reference: `urn:cortex:argument:${id}`,
      argument_hash: `sha256:${'a'.repeat(64)}`,
      verified_preconditions: ['payload.within_size_limit'],
      approval: { status: 'not-required' },
      purpose: 'validate contracted semantic payload',
      proposed_at: proposedAt.toISOString(),
      expires_at: new Date(proposedAt.getTime() + 120_000).toISOString(),
    };
  }

  it('returns idempotent decisions and denies repeated-action loops', async () => {
    const principal = localStdioPrincipal();
    const firstProposal = proposal('guard-0001');
    const first = await guard.evaluate(firstProposal, principal);
    expect(first).toMatchObject({ decision: 'allow', effect_executed: false });
    expect(await guard.evaluate(structuredClone(firstProposal), principal)).toEqual(first);
    expect((await guard.evaluate(proposal('guard-0002'), principal)).decision).toBe('allow');
    expect((await guard.evaluate(proposal('guard-0003'), principal)).decision).toBe('allow');
    expect(await guard.evaluate(proposal('guard-0004'), principal)).toMatchObject({
      decision: 'deny',
      reasons: ['repeated_action_budget_exceeded'],
    });
    const capabilityMismatch = proposal('guard-capability-0001');
    capabilityMismatch.action_key = 'knowledge.read';
    capabilityMismatch.verified_preconditions = ['identity.authenticated'];
    expect(await guard.evaluate(capabilityMismatch, principal)).toMatchObject({
      decision: 'deny',
      reasons: ['agent_capability_denied'],
    });
  });

  it('accepts an effect only after independent system-of-record observation', async () => {
    const input = proposal('effect-0001');
    const decision = await guard.evaluate(input, localStdioPrincipal());
    const broker = new GovernedEffectBroker(schemas, policy, engine);
    const outcome = await broker.executeAndVerify(
      input,
      decision,
      {
        actionKeys: ['ontology.validate'],
        execute: async () => ({
          execution_id: 'execution:test-0001',
          accepted_at: new Date().toISOString(),
          system_of_record: 'semantic-validator',
          receipt_reference: 'urn:validator:receipt:0001',
        }),
      },
      {
        observe: async (_command, receipt) => ({
          execution_id: receipt.execution_id,
          proposal_id: input.proposal_id,
          tenant_id: input.tenant_id,
          action_key: input.action_key,
          status: 'succeeded',
          system_of_record: receipt.system_of_record,
          observation_reference: 'urn:validator:observation:0001',
          observation_hash: `sha256:${'b'.repeat(64)}`,
          observed_at: new Date().toISOString(),
          expected_effects: ['validation.reported'],
          observed_effects: ['validation.reported'],
          verification: 'verified',
          evidence_ids: ['evidence:validation-report-0001'],
        }),
      },
    );
    expect(outcome).toMatchObject({ status: 'succeeded', verification: 'verified' });
    await expect(
      broker.executeAndVerify(
        input,
        decision,
        { actionKeys: ['ontology.validate'], execute: async () => Promise.reject(new Error()) },
        { observe: async () => Promise.reject(new Error()) },
      ),
    ).rejects.toThrow(/already has an execution reservation/iu);
  });

  it('chains traceable audit events and blocks mutation at storage level', async () => {
    await guard.evaluate(proposal('audit-0001'), localStdioPrincipal(), new Date(), {
      actor_id: 'service:test',
      request_id: 'request:audit-0001',
      trace_id: 'trace:audit-0001',
      correlation_id: 'correlation:audit-0001',
      causation_id: 'proposal:audit-0001',
      operation: 'test.guard.evaluate',
    });
    const events = await engine.activity('tenant:guard', 'brain:guard', 20);
    expect(events.every((event) => schemas.validate('brain-activity', event).valid)).toBe(true);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          trace_id: 'trace:audit-0001',
          correlation_id: 'correlation:audit-0001',
          causation_id: 'proposal:audit-0001',
          operation: 'test.guard.evaluate',
          event_hash: expect.stringMatching(/^hmac-sha256-chain:/),
        }),
      ]),
    );
    const integrity = await engine.verifyAuditChain('tenant:guard', 'brain:guard');
    expect(schemas.validate('audit-integrity', integrity).valid).toBe(true);
    expect(integrity).toMatchObject({
      valid: true,
      legacy_events: 0,
    });
    const secondConnection = new DatabaseSync(databasePath);
    expect(() => secondConnection.exec("UPDATE brain_activity SET summary = 'tampered'")).toThrow(
      /append-only/iu,
    );
    secondConnection.close();
  });
});
