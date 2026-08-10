import { createHash, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import Fastify, { LogController, type FastifyInstance, type FastifyRequest } from 'fastify';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server';
import { AgentCoordinator } from './agents/coordinator.js';
import { EmbeddedBrainEngine } from './brain/embedded-engine.js';
import type {
  ActivityContext,
  BrainEngine,
  BrainIngestion,
  RetrievalRequest,
} from './brain/engine.js';
import { PostgresBrainEngine } from './brain/postgres-engine.js';
import {
  selectAttention,
  type AttentionCandidate,
  type AttentionWeights,
} from './cognition/attention.js';
import { proposeConsolidation, type ReplayCandidate } from './cognition/consolidation.js';
import { validateCognitiveCycle, type CognitiveStep } from './cognition/cycle.js';
import { assessCalibration, type ConfidenceSample } from './cognition/metacognition.js';
import { evaluatePredictions, type PredictionObservation } from './cognition/world-model.js';
import { createCortexGraphSnapshot } from './graph.js';
import { InvalidToolProposalError, OntologyGuard } from './guard/ontology-guard.js';
import { loadManifest } from './manifest.js';
import { createCortexMcpServer } from './mcp/cortex-server.js';
import { repositoryRoot } from './paths.js';
import { InvalidPolicyRequestError, PolicyEngine } from './policy.js';
import type { PolicyRequest } from './policy.js';
import { SchemaRegistry } from './schema.js';
import { reasonOntology } from './reasoning.js';
import { CortexShaclValidator } from './shacl.js';
import { CortexObservability, type TraceContext } from './observability.js';
import { AuthorizationDeniedError, GovernedAuthorizer } from './security/authorization.js';
import { IdentityError, IdentityResolver, type IdentityPrincipal } from './security/identity.js';
import { SourceRegistry, SourceVerificationError } from './security/source-registry.js';
import type { WorkforceCostEvent, WorkItemStatus } from './workforce/contracts.js';
import { WorkforceError, WorkforceService } from './workforce/workforce-service.js';

export interface BuildAppOptions {
  root?: string;
  apiToken?: string;
  environment?: string;
  logger?: boolean;
  maximumTurtleBytes?: number;
  maximumRdfQuads?: number;
  rateLimitMax?: number;
  databasePath?: string;
  databaseUrl?: string;
  identityMode?: 'static' | 'gateway-hmac';
  gatewayIdentitySecret?: string;
  staticPrincipal?: Partial<Omit<IdentityPrincipal, 'authentication_method'>>;
  auditSecret?: string;
}

class InvalidCognitiveRequestError extends Error {
  constructor(readonly details: unknown) {
    super('Cognitive request does not conform to its contract.');
  }
}

class InvalidOperationalRequestError extends Error {
  constructor(readonly details: unknown) {
    super('Operational request does not conform to its contract.');
  }
}

function tokenDigest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

function maximumBodyBytes(value: number | undefined): number {
  const candidate = value ?? Number(process.env.CORTEX_MAX_BODY_BYTES ?? '1000000');
  if (!Number.isInteger(candidate) || candidate < 1_024 || candidate > 10_000_000) {
    throw new Error('CORTEX_MAX_BODY_BYTES must be an integer from 1024 to 10000000.');
  }
  return candidate;
}

function maximumRdfQuads(value: number | undefined): number {
  const candidate = value ?? Number(process.env.CORTEX_MAX_RDF_QUADS ?? '10000');
  if (!Number.isInteger(candidate) || candidate < 100 || candidate > 100_000) {
    throw new Error('CORTEX_MAX_RDF_QUADS must be an integer from 100 to 100000.');
  }
  return candidate;
}

function rateLimitMaximum(value: number | undefined): number {
  const candidate = value ?? Number(process.env.CORTEX_RATE_LIMIT_MAX ?? '120');
  if (!Number.isInteger(candidate) || candidate < 10 || candidate > 10_000) {
    throw new Error('CORTEX_RATE_LIMIT_MAX must be an integer from 10 to 10000.');
  }
  return candidate;
}

function logLevel(): string {
  const candidate = process.env.CORTEX_LOG_LEVEL ?? 'info';
  const allowed = new Set(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']);
  if (!allowed.has(candidate)) throw new Error('CORTEX_LOG_LEVEL is invalid.');
  return candidate;
}

function allowedMcpHosts(): Set<string> {
  const configured = process.env.CORTEX_ALLOWED_MCP_HOSTS;
  const values = configured
    ? configured
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean)
    : ['localhost', '127.0.0.1', '[::1]'];
  if (values.length === 0) throw new Error('CORTEX_ALLOWED_MCP_HOSTS must not be empty.');
  return new Set(values);
}

function requestHostname(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(`http://${value}`).hostname;
  } catch {
    return null;
  }
}

