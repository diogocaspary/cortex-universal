import { join } from 'node:path';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { AgentCoordinator } from '../agents/coordinator.js';
import { EmbeddedBrainEngine } from '../brain/embedded-engine.js';
import type { BrainEngine } from '../brain/engine.js';
import { PostgresBrainEngine } from '../brain/postgres-engine.js';
import { createCortexGraphSnapshot } from '../graph.js';
import { OntologyGuard } from '../guard/ontology-guard.js';
import { loadManifest } from '../manifest.js';
import { repositoryRoot } from '../paths.js';
import { PolicyEngine } from '../policy.js';
import { SchemaRegistry } from '../schema.js';
import { reasonOntology } from '../reasoning.js';
import { GovernedAuthorizer } from '../security/authorization.js';
import { localStdioPrincipal } from '../security/identity.js';
import { SourceRegistry } from '../security/source-registry.js';
import { createCortexMcpServer } from './cortex-server.js';
import { WorkforceService } from '../workforce/workforce-service.js';

const root = repositoryRoot();
const environment = process.env.NODE_ENV ?? 'development';
if (environment === 'production') {
  throw new Error('Local stdio MCP is disabled in production; use authenticated HTTP MCP.');
}
const [schemas, manifest, graph, reasoning] = await Promise.all([
  SchemaRegistry.create(root),
  loadManifest(root),
  createCortexGraphSnapshot(root),
  reasonOntology(root),
]);
const policy = await PolicyEngine.create(root, schemas);
const authorizer = new GovernedAuthorizer(policy);
const sources = await SourceRegistry.create(root, schemas, environment);
const databasePath = process.env.CORTEX_DB_PATH ?? join(root, 'runtime', 'cortex.db');
const brain: BrainEngine = process.env.CORTEX_DATABASE_URL
  ? new PostgresBrainEngine(
      process.env.CORTEX_DATABASE_URL,
      graph,
      process.env.CORTEX_AUDIT_HMAC_SECRET,
    )
  : new EmbeddedBrainEngine(databasePath, graph, process.env.CORTEX_AUDIT_HMAC_SECRET);
if ((await brain.health()).status !== 'ready') {
  await brain.close();
  throw new Error('Configured Cortex storage is unavailable or not migrated.');
}
const agents = await AgentCoordinator.create(root, schemas, brain);
const workforce = new WorkforceService(brain, agents);
const guard = new OntologyGuard(schemas, agents, brain, authorizer, manifest.version);
const handle = serveStdio(() =>
  createCortexMcpServer({
    manifest,
    graph,
    schemas,
    policy,
    brain,
    agents,
    principal: localStdioPrincipal(),
    authorizer,
    sources,
    environment,
    guard,
    reasoning,
    workforce,
  }),
);

let closing = false;
async function close(): Promise<void> {
  if (closing) return;
  closing = true;
  await handle.close();
  await brain.close();
}

process.once('SIGINT', () => void close());
process.once('SIGTERM', () => void close());
