import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SchemaRegistry } from './schema.js';

export type Classification = 'public' | 'internal' | 'confidential' | 'restricted';
export type ApprovalPolicy = 'never' | 'policy' | 'human' | 'dual-control' | 'prohibited';

export interface ActionDefinition {
  action_key: string;
  capability: string;
  risk_level: number;
  preconditions: string[];
  expected_effects: string[];
  required_permissions: string[];
  approval_policy: ApprovalPolicy;
  idempotency_required: boolean;
  reversible: boolean;
  compensation_action: string | null;
  verification_action: string;
  allowed_resource_classifications: Classification[];
}

export interface PolicyRule {
  id: string;
  effect: 'allow' | 'deny';
  roles: string[];
  actions: string[];
  classifications: Classification[];
  obligations: string[];
}

export interface PolicyBundle {
  version: string;
  default_effect: 'deny';
  rules: PolicyRule[];
}

export interface PolicyRequest {
  subject: {
    id: string;
    tenant_id: string;
    roles: string[];
    permissions: string[];
  };
  resource: {
    id: string;
    tenant_id: string | null;
    classification: Classification;
  };
  action_key: string;
  verified_preconditions: string[];
  approval: {
    status: 'not-required' | 'pending' | 'approved' | 'denied';
    reference?: string;
    approved_by?: string[];
    approved_at?: string;
    expires_at?: string;
  };
  context: {
    requested_at: string;
    request_id: string;
    purpose: string;
    ip_address?: string;
    environment?: 'development' | 'test' | 'staging' | 'production';
  };
}

export interface PolicyDecision {
  decision: 'allow' | 'deny';
  request_id: string;
  action_key: string;
  risk_level: number | null;
  matched_rule: string | null;
  policy_version: string;
  policy_fingerprint: string;
  reasons: string[];
  obligations: string[];
  verification_action: string | null;
}

export class InvalidPolicyRequestError extends Error {
  readonly details: unknown[];

  constructor(details: unknown[]) {
    super('Policy request does not match the trusted contract.');
    this.name = 'InvalidPolicyRequestError';
    this.details = details;
  }
}

interface ActionRegistryFile {
  version: string;
  actions: ActionDefinition[];
}

function denied(
  request: PolicyRequest,
  bundle: PolicyBundle,
  policyFingerprint: string,
  action: ActionDefinition | undefined,
  reasons: string[],
  matchedRule: string | null = null,
): PolicyDecision {
  return {
    decision: 'deny',
    request_id: request.context.request_id,
    action_key: request.action_key,
    risk_level: action?.risk_level ?? null,
    matched_rule: matchedRule,
    policy_version: bundle.version,
    policy_fingerprint: policyFingerprint,
    reasons,
    obligations: ['audit.authorization_decision'],
    verification_action: action?.verification_action ?? null,
  };
}

export class PolicyEngine {
  readonly #actions: Map<string, ActionDefinition>;
  readonly #bundle: PolicyBundle;
  readonly #schemas: SchemaRegistry;
  readonly #policyFingerprint: string;

  get fingerprint(): string {
    return this.#policyFingerprint;
  }

  get version(): string {
    return this.#bundle.version;
  }

  action(actionKey: string): ActionDefinition | null {
    const action = this.#actions.get(actionKey);
    return action ? structuredClone(action) : null;
  }

  private constructor(
    actions: ActionDefinition[],
    bundle: PolicyBundle,
    schemas: SchemaRegistry,
    policyFingerprint: string,
  ) {
    this.#actions = new Map(actions.map((action) => [action.action_key, action]));
    this.#bundle = bundle;
    this.#schemas = schemas;
    this.#policyFingerprint = policyFingerprint;
  }

  static async create(root: string, schemas: SchemaRegistry): Promise<PolicyEngine> {
    const [registryText, bundleText] = await Promise.all([
      readFile(join(root, 'policies', 'action-registry.json'), 'utf8'),
      readFile(join(root, 'policies', 'default-policy.json'), 'utf8'),
    ]);
    const registry = JSON.parse(registryText) as ActionRegistryFile;
    const bundle = JSON.parse(bundleText) as PolicyBundle;

    const registryReport = schemas.validate('action-registry', registry);
    if (!registryReport.valid) {
      throw new Error(`Invalid trusted action registry: ${JSON.stringify(registryReport.errors)}`);
    }

    for (const action of registry.actions) {
      const report = schemas.validate('action', action);
      if (!report.valid) {
        throw new Error(
          `Invalid trusted action '${action.action_key}': ${JSON.stringify(report.errors)}`,
        );
      }
    }
    const policyReport = schemas.validate('policy-bundle', bundle);
    if (!policyReport.valid) {
      throw new Error(`Invalid trusted policy bundle: ${JSON.stringify(policyReport.errors)}`);
    }

    if (registry.version !== bundle.version) {
      throw new Error('Action registry and policy bundle versions must match.');
    }
    if (
      new Set(registry.actions.map((action) => action.action_key)).size !== registry.actions.length
    ) {
      throw new Error('Trusted action keys must be unique.');
    }
    if (new Set(bundle.rules.map((rule) => rule.id)).size !== bundle.rules.length) {
      throw new Error('Trusted policy rule ids must be unique.');
    }
    const knownActions = new Set(registry.actions.map((action) => action.action_key));
    const unknownRuleAction = bundle.rules
      .flatMap((rule) => rule.actions)
      .find((actionKey) => !knownActions.has(actionKey));
    if (unknownRuleAction) {
      throw new Error(`Policy rule references unknown action '${unknownRuleAction}'.`);
    }

    const invalidIdempotencyAction = registry.actions.find(
      (action) =>
        action.idempotency_required &&
        action.approval_policy !== 'prohibited' &&
        !action.preconditions.includes('idempotency.present'),
    );
    if (invalidIdempotencyAction) {
      throw new Error(
        `Idempotent action '${invalidIdempotencyAction.action_key}' must require idempotency.present.`,
      );
    }

    const policyFingerprint = `sha256:${createHash('sha256')
      .update(registryText, 'utf8')
      .update('\0')
      .update(bundleText, 'utf8')
      .digest('hex')}`;

    return new PolicyEngine(registry.actions, bundle, schemas, policyFingerprint);
  }