function webHeaders(headers: Record<string, string | string[] | undefined>): Headers {
  const result = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      for (const entry of value) result.append(name, entry);
    } else if (value !== undefined) {
      result.set(name, value);
    }
  }
  return result;
}

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const root = repositoryRoot(options.root);
  const environment = options.environment ?? process.env.NODE_ENV ?? 'development';
  const apiToken = options.apiToken ?? process.env.CORTEX_API_TOKEN;
  const maximumTurtleBytes = maximumBodyBytes(options.maximumTurtleBytes);
  const maximumQuads = maximumRdfQuads(options.maximumRdfQuads);
  const maximumRequests = rateLimitMaximum(options.rateLimitMax);
  const mcpHosts = allowedMcpHosts();
  const auditSecret = options.auditSecret ?? process.env.CORTEX_AUDIT_HMAC_SECRET;

  if (environment === 'production' && !apiToken) {
    throw new Error('CORTEX_API_TOKEN is required in production.');
  }
  if (apiToken && Buffer.byteLength(apiToken, 'utf8') < 32) {
    throw new Error('CORTEX_API_TOKEN must contain at least 32 bytes.');
  }
  if (
    environment === 'production' &&
    (!auditSecret || Buffer.byteLength(auditSecret, 'utf8') < 32)
  ) {
    throw new Error('CORTEX_AUDIT_HMAC_SECRET with at least 32 bytes is required in production.');
  }
  const gatewaySecret = options.gatewayIdentitySecret ?? process.env.CORTEX_IDENTITY_HMAC_SECRET;
  const identity = new IdentityResolver({
    environment,
    mode:
      options.identityMode ??
      (process.env.CORTEX_IDENTITY_MODE === 'gateway-hmac' ? 'gateway-hmac' : 'static'),
    ...(gatewaySecret ? { gatewaySecret } : {}),
    ...(options.staticPrincipal ? { staticPrincipal: options.staticPrincipal } : {}),
  });
  const expectedTokenDigest = apiToken ? tokenDigest(apiToken) : null;

  const app = Fastify({
    bodyLimit: maximumTurtleBytes,
    logController: new LogController({ disableRequestLogging: true }),
    logger: options.logger
      ? {
          level: logLevel(),
          redact: {
            paths: [
              'req.headers.authorization',
              'request.headers.authorization',
              'headers.authorization',
            ],
            censor: '[REDACTED]',
          },
        }
      : false,
    requestIdHeader: 'x-request-id',
  });
  const observability = new CortexObservability();
  const principals = new WeakMap<FastifyRequest, IdentityPrincipal>();
  const requestStartedAt = new WeakMap<FastifyRequest, bigint>();
  const traceContexts = new WeakMap<FastifyRequest, TraceContext>();

  function traceContext(request: FastifyRequest): TraceContext {
    const context = traceContexts.get(request);
    if (!context) throw new Error('Trusted request trace context is unavailable.');
    return context;
  }

  function activityContext(
    request: FastifyRequest,
    actorId: string,
    operation: string,
    policyFingerprint?: string | null,
    detailsHash?: string,
    causationId?: string | null,
  ): ActivityContext {
    return {
      actor_id: actorId,
      ...traceContext(request),
      operation,
      policy_fingerprint: policyFingerprint ?? null,
      ...(detailsHash ? { details_hash: detailsHash } : {}),
      causation_id: causationId ?? null,
    };
  }

  function authenticatedPrincipal(request: FastifyRequest): IdentityPrincipal {
    const principal = principals.get(request);
    if (!principal) throw new IdentityError('identity_required', 'Authentication is required.');
    return principal;
  }

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'none'"],
        connectSrc: ["'self'"],
        fontSrc: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        imgSrc: ["'self'", 'data:'],
        objectSrc: ["'none'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        workerSrc: ["'self'", 'blob:'],
      },
    },
    ...(environment === 'production' ? {} : { strictTransportSecurity: false }),
  });
  await app.register(rateLimit, {
    global: true,
    max: maximumRequests,
    timeWindow: '1 minute',
  });

  app.addContentTypeParser(
    ['text/turtle', 'application/x-turtle'],
    { parseAs: 'string', bodyLimit: maximumTurtleBytes },
    (_request, body, done) => done(null, body),
  );

  await app.register(fastifyStatic, {
    root: join(root, 'dist', 'dashboard'),
    prefix: '/dashboard/',
    cacheControl: true,
    maxAge: '1h',
  });

  const [schemas, shacl, manifest, graphSnapshot, reasoningReport] = await Promise.all([
    SchemaRegistry.create(root),
    CortexShaclValidator.create(root),
    loadManifest(root),
    createCortexGraphSnapshot(root),
    reasonOntology(root),
  ]);
  const policy = await PolicyEngine.create(root, schemas);
  const authorizer = new GovernedAuthorizer(policy);
  const sources = await SourceRegistry.create(root, schemas, environment);
  const databaseUrl = options.databaseUrl ?? process.env.CORTEX_DATABASE_URL;
  let brain: BrainEngine;
  if (databaseUrl) {
    brain = new PostgresBrainEngine(databaseUrl, graphSnapshot, auditSecret);
    const health = await brain.health();
    if (health.status !== 'ready') {
      await brain.close();
      throw new Error(
        'PostgreSQL Cortex storage is unavailable or not migrated; apply storage/postgres/001_init.sql with a pgvector-enabled database.',
      );
    }
  } else {
    const databasePath =
      options.databasePath ??
      (environment === 'test'
        ? ':memory:'
        : (process.env.CORTEX_DB_PATH ?? join(root, 'runtime', 'cortex.db')));
    brain = new EmbeddedBrainEngine(databasePath, graphSnapshot, auditSecret);
  }
  const agents = await AgentCoordinator.create(root, schemas, brain);
  const workforce = new WorkforceService(brain, agents);
  const guard = new OntologyGuard(schemas, agents, brain, authorizer, manifest.version, {
    maximumSteps: Number(process.env.CORTEX_AGENT_MAX_STEPS ?? '32'),
    maximumRepeatedActionCalls: Number(process.env.CORTEX_AGENT_MAX_REPEATED_ACTION ?? '3'),
  });
  app.addHook('onClose', async () => brain.close());
  const graphReport = schemas.validate('graph-snapshot', graphSnapshot);
  if (!graphReport.valid) {
    throw new Error(`Invalid trusted graph snapshot: ${JSON.stringify(graphReport.errors)}`);
  }
  const reasoningContract = schemas.validate('reasoning-report', reasoningReport);
  if (!reasoningContract.valid) {
    throw new Error(
      `Invalid trusted reasoning report: ${JSON.stringify(reasoningContract.errors)}`,
    );
  }

  function cognitiveBody<T>(schema: string, body: unknown): T {
    const report = schemas.validate(schema, body);
    if (!report.valid) throw new InvalidCognitiveRequestError(report.errors);
    return body as T;
  }

  function operationalBody<T>(schema: string, body: unknown): T {
    const report = schemas.validate(schema, body);
    if (!report.valid) throw new InvalidOperationalRequestError(report.errors);
    return body as T;
  }

  function cognitiveComputation<T>(operation: () => T): T {
    try {
      return operation();
    } catch (error) {
      throw new InvalidCognitiveRequestError([
        { message: error instanceof Error ? error.message : 'Cognitive computation failed.' },
      ]);
    }
  }

  async function operationalComputation<T>(operation: () => Promise<T> | T): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      throw new InvalidOperationalRequestError([
        { message: error instanceof Error ? error.message : 'Operational computation failed.' },
      ]);
    }
  }

  async function workforceComputation<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof WorkforceError) throw error;
      throw new InvalidOperationalRequestError([
        { message: error instanceof Error ? error.message : 'Workforce computation failed.' },
      ]);
    }
  }

  async function authorize(
    request: FastifyRequest,
    actionKey: string,
    resource: {
      id: string;
      tenant_id: string | null;
      classification: import('./policy.js').Classification;
    },
    purpose: string,
    verifiedPreconditions: string[] = ['identity.authenticated'],
    auditBrainId?: string,
  ) {
    const principal = authenticatedPrincipal(request);
    try {
      const decision = authorizer.authorize(principal, actionKey, resource, {
        request_id: traceContext(request).request_id,
        purpose,
        verified_preconditions: verifiedPreconditions,
        environment:
          environment === 'production' || environment === 'staging' || environment === 'test'
            ? environment
            : 'development',
      });
      const decisionId = `authorization:${createHash('sha256')
        .update(`${traceContext(request).request_id}\n${actionKey}\n${decision.policy_fingerprint}`)
        .digest('hex')}`;
      await brain.recordActivity(
        resource.tenant_id ?? 'tenant:cortex-system',
        auditBrainId ?? (resource.tenant_id ? resource.id : 'brain:control-plane'),
        'authorization',
        'accepted',
        decisionId,
        `Policy allowed ${actionKey}.`,
        activityContext(
          request,
          principal.id,
          `policy.${actionKey}`,
          decision.policy_fingerprint,
          `sha256:${createHash('sha256').update(decisionId).digest('hex')}`,
          resource.id,
        ),
      );
      return decision;
    } catch (error) {
      if (error instanceof AuthorizationDeniedError) {
        const decisionId = `authorization:${createHash('sha256')
          .update(
            `${traceContext(request).request_id}\n${actionKey}\n${error.decision.policy_fingerprint}`,
          )
          .digest('hex')}`;
        await brain.recordActivity(
          resource.tenant_id ?? 'tenant:cortex-system',
          auditBrainId ?? (resource.tenant_id ? resource.id : 'brain:control-plane'),
          'authorization',
          'rejected',
          decisionId,
          `Policy denied ${actionKey}.`,
          activityContext(
            request,
            principal.id,
            `policy.${actionKey}`,
            error.decision.policy_fingerprint,
            `sha256:${createHash('sha256').update(decisionId).digest('hex')}`,
            resource.id,
          ),
        );
      } else {
        const message = error instanceof Error ? `${error.name}:${error.message}` : String(error);
        await brain.recordActivity(
          'tenant:cortex-system',
          'brain:control-plane',
          'authorization',
          'rejected',
          `authorization:${createHash('sha256')
            .update(`${traceContext(request).request_id}\n${actionKey}\n${message}`)
            .digest('hex')}`,
          `Authorization precheck rejected ${actionKey}.`,
          activityContext(
            request,
            principal.id,
            `policy.${actionKey}`,
            null,
            `sha256:${createHash('sha256').update(message, 'utf8').digest('hex')}`,
            resource.id,
          ),
        );
      }
      throw error;
    }
  }

  async function authorizeCognition(
    request: FastifyRequest,
    body: { tenant_id: string; brain_id: string },
  ): Promise<void> {
    await authorize(
      request,
      'cognition.evaluate',
      { id: body.brain_id, tenant_id: body.tenant_id, classification: 'internal' },
      'bounded cognitive assessment',
      ['identity.authenticated', 'tenant.resolved', 'schema.validated'],
      body.brain_id,
    );
  }

  app.addHook('onRequest', async (request, reply) => {
    requestStartedAt.set(request, process.hrtime.bigint());
    const externalCorrelation = Array.isArray(request.headers['x-correlation-id'])
      ? request.headers['x-correlation-id'][0]
      : request.headers['x-correlation-id'];
    traceContexts.set(
      request,
      observability.createContext(String(request.id), externalCorrelation),
    );
    const isVersionedApi = request.url.startsWith('/v1/');
    const isMcp = request.url === '/mcp' || request.url.startsWith('/mcp?');
    if (isMcp) {
      const hostname = requestHostname(request.headers.host);
      let originHostname: string | null = null;
      try {
        originHostname = request.headers.origin ? new URL(request.headers.origin).hostname : null;
      } catch {
        observability.recordFailure(
          traceContext(request),
          '/mcp',
          403,
          'invalid_mcp_origin',
          new Error('Invalid MCP origin.'),
        );
        return reply.code(403).send({ error: 'invalid_mcp_origin' });
      }
      if (
        !hostname ||
        !mcpHosts.has(hostname) ||
        (originHostname && !mcpHosts.has(originHostname))
      ) {
        observability.recordFailure(
          traceContext(request),
          '/mcp',
          403,
          'mcp_host_or_origin_rejected',
          new Error('MCP host or origin rejected.'),
        );
        return reply.code(403).send({ error: 'mcp_host_or_origin_rejected' });
      }
      if (!apiToken) {
        observability.recordFailure(
          traceContext(request),
          '/mcp',
          503,
          'mcp_http_auth_not_configured',
          new Error('MCP HTTP authentication is not configured.'),
        );
        return reply.code(503).send({ error: 'mcp_http_auth_not_configured' });
      }
    }
    if (!isVersionedApi && !isMcp) return;
    if (apiToken) {
      const authorization = request.headers.authorization;
      const candidate = authorization?.startsWith('Bearer ')
        ? tokenDigest(authorization.slice('Bearer '.length))
        : null;
      if (!candidate || !expectedTokenDigest || !timingSafeEqual(candidate, expectedTokenDigest)) {
        reply.header('www-authenticate', 'Bearer realm="cortex-universal"');
        observability.recordFailure(
          traceContext(request),
          request.routeOptions.url ?? 'unmatched',
          401,
          'unauthorized',
          new Error('Bearer token rejected.'),
        );
        return reply.code(401).send({ error: 'unauthorized' });
      }
    }
    principals.set(request, identity.resolve(request.headers));
  });

  app.addHook('onSend', async (request, reply) => {
    reply.header('x-cortex-version', manifest.version);
    const context = traceContexts.get(request);
    if (context) {
      reply.header('x-cortex-trace-id', context.trace_id);
      reply.header('x-cortex-correlation-id', context.correlation_id);
    }
    if (request.url.startsWith('/v1/')) reply.header('cache-control', 'no-store');
  });
  app.addHook('onResponse', async (request, reply) => {
    const started = requestStartedAt.get(request);
    if (!started) return;
    const durationMs = Number(process.hrtime.bigint() - started) / 1_000_000;
    const operation = request.routeOptions.url ?? 'unmatched';
    observability.record(operation, reply.statusCode, durationMs);
    const context = traceContexts.get(request);
    request.log.info(
      {
        operation,
        status_code: reply.statusCode,
        duration_ms: durationMs,
        ...(context ? { trace_id: context.trace_id, correlation_id: context.correlation_id } : {}),
      },
      'request completed',
    );
  });

  app.get('/', async () => ({
    service: manifest.name,
    version: manifest.version,
    status: 'ready',
    endpoints: [
      '/dashboard/',
      '/healthz',
      '/readyz',
      '/v1/manifest',
      '/v1/graph',
      '/v1/ontology/reasoning',
      '/v1/brain/ingest',
      '/v1/brain/retrieve',
      '/v1/brain/activity',
      '/v1/agents/registry',
      '/v1/agents/sessions',
      '/v1/workforce/snapshot',
      '/v1/workforce/goals',
      '/v1/workforce/work-items',
      '/v1/workforce/routines',
      '/v1/workforce/cost-events',
      '/v1/workforce/heartbeats',
      '/v1/workforce/evaluations',
      '/v1/guard/evaluate',
      '/v1/audit/integrity',
      '/v1/observability/metrics',
      '/v1/observability/failures',
      '/mcp',
      '/v1/cognition/attention/select',
      '/v1/cognition/prediction/evaluate',
      '/v1/cognition/metacognition/evaluate',
      '/v1/cognition/consolidation/propose',
      '/v1/cognition/cycle/validate',
    ],
  }));
  app.get('/dashboard', async (_request, reply) => reply.redirect('/dashboard/'));
  app.get('/healthz', async () => ({ status: 'ok' }));
  app.get('/readyz', async (_request, reply) => {
    const health = await brain.health();
    return reply.code(health.status === 'ready' ? 200 : 503).send(health);
  });
  app.get('/v1/manifest', async (request) => {
    await authorize(
      request,
      'ontology.read',
      { id: 'ontology:manifest', tenant_id: null, classification: 'public' },
      'read ontology manifest',
    );
    return manifest;
  });
  app.get('/v1/graph', async (request) => {
    await authorize(
      request,
      'ontology.read',
      { id: 'ontology:graph', tenant_id: null, classification: 'public' },
      'read semantic graph',
    );
    return graphSnapshot;
  });
  app.get('/v1/ontology/reasoning', async (request) => {
    await authorize(
      request,
      'ontology.read',
      { id: 'ontology:reasoning', tenant_id: null, classification: 'public' },
      'read bounded explainable ontology inferences',
    );
    return reasoningReport;
  });
  app.get('/v1/brain/health', async (request) => {
    await authorize(
      request,
      'observability.read',
      { id: 'runtime:brain', tenant_id: null, classification: 'internal' },
      'read brain engine health',
    );
    return brain.health();
  });
  app.get<{ Querystring: { tenant_id?: string; brain_id?: string; limit?: string } }>(
    '/v1/brain/activity',
    async (request, reply) => {
      const { tenant_id: tenantId, brain_id: brainId } = request.query;
      const limit = Number(request.query.limit ?? '100');
      if (!tenantId || !brainId || !Number.isInteger(limit) || limit < 1 || limit > 500) {
        throw new InvalidOperationalRequestError([
          { message: 'tenant_id, brain_id and an optional limit from 1 to 500 are required.' },
        ]);
      }
      await authorize(
        request,
        'activity.read',
        { id: brainId, tenant_id: tenantId, classification: 'restricted' },
        'read append-only runtime activity',
        ['identity.authenticated', 'tenant.resolved'],
      );
      const activity = await brain.activity(tenantId, brainId, limit);
      if (activity.some((event) => !schemas.validate('brain-activity', event).valid)) {
        throw new Error('Brain engine emitted an invalid activity event.');
      }
      return reply.code(200).send({ activity });
    },
  );
  app.post<{ Body: unknown }>('/v1/brain/ingest', async (request, reply) => {
    const input = operationalBody<BrainIngestion>('brain-ingestion', request.body);
    const principal = authenticatedPrincipal(request);
    if (input.envelope.provenance.actor_id !== principal.id && environment === 'production') {
      throw new IdentityError(
        'identity_scope_denied',
        'Production ingestion provenance actor must match the authenticated identity.',
      );
    }
    const verification = sources.verify(input.envelope);
    const decision = await authorize(
      request,
      'evidence.ingest',
      {
        id: input.envelope.id,
        tenant_id: input.envelope.tenant_id,
        classification: input.envelope.classification,
      },
      'ingest source-bound evidence',
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
    input.activity_context = activityContext(
      request,
      principal.id,
      'http.brain.ingest',
      decision.policy_fingerprint,
      input.envelope.content_hash,
      input.envelope.provenance.correlation_id,
    );
    const result = await operationalComputation(() => brain.ingest(input));
    await brain.recordActivity(
      input.envelope.tenant_id,
      input.envelope.brain_id,
      'ingestion',
      'completed',
      input.envelope.id,
      'Evidence ingestion authorization was enforced.',
      activityContext(
        request,
        principal.id,
        'http.brain.ingest.authorization',
        decision.policy_fingerprint,
        input.envelope.content_hash,
        input.envelope.id,
      ),
    );
    return reply.code(result.accepted ? 201 : 200).send(result);
  });
  app.post<{ Body: unknown }>('/v1/brain/retrieve', async (request, reply) => {
    const input = operationalBody<RetrievalRequest>('retrieval-request', request.body);
    const principal = authenticatedPrincipal(request);
    if (input.requester_id !== principal.id) {
      throw new IdentityError(
        'identity_scope_denied',
        'requester_id must match the authenticated identity.',
      );
    }
    await authorize(
      request,
      'knowledge.read',
      {
        id: input.brain_id,
        tenant_id: input.tenant_id,
        classification: input.allowed_classifications.reduce(
          (highest, candidate) =>
            ['public', 'internal', 'confidential', 'restricted'].indexOf(candidate) >
            ['public', 'internal', 'confidential', 'restricted'].indexOf(highest)
              ? candidate
              : highest,
          'public',
        ),
      },
      input.purpose,
      ['identity.authenticated'],
    );
    input.activity_context = activityContext(
      request,
      principal.id,
      'http.brain.retrieve',
      policy.fingerprint,
    );
    const response = await operationalComputation(() => brain.retrieve(input));
    const report = schemas.validate('retrieval-response', response);
    if (!report.valid)
      throw new Error(`Brain engine emitted an invalid response: ${JSON.stringify(report.errors)}`);
    return reply.code(200).send(response);
  });

  app.get('/v1/agents/registry', async (request) => {
    await authorize(
      request,
      'ontology.read',
      { id: 'agents:registry', tenant_id: null, classification: 'public' },
      'read trusted agent registry',
    );
    return agents.registry;
  });
  app.get<{ Querystring: { tenant_id?: string; brain_id?: string } }>(
    '/v1/workforce/snapshot',
    async (request, reply) => {
      const { tenant_id: tenantId, brain_id: brainId } = request.query;
      if (!tenantId || !brainId) {
        throw new InvalidOperationalRequestError([
          { message: 'tenant_id and brain_id are required.' },
        ]);
      }
      await authorize(
        request,
        'workforce.read',
        { id: brainId, tenant_id: tenantId, classification: 'restricted' },
        'read governed workforce control-plane snapshot',
        ['identity.authenticated', 'tenant.resolved'],
        brainId,
      );
      return reply.code(200).send(await workforce.snapshot(tenantId, brainId));
    },
  );
  app.post<{ Body: unknown }>('/v1/workforce/goals', async (request, reply) => {
    const input = operationalBody<{
      tenant_id: string;
      brain_id: string;
      classification: import('./policy.js').Classification;
      parent_goal_id?: string | null;
      title: string;
      description: string;
      success_criteria: Array<{
        id: string;
        description: string;
        verification_method: 'evidence' | 'test' | 'human-approval';
        required: boolean;
      }>;
      owner_agent_id: string;
      idempotency_key: string;
    }>('workforce-goal', request.body);
    const principal = authenticatedPrincipal(request);
    const decision = await authorize(
      request,
      'workforce.goal.create',
      { id: input.brain_id, tenant_id: input.tenant_id, classification: input.classification },
      'create ontology-bound workforce goal',
      [
        'identity.authenticated',
        'tenant.resolved',
        'schema.validated',
        'agent.registered',
        'idempotency.present',
      ],
      input.brain_id,
    );
    const goal = await workforceComputation(() =>
      workforce.createGoal(
        input,
        activityContext(
          request,
          principal.id,
          'http.workforce.goal.create',
          decision.policy_fingerprint,
        ),
      ),
    );
    return reply.code(201).send(goal);
  });
  app.post<{ Body: unknown }>('/v1/workforce/work-items', async (request, reply) => {
    const input = operationalBody<{
      tenant_id: string;
      brain_id: string;
      classification: import('./policy.js').Classification;
      goal_id: string;
      parent_work_item_id?: string | null;
      title: string;
      description: string;
      priority: 1 | 2 | 3 | 4 | 5;
      assigned_agent_id: string;
      required_capabilities: string[];
      acceptance_criteria: Array<{
        id: string;
        description: string;
        verification_method: 'evidence' | 'test' | 'human-approval';
        required: boolean;
      }>;
      blocked_by: string[];
      budget: { max_total_tokens: number; max_cost_microusd: number; max_duration_ms: number };
      review_required: boolean;
      source?: 'human' | 'agent-proposal';
      idempotency_key: string;
    }>('work-item', request.body);
    const principal = authenticatedPrincipal(request);
    const decision = await authorize(
      request,
      'workforce.work.create',
      { id: input.goal_id, tenant_id: input.tenant_id, classification: input.classification },
      'create goal-traceable work item',
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
    const item = await workforceComputation(() =>
      workforce.createWorkItem(
        input,
        activityContext(
          request,
          principal.id,
          'http.workforce.work.create',
          decision.policy_fingerprint,
          undefined,
          input.goal_id,
        ),
      ),
    );
    return reply.code(201).send(item);
  });
  app.post<{ Params: { id: string }; Body: unknown }>(
    '/v1/workforce/work-items/:id/checkout',
    async (request, reply) => {
      const input = operationalBody<{
        tenant_id: string;
        brain_id: string;
        classification: import('./policy.js').Classification;
        agent_id: string;
        lease_seconds: number;
      }>('work-item-checkout', request.body);
      const principal = authenticatedPrincipal(request);
      const decision = await authorize(
        request,
        'workforce.work.checkout',
        { id: request.params.id, tenant_id: input.tenant_id, classification: input.classification },
        'atomically lease ready work to its assigned agent',
        [
          'identity.authenticated',
          'tenant.resolved',
          'agent.registered',
          'work.ready',
          'budget.available',
        ],
        input.brain_id,
      );
      const item = await workforceComputation(() =>
        workforce.checkout(
          { ...input, work_item_id: request.params.id },
          activityContext(
            request,
            principal.id,
            'http.workforce.work.checkout',
            decision.policy_fingerprint,
            undefined,
            request.params.id,
          ),
        ),
      );
      return reply.code(200).send(item);
    },
  );
  app.post<{ Params: { id: string }; Body: unknown }>(
    '/v1/workforce/work-items/:id/transitions',
    async (request, reply) => {
      const input = operationalBody<{
        tenant_id: string;
        brain_id: string;
        classification: import('./policy.js').Classification;
        actor_agent_id: string;
        target_status: WorkItemStatus;
        evidence_ids: string[];
        reviewer_agent_id?: string | null;
      }>('work-item-transition', request.body);
      const principal = authenticatedPrincipal(request);
      const decision = await authorize(
        request,
        'workforce.work.transition',
        { id: request.params.id, tenant_id: input.tenant_id, classification: input.classification },
        'apply governed work-item state transition',
        ['identity.authenticated', 'tenant.resolved', 'schema.validated', 'state.transition_valid'],
        input.brain_id,
      );
      const item = await workforceComputation(() =>
        workforce.transition(
          { ...input, work_item_id: request.params.id },
          activityContext(
            request,
            principal.id,
            'http.workforce.work.transition',
            decision.policy_fingerprint,
            undefined,
            request.params.id,
          ),
        ),
      );
      return reply.code(200).send(item);
    },
  );
  app.post<{ Body: unknown }>('/v1/workforce/routines', async (request, reply) => {
    const input = operationalBody<Parameters<WorkforceService['createRoutine']>[0]>(
      'workforce-routine',
      request.body,
    );
    const principal = authenticatedPrincipal(request);
    const decision = await authorize(
      request,
      'workforce.routine.create',
      { id: input.goal_id, tenant_id: input.tenant_id, classification: input.classification },
      'create bounded recurring work template',
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
    const routine = await workforceComputation(() =>
      workforce.createRoutine(
        input,
        activityContext(
          request,
          principal.id,
          'http.workforce.routine.create',
          decision.policy_fingerprint,
          undefined,
          input.goal_id,
        ),
      ),
    );
    return reply.code(201).send(routine);
  });
  app.post<{ Body: unknown }>('/v1/workforce/routines/materialize', async (request, reply) => {
    const input = operationalBody<{
      tenant_id: string;
      brain_id: string;
      classification: import('./policy.js').Classification;
      now: string;
    }>('workforce-routine-materialize', request.body);
    const principal = authenticatedPrincipal(request);
    const decision = await authorize(
      request,
      'workforce.routine.materialize',
      { id: input.brain_id, tenant_id: input.tenant_id, classification: input.classification },
      'materialize due routines into tracked work without executing external effects',
      ['identity.authenticated', 'tenant.resolved', 'schedule.due', 'budget.declared'],
      input.brain_id,
    );
    return reply
      .code(200)
      .send(
        await workforceComputation(() =>
          workforce.materializeDueRoutines(
            input.tenant_id,
            input.brain_id,
            input.classification,
            input.now,
            activityContext(
              request,
              principal.id,
              'http.workforce.routine.materialize',
              decision.policy_fingerprint,
            ),
          ),
        ),
      );
  });
  app.post<{ Body: unknown }>('/v1/workforce/cost-events', async (request, reply) => {
    const input = operationalBody<
      Omit<WorkforceCostEvent, 'id'> & { classification: import('./policy.js').Classification }
    >('workforce-cost-event', request.body);
    const principal = authenticatedPrincipal(request);
    const decision = await authorize(
      request,
      'workforce.cost.record',
      { id: input.work_item_id, tenant_id: input.tenant_id, classification: input.classification },
      'record real provider-metered or allocated agent cost',
      [
        'identity.authenticated',
        'tenant.resolved',
        'schema.validated',
        'metering.evidence_present',
        'idempotency.present',
      ],
      input.brain_id,
    );
    return reply
      .code(201)
      .send(
        await workforceComputation(() =>
          workforce.recordCost(
            input,
            activityContext(
              request,
              principal.id,
              'http.workforce.cost.record',
              decision.policy_fingerprint,
              undefined,
              input.work_item_id,
            ),
          ),
        ),
      );
  });
  app.post<{ Body: unknown }>('/v1/workforce/evaluations', async (request, reply) => {
    const input = operationalBody<Parameters<WorkforceService['evaluate']>[0]>(
      'workforce-evaluation',
      request.body,
    );
    const principal = authenticatedPrincipal(request);
    const decision = await authorize(
      request,
      'workforce.evaluation.record',
      { id: input.work_item_id, tenant_id: input.tenant_id, classification: input.classification },
      'record independent evidence-based agent evaluation',
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
    return reply
      .code(201)
      .send(
        await workforceComputation(() =>
          workforce.evaluate(
            input,
            activityContext(
              request,
              principal.id,
              'http.workforce.evaluation.record',
              decision.policy_fingerprint,
              undefined,
              input.work_item_id,
            ),
          ),
        ),
      );
  });
  app.post<{ Body: unknown }>('/v1/workforce/heartbeats', async (request, reply) => {
    const input = operationalBody<Parameters<WorkforceService['recordHeartbeat']>[0]>(
      'workforce-heartbeat',
      request.body,
    );
    const principal = authenticatedPrincipal(request);
    const decision = await authorize(
      request,
      'workforce.heartbeat.record',
      { id: input.agent_id, tenant_id: input.tenant_id, classification: input.classification },
      'record an evidence-backed agent heartbeat',
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
    return reply
      .code(201)
      .send(
        await workforceComputation(() =>
          workforce.recordHeartbeat(
            input,
            activityContext(
              request,
              principal.id,
              'http.workforce.heartbeat.record',
              decision.policy_fingerprint,
              undefined,
              input.current_work_item_id ?? input.agent_id,
            ),
          ),
        ),
      );
  });
  app.post<{ Body: unknown }>('/v1/guard/evaluate', async (request, reply) => {
    const decision = await guard.evaluate(
      request.body,
      authenticatedPrincipal(request),
      new Date(),
      activityContext(request, authenticatedPrincipal(request).id, 'http.guard.evaluate'),
    );
    return reply.code(200).send(decision);
  });
  app.post<{ Body: unknown }>('/v1/agents/sessions', async (request, reply) => {
    const input = operationalBody<{
      tenant_id: string;
      brain_id: string;
      objective: string;
      initial_agent: string;
    }>('agent-session', request.body);
    const principal = authenticatedPrincipal(request);
    const agent = agents.assertCapability(input.initial_agent, 'handoff.propose');
    const classifications = principal.allowed_classifications.filter((classification) =>
      agent.allowed_classifications.includes(classification),
    );
    const decision = await authorize(
      request,
      'agent.session.create',
      {
        id: input.brain_id,
        tenant_id: input.tenant_id,
        classification: classifications.at(-1) ?? 'public',
      },
      'create governed agent session',
      ['identity.authenticated', 'tenant.resolved', 'agent.registered'],
    );
    return reply.code(201).send(
      await operationalComputation(() =>
        agents.create({
          ...input,
          allowed_classifications: classifications,
          activity_context: activityContext(
            request,
            principal.id,
            'http.agent.session.create',
            decision.policy_fingerprint,
          ),
        }),
      ),
    );
  });
  app.get<{
    Params: { id: string };
    Querystring: { tenant_id?: string; brain_id?: string };
  }>('/v1/agents/sessions/:id', async (request, reply) => {
    const session = await agents.get(
      request.params.id,
      request.query.tenant_id,
      request.query.brain_id,
    );
    if (!session) return reply.code(404).send({ error: 'agent_session_not_found' });
    if (
      !request.query.tenant_id ||
      !request.query.brain_id ||
      session.tenant_id !== request.query.tenant_id ||
      session.brain_id !== request.query.brain_id
    ) {
      return reply.code(404).send({ error: 'agent_session_not_found' });
    }
    await authorize(
      request,
      'activity.read',
      { id: session.id, tenant_id: session.tenant_id, classification: 'restricted' },
      'read governed agent session',
      ['identity.authenticated', 'tenant.resolved'],
    );
    return reply.code(200).send(session);
  });
  app.post<{ Params: { id: string }; Body: unknown }>(
    '/v1/agents/sessions/:id/handoffs',
    async (request, reply) => {
      const input = operationalBody<{
        tenant_id: string;
        brain_id: string;
        from_agent: string;
        to_agent: string;
        reason: string;
        evidence_ids: string[];
      }>('agent-handoff', request.body);
      const principal = authenticatedPrincipal(request);
      const decision = await authorize(
        request,
        'agent.handoff.propose',
        { id: request.params.id, tenant_id: input.tenant_id, classification: 'confidential' },
        'record evidence-bearing agent handoff',
        ['identity.authenticated', 'tenant.resolved', 'agent.registered'],
      );
      try {
        return reply.code(200).send(
          await operationalComputation(() =>
            agents.handoff(request.params.id, {
              ...input,
              activity_context: activityContext(
                request,
                principal.id,
                'http.agent.handoff.propose',
                decision.policy_fingerprint,
                undefined,
                request.params.id,
              ),
            }),
          ),
        );
      } catch (error) {
        if (
          error instanceof InvalidOperationalRequestError &&
          JSON.stringify(error.details).includes('Agent session was not found.')
        ) {
          return reply.code(404).send({ error: 'agent_session_not_found' });
        }
        throw error;
      }
    },
  );

  app.post<{ Body: unknown }>('/mcp', async (request, reply) => {
    const mcpServer = createCortexMcpServer({
      manifest,
      graph: graphSnapshot,
      schemas,
      policy,
      brain,
      agents,
      principal: authenticatedPrincipal(request),
      authorizer,
      sources,
      environment,
      guard,
      reasoning: reasoningReport,
      workforce,
    });
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
      keepAliveMs: 0,
    });
    try {
      await mcpServer.connect(transport);
      const host = request.headers.host ?? 'localhost';
      const webRequest = new Request(new URL(request.url, `http://${host}`), {
        method: 'POST',
        headers: webHeaders(request.headers),
      });
      const response = await transport.handleRequest(webRequest, { parsedBody: request.body });
      for (const [name, value] of response.headers) reply.header(name, value);
      return reply.code(response.status).send(Buffer.from(await response.arrayBuffer()));
    } finally {
      await mcpServer.close();
    }
  });
  for (const method of ['GET', 'DELETE'] as const) {
    app.route({
      method,
      url: '/mcp',
      handler: async (_request, reply) =>
        reply
          .header('allow', 'POST')
          .code(405)
          .send({
            jsonrpc: '2.0',
            error: { code: -32600, message: 'Method not allowed.' },
            id: null,
          }),
    });
  }

  app.post<{ Params: { schema: string }; Body: unknown }>(
    '/v1/validate/json/:schema',
    async (request, reply) => {
      await authorize(
        request,
        'ontology.validate',
        { id: `schema:${request.params.schema}`, tenant_id: null, classification: 'public' },
        'validate JSON contract',
        ['payload.within_size_limit'],
      );
      try {
        const report = schemas.validate(request.params.schema, request.body);
        return await reply.code(report.valid ? 200 : 422).send(report);
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('Unknown schema')) {
          return reply.code(404).send({ error: 'schema_not_found', available: schemas.names() });
        }
        throw error;
      }
    },
  );

  app.post<{ Body: string }>('/v1/validate/shacl', async (request, reply) => {
    await authorize(
      request,
      'ontology.validate',
      { id: 'ontology:shacl', tenant_id: null, classification: 'public' },
      'validate RDF data with SHACL',
      ['payload.within_size_limit'],
    );
    if (typeof request.body !== 'string') {
      return reply.code(415).send({
        error: 'unsupported_media_type',
        message: 'Send Turtle using Content-Type: text/turtle.',
      });
    }
    try {
      const report = await shacl.validateTurtle(request.body, maximumTurtleBytes, maximumQuads);
      return reply.code(report.conforms ? 200 : 422).send(report);
    } catch (error) {
      return reply.code(400).send({
        error: 'invalid_turtle',
        message:
          environment === 'production'
            ? 'Turtle could not be parsed within the configured limits.'
            : error instanceof Error
              ? error.message
              : 'Turtle parsing failed.',
      });
    }
  });

  app.post<{ Body: unknown }>('/v1/policies/evaluate', async (request, reply) => {
    try {
      const report = schemas.validate('policy-request', request.body);
      if (!report.valid) throw new InvalidPolicyRequestError(report.errors);
      const proposed = request.body as PolicyRequest;
      const principal = authenticatedPrincipal(request);
      await authorize(request, 'policy.evaluate', proposed.resource, proposed.context.purpose, [
        'identity.authenticated',
        'schema.validated',
      ]);
      const trustedRequest: PolicyRequest = {
        ...proposed,
        subject: {
          id: principal.id,
          tenant_id: proposed.resource.tenant_id ?? principal.tenant_ids[0] ?? 'public',
          roles: principal.roles,
          permissions: principal.permissions,
        },
        context: { ...proposed.context, request_id: traceContext(request).request_id },
      };
      return await reply.code(200).send(policy.evaluate(trustedRequest));
    } catch (error) {
      if (error instanceof InvalidPolicyRequestError) {
        return reply.code(400).send({
          error: 'invalid_policy_request',
          details: error.details,
        });
      }
      throw error;
    }
  });

  app.post<{ Body: unknown }>('/v1/cognition/attention/select', async (request, reply) => {
    const body = cognitiveBody<{
      request_id: string;
      tenant_id: string;
      brain_id: string;
      capacity: number;
      weights?: AttentionWeights;
      candidates: AttentionCandidate[];
    }>('attention-selection', request.body);
    await authorizeCognition(request, body);
    return reply.code(200).send({
      request_id: body.request_id,
      tenant_id: body.tenant_id,
      brain_id: body.brain_id,
      ...cognitiveComputation(() => selectAttention(body.candidates, body.capacity, body.weights)),
    });
  });

  app.post<{ Body: unknown }>('/v1/cognition/prediction/evaluate', async (request, reply) => {
    const body = cognitiveBody<{
      request_id: string;
      tenant_id: string;
      brain_id: string;
      deliberation_threshold: number;
      observations: PredictionObservation[];
    }>('prediction-observation', request.body);
    await authorizeCognition(request, body);
    return reply.code(200).send({
      request_id: body.request_id,
      tenant_id: body.tenant_id,
      brain_id: body.brain_id,
      ...cognitiveComputation(() =>
        evaluatePredictions(body.observations, body.deliberation_threshold),
      ),
    });
  });

  app.post<{ Body: unknown }>('/v1/cognition/metacognition/evaluate', async (request, reply) => {
    const body = cognitiveBody<{
      request_id: string;
      tenant_id: string;
      brain_id: string;
      bin_count: number;
      samples: ConfidenceSample[];
    }>('metacognitive-evaluation', request.body);
    await authorizeCognition(request, body);
    return reply.code(200).send({
      request_id: body.request_id,
      tenant_id: body.tenant_id,
      brain_id: body.brain_id,
      assessment: cognitiveComputation(() => assessCalibration(body.samples, body.bin_count)),
    });
  });

  app.post<{ Body: unknown }>('/v1/cognition/consolidation/propose', async (request, reply) => {
    const body = cognitiveBody<{
      request_id: string;
      tenant_id: string;
      brain_id: string;
      batch_size: number;
      candidates: ReplayCandidate[];
    }>('consolidation-proposal', request.body);
    await authorizeCognition(request, body);
    return reply.code(200).send({
      request_id: body.request_id,
      tenant_id: body.tenant_id,
      brain_id: body.brain_id,
      proposal: cognitiveComputation(() => proposeConsolidation(body.candidates, body.batch_size)),
    });
  });

  app.post<{ Body: unknown }>('/v1/cognition/cycle/validate', async (request, reply) => {
    const body = cognitiveBody<{
      cycle_id: string;
      status: 'completed' | 'abstained';
      started_at: string;
      completed_at: string;
      steps: CognitiveStep[];
    }>('cognitive-cycle', request.body);
    const cycleScope = request.body as { tenant_id?: string; brain_id?: string };
    if (cycleScope.tenant_id && cycleScope.brain_id) {
      await authorizeCognition(request, {
        tenant_id: cycleScope.tenant_id,
        brain_id: cycleScope.brain_id,
      });
    } else {
      await authorize(
        request,
        'cognition.evaluate',
        { id: body.cycle_id, tenant_id: null, classification: 'internal' },
        'validate cognitive event sequence',
        ['identity.authenticated', 'schema.validated'],
      );
    }
    const report = validateCognitiveCycle(body.steps, {
      status: body.status,
      started_at: body.started_at,
      completed_at: body.completed_at,
    });
    return reply.code(report.valid ? 200 : 422).send({ cycle_id: body.cycle_id, ...report });
  });

  app.get<{ Querystring: { tenant_id?: string; brain_id?: string } }>(
    '/v1/audit/integrity',
    async (request, reply) => {
      const { tenant_id: tenantId, brain_id: brainId } = request.query;
      if (!tenantId || !brainId) {
        throw new InvalidOperationalRequestError([
          { message: 'tenant_id and brain_id are required.' },
        ]);
      }
      await authorize(
        request,
        'activity.read',
        { id: brainId, tenant_id: tenantId, classification: 'restricted' },
        'verify append-only audit integrity',
        ['identity.authenticated', 'tenant.resolved'],
      );
      const report = await brain.verifyAuditChain(tenantId, brainId);
      const contract = schemas.validate('audit-integrity', report);
      if (!contract.valid) throw new Error('Brain engine emitted an invalid audit report.');
      return reply.code(report.valid ? 200 : 409).send(report);
    },
  );

  app.get('/v1/observability/metrics', async (request, reply) => {
    await authorize(
      request,
      'observability.read',
      { id: 'runtime:metrics', tenant_id: null, classification: 'internal' },
      'read payload-free runtime metrics',
    );
    return reply.code(200).send(observability.snapshot());
  });

  app.get<{ Querystring: { limit?: string } }>(
    '/v1/observability/failures',
    async (request, reply) => {
      await authorize(
        request,
        'observability.read',
        { id: 'runtime:failures', tenant_id: null, classification: 'internal' },
        'read sanitized failure diagnostics',
      );
      const limit = Number(request.query.limit ?? '100');
      let failures: ReturnType<CortexObservability['failures']>;
      try {
        failures = observability.failures(limit);
      } catch (error) {
        throw new InvalidOperationalRequestError([
          { message: error instanceof Error ? error.message : 'Invalid failure limit.' },
        ]);
      }
      if (failures.some((failure) => !schemas.validate('sanitized-failure', failure).valid)) {
        throw new Error('Observability emitted an invalid sanitized failure.');
      }
      return reply.code(200).send({ failures });
    },
  );

  app.setErrorHandler(async (error, request, reply) => {
    const operation = request.routeOptions.url ?? 'unmatched';
    const context = traceContexts.get(request) ?? observability.createContext(String(request.id));
    const failed = (status: number, code: string) => {
      const failure = observability.recordFailure(context, operation, status, code, error);
      request.log.warn(
        {
          failure_id: failure.failure_id,
          operation: failure.operation,
          status_code: failure.status_code,
          error_code: failure.error_code,
          error_fingerprint: failure.error_fingerprint,
          trace_id: failure.trace_id,
          correlation_id: failure.correlation_id,
        },
        'request failed',
      );
      return failure;
    };
    if (error instanceof IdentityError) {
      const status =
        error.code === 'identity_required' ||
        error.code === 'identity_invalid' ||
        error.code === 'identity_expired'
          ? 401
          : 403;
      failed(status, error.code);
      return reply.code(status).send({ error: error.code, message: error.message });
    }
    if (error instanceof AuthorizationDeniedError) {
      failed(403, 'authorization_denied');
      return reply.code(403).send({
        error: 'authorization_denied',
        reasons: error.decision.reasons,
        policy_fingerprint: error.decision.policy_fingerprint,
      });
    }
    if (error instanceof SourceVerificationError) {
      failed(400, error.code);
      return reply.code(400).send({ error: error.code, message: error.message });
    }
    if (error instanceof InvalidToolProposalError) {
      failed(400, 'invalid_tool_proposal');
      return reply.code(400).send({ error: 'invalid_tool_proposal', details: error.details });
    }
    if (error instanceof WorkforceError) {
      const status =
        error.code === 'goal_not_found' ||
        error.code === 'work_item_not_found' ||
        error.code === 'routine_not_found'
          ? 404
          : error.code === 'self_review_denied'
            ? 403
            : 409;
      failed(status, error.code);
      return reply.code(status).send({ error: error.code, message: error.message });
    }
    if (error instanceof InvalidCognitiveRequestError) {
      failed(400, 'invalid_cognitive_request');
      return reply.code(400).send({
        error: 'invalid_cognitive_request',
        details: error.details,
      });
    }
    if (error instanceof InvalidOperationalRequestError) {
      failed(400, 'invalid_operational_request');
      return reply.code(400).send({
        error: 'invalid_operational_request',
        details: error.details,
      });
    }
    const failure = error as Error & { statusCode?: number };
    const status = failure.statusCode && failure.statusCode < 500 ? failure.statusCode : 500;
    failed(status, status >= 500 ? 'internal_error' : 'request_error');
    return reply.code(status).send({
      error: status >= 500 ? 'internal_error' : 'request_error',
      message: status >= 500 ? 'The request could not be completed.' : failure.message,
    });
  });

  return app;
}
