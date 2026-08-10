import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';
import { listFilesRecursively } from '../src/files.js';
import { loadManifest, resolvePackageFile } from '../src/manifest.js';
import { repositoryRoot } from '../src/paths.js';
import { parseTurtleFile } from '../src/rdf.js';

const root = repositoryRoot();

interface Manifest {
  core: string;
  modules: Array<{ id: string; file: string }>;
  shapes: string[];
  schemas: string[];
  profiles: Array<{ id: string; file: string }>;
}

describe('ontology package', () => {
  it('parses every Turtle document', async () => {
    const files = (
      await Promise.all(
        ['ontology', 'shapes', 'examples'].map((directory) =>
          listFilesRecursively(join(root, directory), (file) => file.endsWith('.ttl')),
        ),
      )
    ).flat();
    const datasets = await Promise.all(files.map(parseTurtleFile));
    expect(files).toHaveLength(46);
    expect(datasets.every((dataset) => dataset.size > 0)).toBe(true);
  });

  it('contains every file declared by the manifest', async () => {
    const manifest = parseYaml(
      await readFile(join(root, 'ontology', 'manifest.yaml'), 'utf8'),
    ) as Manifest;
    const declared = [
      manifest.core,
      ...manifest.modules.map((module) => module.file),
      ...manifest.shapes,
      ...manifest.schemas,
      ...manifest.profiles.map((profile) => profile.file),
    ];
    await expect(
      Promise.all(declared.map((file) => access(join(root, file)))),
    ).resolves.toBeDefined();
    expect(new Set(manifest.modules.map((module) => module.id)).size).toBe(manifest.modules.length);
  });

  it('uses a protected JSON-LD context', async () => {
    const context = JSON.parse(
      await readFile(join(root, 'ontology', 'context', 'cubo.context.jsonld'), 'utf8'),
    ) as { '@context': { '@protected'?: boolean } };
    expect(context['@context']['@protected']).toBe(true);
  });

  it('rejects package path traversal', async () => {
    await expect(resolvePackageFile(root, '../outside.ttl')).rejects.toThrow('Unsafe package path');
  });

  it('loads the complete strict manifest', async () => {
    const manifest = await loadManifest(root);
    expect(manifest.modules).toHaveLength(34);
    expect(manifest.schemas).toHaveLength(43);
    expect(manifest.shapes).toHaveLength(8);
    expect(manifest.profiles).toHaveLength(0);
  });

  it('ships local lifecycle scripts for Unix-like systems', async () => {
    await expect(
      Promise.all(
        ['install.sh', 'start.sh', 'status.sh', 'stop.sh'].map((file) =>
          access(join(root, 'local', 'unix', file)),
        ),
      ),
    ).resolves.toBeDefined();
  });
});