  evaluate(value: unknown): PolicyDecision {
    const validation = this.#schemas.validate('policy-request', value);
    if (!validation.valid) {
      throw new InvalidPolicyRequestError(validation.errors);
    }

    const request = value as PolicyRequest;
    const action = this.#actions.get(request.action_key);

    if (!action) {
      return denied(request, this.#bundle, this.#policyFingerprint, undefined, ['unknown_action']);
    }

    if (action.risk_level >= 5 || action.approval_policy === 'prohibited') {
      return denied(request, this.#bundle, this.#policyFingerprint, action, ['action_prohibited']);
    }

    if (
      request.resource.classification !== 'public' &&
      request.resource.tenant_id !== null &&
      request.resource.tenant_id !== request.subject.tenant_id
    ) {
      return denied(request, this.#bundle, this.#policyFingerprint, action, [
        'cross_tenant_access_denied',
      ]);
    }

    if (!action.allowed_resource_classifications.includes(request.resource.classification)) {
      return denied(request, this.#bundle, this.#policyFingerprint, action, [
        'classification_not_allowed_for_action',
      ]);
    }

    const missingPermissions = action.required_permissions.filter(
      (permission) => !request.subject.permissions.includes(permission),
    );
    if (missingPermissions.length > 0) {
      return denied(
        request,
        this.#bundle,
        this.#policyFingerprint,
        action,
        missingPermissions.map((permission) => `missing_permission:${permission}`),
      );
    }

    const missingPreconditions = action.preconditions.filter(
      (precondition) => !request.verified_preconditions.includes(precondition),
    );
    if (missingPreconditions.length > 0) {
      return denied(
        request,
        this.#bundle,
        this.#policyFingerprint,
        action,
        missingPreconditions.map((precondition) => `missing_precondition:${precondition}`),
      );
    }

    const approvers = new Set(request.approval.approved_by ?? []);
    if (request.approval.status === 'denied') {
      return denied(request, this.#bundle, this.#policyFingerprint, action, ['approval_denied']);
    }
    if (action.risk_level >= 3 && approvers.has(request.subject.id)) {
      return denied(request, this.#bundle, this.#policyFingerprint, action, [
        'self_approval_not_allowed',
      ]);
    }
    if (
      action.approval_policy === 'human' &&
      (request.approval.status !== 'approved' || approvers.size < 1 || !request.approval.reference)
    ) {
      return denied(request, this.#bundle, this.#policyFingerprint, action, [
        'human_approval_required',
      ]);
    }
    if (
      action.approval_policy === 'dual-control' &&
      (request.approval.status !== 'approved' || approvers.size < 2 || !request.approval.reference)
    ) {
      return denied(request, this.#bundle, this.#policyFingerprint, action, [
        'dual_control_approval_required',
      ]);
    }

    if (request.approval.status === 'approved') {
      const requestedAt = Date.parse(request.context.requested_at);
      const approvedAt = Date.parse(request.approval.approved_at ?? '');
      const expiresAt = Date.parse(request.approval.expires_at ?? '');
      if (approvedAt > requestedAt) {
        return denied(request, this.#bundle, this.#policyFingerprint, action, [
          'approval_not_yet_valid',
        ]);
      }
      if (expiresAt <= approvedAt) {
        return denied(request, this.#bundle, this.#policyFingerprint, action, [
          'approval_invalid_interval',
        ]);
      }
      if (expiresAt <= requestedAt) {
        return denied(request, this.#bundle, this.#policyFingerprint, action, ['approval_expired']);
      }
    }

    const matchingRules = this.#bundle.rules.filter(
      (rule) =>
        rule.actions.includes(request.action_key) &&
        rule.classifications.includes(request.resource.classification) &&
        rule.roles.some((role) => request.subject.roles.includes(role)),
    );
    const denyRule = matchingRules.find((rule) => rule.effect === 'deny');
    if (denyRule) {
      return denied(
        request,
        this.#bundle,
        this.#policyFingerprint,
        action,
        ['explicit_policy_deny'],
        denyRule.id,
      );
    }

    const allowRule = matchingRules.find((rule) => rule.effect === 'allow');
    if (!allowRule) {
      return denied(request, this.#bundle, this.#policyFingerprint, action, ['default_deny']);
    }

    return {
      decision: 'allow',
      request_id: request.context.request_id,
      action_key: request.action_key,
      risk_level: action.risk_level,
      matched_rule: allowRule.id,
      policy_version: this.#bundle.version,
      policy_fingerprint: this.#policyFingerprint,
      reasons: ['all_controls_satisfied'],
      obligations: [...new Set([...allowRule.obligations, 'audit.authorization_decision'])],
      verification_action: action.verification_action,
    };
  }
}
