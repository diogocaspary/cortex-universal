import type { PolicyRequest } from '../src/policy.js';

export function validationRequest(overrides: Partial<PolicyRequest> = {}): PolicyRequest {
  return {
    subject: {
      id: 'semantic-validator-1',
      tenant_id: 'tenant-1',
      roles: ['semantic-service'],
      permissions: ['ontology.validate'],
    },
    resource: {
      id: 'graph-1',
      tenant_id: 'tenant-1',
      classification: 'internal',
    },
    action_key: 'ontology.validate',
    verified_preconditions: ['payload.within_size_limit'],
    approval: { status: 'not-required' },
    context: {
      requested_at: '2026-08-08T18:00:00Z',
      request_id: 'request-validation-001',
      purpose: 'ontology-conformance',
      environment: 'test',
    },
    ...overrides,
  };
}

export function refundRequest(): PolicyRequest {
  return {
    subject: {
      id: 'finance-user-1',
      tenant_id: 'tenant-1',
      roles: ['finance-operator'],
      permissions: ['payment.refund'],
    },
    resource: {
      id: 'payment-1',
      tenant_id: 'tenant-1',
      classification: 'confidential',
    },
    action_key: 'payment.refund',
    verified_preconditions: [
      'payment.verified',
      'refund.eligible',
      'amount.within_policy',
      'idempotency.present',
    ],
    approval: { status: 'pending' },
    context: {
      requested_at: '2026-08-08T18:00:00Z',
      request_id: 'request-refund-001',
      purpose: 'customer-refund',
      environment: 'test',
    },
  };
}

export function exportRequest(): PolicyRequest {
  return {
    subject: {
      id: 'dpo-1',
      tenant_id: 'tenant-1',
      roles: ['data-protection-officer'],
      permissions: ['data.bulk_export'],
    },
    resource: {
      id: 'dataset-1',
      tenant_id: 'tenant-1',
      classification: 'restricted',
    },
    action_key: 'data.bulk_export',
    verified_preconditions: [
      'request.verified',
      'purpose.authorized',
      'scope.minimized',
      'destination.approved',
      'idempotency.present',
    ],
    approval: { status: 'pending' },
    context: {
      requested_at: '2026-08-08T18:00:00Z',
      request_id: 'request-export-001',
      purpose: 'data-subject-export',
      environment: 'test',
    },
  };
}
