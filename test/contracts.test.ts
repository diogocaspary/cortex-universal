import { access, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';
import { repositoryRoot } from '../src/paths.js';

const root = repositoryRoot();

interface OpenApiDocument {
  openapi: string;
  info: { version: string };
  paths: Record<string, unknown>;
}

describe('portable contracts', () => {
  it('keeps package, ontology, and OpenAPI versions aligned', async () => {
    const packageDocument = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as {
      version: string;
    };
    const manifest = parseYaml(await readFile(join(root, 'ontology', 'manifest.yaml'), 'utf8')) as {
      version: string;
    };
    const openapi = parseYaml(
      await readFile(join(root, 'openapi.yaml'), 'utf8'),
    ) as OpenApiDocument;

    expect(openapi.openapi).toBe('3.1.0');
    expect(manifest.version).toBe(packageDocument.version);
    expect(openapi.info.version).toBe(packageDocument.version);
  });

  it('declares all implemented endpoints', async () => {
    const openapi = parseYaml(
      await readFile(join(root, 'openapi.yaml'), 'utf8'),
    ) as OpenApiDocument;
    expect(Object.keys(openapi.paths).sort()).toEqual(
      [
        '/healthz',
        '/',
        '/dashboard',
        '/dashboard/',
        '/readyz',
        '/mcp',
        '/v1/agents/registry',
        '/v1/agents/sessions',
        '/v1/agents/sessions/{id}',
        '/v1/agents/sessions/{id}/handoffs',
        '/v1/brain/activity',
        '/v1/brain/health',
        '/v1/brain/ingest',
        '/v1/brain/retrieve',
        '/v1/graph',
        '/v1/ontology/reasoning',
        '/v1/guard/evaluate',
        '/v1/audit/integrity',
        '/v1/observability/metrics',
        '/v1/observability/failures',
        '/v1/cognition/attention/select',
        '/v1/cognition/consolidation/propose',
        '/v1/cognition/cycle/validate',
        '/v1/cognition/metacognition/evaluate',
        '/v1/cognition/prediction/evaluate',
        '/v1/manifest',
        '/v1/policies/evaluate',
        '/v1/validate/json/{schema}',
        '/v1/validate/shacl',
        '/v1/workforce/snapshot',
        '/v1/workforce/goals',
        '/v1/workforce/work-items',
        '/v1/workforce/work-items/{id}/checkout',
        '/v1/workforce/work-items/{id}/transitions',
        '/v1/workforce/routines',
        '/v1/workforce/routines/materialize',
        '/v1/workforce/cost-events',
        '/v1/workforce/evaluations',
        '/v1/workforce/heartbeats',
      ].sort(),
    );
  });

  it('ships local Windows and Unix launchers', async () => {
    const files = [
      'INSTALAR-NO-WINDOWS.cmd',
      'INICIAR-NO-WINDOWS.cmd',
      'PARAR-NO-WINDOWS.cmd',
      'STATUS-NO-WINDOWS.cmd',
      'TESTAR-NO-WINDOWS.cmd',
      'local/windows/install.ps1',
      'local/windows/start.ps1',
      'local/windows/stop.ps1',
      'local/windows/test.ps1',
      'local/unix/install.sh',
      'local/unix/status.sh',
      'local/unix/stop.sh',
    ];
    await expect(Promise.all(files.map((file) => access(join(root, file))))).resolves.toBeDefined();
  });

  it('ships a self-contained dashboard and generated dependency notices', async () => {
    const files = [
      'dashboard/index.html',
      'dashboard/src/main.ts',
      'dashboard/styles.css',
      'dist/dashboard/index.html',
      'dist/dashboard/main.js',
      'dist/dashboard/styles.css',
      'dist/dashboard/THIRD_PARTY_LICENSES.txt',
      'THIRD_PARTY_NOTICES.md',
    ];
    await expect(Promise.all(files.map((file) => access(join(root, file))))).resolves.toBeDefined();
    const notices = await readFile(
      join(root, 'dist', 'dashboard', 'THIRD_PARTY_LICENSES.txt'),
      'utf8',
    );
    expect(notices).toContain('@antv/g6@5.1.1 — MIT');
    expect(notices).toContain('@antv/util@2.0.17 — ISC');
    expect(notices).toContain('@antv/util@3.3.11 — MIT');
    expect(notices).toContain('3d-force-graph@1.80.0 — MIT');
  });

  it('resolves every external schema reference in OpenAPI', async () => {
    const openapiPath = join(root, 'openapi.yaml');
    const source = await readFile(openapiPath, 'utf8');
    const references = [...source.matchAll(/\$ref:\s+(\.\/[^\s]+)/g)].map((match) => match[1]);
    expect(references.length).toBeGreaterThan(0);
    await expect(
      Promise.all(
        references.map((reference) => access(resolve(dirname(openapiPath), reference ?? ''))),
      ),
    ).resolves.toBeDefined();
  });
});
