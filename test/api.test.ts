import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { repositoryRoot } from '../src/paths.js';
import { SchemaRegistry } from '../src/schema.js';
import { validationRequest } from './helpers.js';

const token = 'test-token-that-is-at-least-32-bytes-long';
const root = repositoryRoot();
let app: FastifyInstance;
let schemas: SchemaRegistry;

beforeAll(async () => {
  schemas = await SchemaRegistry.create(root);
  app = await buildApp({ root, apiToken: token, environment: 'test' });
});

afterAll(async () => {
  if (app) await app.close();
});

describe('reference API', () => {
  it('exposes a local service landing response', async () => {
    const response = await app.inject({ method: 'GET', url: '/' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      service: 'Cortex Universal Business Ontology',
      version: '0.6.0',
      status: 'ready',
      endpoints: expect.arrayContaining(['/dashboard/', '/v1/graph']),
    });
    expect(response.headers['x-cortex-version']).toBe('0.6.0');
  });

  it('exposes unauthenticated liveness with security headers', async () => {
    const response = await app.inject({ method: 'GET', url: '/healthz' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
    expect(response.headers['x-content-type-options']).toBe('nosniff');
  });

  it('protects every versioned endpoint', async () => {
    const missing = await app.inject({ method: 'GET', url: '/v1/manifest' });
    expect(missing.statusCode).toBe(401);
    expect(missing.headers['www-authenticate']).toContain('Bearer');

    const wrong = await app.inject({
      method: 'GET',
      url: '/v1/manifest',
      headers: { authorization: 'Bearer wrong-token' },
    });
    expect(wrong.statusCode).toBe(401);

    const accepted = await app.inject({
      method: 'GET',
      url: '/v1/manifest',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({ id: 'cortex-universal', version: '0.6.0' });
    expect(accepted.headers['cache-control']).toBe('no-store');
    expect(accepted.json().modules).toHaveLength(34);
    expect(accepted.headers['x-cortex-trace-id']).toMatch(/^trace:/);
    expect(accepted.headers['x-cortex-correlation-id']).toMatch(/^correlation:/);
  });

  it('serves authenticated MCP Streamable HTTP with host protection', async () => {
    const rejected = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: {
        authorization: `Bearer ${token}`,
        host: 'malicious.example',
        accept: 'application/json, text/event-stream',
      },
      payload: {},
    });
    expect(rejected.statusCode).toBe(403);

    const response = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: {
        authorization: `Bearer ${token}`,
        host: 'localhost:8080',
        accept: 'application/json, text/event-stream',
      },
      payload: {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'cortex-test-client', version: '1.0.0' },
        },
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('cortex-universal');
    expect(response.body).toContain('2025-11-25');

    const tools = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: {
        authorization: `Bearer ${token}`,
        host: 'localhost:8080',
        accept: 'application/json, text/event-stream',
      },
      payload: { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    });
    expect(tools.statusCode).toBe(200);
    for (const name of [
      'cortex_workforce_snapshot',
      'cortex_create_goal',
      'cortex_create_work_item',
      'cortex_checkout_work_item',
      'cortex_transition_work_item',
      'cortex_create_routine',
      'cortex_materialize_routines',
      'cortex_record_cost',
      'cortex_record_heartbeat',
      'cortex_record_agent_evaluation',
    ]) {
      expect(tools.body).toContain(name);
    }
  });

  it('serves the local dashboard with a restrictive content security policy', async () => {
    const redirect = await app.inject({ method: 'GET', url: '/dashboard' });
    expect(redirect.statusCode).toBe(302);
    expect(redirect.headers.location).toBe('/dashboard/');

    const response = await app.inject({ method: 'GET', url: '/dashboard/' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.body).toContain('Mapa ontológico verificável');
    expect(response.body).toContain('Mapa ontológico 3D');
    expect(response.body).toContain('Rede operacional real');
    expect(response.body).toContain('Eventos reais do runtime');
    expect(response.body).not.toMatch(/simular|simulad[oa]|pulsos? sin[aá]pticos?/iu);
    expect(response.body).not.toMatch(/<script[^>]+src=["']https?:/iu);
    expect(response.headers['content-security-policy']).toContain("default-src 'self'");
    expect(response.headers['content-security-policy']).toContain("object-src 'none'");
  });

  it('protects and returns a deterministic visualization graph', async () => {
    const missing = await app.inject({ method: 'GET', url: '/v1/graph' });
    expect(missing.statusCode).toBe(401);

    const response = await app.inject({
      method: 'GET',
      url: '/v1/graph',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toMatchObject({
      version: '0.6.0',
      stats: {
        node_count: expect.any(Number),
        edge_count: expect.any(Number),
        module_count: expect.any(Number),
      },
    });
    expect(response.json().stats.node_count).toBeGreaterThan(100);
    expect(response.json().stats.edge_count).toBeGreaterThan(100);
  });

  it('exposes bounded explainable reasoning without claiming complete OWL reasoning', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/ontology/reasoning',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      profile: 'cortex-rdfs-owl-rl-subset-v1',
      complete_owl_reasoner: false,
      explicit_triples: expect.any(Number),
      inferred_triples: expect.any(Number),
      consistent: expect.any(Boolean),
    });
  });

  it('maps failures to sanitized trace diagnostics without payloads', async () => {
    const failed = await app.inject({
      method: 'POST',
      url: '/v1/brain/retrieve',
      headers: {
        authorization: `Bearer ${token}`,
        'x-correlation-id': 'external:test-correlation-0001',
      },
      payload: { invalid: 'secret-that-must-not-be-logged' },
    });
    expect(failed.statusCode).toBe(400);
    const traceId = failed.headers['x-cortex-trace-id'];
    const diagnostics = await app.inject({
      method: 'GET',
      url: '/v1/observability/failures?limit=20',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(diagnostics.statusCode).toBe(200);
    const encoded = JSON.stringify(diagnostics.json());
    expect(encoded).not.toContain('secret-that-must-not-be-logged');
    expect(
      diagnostics
        .json()
        .failures.every((failure: unknown) => schemas.validate('sanitized-failure', failure).valid),
    ).toBe(true);
    expect(diagnostics.json().failures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          trace_id: traceId,
          correlation_id: 'external:test-correlation-0001',
          operation: '/v1/brain/retrieve',
          error_code: 'invalid_operational_request',
          error_fingerprint: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        }),
      ]),
    );
  });

  it('validates JSON contracts', async () => {
    const claim = JSON.parse(
      await readFile(join(root, 'examples', 'valid', 'claim.json'), 'utf8'),
    ) as Record<string, unknown>;
    const response = await app.inject({
      method: 'POST',
      url: '/v1/validate/json/claim',
      headers: { authorization: `Bearer ${token}` },
      payload: claim,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ valid: true, schema: 'claim' });
  });

  it('exposes the governed workforce through authenticated contracts', async () => {
    const headers = { authorization: `Bearer ${token}` };
    const tenantId = 'tenant:api-workforce';
    const brainId = 'brain:api-workforce';
    const goalPayload = {
      tenant_id: tenantId,
      brain_id: brainId,
      classification: 'internal',
      title: 'Exercise the workforce HTTP contracts',
      description: 'Create and check out one task through the authenticated API.',
      success_criteria: [
        {
          id: 'api_verified',
          description: 'The API integration test passes.',
          verification_method: 'test',
          required: true,
        },
      ],
      owner_agent_id: 'orchestrator',
      idempotency_key: 'api-workforce-goal-0001',
    };
    const goal = await app.inject({
      method: 'POST',
      url: '/v1/workforce/goals',
      headers,
      payload: goalPayload,
    });
    expect(goal.statusCode).toBe(201);
    expect(goal.json()).toMatchObject({ record_type: 'goal', status: 'active' });
    const duplicate = await app.inject({
      method: 'POST',
      url: '/v1/workforce/goals',
      headers,
      payload: goalPayload,
    });
    expect(duplicate.statusCode).toBe(201);
    expect(duplicate.json().id).toBe(goal.json().id);
    const conflicting = await app.inject({
      method: 'POST',
      url: '/v1/workforce/goals',
      headers,
      payload: { ...goalPayload, title: 'A conflicting title for the same idempotency key' },
    });
    expect(conflicting.statusCode).toBe(409);
    expect(conflicting.json()).toMatchObject({ error: 'record_conflict' });

    const item = await app.inject({
      method: 'POST',
      url: '/v1/workforce/work-items',
      headers,
      payload: {
        tenant_id: tenantId,
        brain_id: brainId,
        classification: 'internal',
        goal_id: goal.json().id,
        title: 'Verify API workforce state',
        description: 'Use an atomic lease and retain an evidence-bearing heartbeat.',
        priority: 2,
        assigned_agent_id: 'ontologist',
        required_capabilities: ['ontology.validate'],
        acceptance_criteria: [
          {
            id: 'api_task_verified',
            description: 'The API task is verified by this test.',
            verification_method: 'test',
            required: true,
          },
        ],
        blocked_by: [],
        budget: {
          max_total_tokens: 1_000,
          max_cost_microusd: 100_000,
          max_duration_ms: 60_000,
        },
        review_required: true,
        source: 'human',
        idempotency_key: 'api-workforce-item-0001',
      },
    });
    expect(item.statusCode).toBe(201);
    expect(item.json()).toMatchObject({ record_type: 'work_item', status: 'ready' });

    const checkout = await app.inject({
      method: 'POST',
      url: `/v1/workforce/work-items/${item.json().id}/checkout`,
      headers,
      payload: {
        tenant_id: tenantId,
        brain_id: brainId,
        classification: 'internal',
        agent_id: 'ontologist',
        lease_seconds: 30,
      },
    });
    expect(checkout.statusCode).toBe(200);
    expect(checkout.json()).toMatchObject({ status: 'in_progress' });

    const heartbeat = await app.inject({
      method: 'POST',
      url: '/v1/workforce/heartbeats',
      headers,
      payload: {
        tenant_id: tenantId,
        brain_id: brainId,
        classification: 'internal',
        agent_id: 'ontologist',
        status: 'working',
        current_work_item_id: item.json().id,
        observed_at: new Date().toISOString(),
        evidence_reference: 'urn:cortex:api-heartbeat:test-0001',
        idempotency_key: 'api-workforce-heartbeat-0001',
      },
    });
    expect(heartbeat.statusCode).toBe(201);
    expect(heartbeat.json()).toMatchObject({ record_type: 'heartbeat', status: 'working' });

    const snapshot = await app.inject({
      method: 'GET',
      url: `/v1/workforce/snapshot?tenant_id=${tenantId}&brain_id=${brainId}`,
      headers,
    });
    expect(snapshot.statusCode).toBe(200);
    expect(snapshot.json()).toMatchObject({
      goals: [{ id: goal.json().id }],
      work_items: [{ id: item.json().id, status: 'in_progress' }],
      heartbeats: [{ agent_id: 'ontologist', status: 'working' }],
      costs: { event_count: 0, total_tokens: 0, cost_microusd: 0 },
    });
  });

  it('returns a conformance report for invalid Turtle', async () => {
    const data = await readFile(
      join(root, 'examples', 'invalid', 'missing-provenance.ttl'),
      'utf8',
    );
    const response = await app.inject({
      method: 'POST',
      url: '/v1/validate/shacl',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'text/turtle',
      },
      payload: data,
    });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ conforms: false });
  });

  it('evaluates but never executes a trusted action', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/policies/evaluate',
      headers: { authorization: `Bearer ${token}` },
      payload: validationRequest(),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      decision: 'allow',
      action_key: 'ontology.validate',
      verification_action: 'validation.get_report',
    });
  });

  it('exposes bounded cognitive computation without external effects', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/cognition/attention/select',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        request_id: 'request:attention:1',
        tenant_id: 'tenant:one',
        brain_id: 'brain:one',
        capacity: 1,
        candidates: [
          {
            id: 'candidate:one',
            relevance: 1,
            goal_alignment: 1,
            novelty: 0,
            urgency: 0,
            uncertainty: 0,
            classification: 'internal',
            source_ids: ['source:one'],
            observed_at: '2026-08-09T12:00:00.000Z',
          },
        ],
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      request_id: 'request:attention:1',
      tenant_id: 'tenant:one',
      selected: [{ id: 'candidate:one', source_ids: ['source:one'] }],
      deferred: [],
    });
  });

  it('persists evidence and retrieves it through isolated hybrid channels', async () => {
    const ingestion = JSON.parse(
      await readFile(join(root, 'examples', 'valid', 'brain-ingestion.json'), 'utf8'),
    ) as Record<string, unknown>;
    const accepted = await app.inject({
      method: 'POST',
      url: '/v1/brain/ingest',
      headers: { authorization: `Bearer ${token}` },
      payload: ingestion,
    });
    expect(accepted.statusCode).toBe(201);
    expect(accepted.json()).toMatchObject({ id: 'evidence:customer-42-status', accepted: true });

    const duplicate = await app.inject({
      method: 'POST',
      url: '/v1/brain/ingest',
      headers: { authorization: `Bearer ${token}` },
      payload: ingestion,
    });
    expect(duplicate.statusCode).toBe(200);
    expect(duplicate.json()).toMatchObject({ accepted: false });

    const retrieval = JSON.parse(
      await readFile(join(root, 'examples', 'valid', 'retrieval-request.json'), 'utf8'),
    ) as Record<string, unknown>;
    const response = await app.inject({
      method: 'POST',
      url: '/v1/brain/retrieve',
      headers: { authorization: `Bearer ${token}` },
      payload: retrieval,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      request_id: 'request:0001',
      hits: [
        {
          id: 'evidence:customer-42-status',
          excerpt: expect.stringContaining('cliente 42'),
          citations: ['urn:cortex:evidence:crm-event-9001'],
        },
      ],
    });

    const isolated = await app.inject({
      method: 'POST',
      url: '/v1/brain/retrieve',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        ...retrieval,
        request_id: 'request:isolated:1',
        tenant_id: 'another-tenant',
        modes: ['keyword'],
        query: 'cliente',
      },
    });
    expect(isolated.statusCode).toBe(200);
    expect(isolated.json()).toMatchObject({
      hits: [],
      gaps: [{ code: 'no_results' }],
    });
  });

  it('coordinates registered agents and records cortex activity without executing effects', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/v1/agents/sessions',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        tenant_id: 'tenant-example',
        brain_id: 'customer-operations',
        objective: 'Verificar as evidências da situação atual do cliente.',
        initial_agent: 'orchestrator',
      },
    });
    expect(created.statusCode).toBe(201);
    const session = created.json() as { id: string };

    const handedOff = await app.inject({
      method: 'POST',
      url: `/v1/agents/sessions/${encodeURIComponent(session.id)}/handoffs`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        tenant_id: 'tenant-example',
        brain_id: 'customer-operations',
        from_agent: 'orchestrator',
        to_agent: 'verifier',
        reason: 'A confiança e as citações precisam de verificação independente.',
        evidence_ids: ['evidence:customer-42-status'],
      },
    });
    expect(handedOff.statusCode).toBe(200);
    expect(handedOff.json()).toMatchObject({ active_agent: 'verifier' });

    const activity = await app.inject({
      method: 'GET',
      url: '/v1/brain/activity?tenant_id=tenant-example&brain_id=customer-operations',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(activity.statusCode).toBe(200);
    expect(activity.json().activity).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'agent_handoff', status: 'proposed' }),
        expect.objectContaining({ kind: 'ingestion', status: 'accepted' }),
      ]),
    );
  });

  it('rejects tampered evidence before persistence', async () => {
    const ingestion = JSON.parse(
      await readFile(join(root, 'examples', 'valid', 'brain-ingestion.json'), 'utf8'),
    ) as { envelope: Record<string, unknown>; projection: Record<string, unknown> };
    ingestion.envelope.id = 'evidence:tampered-customer';
    ingestion.envelope.idempotency_key = 'tampered-event-key-0001';
    ingestion.projection.text = 'Conteúdo adulterado.';
    const response = await app.inject({
      method: 'POST',
      url: '/v1/brain/ingest',
      headers: { authorization: `Bearer ${token}` },
      payload: ingestion,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'invalid_operational_request' });
  });

  it('rejects an invalid cognitive contract before computation', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/cognition/metacognition/evaluate',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        request_id: 'request:metacognition:1',
        tenant_id: 'tenant:one',
        brain_id: 'brain:one',
        bin_count: 10,
        samples: [{ id: 'sample:one', confidence: 1.5, correct: true, evidence_ids: ['e:1'] }],
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'invalid_cognitive_request' });
  });

  it('rejects malformed policy context', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/policies/evaluate',
      headers: { authorization: `Bearer ${token}` },
      payload: { action_key: 'ontology.validate' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'invalid_policy_request' });
  });

  it('refuses production startup without a token', async () => {
    await expect(buildApp({ root, environment: 'production' })).rejects.toThrow(
      'required in production',
    );
  });
});
