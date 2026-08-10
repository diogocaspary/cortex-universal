import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import type { Classification } from '../policy.js';

const CLASSIFICATIONS: Classification[] = ['public', 'internal', 'confidential', 'restricted'];

export type AuthenticationMethod = 'static-service-token' | 'signed-gateway' | 'local-stdio';

export interface IdentityPrincipal {
  id: string;
  tenant_ids: string[];
  roles: string[];
  permissions: string[];
  allowed_classifications: Classification[];
  authentication_method: AuthenticationMethod;
}

interface SignedIdentityDocument {
  id: string;
  tenant_ids: string[];
  roles: string[];
  permissions: string[];
  allowed_classifications: Classification[];
  issued_at: string;
  expires_at: string;
}

export class IdentityError extends Error {
  constructor(
    readonly code:
      | 'identity_required'
      | 'identity_invalid'
      | 'identity_expired'
      | 'identity_scope_denied'
      | 'identity_permission_denied'
      | 'identity_classification_denied',
    message: string,
  ) {
    super(message);
    this.name = 'IdentityError';
  }
}

export interface IdentityResolverOptions {
  environment: string;
  mode?: 'static' | 'gateway-hmac';
  gatewaySecret?: string;
  staticPrincipal?: Partial<Omit<IdentityPrincipal, 'authentication_method'>>;
}

function configuredList(value: string | undefined): string[] {
  return value
    ? [
        ...new Set(
          value
            .split(',')
            .map((entry) => entry.trim())
            .filter(Boolean),
        ),
      ]
    : [];
}

function exactStringArray(value: unknown, maximum: number): string[] | null {
  if (
    !Array.isArray(value) ||
    value.length > maximum ||
    value.some((entry) => typeof entry !== 'string' || entry.length < 1 || entry.length > 256)
  ) {
    return null;
  }
  return [...new Set(value)];
}

function isClassification(value: string): value is Classification {
  return CLASSIFICATIONS.includes(value as Classification);
}

