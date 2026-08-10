import { McpServer } from '@modelcontextprotocol/server';
import { createHash, randomUUID } from 'node:crypto';
import * as z from 'zod/v4';
import type { AgentCoordinator } from '../agents/coordinator.js';
import type { BrainEngine, BrainIngestion, RetrievalRequest } from '../brain/engine.js';
import {
  selectAttention,
  type AttentionCandidate,
  type AttentionWeights,
} from '../cognition/attention.js';
import { proposeConsolidation, type ReplayCandidate } from '../cognition/consolidation.js';
import { assessCalibration, type ConfidenceSample } from '../cognition/metacognition.js';
import { evaluatePredictions, type PredictionObservation } from '../cognition/world-model.js';
import type { CortexGraphSnapshot } from '../graph.js';
import type { OntologyGuard } from '../guard/ontology-guard.js';
import type { CortexManifest } from '../manifest.js';
import type { PolicyEngine } from '../policy.js';
import type { ReasoningReport } from '../reasoning.js';
import type { SchemaRegistry } from '../schema.js';
import type { GovernedAuthorizer } from '../security/authorization.js';
import type { IdentityPrincipal } from '../security/identity.js';
import type { SourceRegistry } from '../security/source-registry.js';
import type { WorkforceCostEvent, WorkItemStatus } from '../workforce/contracts.js';
import type { WorkforceService } from '../workforce/workforce-service.js';

interface CortexMcpDependencies {
  manifest: CortexManifest;
  graph: CortexGraphSnapshot;
  schemas: SchemaRegistry;
  policy: PolicyEngine;
  brain: BrainEngine;
  agents: AgentCoordinator;
  principal: IdentityPrincipal;
  authorizer: GovernedAuthorizer;
  sources: SourceRegistry;
  environment: string;
  guard: OntologyGuard;
  reasoning: ReasoningReport;
  workforce: WorkforceService;
}

function result(value: unknown): {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent: Record<string, unknown>;
} {
  const structuredContent =
    value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : { value };
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    structuredContent,
  };
}

function contracted<T>(schemas: SchemaRegistry, schema: string, value: unknown): T {
  const report = schemas.validate(schema, value);
  if (!report.valid) {
    throw new Error(`Input violates '${schema}': ${JSON.stringify(report.errors)}`);
  }
  return value as T;
}

const payloadSchema = z.object({ payload: z.record(z.string(), z.unknown()) });

