import { Readable } from 'node:stream';
import rdf from '@zazuko/env-node';
import type { DatasetCore } from '@rdfjs/types';
import { loadManifest, resolvePackageFile } from './manifest.js';

export async function parseTurtleFile(path: string): Promise<DatasetCore> {
  return rdf.dataset().import(rdf.fromFile(path));
}

export async function parseTurtle(
  turtle: string,
  maximumBytes = 1_000_000,
  maximumQuads = 10_000,
): Promise<DatasetCore> {
  if (Buffer.byteLength(turtle, 'utf8') > maximumBytes) {
    throw new Error(`Turtle payload exceeds the ${maximumBytes}-byte limit.`);
  }

  const parser = rdf.formats.parsers.get('text/turtle');
  if (!parser) {
    throw new Error('The Turtle parser is not available.');
  }

  const dataset = await rdf.dataset().import(parser.import(Readable.from([turtle])));
  if (dataset.size > maximumQuads) {
    throw new Error(`Turtle payload exceeds the ${maximumQuads}-quad limit.`);
  }
  return dataset;
}

export async function loadOntology(root: string): Promise<DatasetCore> {
  const manifest = await loadManifest(root);
  const declared = [
    manifest.core,
    ...manifest.modules.map((module) => module.file),
    ...manifest.profiles.map((profile) => profile.file),
  ];
  const files = await Promise.all(declared.map((file) => resolvePackageFile(root, file)));
  const datasets = await Promise.all(files.map(parseTurtleFile));
  return rdf.dataset(datasets.flatMap((dataset) => [...dataset]));
}

export async function loadShapes(root: string): Promise<DatasetCore> {
  const manifest = await loadManifest(root);
  const files = await Promise.all(manifest.shapes.map((file) => resolvePackageFile(root, file)));
  const datasets = await Promise.all(files.map(parseTurtleFile));
  return rdf.dataset(datasets.flatMap((dataset) => [...dataset]));
}

export function mergeDatasets(...datasets: DatasetCore[]): DatasetCore {
  return rdf.dataset(datasets.flatMap((dataset) => [...dataset]));
}