function parseSignedIdentity(value: string): SignedIdentityDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
  } catch {
    throw new IdentityError('identity_invalid', 'The signed identity document is not valid.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new IdentityError('identity_invalid', 'The signed identity document is not an object.');
  }
  const candidate = parsed as Record<string, unknown>;
  const keys = Object.keys(candidate).sort();
  const expected = [
    'allowed_classifications',
    'expires_at',
    'id',
    'issued_at',
    'permissions',
    'roles',
    'tenant_ids',
  ].sort();
  if (JSON.stringify(keys) !== JSON.stringify(expected)) {
    throw new IdentityError('identity_invalid', 'The signed identity document has unknown fields.');
  }
  const tenants = exactStringArray(candidate.tenant_ids, 100);
  const roles = exactStringArray(candidate.roles, 100);
  const permissions = exactStringArray(candidate.permissions, 250);
  const classifications = exactStringArray(candidate.allowed_classifications, 4);
  if (
    typeof candidate.id !== 'string' ||
    candidate.id.length < 1 ||
    candidate.id.length > 256 ||
    !tenants?.length ||
    !roles ||
    !permissions ||
    !classifications?.length ||
    !classifications.every(isClassification) ||
    typeof candidate.issued_at !== 'string' ||
    typeof candidate.expires_at !== 'string'
  ) {
    throw new IdentityError('identity_invalid', 'The signed identity fields are invalid.');
  }
  return {
    id: candidate.id,
    tenant_ids: tenants,
    roles,
    permissions,
    allowed_classifications: classifications as Classification[],
    issued_at: candidate.issued_at,
    expires_at: candidate.expires_at,
  };
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, 'utf8');
  const rightBuffer = Buffer.from(right, 'utf8');
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export class IdentityResolver {
  readonly mode: 'static' | 'gateway-hmac';
  readonly #environment: string;
  readonly #gatewaySecret: string | undefined;
  readonly #staticPrincipal: IdentityPrincipal;

  constructor(options: IdentityResolverOptions) {
    this.#environment = options.environment;
    this.mode = options.mode ?? 'static';
    this.#gatewaySecret = options.gatewaySecret;
    const isLocal = options.environment === 'development' || options.environment === 'test';
    const tenantIds =
      options.staticPrincipal?.tenant_ids ??
      configuredList(process.env.CORTEX_STATIC_TENANTS).concat(isLocal ? ['*'] : []);
    const roles =
      options.staticPrincipal?.roles ??
      configuredList(process.env.CORTEX_STATIC_ROLES).concat(
        isLocal
          ? ['cortex-local-operator', 'knowledge-reader', 'knowledge-curator', 'semantic-service']
          : [],
      );
    const permissions =
      options.staticPrincipal?.permissions ??
      configuredList(process.env.CORTEX_STATIC_PERMISSIONS).concat(
        isLocal
          ? [
              'ontology.read',
              'ontology.validate',
              'evidence.ingest',
              'knowledge.read',
              'activity.read',
              'agent.session.create',
              'agent.handoff.propose',
              'cognition.evaluate',
              'policy.evaluate',
              'observability.read',
              'guard.evaluate',
              'workforce.read',
              'workforce.goal.create',
              'workforce.work.create',
              'workforce.work.checkout',
              'workforce.work.transition',
              'workforce.routine.create',
              'workforce.routine.materialize',
              'workforce.cost.record',
              'workforce.heartbeat.record',
              'workforce.evaluation.record',
            ]
          : [],
      );
    const allowedClassifications =
      options.staticPrincipal?.allowed_classifications ??
      configuredList(process.env.CORTEX_STATIC_CLASSIFICATIONS).filter(isClassification);

    this.#staticPrincipal = {
      id:
        options.staticPrincipal?.id ??
        process.env.CORTEX_STATIC_SUBJECT_ID ??
        (isLocal ? 'service:cortex-local-operator' : ''),
      tenant_ids: [...new Set(tenantIds)],
      roles: [...new Set(roles)],
      permissions: [...new Set(permissions)],
      allowed_classifications:
        allowedClassifications.length > 0
          ? [...new Set(allowedClassifications)]
          : isLocal
            ? [...CLASSIFICATIONS]
            : [],
      authentication_method: 'static-service-token',
    };

    if (this.mode === 'gateway-hmac' && (!this.#gatewaySecret || this.#gatewaySecret.length < 32)) {
      throw new Error(
        'CORTEX_IDENTITY_HMAC_SECRET must contain at least 32 bytes in gateway-hmac mode.',
      );
    }
    if (
      this.mode === 'static' &&
      options.environment === 'production' &&
      (!this.#staticPrincipal.id ||
        this.#staticPrincipal.tenant_ids.length === 0 ||
        this.#staticPrincipal.tenant_ids.includes('*') ||
        this.#staticPrincipal.permissions.length === 0 ||
        this.#staticPrincipal.allowed_classifications.length === 0)
    ) {
      throw new Error(
        'Production static identity requires CORTEX_STATIC_SUBJECT_ID, explicit CORTEX_STATIC_TENANTS, permissions and classifications; wildcard tenancy is prohibited.',
      );
    }
  }

  resolve(headers: IncomingHttpHeaders, now = new Date()): IdentityPrincipal {
    if (this.mode === 'static') return structuredClone(this.#staticPrincipal);
    const encoded = headers['x-cortex-identity'];
    const signature = headers['x-cortex-identity-signature'];
    if (typeof encoded !== 'string' || typeof signature !== 'string') {
      throw new IdentityError('identity_required', 'A signed gateway identity is required.');
    }
    const expected = createHmac('sha256', this.#gatewaySecret ?? '')
      .update(encoded)
      .digest('base64url');
    if (!safeEqual(signature, expected)) {
      throw new IdentityError('identity_invalid', 'The gateway identity signature is invalid.');
    }
    const document = parseSignedIdentity(encoded);
    const issuedAt = Date.parse(document.issued_at);
    const expiresAt = Date.parse(document.expires_at);
    const current = now.getTime();
    if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || expiresAt <= issuedAt) {
      throw new IdentityError(
        'identity_invalid',
        'The gateway identity validity interval is invalid.',
      );
    }
    if (issuedAt > current + 30_000 || expiresAt <= current || expiresAt - issuedAt > 15 * 60_000) {
      throw new IdentityError(
        'identity_expired',
        'The gateway identity is expired or outside its permitted lifetime.',
      );
    }
    if (this.#environment === 'production' && document.tenant_ids.includes('*')) {
      throw new IdentityError('identity_invalid', 'Wildcard tenancy is prohibited in production.');
    }
    return {
      id: document.id,
      tenant_ids: document.tenant_ids,
      roles: document.roles,
      permissions: document.permissions,
      allowed_classifications: document.allowed_classifications,
      authentication_method: 'signed-gateway',
    };
  }
}

export function assertTenant(principal: IdentityPrincipal, tenantId: string): void {
  if (!principal.tenant_ids.includes('*') && !principal.tenant_ids.includes(tenantId)) {
    throw new IdentityError(
      'identity_scope_denied',
      'The authenticated identity cannot access this tenant.',
    );
  }
}

export function assertPermission(principal: IdentityPrincipal, permission: string): void {
  if (!principal.permissions.includes(permission)) {
    throw new IdentityError(
      'identity_permission_denied',
      `Permission '${permission}' is required.`,
    );
  }
}

export function assertClassifications(
  principal: IdentityPrincipal,
  classifications: Classification[],
): void {
  const denied = classifications.find(
    (classification) => !principal.allowed_classifications.includes(classification),
  );
  if (denied) {
    throw new IdentityError(
      'identity_classification_denied',
      `Classification '${denied}' exceeds the authenticated identity ceiling.`,
    );
  }
}

export function localStdioPrincipal(): IdentityPrincipal {
  return {
    id: 'service:cortex-local-stdio',
    tenant_ids: ['*'],
    roles: ['cortex-local-operator', 'knowledge-reader', 'knowledge-curator', 'semantic-service'],
    permissions: [
      'ontology.read',
      'ontology.validate',
      'evidence.ingest',
      'knowledge.read',
      'activity.read',
      'agent.session.create',
      'agent.handoff.propose',
      'cognition.evaluate',
      'policy.evaluate',
      'observability.read',
      'guard.evaluate',
    ],
    allowed_classifications: [...CLASSIFICATIONS],
    authentication_method: 'local-stdio',
  };
}
