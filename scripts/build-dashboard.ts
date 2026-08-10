import { readdir, readFile, rm, mkdir, copyFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceDirectory = join(repositoryRoot, 'dashboard');
const outputDirectory = join(repositoryRoot, 'dist', 'dashboard');
const reviewedLicenses = new Set([
  '0BSD',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'ISC',
  'MIT',
]);

function packageLocationFromInput(input: string): { name: string; candidate: string } | null {
  const normalized = input.replaceAll('\\', '/');
  const marker = 'node_modules/';
  const markerIndex = normalized.lastIndexOf(marker);
  if (markerIndex < 0) return null;
  const remainder = normalized.slice(markerIndex + marker.length);
  const parts = remainder.split('/');
  const packageName = parts[0]?.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
  if (!packageName) return null;
  return {
    name: packageName,
    candidate: resolve(
      repositoryRoot,
      normalized.slice(0, markerIndex + marker.length),
      packageName,
    ),
  };
}

async function packageRootFromInput(input: string): Promise<string | null> {
  const location = packageLocationFromInput(input);
  if (!location) return null;
  try {
    await readFile(join(location.candidate, 'package.json'), 'utf8');
    return location.candidate;
  } catch {
    // Some published packages vendor dependency source under a folder named node_modules
    // without its metadata. In that case npm's resolved top-level package is authoritative.
    const resolvedRoot = join(repositoryRoot, 'node_modules', location.name);
    await readFile(join(resolvedRoot, 'package.json'), 'utf8');
    return resolvedRoot;
  }
}

async function buildThirdPartyNotices(inputs: string[]): Promise<string> {
  const packageRoots = [
    ...new Set(
      (await Promise.all(inputs.map(packageRootFromInput))).filter((path) => path !== null),
    ),
  ].sort();
  const notices = [
    'THIRD-PARTY SOFTWARE NOTICES',
    '',
    'Generated from the packages bundled into the Cortex dashboard.',
    '',
  ];

  for (const packageRoot of packageRoots) {
    const packageDocument = JSON.parse(
      await readFile(join(packageRoot, 'package.json'), 'utf8'),
    ) as { name?: string; version?: string; license?: string };
    if (!packageDocument.name || !packageDocument.version || !packageDocument.license) {
      throw new Error(`Bundled package metadata is incomplete at '${packageRoot}'.`);
    }
    if (!reviewedLicenses.has(packageDocument.license)) {
      throw new Error(
        `Bundled package '${packageDocument.name}' uses unreviewed license '${packageDocument.license}'.`,
      );
    }
    const candidates = (await readdir(packageRoot))
      .filter((file) => /^(licen[cs]e|copying|notice)(\..*)?$/i.test(file))
      .sort();
    const licenseText = candidates[0]
      ? await readFile(join(packageRoot, candidates[0]), 'utf8')
      : 'No standalone license file was included in the package; see its package metadata.';
    notices.push(
      '================================================================================',
      `${packageDocument.name}@${packageDocument.version} — ${packageDocument.license}`,
      '================================================================================',
      licenseText.trim(),
      '',
    );
  }

  return `${notices.join('\n')}\n`;
}

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });

const result = await build({
  entryPoints: [join(sourceDirectory, 'src', 'main.ts')],
  outdir: outputDirectory,
  bundle: true,
  chunkNames: 'chunks/[name]-[hash]',
  entryNames: 'main',
  define: { 'process.env.NODE_ENV': '"production"' },
  format: 'esm',
  legalComments: 'eof',
  metafile: true,
  minify: true,
  platform: 'browser',
  splitting: true,
  target: ['es2022'],
});

await Promise.all([
  copyFile(join(sourceDirectory, 'index.html'), join(outputDirectory, 'index.html')),
  copyFile(join(sourceDirectory, 'styles.css'), join(outputDirectory, 'styles.css')),
  writeFile(
    join(outputDirectory, 'THIRD_PARTY_LICENSES.txt'),
    await buildThirdPartyNotices(Object.keys(result.metafile.inputs)),
    'utf8',
  ),
]);

console.log(`Dashboard built in ${outputDirectory}.`);
