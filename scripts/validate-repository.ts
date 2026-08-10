import { createHash, createPublicKey, verify } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, join, relative, sep } from 'node:path';
import { listFilesRecursively } from '../src/files.js';
import { loadManifest, resolvePackageFile } from '../src/manifest.js';
import { repositoryRoot } from '../src/paths.js';
import { PolicyEngine } from '../src/policy.js';
import { parseTurtleFile } from '../src/rdf.js';
import { SchemaRegistry } from '../src/schema.js';
import { CortexShaclValidator } from '../src/shacl.js';

interface ActionRegistry {
  version: string;
  actions: Array<{ action_key: string; required_permissions: string[] }>;
}

interface AgentRegistry {
  version: string;
  agents: Array<{ id: string; reports_to: string | null; skill_ids: string[] }>;
}

interface SkillRegistry {
  version: string;
  skills: Array<{
    id: string;
    source_type: 'bundled' | 'git';
    source_locator: string;
    content_hash: string;
    signature?: {
      algorithm: 'Ed25519';
      key_id: string;
      value: string;
    } | null;
  }>;
}

interface SkillTrustRegistry {
  version: string;
  keys: Array<{
    key_id: string;
    algorithm: 'Ed25519';
    public_key_pem: string;
    status: 'active' | 'revoked';
  }>;
}

interface OperationRegistry {
  version: string;
  operations: Array<{
    operation_id: string;
    transport: 'http' | 'mcp-tool' | 'mcp-resource';
    method: string;
    path: string;
    permission: string | null;
  }>;
}

