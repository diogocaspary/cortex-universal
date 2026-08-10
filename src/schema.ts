import { isIP } from 'node:net';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormatsModule, { type FormatsPlugin } from 'ajv-formats';
import { loadManifest, resolvePackageFile } from './manifest.js';

export interface JsonValidationReport {
  valid: boolean;
  schema: string;
  errors: ErrorObject[];
}

export class SchemaRegistry {
  readonly #validators = new Map<string, ValidateFunction>();

  private constructor() {}

  static async create(root: string): Promise<SchemaRegistry> {
    const registry = new SchemaRegistry();
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    const addFormats = addFormatsModule as unknown as FormatsPlugin;
    addFormats(ajv);
    ajv.addFormat('ip', {
      type: 'string',
      validate: (value: string) => isIP(value) !== 0,
    });

    const manifest = await loadManifest(root);
    const files = await Promise.all(manifest.schemas.map((file) => resolvePackageFile(root, file)));
    const pending: Array<{ name: string; id: string }> = [];

    for (const file of files) {
      const schema = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
      const name = basename(file, '.schema.json');
      const id = schema.$id;
      if (typeof id !== 'string' || id.length === 0) {
        throw new Error(`Schema '${name}' must declare a non-empty $id.`);
      }
      if (pending.some((entry) => entry.name === name || entry.id === id)) {
        throw new Error(`Duplicate schema name or $id for '${name}'.`);
      }
      ajv.addSchema(schema);
      pending.push({ name, id });
    }

    for (const { name, id } of pending) {
      const validator = ajv.getSchema(id);
      if (!validator) throw new Error(`Schema '${name}' could not be compiled.`);
      registry.#validators.set(name, validator);
    }

    const manifestReport = registry.validate('package-manifest', manifest);
    if (!manifestReport.valid) {
      throw new Error(`Invalid ontology manifest: ${JSON.stringify(manifestReport.errors)}`);
    }

    return registry;
  }

  names(): string[] {
    return [...this.#validators.keys()].sort();
  }

  validate(schemaName: string, value: unknown): JsonValidationReport {
    const validator = this.#validators.get(schemaName);
    if (!validator) {
      throw new Error(`Unknown schema '${schemaName}'.`);
    }

    const valid = validator(value);
    return {
      valid,
      schema: schemaName,
      errors: valid ? [] : structuredClone(validator.errors ?? []),
    };
  }
}
