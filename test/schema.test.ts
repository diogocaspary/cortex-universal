import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { repositoryRoot } from '../src/paths.js';
import { SchemaRegistry } from '../src/schema.js';

const root = repositoryRoot();
let schemas: SchemaRegistry;

beforeAll(async () => {
  schemas = await SchemaRegistry.create(root);
});

async function fixture(path: string): Promise<unknown> {
  return JSON.parse(await readFile(join(root, path), 'utf8')) as unknown;
}

describe('JSON contracts', () => {
  it('loads all public schema names', () => {
    expect(schemas.names()).toEqual([
      'action',
      'action-registry',
      'agent-handoff',
      'agent-registry',
      'agent-session',
      'attention-selection',
      'audit-integrity',
      'brain-activity',
      'brain-ingestion',
      'claim',
      'cognitive-cycle',
      'consolidation-proposal',
      'effect-outcome',
      'event',
      'graph-snapshot',
      'guard-decision',
      'ingestion-envelope',
      'metacognitive-evaluation',
      'module-manifest',
      'operation-registry',
      'package-manifest',
      'policy-bundle',
      'policy-decision',
      'policy-request',
      'prediction-observation',
      'reasoning-report',
      'retrieval-request',
      'retrieval-response',
      'sanitized-failure',
      'shacl-report',
      'skill-registry',
      'skill-trust-registry',
      'source-registry',
      'tool-proposal',
      'work-item',
      'work-item-checkout',
      'work-item-transition',
      'workforce-cost-event',
      'workforce-evaluation',
      'workforce-goal',
      'workforce-heartbeat',
      'workforce-routine',
      'workforce-routine-materialize',
    ]);
  });

  it('enforces bounded, tenant-scoped cognitive contracts', () => {
    const attention = {
      request_id: 'request:attention:1',
      tenant_id: 'tenant:one',
      brain_id: 'brain:one',
      capacity: 1,
      candidates: [
        {
          id: 'candidate:one',
          relevance: 0.9,
          goal_alignment: 0.8,
          novelty: 0.4,
          urgency: 0.7,
          uncertainty: 0.2,
          classification: 'internal',
          source_ids: ['source:one'],
          observed_at: '2026-08-09T12:00:00.000Z',
        },
      ],
    };
    expect(schemas.validate('attention-selection', attention).valid).toBe(true);
    expect(
      schemas.validate('attention-selection', { ...attention, tenant_id: undefined }).valid,
    ).toBe(false);
    expect(schemas.validate('attention-selection', { ...attention, capacity: 101 }).valid).toBe(
      false,
    );
  });

  it('accepts the valid claim and event fixtures', async () => {
    expect(schemas.validate('claim', await fixture('examples/valid/claim.json')).valid).toBe(true);
    expect(schemas.validate('event', await fixture('examples/valid/event.json')).valid).toBe(true);
  });

  it('accepts ingestion and evidence-bearing retrieval fixtures', async () => {
    for (const schema of [
      'brain-ingestion',
      'ingestion-envelope',
      'retrieval-request',
      'retrieval-response',
    ]) {
      expect(schemas.validate(schema, await fixture(`examples/valid/${schema}.json`)).valid).toBe(
        true,
      );
    }
  });

  it('rejects retrieval without tenant scope and permits explicit uncited gaps', async () => {
    const request = (await fixture('examples/valid/retrieval-request.json')) as Record<
      string,
      unknown
    >;
    delete request.tenant_id;
    expect(schemas.validate('retrieval-request', request).valid).toBe(false);

    const response = (await fixture('examples/valid/retrieval-response.json')) as {
      hits: Array<Record<string, unknown>>;
    };
    response.hits[0]!.citations = [];
    expect(schemas.validate('retrieval-response', response).valid).toBe(true);
  });

  it('rejects undeclared retrieval filters', async () => {
    const request = (await fixture('examples/valid/retrieval-request.json')) as {
      filters: Record<string, unknown>;
    };
    request.filters.raw_sql = 'select * from another_tenant';
    expect(schemas.validate('retrieval-request', request).valid).toBe(false);
  });

  it('requires claim validity and event classification', async () => {
    const claim = (await fixture('examples/valid/claim.json')) as Record<string, unknown>;
    delete claim.valid_from;
    expect(schemas.validate('claim', claim).valid).toBe(false);

    const event = (await fixture('examples/valid/event.json')) as Record<string, unknown>;
    delete event.classification;
    expect(schemas.validate('event', event).valid).toBe(false);
  });

  it('rejects an untrusted and incomplete claim', async () => {
    const report = schemas.validate('claim', await fixture('examples/invalid/claim.json'));
    expect(report.valid).toBe(false);
    expect(report.errors.length).toBeGreaterThan(3);
  });

  it('rejects undeclared properties', async () => {
    const claim = (await fixture('examples/valid/claim.json')) as Record<string, unknown>;
    claim.secret = 'must-not-cross-contract-boundary';
    expect(schemas.validate('claim', claim).valid).toBe(false);
  });

  it('does not resolve arbitrary schema paths', () => {
    expect(() => schemas.validate('../../etc/passwd', {})).toThrow('Unknown schema');
  });

  it('rejects estimated costs and heartbeats without observation evidence', () => {
    const cost = {
      tenant_id: 'tenant:one',
      brain_id: 'brain:one',
      classification: 'internal',
      agent_id: 'ontologist',
      goal_id: `goal:${'a'.repeat(32)}`,
      work_item_id: `work:${'b'.repeat(32)}`,
      provider: 'provider-under-test',
      model: 'model-under-test',
      input_tokens: 1,
      output_tokens: 1,
      cached_input_tokens: 0,
      cost_microusd: 1,
      measurement_status: 'estimated',
      evidence_reference: 'urn:cortex:meter:test',
      occurred_at: '2026-08-10T12:00:00.000Z',
      idempotency_key: 'cost-schema-test-0001',
    };
    expect(schemas.validate('workforce-cost-event', cost).valid).toBe(false);

    const heartbeat = {
      tenant_id: 'tenant:one',
      brain_id: 'brain:one',
      classification: 'internal',
      agent_id: 'ontologist',
      status: 'idle',
      current_work_item_id: null,
      observed_at: '2026-08-10T12:00:00.000Z',
      idempotency_key: 'heartbeat-schema-test-0001',
    };
    expect(schemas.validate('workforce-heartbeat', heartbeat).valid).toBe(false);
  });

  it('rejects a Git skill whose required signature is null', () => {
    const report = schemas.validate('skill-registry', {
      version: '0.6.0',
      skills: [
        {
          id: 'untrusted.skill',
          name: 'Untrusted skill',
          source_type: 'git',
          source_locator: 'https://github.com/example/untrusted',
          source_revision: '0'.repeat(40),
          content_hash: `sha256:${'0'.repeat(64)}`,
          permissions: [],
          network_access: false,
          secret_bindings: [],
          license: 'MIT',
          reviewed_at: '2026-08-10T00:00:00.000Z',
          reviewed_by: 'security-review',
          signature: null,
        },
      ],
    });
    expect(report.valid).toBe(false);
  });
});
