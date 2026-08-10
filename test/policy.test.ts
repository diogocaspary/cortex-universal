import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { PolicyEngine } from '../src/policy.js';
import { repositoryRoot } from '../src/paths.js';
import { SchemaRegistry } from '../src/schema.js';
import { exportRequest, refundRequest, validationRequest } from './helpers.js';

let engine: PolicyEngine;
let schemas: SchemaRegistry;

beforeAll(async () => {
  const root = repositoryRoot();
  schemas = await SchemaRegistry.create(root);
  engine = await PolicyEngine.create(root, schemas);
});

describe('deterministic policy engine', () => {
  it('allows only when every validation control is satisfied', () => {
    const decision = engine.evaluate(validationRequest());
    expect(decision).toMatchObject({
      decision: 'allow',
      request_id: 'request-validation-001',
      matched_rule: 'allow-semantic-validation',
      reasons: ['all_controls_satisfied'],
    });
    expect(decision.policy_fingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(schemas.validate('policy-decision', decision).valid).toBe(true);
  });

  it('denies unknown actions', () => {
    const result = engine.evaluate(validationRequest({ action_key: 'unknown.action' }));
    expect(result).toMatchObject({ decision: 'deny', reasons: ['unknown_action'] });
  });

  it('denies non-public cross-tenant access', () => {
    const request = validationRequest();
    request.resource.tenant_id = 'tenant-2';
    expect(engine.evaluate(request).reasons).toContain('cross_tenant_access_denied');
  });

  it('permits a policy-authorized public resource across tenants', () => {
    const request = validationRequest();
    request.resource = { id: 'public-graph', tenant_id: 'tenant-2', classification: 'public' };
    expect(engine.evaluate(request).decision).toBe('allow');
  });

  it('denies missing permissions and verified preconditions', () => {
    const noPermission = validationRequest();
    noPermission.subject.permissions = [];
    expect(engine.evaluate(noPermission).reasons).toContain('missing_permission:ontology.validate');

    const noPrecondition = validationRequest();
    noPrecondition.verified_preconditions = [];
    expect(engine.evaluate(noPrecondition).reasons).toContain(
      'missing_precondition:payload.within_size_limit',
    );
  });

  it('requires a recorded human approval for refunds', () => {
    const pending = refundRequest();
    expect(engine.evaluate(pending).reasons).toContain('human_approval_required');

    pending.approval = {
      status: 'approved',
      reference: 'approval-100',
      approved_by: ['finance-manager-2'],
      approved_at: '2026-08-08T17:55:00Z',
      expires_at: '2026-08-08T18:05:00Z',
    };
    expect(engine.evaluate(pending).decision).toBe('allow');
  });

  it('requires two distinct approvers for bulk export', () => {
    const request = exportRequest();
    request.approval = {
      status: 'approved',
      reference: 'approval-export-1',
      approved_by: ['approver-1'],
      approved_at: '2026-08-08T17:55:00Z',
      expires_at: '2026-08-08T18:05:00Z',
    };
    expect(engine.evaluate(request).reasons).toContain('dual_control_approval_required');

    request.approval.approved_by = ['approver-1', 'approver-2'];
    expect(engine.evaluate(request).decision).toBe('allow');
  });

  it('rejects self-approval for high-risk actions', () => {
    const request = refundRequest();
    request.approval = {
      status: 'approved',
      reference: 'approval-101',
      approved_by: [request.subject.id],
      approved_at: '2026-08-08T17:55:00Z',
      expires_at: '2026-08-08T18:05:00Z',
    };
    expect(engine.evaluate(request).reasons).toEqual(['self_approval_not_allowed']);
  });

  it('rejects expired or not-yet-valid approval evidence', () => {
    const expired = refundRequest();
    expired.approval = {
      status: 'approved',
      reference: 'approval-expired',
      approved_by: ['finance-manager-2'],
      approved_at: '2026-08-08T17:00:00Z',
      expires_at: '2026-08-08T17:59:59Z',
    };
    expect(engine.evaluate(expired).reasons).toEqual(['approval_expired']);

    const future = refundRequest();
    future.approval = {
      status: 'approved',
      reference: 'approval-future',
      approved_by: ['finance-manager-2'],
      approved_at: '2026-08-08T18:00:01Z',
      expires_at: '2026-08-08T19:00:00Z',
    };
    expect(engine.evaluate(future).reasons).toEqual(['approval_not_yet_valid']);

    const invalidInterval = refundRequest();
    invalidInterval.approval = {
      status: 'approved',
      reference: 'approval-invalid-interval',
      approved_by: ['finance-manager-2'],
      approved_at: '2026-08-08T17:55:00Z',
      expires_at: '2026-08-08T17:54:59Z',
    };
    expect(engine.evaluate(invalidInterval).reasons).toEqual(['approval_invalid_interval']);
  });

  it('always prohibits risk-level-five tenant deletion', () => {
    const request = validationRequest({
      action_key: 'system.delete_tenant',
      verified_preconditions: ['prohibited.by_reference_kernel'],
    });
    request.subject.permissions = ['tenant.destroy'];
    request.resource.classification = 'restricted';
    expect(engine.evaluate(request).reasons).toEqual(['action_prohibited']);
  });

  it('uses default deny when no role rule matches', () => {
    const request = validationRequest();
    request.subject.roles = ['untrusted-agent'];
    expect(engine.evaluate(request).reasons).toEqual(['default_deny']);
  });

  it('rejects malformed requests before evaluating policy', () => {
    expect(() => engine.evaluate({ action_key: 'ontology.validate' })).toThrow('trusted contract');
  });

  it('returns the same decision for the same input', () => {
    const request = validationRequest();
    expect(engine.evaluate(request)).toEqual(engine.evaluate(structuredClone(request)));
  });

  it('validates the complete observable-operation registry', async () => {
    const registry = JSON.parse(
      await readFile(join(repositoryRoot(), 'policies', 'operation-registry.json'), 'utf8'),
    ) as { operations: Array<{ operation_id: string }> };
    expect(schemas.validate('operation-registry', registry).valid).toBe(true);
    expect(new Set(registry.operations.map((operation) => operation.operation_id)).size).toBe(
      registry.operations.length,
    );
  });
});