/** Creates one MCP server instance, sharing the API's governed semantic services. */
export function createCortexMcpServer(dependencies: CortexMcpDependencies): McpServer {
  const {
    manifest,
    graph,
    schemas,
    policy,
    brain,
    agents,
    principal,
    authorizer,
    sources,
    guard,
    reasoning,
    workforce,
  } = dependencies;
  const environment =
    dependencies.environment === 'production' ||
    dependencies.environment === 'staging' ||
    dependencies.environment === 'test'
      ? dependencies.environment
      : 'development';
  const authorize = async (
    actionKey: string,
    resource: {
      id: string;
      tenant_id: string | null;
      classification: import('../policy.js').Classification;
    },
    purpose: string,
    verifiedPreconditions: string[] = ['identity.authenticated'],
    auditBrainId?: string,
  ) => {
    const requestId = `request:${randomUUID()}`;
    const traceId = `trace:${randomUUID()}`;
    try {
      const decision = authorizer.authorize(principal, actionKey, resource, {
        request_id: requestId,
        purpose,
        verified_preconditions: verifiedPreconditions,
        environment,
      });
      await brain.recordActivity(
        resource.tenant_id ?? 'tenant:cortex-system',
        auditBrainId ?? (resource.tenant_id ? resource.id : 'brain:control-plane'),
        'mcp',
        'accepted',
        `authorization:${randomUUID()}`,
        `MCP policy allowed ${actionKey}.`,
        {
          actor_id: principal.id,
          request_id: requestId,
          trace_id: traceId,
          correlation_id: traceId.replace(/^trace:/u, 'correlation:'),
          causation_id: resource.id,
          operation: `mcp.${actionKey}`,
          details_hash: `sha256:${createHash('sha256').update(decision.policy_fingerprint).digest('hex')}`,
          policy_fingerprint: decision.policy_fingerprint,
        },
      );
      return decision;
    } catch (error) {
      if (error instanceof Error) {
        await brain.recordActivity(
          'tenant:cortex-system',
          'brain:control-plane',
          'mcp',
          'rejected',
          `authorization:${randomUUID()}`,
          `MCP policy rejected ${actionKey}.`,
          {
            actor_id: principal.id,
            request_id: requestId,
            trace_id: traceId,
            correlation_id: traceId.replace(/^trace:/u, 'correlation:'),
            causation_id: resource.id,
            operation: `mcp.${actionKey}`,
            details_hash: `sha256:${createHash('sha256')
              .update(`${error.name}:${error.message}`, 'utf8')
              .digest('hex')}`,
          },
        );
      }
      throw error;
    }
  };
  const server = new McpServer(
    { name: 'cortex-universal', version: manifest.version },
    { capabilities: { tools: {}, resources: {} } },
  );

  server.registerResource(
    'ontology-manifest',
    'cortex://ontology/manifest',
    {
      title: 'Cortex ontology manifest',
      description: 'Authoritative versioned inventory of ontology modules, shapes and contracts.',
      mimeType: 'application/json',
    },
    async (uri) => {
      await authorize(
        'ontology.read',
        { id: 'ontology:manifest', tenant_id: null, classification: 'public' },
        'read ontology manifest through MCP',
      );
      return {
        contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(manifest) }],
      };
    },
  );
  server.registerResource(
    'ontology-reasoning',
    'cortex://ontology/reasoning',
    {
      title: 'Cortex bounded reasoning report',
      description: 'Explainable RDFS and OWL-RL-subset inferences and consistency diagnostics.',
      mimeType: 'application/json',
    },
    async (uri) => {
      await authorize(
        'ontology.read',
        { id: 'ontology:reasoning', tenant_id: null, classification: 'public' },
        'read bounded ontology reasoning through MCP',
      );
      return {
        contents: [
          { uri: uri.href, mimeType: 'application/json', text: JSON.stringify(reasoning) },
        ],
      };
    },
  );
  server.registerResource(
    'semantic-graph',
    'cortex://ontology/graph',
    {
      title: 'Cortex semantic graph',
      description: 'Read-only RDF/OWL, SHACL and policy projection used by the visual cortex.',
      mimeType: 'application/json',
    },
    async (uri) => {
      await authorize(
        'ontology.read',
        { id: 'ontology:graph', tenant_id: null, classification: 'public' },
        'read semantic graph through MCP',
      );
      return {
        contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(graph) }],
      };
    },
  );

  server.registerTool(
    'cortex_manifest',
    {
      title: 'Read ontology manifest',
      description: 'Returns the ontology authority, modules, schemas and version.',
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      await authorize(
        'ontology.read',
        { id: 'ontology:manifest', tenant_id: null, classification: 'public' },
        'read ontology manifest through MCP',
      );
      return result(manifest);
    },
  );
  server.registerTool(
    'cortex_explore_graph',
    {
      title: 'Explore semantic cortex',
      description: 'Returns a bounded read-only subgraph filtered by module, kind or text.',
      inputSchema: z.object({
        query: z.string().max(256).optional(),
        module: z.string().max(64).optional(),
        kind: z.string().max(64).optional(),
        limit: z.number().int().min(1).max(500).default(100),
      }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ query, module, kind, limit }) => {
      await authorize(
        'ontology.read',
        { id: 'ontology:graph', tenant_id: null, classification: 'public' },
        'explore semantic graph through MCP',
      );
      const normalized = query?.toLocaleLowerCase('pt-BR');
      const nodes = graph.nodes
        .filter(
          (node) =>
            (!module || node.module === module) &&
            (!kind || node.kind === kind) &&
            (!normalized ||
              [node.id, node.label, node.description ?? ''].some((value) =>
                value.toLocaleLowerCase('pt-BR').includes(normalized),
              )),
        )
        .slice(0, limit);
      const ids = new Set(nodes.map((node) => node.id));
      return result({
        version: graph.version,
        nodes,
        edges: graph.edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target)),
        truncated: nodes.length === limit,
      });
    },
  );
  server.registerTool(
    'cortex_reasoning_report',
    {
      title: 'Read explainable ontology reasoning',
      description:
        'Returns bounded RDFS and OWL-RL-subset inferences, supports, truncation state and consistency diagnostics.',
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      await authorize(
        'ontology.read',
        { id: 'ontology:reasoning', tenant_id: null, classification: 'public' },
        'read bounded ontology reasoning through MCP',
      );
      return result(reasoning);
    },
  );
  server.registerTool(
    'cortex_ingest_evidence',
    {
      title: 'Ingest validated evidence',
      description:
        'Indexes evidence after JSON contract and SHA-256 verification; never executes an action.',
      inputSchema: payloadSchema,
      annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ payload }) => {
      const input = contracted<BrainIngestion>(schemas, 'brain-ingestion', payload);
      const verification = sources.verify(input.envelope);
      const decision = await authorize(
        'evidence.ingest',
        {
          id: input.envelope.id,
          tenant_id: input.envelope.tenant_id,
          classification: input.envelope.classification,
        },
        'ingest source-bound evidence through MCP',
        [
          'identity.authenticated',
          'tenant.resolved',
          'schema.validated',
          'source.registered',
          'source.accepted',
          'content.integrity_valid',
          'idempotency.present',
        ],
        input.envelope.brain_id,
      );
      input.source_verification = verification;
      const response = await brain.ingest(input);
      await brain.recordActivity(
        input.envelope.tenant_id,
        input.envelope.brain_id,
        'mcp',
        'accepted',
        input.envelope.id,
        'Evidence ingestion requested through authenticated/local MCP.',
        {
          actor_id: principal.id,
          request_id: decision.request_id,
          details_hash: input.envelope.content_hash,
          policy_fingerprint: decision.policy_fingerprint,
        },
      );
      return result(response);
    },
  );
  server.registerTool(
    'cortex_retrieve_memory',
    {
      title: 'Retrieve authorized memory',
      description: 'Runs tenant-scoped hybrid keyword, vector and graph retrieval with citations.',
      inputSchema: payloadSchema,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ payload }) => {
      const input = contracted<RetrievalRequest>(schemas, 'retrieval-request', payload);
      if (input.requester_id !== principal.id) {
        throw new Error('requester_id must match the authenticated MCP identity.');
      }
      const ordered = ['public', 'internal', 'confidential', 'restricted'] as const;
      const classification = input.allowed_classifications.reduce(
        (highest, candidate) =>
          ordered.indexOf(candidate) > ordered.indexOf(highest) ? candidate : highest,
        'public' as (typeof ordered)[number],
      );
      await authorize(
        'knowledge.read',
        { id: input.brain_id, tenant_id: input.tenant_id, classification },
        input.purpose,
        ['identity.authenticated'],
        input.brain_id,
      );
      return result(await brain.retrieve(input));
    },
  );
  server.registerTool(
    'cortex_select_attention',
    {
      title: 'Select bounded attention',
      description: 'Selects a capacity-limited working set using the cognitive contract.',
      inputSchema: payloadSchema,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ payload }) => {
      const input = contracted<{
        tenant_id: string;
        brain_id: string;
        capacity: number;
        weights?: AttentionWeights;
        candidates: AttentionCandidate[];
      }>(schemas, 'attention-selection', payload);
      await authorize(
        'cognition.evaluate',
        { id: input.brain_id, tenant_id: input.tenant_id, classification: 'internal' },
        'select bounded attention through MCP',
        ['identity.authenticated', 'tenant.resolved', 'schema.validated'],
        input.brain_id,
      );
      return result(selectAttention(input.candidates, input.capacity, input.weights));
    },
  );
  server.registerTool(
    'cortex_evaluate_predictions',
    {
      title: 'Evaluate world-model predictions',
      description: 'Compares predictions with observations and exposes prediction error.',
      inputSchema: payloadSchema,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ payload }) => {
      const input = contracted<{
        tenant_id: string;
        brain_id: string;
        deliberation_threshold: number;
        observations: PredictionObservation[];
      }>(schemas, 'prediction-observation', payload);
      await authorize(
        'cognition.evaluate',
        { id: input.brain_id, tenant_id: input.tenant_id, classification: 'internal' },
        'evaluate predictions through MCP',
        ['identity.authenticated', 'tenant.resolved', 'schema.validated'],
        input.brain_id,
      );
      return result(evaluatePredictions(input.observations, input.deliberation_threshold));
    },
  );
  server.registerTool(
    'cortex_evaluate_metacognition',
    {
      title: 'Evaluate confidence calibration',
      description: 'Measures calibration without exposing or requesting private chain-of-thought.',
      inputSchema: payloadSchema,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ payload }) => {
      const input = contracted<{
        tenant_id: string;
        brain_id: string;
        bin_count: number;
        samples: ConfidenceSample[];
      }>(schemas, 'metacognitive-evaluation', payload);
      await authorize(
        'cognition.evaluate',
        { id: input.brain_id, tenant_id: input.tenant_id, classification: 'internal' },
        'evaluate confidence calibration through MCP',
        ['identity.authenticated', 'tenant.resolved', 'schema.validated'],
        input.brain_id,
      );
      return result(assessCalibration(input.samples, input.bin_count));
    },
  );
  server.registerTool(
    'cortex_propose_consolidation',
    {
      title: 'Propose memory consolidation',
      description:
        'Ranks replay candidates and returns a review-required proposal with zero autonomous writes.',
      inputSchema: payloadSchema,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ payload }) => {
      const input = contracted<{
        tenant_id: string;
        brain_id: string;
        batch_size: number;
        candidates: ReplayCandidate[];
      }>(schemas, 'consolidation-proposal', payload);
      await authorize(
        'cognition.evaluate',
        { id: input.brain_id, tenant_id: input.tenant_id, classification: 'internal' },
        'propose memory consolidation through MCP',
        ['identity.authenticated', 'tenant.resolved', 'schema.validated'],
        input.brain_id,
      );
      return result(proposeConsolidation(input.candidates, input.batch_size));
    },
  );
  server.registerTool(
    'cortex_evaluate_policy',
    {
      title: 'Evaluate deterministic policy',
      description: 'Evaluates an allowlisted capability; does not execute the resulting action.',
      inputSchema: payloadSchema,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ payload }) => {
      const proposed = contracted<import('../policy.js').PolicyRequest>(
        schemas,
        'policy-request',
        payload,
      );
      await authorize('policy.evaluate', proposed.resource, proposed.context.purpose, [
        'identity.authenticated',
        'schema.validated',
      ]);
      return result(
        policy.evaluate({
          ...proposed,
          subject: {
            id: principal.id,
            tenant_id: proposed.resource.tenant_id ?? principal.tenant_ids[0] ?? 'public',
            roles: principal.roles,
            permissions: principal.permissions,
          },
        }),
      );
    },
  );
  server.registerTool(
    'cortex_evaluate_tool_proposal',
    {
      title: 'Evaluate tool proposal with Ontology Guard',
      description:
        'Applies identity, agent capability, loop budget, ontology-bound policy and approval checks; executes no effect.',
      inputSchema: payloadSchema,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ payload }) => result(await guard.evaluate(payload, principal)),
  );
  server.registerTool(
    'cortex_start_agent_session',
    {
      title: 'Start governed agent session',
      description: 'Creates an auditable coordination session from the trusted agent registry.',
      inputSchema: payloadSchema,
      annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ payload }) => {
      const input = contracted<{
        tenant_id: string;
        brain_id: string;
        objective: string;
        initial_agent: string;
      }>(schemas, 'agent-session', payload);
      const agent = agents.assertCapability(input.initial_agent, 'handoff.propose');
      const classifications = principal.allowed_classifications.filter((classification) =>
        agent.allowed_classifications.includes(classification),
      );
      const decision = await authorize(
        'agent.session.create',
        {
          id: input.brain_id,
          tenant_id: input.tenant_id,
          classification: classifications.at(-1) ?? 'public',
        },
        'create governed agent session through MCP',
        ['identity.authenticated', 'tenant.resolved', 'agent.registered'],
        input.brain_id,
      );
      return result(
        await agents.create({
          ...input,
          allowed_classifications: classifications,
          activity_context: {
            actor_id: principal.id,
            request_id: decision.request_id,
            policy_fingerprint: decision.policy_fingerprint,
          },
        }),
      );
    },
  );
  server.registerTool(
    'cortex_get_agent_session',
    {
      title: 'Read governed agent session',
      description: 'Reads one session only when tenant and brain scope match.',
      inputSchema: z.object({
        session_id: z.string().min(8).max(128),
        tenant_id: z.string().min(1).max(128),
        brain_id: z.string().min(1).max(128),
      }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ session_id: sessionId, tenant_id: tenantId, brain_id: brainId }) => {
      await authorize(
        'activity.read',
        { id: sessionId, tenant_id: tenantId, classification: 'restricted' },
        'read governed agent session through MCP',
        ['identity.authenticated', 'tenant.resolved'],
        brainId,
      );
      const session = await agents.get(sessionId, tenantId, brainId);
      if (!session || session.tenant_id !== tenantId || session.brain_id !== brainId) {
        throw new Error('Agent session was not found in the authorized scope.');
      }
      return result(session);
    },
  );
  server.registerTool(
    'cortex_handoff_agent',
    {
      title: 'Record governed agent handoff',
      description:
        'Changes workflow responsibility with scope and evidence; executes no external effect.',
      inputSchema: z.object({
        session_id: z.string().min(8).max(128),
        payload: z.record(z.string(), z.unknown()),
      }),
      annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ session_id: sessionId, payload }) => {
      const input = contracted<{
        tenant_id: string;
        brain_id: string;
        from_agent: string;
        to_agent: string;
        reason: string;
        evidence_ids: string[];
      }>(schemas, 'agent-handoff', payload);
      const decision = await authorize(
        'agent.handoff.propose',
        { id: sessionId, tenant_id: input.tenant_id, classification: 'confidential' },
        'record evidence-bearing handoff through MCP',
        ['identity.authenticated', 'tenant.resolved', 'agent.registered'],
        input.brain_id,
      );
      return result(
        await agents.handoff(sessionId, {
          ...input,
          activity_context: {
            actor_id: principal.id,
            request_id: decision.request_id,
            policy_fingerprint: decision.policy_fingerprint,
          },
        }),
      );
    },
  );
  server.registerTool(
    'cortex_workforce_snapshot',
    {
      title: 'Read governed workforce snapshot',
      description:
        'Returns real goals, work items, routines, evaluations and metered costs for one tenant and brain.',
      inputSchema: z.object({
        tenant_id: z.string().min(1).max(128),
        brain_id: z.string().min(1).max(128),
      }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ tenant_id: tenantId, brain_id: brainId }) => {
      await authorize(
        'workforce.read',
        { id: brainId, tenant_id: tenantId, classification: 'restricted' },
        'read governed workforce snapshot through MCP',
        ['identity.authenticated', 'tenant.resolved'],
        brainId,
      );
      return result(await workforce.snapshot(tenantId, brainId));
    },
  );
  server.registerTool(
    'cortex_create_goal',
    {
      title: 'Create governed goal',
      description: 'Creates an idempotent ontology-bound goal with measurable success criteria.',
      inputSchema: payloadSchema,
      annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ payload }) => {
      const input = contracted<Parameters<WorkforceService['createGoal']>[0]>(
        schemas,
        'workforce-goal',
        payload,
      );
      const decision = await authorize(
        'workforce.goal.create',
        { id: input.brain_id, tenant_id: input.tenant_id, classification: input.classification },
        'create governed workforce goal through MCP',
        [
          'identity.authenticated',
          'tenant.resolved',
          'schema.validated',
          'agent.registered',
          'idempotency.present',
        ],
        input.brain_id,
      );
      return result(
        await workforce.createGoal(input, {
          actor_id: principal.id,
          request_id: decision.request_id,
          operation: 'mcp.workforce.goal.create',
          policy_fingerprint: decision.policy_fingerprint,
        }),
      );
    },
  );
  server.registerTool(
    'cortex_create_work_item',
    {
      title: 'Create governed work item',
      description: 'Creates budgeted, goal-traceable work assigned to a registered agent.',
      inputSchema: payloadSchema,
      annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ payload }) => {
      const input = contracted<Parameters<WorkforceService['createWorkItem']>[0]>(
        schemas,
        'work-item',
        payload,
      );
      const decision = await authorize(
        'workforce.work.create',
        { id: input.goal_id, tenant_id: input.tenant_id, classification: input.classification },
        'create governed work item through MCP',
        [
          'identity.authenticated',
          'tenant.resolved',
          'schema.validated',
          'goal.active',
          'agent.registered',
          'idempotency.present',
        ],
        input.brain_id,
      );
      return result(
        await workforce.createWorkItem(input, {
          actor_id: principal.id,
          request_id: decision.request_id,
          operation: 'mcp.workforce.work.create',
          causation_id: input.goal_id,
          policy_fingerprint: decision.policy_fingerprint,
        }),
      );
    },
  );
  server.registerTool(
    'cortex_checkout_work_item',
    {
      title: 'Atomically check out work',
      description:
        'Acquires one expiring lease only when assignment, blockers and budgets permit it.',
      inputSchema: z.object({
        work_item_id: z.string().regex(/^work:[a-f0-9]{32}$/u),
        payload: z.record(z.string(), z.unknown()),
      }),
      annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ work_item_id: workItemId, payload }) => {
      const input = contracted<{
        tenant_id: string;
        brain_id: string;
        classification: import('../policy.js').Classification;
        agent_id: string;
        lease_seconds: number;
      }>(schemas, 'work-item-checkout', payload);
      const decision = await authorize(
        'workforce.work.checkout',
        { id: workItemId, tenant_id: input.tenant_id, classification: input.classification },
        'atomically check out governed work through MCP',
        [
          'identity.authenticated',
          'tenant.resolved',
          'agent.registered',
          'work.ready',
          'budget.available',
        ],
        input.brain_id,
      );
      return result(
        await workforce.checkout(
          { ...input, work_item_id: workItemId },
          {
            actor_id: principal.id,
            request_id: decision.request_id,
            operation: 'mcp.workforce.work.checkout',
            causation_id: workItemId,
            policy_fingerprint: decision.policy_fingerprint,
          },
        ),
      );
    },
  );
  server.registerTool(
    'cortex_transition_work_item',
    {
      title: 'Transition governed work',
      description:
        'Applies the bounded work-state machine with evidence and independent review gates.',
      inputSchema: z.object({
        work_item_id: z.string().regex(/^work:[a-f0-9]{32}$/u),
        payload: z.record(z.string(), z.unknown()),
      }),
      annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ work_item_id: workItemId, payload }) => {
      const input = contracted<{
        tenant_id: string;
        brain_id: string;
        classification: import('../policy.js').Classification;
        actor_agent_id: string;
        target_status: WorkItemStatus;
        evidence_ids: string[];
        reviewer_agent_id?: string | null;
      }>(schemas, 'work-item-transition', payload);
      const decision = await authorize(
        'workforce.work.transition',
        { id: workItemId, tenant_id: input.tenant_id, classification: input.classification },
        'transition governed work through MCP',
        ['identity.authenticated', 'tenant.resolved', 'schema.validated', 'state.transition_valid'],
        input.brain_id,
      );
      return result(
        await workforce.transition(
          { ...input, work_item_id: workItemId },
          {
            actor_id: principal.id,
            request_id: decision.request_id,
            operation: 'mcp.workforce.work.transition',
            causation_id: workItemId,
            policy_fingerprint: decision.policy_fingerprint,
          },
        ),
      );
    },
  );
  server.registerTool(
    'cortex_create_routine',
    {
      title: 'Create governed routine',
      description: 'Creates a bounded recurring template; it does not execute an external effect.',
      inputSchema: payloadSchema,
      annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ payload }) => {
      const input = contracted<Parameters<WorkforceService['createRoutine']>[0]>(
        schemas,
        'workforce-routine',
        payload,
      );
      const decision = await authorize(
        'workforce.routine.create',
        { id: input.goal_id, tenant_id: input.tenant_id, classification: input.classification },
        'create governed workforce routine through MCP',
        [
          'identity.authenticated',
          'tenant.resolved',
          'schema.validated',
          'goal.active',
          'budget.declared',
          'idempotency.present',
        ],
        input.brain_id,
      );
      return result(
        await workforce.createRoutine(input, {
          actor_id: principal.id,
          request_id: decision.request_id,
          operation: 'mcp.workforce.routine.create',
          causation_id: input.goal_id,
          policy_fingerprint: decision.policy_fingerprint,
        }),
      );
    },
  );
  server.registerTool(
    'cortex_materialize_routines',
    {
      title: 'Materialize due routines',
      description: 'Creates tracked work for due routines without executing the work itself.',
      inputSchema: payloadSchema,
      annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ payload }) => {
      const input = contracted<{
        tenant_id: string;
        brain_id: string;
        classification: import('../policy.js').Classification;
        now: string;
      }>(schemas, 'workforce-routine-materialize', payload);
      const decision = await authorize(
        'workforce.routine.materialize',
        { id: input.brain_id, tenant_id: input.tenant_id, classification: input.classification },
        'materialize governed workforce routines through MCP',
        ['identity.authenticated', 'tenant.resolved', 'schedule.due', 'budget.declared'],
        input.brain_id,
      );
      return result(
        await workforce.materializeDueRoutines(
          input.tenant_id,
          input.brain_id,
          input.classification,
          input.now,
          {
            actor_id: principal.id,
            request_id: decision.request_id,
            operation: 'mcp.workforce.routine.materialize',
            policy_fingerprint: decision.policy_fingerprint,
          },
        ),
      );
    },
  );
  server.registerTool(
    'cortex_record_cost',
    {
      title: 'Record real workforce cost',
      description:
        'Appends provider-reported or evidence-backed allocated usage; estimates are rejected.',
      inputSchema: payloadSchema,
      annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ payload }) => {
      const input = contracted<
        Omit<WorkforceCostEvent, 'id'> & { classification: import('../policy.js').Classification }
      >(schemas, 'workforce-cost-event', payload);
      const decision = await authorize(
        'workforce.cost.record',
        {
          id: input.work_item_id,
          tenant_id: input.tenant_id,
          classification: input.classification,
        },
        'record evidence-backed workforce cost through MCP',
        [
          'identity.authenticated',
          'tenant.resolved',
          'schema.validated',
          'metering.evidence_present',
          'idempotency.present',
        ],
        input.brain_id,
      );
      return result(
        await workforce.recordCost(input, {
          actor_id: principal.id,
          request_id: decision.request_id,
          operation: 'mcp.workforce.cost.record',
          causation_id: input.work_item_id,
          policy_fingerprint: decision.policy_fingerprint,
        }),
      );
    },
  );
  server.registerTool(
    'cortex_record_heartbeat',
    {
      title: 'Record evidence-backed agent heartbeat',
      description:
        'Appends an observed agent status; it does not infer liveness or invent activity.',
      inputSchema: payloadSchema,
      annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ payload }) => {
      const input = contracted<Parameters<WorkforceService['recordHeartbeat']>[0]>(
        schemas,
        'workforce-heartbeat',
        payload,
      );
      const decision = await authorize(
        'workforce.heartbeat.record',
        { id: input.agent_id, tenant_id: input.tenant_id, classification: input.classification },
        'record evidence-backed agent heartbeat through MCP',
        [
          'identity.authenticated',
          'tenant.resolved',
          'schema.validated',
          'agent.registered',
          'evidence.present',
          'idempotency.present',
        ],
        input.brain_id,
      );
      return result(
        await workforce.recordHeartbeat(input, {
          actor_id: principal.id,
          request_id: decision.request_id,
          operation: 'mcp.workforce.heartbeat.record',
          causation_id: input.current_work_item_id ?? input.agent_id,
          policy_fingerprint: decision.policy_fingerprint,
        }),
      );
    },
  );
  server.registerTool(
    'cortex_record_agent_evaluation',
    {
      title: 'Record evidence-based agent evaluation',
      description:
        'Records independent quality, correctness, efficiency and policy-compliance scores.',
      inputSchema: payloadSchema,
      annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ payload }) => {
      const input = contracted<Parameters<WorkforceService['evaluate']>[0]>(
        schemas,
        'workforce-evaluation',
        payload,
      );
      const decision = await authorize(
        'workforce.evaluation.record',
        {
          id: input.work_item_id,
          tenant_id: input.tenant_id,
          classification: input.classification,
        },
        'record independent workforce evaluation through MCP',
        [
          'identity.authenticated',
          'tenant.resolved',
          'schema.validated',
          'evidence.present',
          'reviewer.independent',
          'idempotency.present',
        ],
        input.brain_id,
      );
      return result(
        await workforce.evaluate(input, {
          actor_id: principal.id,
          request_id: decision.request_id,
          operation: 'mcp.workforce.evaluation.record',
          causation_id: input.work_item_id,
          policy_fingerprint: decision.policy_fingerprint,
        }),
      );
    },
  );
  server.registerTool(
    'cortex_read_activity',
    {
      title: 'Read brain activity',
      description: 'Reads recent operational activity within one explicit tenant and brain scope.',
      inputSchema: z.object({
        tenant_id: z.string().min(1).max(128),
        brain_id: z.string().min(1).max(128),
        limit: z.number().int().min(1).max(500).default(100),
      }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ tenant_id: tenantId, brain_id: brainId, limit }) => {
      await authorize(
        'activity.read',
        { id: brainId, tenant_id: tenantId, classification: 'restricted' },
        'read append-only activity through MCP',
        ['identity.authenticated', 'tenant.resolved'],
        brainId,
      );
      const activity = await brain.activity(tenantId, brainId, limit);
      if (activity.some((event) => !schemas.validate('brain-activity', event).valid)) {
        throw new Error('Brain engine emitted an invalid activity event.');
      }
      return result({ activity });
    },
  );

  return server;
}