function ensure(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
    .join(',')}}`;
}

const root = repositoryRoot();
const manifest = await loadManifest(root);
ensure(manifest.id === 'cortex-universal', 'Unexpected ontology package id.');

const declaredFiles = [
  manifest.core,
  ...manifest.modules.map((module) => module.file),
  ...manifest.shapes,
  ...manifest.schemas,
  ...manifest.profiles.map((profile) => profile.file),
];
await Promise.all(declaredFiles.map((file) => resolvePackageFile(root, file)));

function packagePath(file: string): string {
  return relative(root, file).split(sep).join('/');
}

async function assertDeclaredDirectory(
  directory: string,
  suffix: string,
  declared: string[],
): Promise<void> {
  const actual = (
    await listFilesRecursively(join(root, directory), (file) => file.endsWith(suffix))
  )
    .map(packagePath)
    .sort();
  const expected = [...declared].sort();
  ensure(
    JSON.stringify(actual) === JSON.stringify(expected),
    `Declared files differ in ${directory}: expected ${expected.join(', ')}, found ${actual.join(', ')}.`,
  );
}

await Promise.all([
  assertDeclaredDirectory(
    'ontology/modules',
    '.ttl',
    manifest.modules.map((module) => module.file),
  ),
  assertDeclaredDirectory(
    'ontology/profiles',
    '.ttl',
    manifest.profiles.map((profile) => profile.file),
  ),
  assertDeclaredDirectory('shapes', '.ttl', manifest.shapes),
  assertDeclaredDirectory('schemas', '.schema.json', manifest.schemas),
]);

const dashboardSource = await readFile(join(root, 'dashboard', 'src', 'main.ts'), 'utf8');
for (const forbidden of [
  'linkDirectionalParticles',
  'simulate-pulses',
  'simulatePulses',
  'example-business',
]) {
  ensure(
    !dashboardSource.includes(forbidden),
    `Dashboard must not contain simulated or example runtime data: ${forbidden}.`,
  );
}
ensure(
  !dashboardSource.includes('/examples/'),
  'Dashboard must never load repository conformance fixtures.',
);

const turtleFiles = (
  await Promise.all(
    ['ontology', 'shapes', 'examples'].map((directory) =>
      listFilesRecursively(join(root, directory), (file) => file.endsWith('.ttl')),
    ),
  )
).flat();
await Promise.all(turtleFiles.map(parseTurtleFile));

const schemas = await SchemaRegistry.create(root);
const validJsonFiles = await listFilesRecursively(join(root, 'examples', 'valid'), (file) =>
  file.endsWith('.json'),
);
for (const file of validJsonFiles) {
  const schemaName = basename(file, '.json');
  const value = JSON.parse(await readFile(file, 'utf8')) as unknown;
  const report = schemas.validate(schemaName, value);
  ensure(report.valid, `${file} failed ${schemaName} validation: ${JSON.stringify(report.errors)}`);
}

const invalidClaim = JSON.parse(
  await readFile(join(root, 'examples', 'invalid', 'claim.json'), 'utf8'),
) as unknown;
ensure(
  !schemas.validate('claim', invalidClaim).valid,
  'Invalid claim fixture unexpectedly passed.',
);

const actionRegistry = JSON.parse(
  await readFile(join(root, 'policies', 'action-registry.json'), 'utf8'),
) as ActionRegistry;
const actionRegistryReport = schemas.validate('action-registry', actionRegistry);
ensure(
  actionRegistryReport.valid,
  `Action registry is invalid: ${JSON.stringify(actionRegistryReport.errors)}`,
);
for (const action of actionRegistry.actions) {
  const report = schemas.validate('action', action);
  ensure(
    report.valid,
    `Trusted action ${action.action_key} is invalid: ${JSON.stringify(report.errors)}`,
  );
}
ensure(
  new Set(actionRegistry.actions.map((action) => action.action_key)).size ===
    actionRegistry.actions.length,
  'Action keys must be unique.',
);
ensure(
  actionRegistry.version === manifest.version,
  'Action registry version must match the manifest.',
);

const sourceRegistry = JSON.parse(
  await readFile(join(root, 'policies', 'source-registry.json'), 'utf8'),
) as { version: string };
const sourceRegistryReport = schemas.validate('source-registry', sourceRegistry);
ensure(
  sourceRegistryReport.valid,
  `Source registry is invalid: ${JSON.stringify(sourceRegistryReport.errors)}`,
);
ensure(
  sourceRegistry.version === manifest.version,
  'Source registry version must match the manifest.',
);

const skillRegistry = JSON.parse(
  await readFile(join(root, 'policies', 'skill-registry.json'), 'utf8'),
) as SkillRegistry;
const skillRegistryReport = schemas.validate('skill-registry', skillRegistry);
ensure(
  skillRegistryReport.valid,
  `Skill registry is invalid: ${JSON.stringify(skillRegistryReport.errors)}`,
);
ensure(
  skillRegistry.version === manifest.version,
  'Skill registry version must match the manifest.',
);
ensure(
  new Set(skillRegistry.skills.map((skill) => skill.id)).size === skillRegistry.skills.length,
  'Skill identifiers must be unique.',
);

const skillTrustRegistry = JSON.parse(
  await readFile(join(root, 'policies', 'skill-trust-registry.json'), 'utf8'),
) as SkillTrustRegistry;
const skillTrustReport = schemas.validate('skill-trust-registry', skillTrustRegistry);
ensure(
  skillTrustReport.valid,
  `Skill trust registry is invalid: ${JSON.stringify(skillTrustReport.errors)}`,
);
ensure(
  skillTrustRegistry.version === manifest.version,
  'Skill trust registry version must match the manifest.',
);
ensure(
  new Set(skillTrustRegistry.keys.map((key) => key.key_id)).size === skillTrustRegistry.keys.length,
  'Skill trust key identifiers must be unique.',
);
for (const skill of skillRegistry.skills) {
  if (skill.source_type === 'bundled') {
    const file = await resolvePackageFile(root, skill.source_locator);
    const digest = `sha256:${createHash('sha256')
      .update(await readFile(file))
      .digest('hex')}`;
    ensure(digest === skill.content_hash, `Bundled skill ${skill.id} content hash does not match.`);
    continue;
  }
  ensure(
    skill.signature !== null && skill.signature !== undefined,
    `Git skill ${skill.id} is unsigned.`,
  );
  const trustKey = skillTrustRegistry.keys.find(
    (key) => key.key_id === skill.signature?.key_id && key.status === 'active',
  );
  ensure(trustKey !== undefined, `Git skill ${skill.id} has no active trusted signing key.`);
  const publicKey = createPublicKey(trustKey.public_key_pem);
  ensure(publicKey.asymmetricKeyType === 'ed25519', `Skill key ${trustKey.key_id} is not Ed25519.`);
  const { signature, ...signedManifest } = skill;
  ensure(
    verify(
      null,
      Buffer.from(canonical(signedManifest), 'utf8'),
      publicKey,
      Buffer.from(signature.value, 'base64'),
    ),
    `Git skill ${skill.id} has an invalid signature.`,
  );
}

const operationRegistry = JSON.parse(
  await readFile(join(root, 'policies', 'operation-registry.json'), 'utf8'),
) as OperationRegistry;
const operationRegistryReport = schemas.validate('operation-registry', operationRegistry);
ensure(
  operationRegistryReport.valid,
  `Operation registry is invalid: ${JSON.stringify(operationRegistryReport.errors)}`,
);
ensure(
  operationRegistry.version === manifest.version,
  'Operation registry version must match the manifest.',
);
ensure(
  new Set(operationRegistry.operations.map((operation) => operation.operation_id)).size ===
    operationRegistry.operations.length,
  'Operation identifiers must be unique.',
);
const knownPermissions = new Set(
  actionRegistry.actions.flatMap((action) => action.required_permissions),
);
for (const operation of operationRegistry.operations) {
  ensure(
    operation.permission === null || knownPermissions.has(operation.permission),
    `Operation ${operation.operation_id} references an unknown permission.`,
  );
}
const mcpSource = await readFile(join(root, 'src', 'mcp', 'cortex-server.ts'), 'utf8');
for (const operation of operationRegistry.operations.filter(
  (candidate) => candidate.transport === 'mcp-tool',
)) {
  ensure(
    mcpSource.includes(`'${operation.path}'`),
    `Registered MCP operation ${operation.operation_id} is not implemented.`,
  );
}

const bundle = JSON.parse(
  await readFile(join(root, 'policies', 'default-policy.json'), 'utf8'),
) as unknown;
const policyReport = schemas.validate('policy-bundle', bundle);
ensure(policyReport.valid, `Policy bundle is invalid: ${JSON.stringify(policyReport.errors)}`);
await PolicyEngine.create(root, schemas);

const agentRegistry = JSON.parse(
  await readFile(join(root, 'policies', 'agent-registry.json'), 'utf8'),
) as AgentRegistry;
const agentRegistryReport = schemas.validate('agent-registry', agentRegistry);
ensure(
  agentRegistryReport.valid,
  `Agent registry is invalid: ${JSON.stringify(agentRegistryReport.errors)}`,
);
ensure(
  agentRegistry.version === manifest.version,
  'Agent registry version must match the manifest.',
);
ensure(
  new Set(agentRegistry.agents.map((agent) => agent.id)).size === agentRegistry.agents.length,
  'Agent identifiers must be unique.',
);
const agentIds = new Set(agentRegistry.agents.map((agent) => agent.id));
const skillIds = new Set(skillRegistry.skills.map((skill) => skill.id));
for (const agent of agentRegistry.agents) {
  ensure(agent.reports_to !== agent.id, `Agent ${agent.id} cannot report to itself.`);
  ensure(
    agent.reports_to === null || agentIds.has(agent.reports_to),
    `Agent ${agent.id} reports to an unknown agent.`,
  );
  for (const skillId of agent.skill_ids) {
    ensure(skillIds.has(skillId), `Agent ${agent.id} references unknown skill ${skillId}.`);
  }
  const seen = new Set<string>();
  let cursor: string | null = agent.id;
  while (cursor !== null) {
    ensure(!seen.has(cursor), `Agent reporting hierarchy contains a cycle at ${cursor}.`);
    seen.add(cursor);
    cursor = agentRegistry.agents.find((candidate) => candidate.id === cursor)?.reports_to ?? null;
  }
}

const shacl = await CortexShaclValidator.create(root);
const validGraph = await shacl.validateTurtle(
  await readFile(join(root, 'examples', 'valid', 'sample.ttl'), 'utf8'),
);
ensure(validGraph.conforms, `Valid graph failed SHACL: ${JSON.stringify(validGraph.results)}`);

for (const fixture of ['missing-provenance.ttl', 'secret-leak.ttl']) {
  const report = await shacl.validateTurtle(
    await readFile(join(root, 'examples', 'invalid', fixture), 'utf8'),
  );
  ensure(!report.conforms, `Invalid fixture ${fixture} unexpectedly conformed.`);
}

console.log(
  `Validated ${turtleFiles.length} Turtle files, ${schemas.names().length} JSON schemas, ` +
    `${manifest.modules.length} modules, ${actionRegistry.actions.length} actions, ` +
    `${agentRegistry.agents.length} agents, ${operationRegistry.operations.length} observable operations, ` +
    `policy ${manifest.version}, and all fixtures.`,
);
