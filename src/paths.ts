import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const moduleDirectory = dirname(fileURLToPath(import.meta.url));

function isRepositoryRoot(candidate: string): boolean {
  return existsSync(join(candidate, 'ontology', 'manifest.yaml'));
}

export function repositoryRoot(explicitRoot?: string): string {
  const candidates = [
    explicitRoot,
    process.env.CORTEX_ROOT,
    process.cwd(),
    resolve(moduleDirectory, '..'),
    resolve(moduleDirectory, '..', '..'),
  ].filter((candidate): candidate is string => Boolean(candidate));

  const root = candidates.find(isRepositoryRoot);
  if (!root) {
    throw new Error(
      'Cortex repository root not found. Set CORTEX_ROOT to a directory containing ontology/manifest.yaml.',
    );
  }

  return resolve(root);
}
