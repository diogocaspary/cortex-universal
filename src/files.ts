import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

export async function listFilesRecursively(
  directory: string,
  predicate: (file: string) => boolean = () => true,
): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory()
        ? listFilesRecursively(path, predicate)
        : predicate(path)
          ? [path]
          : [];
    }),
  );

  return files.flat().sort();
}
