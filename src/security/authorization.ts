import { randomUUID } from 'node:crypto';
import type { Classification, PolicyDecision, PolicyEngine, PolicyRequest } from '../policy.js';
import {
  assertClassifications,
  assertPermission,
  assertTenant,
  type IdentityPrincipal,
} from './identity.js';

export class AuthorizationDeniedError extends Error {
  constructor(readonly decision: PolicyDecision) {
    super(`Authorization denied: ${decision.reasons.join(', ')}.`);
    this.name = 'AuthorizationDeniedError';
  }
}

export interface AuthorizationResource {
  id: string;
  tenant_id: string | null;
  classification: Classification;
}

export interface AuthorizationOptions {
  request_id?: string;
  purpose: string;
  verified_preconditions?: string[];
  approval?: PolicyRequest['approval'];
  environment?: PolicyRequest['context']['environment'];
}

/**
 * Policy enforcement point. Subject claims come exclusively from the authenticated principal;
 * callers can provide resource facts and verified preconditions, never roles or permissions.
 */
export class GovernedAuthorizer {
  constructor(readonly policy: PolicyEngine) {}

  authorize(
    principal: IdentityPrincipal,
    actionKey: string,
    resource: AuthorizationResource,
    options: AuthorizationOptions,
  ): PolicyDecision {
    if (resource.tenant_id !== null) assertTenant(principal, resource.tenant_id);
    assertClassifications(principal, [resource.classification]);
    assertPermission(principal, actionKey);
    const request: PolicyRequest = {
      subject: {
        id: principal.id,
        tenant_id: resource.tenant_id ?? principal.tenant_ids[0] ?? 'public',
        roles: principal.roles,
        permissions: principal.permissions,
      },
      resource,
      action_key: actionKey,
      verified_preconditions: [...new Set(options.verified_preconditions ?? [])],
      approval: options.approval ?? { status: 'not-required' },
      context: {
        requested_at: new Date().toISOString(),
        request_id: options.request_id ?? `request:${randomUUID()}`,
        purpose: options.purpose,
        ...(options.environment ? { environment: options.environment } : {}),
      },
    };
    const decision = this.policy.evaluate(request);
    if (decision.decision !== 'allow') throw new AuthorizationDeniedError(decision);
    return decision;
  }
}
