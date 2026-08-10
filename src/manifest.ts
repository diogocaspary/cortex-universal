import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute, resolve, sep } from 'node:path';
import { parse as parseYaml } from 'yaml';

export interface ManifestModule {
  id: string;
  file: string;
}

export interface CortexManifest {
  id: string;
  name: string;
  version: string;
  status: 'experimental' | 'stable' | 'deprecated';
  namespace: string;
  core: string;
  minimum_node_version: string;
  standards: string[];
  modules: ManifestModule[];
  shapes: string[];
  schemas: string[];
  profiles: ManifestModule[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) {
    throw new Error(`Manifest field '${field}' must be an array of strings.`);
  }
  return value;
}

function moduleArray(value: unknown, field: string): ManifestModule[] {
  if (
    !Array.isArray(value) ||
    !value.every(
      (entry) => isRecord(entry) && typeof entry.id === 'string' && typeof entry.file === 'string',
    )
  ) {
    throw new Error(`Manifest field '${field}' must contain id/file objects.`);
  }
  return value as ManifestModule[];
}

function requiredString(document: Record<string, unknown>, field: string): string {
  const value = document[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Manifest field '${field}' must be a non-empty string.`);
  }
  return value;
}

function assertRelativePackagePath(path: string): void {
  if (
    isAbsolute(path) ||
    path.includes('\\') ||
    path.split('/').some((segment) => segment === '..' || segment === '.' || segment === '')
  ) {
    throw new Error(`Unsafe package path '${path}'.`);
  }
}

export async function loadManifest(root: string): Promise<CortexManifest> {
  const text = await readFile(resolve(root, 'ontology', 'manifest.yaml'), 'utf8');
  const value = parseYaml(text, { maxAliasCount: 10 }) as unknown;
  if (!isRecord(value)) throw new Error('Ontology manifest must be an object.');

  const allowedFields = new Set([
    'id',
    'name',
    'version',
    'status',
    'namespace',
    'core',
    'minimum_node_version',
    'standards',
    'modules',
    'shapes',
    'schemas',
    'profiles',
  ]);
  const unknownField = Object.keys(value).find((field) => !allowedFields.has(field));
  if (unknownField) throw new Error(`Unknown manifest field '${unknownField}'.`);

  const status = requiredString(value, 'status');
  if (!new Set(['experimental', 'stable', 'deprecated']).has(status)) {
    throw new Error(`Unsupported manifest status '${status}'.`);
  }

  const manifest: CortexManifest = {
    id: requiredString(value, 'id'),
    name: requiredString(value, 'name'),
    version: requiredString(value, 'version'),
    status: status as CortexManifest['status'],
    namespace: requiredString(value, 'namespace'),
    core: requiredString(value, 'core'),
    minimum_node_version: requiredString(value, 'minimum_node_version'),
    standards: stringArray(value.standards, 'standards'),
    modules: moduleArray(value.modules, 'modules'),
    shapes: stringArray(value.shapes, 'shapes'),
    schemas: stringArray(value.schemas, 'schemas'),
    profiles: moduleArray(value.profiles, 'profiles'),
  };

  const ids = [...manifest.modules, ...manifest.profiles].map((entry) => entry.id);
  if (new Set(ids).size !== ids.length) {
    throw new Error('Manifest module/profile ids must be unique.');
  }

  const paths = [
    manifest.core,
    ...manifest.modules.map((entry) => entry.file),
    ...manifest.shapes,
    ...manifest.schemas,
    ...manifest.profiles.map((entry) => entry.file),
  ];
  paths.forEach(assertRelativePackagePath);
  if (new Set(paths).size !== paths.length) throw new Error('Manifest paths must be unique.');

  return manifest;
}

export async function resolvePackageFile(root: string, relativePath: string): Promise<string> {
  assertRelativePackagePath(relativePath);
  const [rootPath, filePath] = await Promise.all([
    realpath(root),
    realpath(resolve(root, relativePath)),
  ]);
  if (filePath !== rootPath && !filePath.startsWith(`${rootPath}${sep}`)) {
    throw new Error(`Package path escapes repository root: '${relativePath}'.`);
  }
  return filePath;
}
