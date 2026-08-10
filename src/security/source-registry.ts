import { createHash, verify } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { IngestionEnvelope } from '../brain/engine.js';
import type { Classification } from '../policy.js';
import type { SchemaRegistry } from '../schema.js';

const CLASSIFICATION_RANK: Record<Classification, number> = {
  public: 0,
  internal: 1,
  confidential: 2,
  restricted: 3,
};

export interface SourceAttestation {
  method: 'ed25519';
  key_id: string;
  signed_at: string;
  signature: string;
}

export interface SourceDefinition {
  id: string;
  kind: 'system-of-record' | 'authoritative-feed' | 'human-attested' | 'test-fixture';
  environments: Array<'development' | 'test' | 'staging' | 'production'>;
  tenant_ids: string[];
  provenance_systems: string[];
  maximum_classification: Classification;
  attestation:
    | { method: 'none'; reason: 'conformance-fixture-only' }
    | { method: 'ed25519'; key_id: string; public_key_pem: string };
}

interface SourceRegistryDocument {
  version: string;
  sources: SourceDefinition[];
}

export interface SourceVerification {
  source_id: string;
  registry_version: string;
  status: 'cryptographically-attested' | 'conformance-fixture';
  verified_at: string;
  key_id: string | null;
  signed_payload_hash: string;
}

export class SourceVerificationError extends Error {
  constructor(
    readonly code:
      | 'source_unregistered'
      | 'source_environment_denied'
      | 'source_scope_denied'
      | 'source_system_mismatch'
      | 'source_classification_denied'
      | 'source_attestation_required'
      | 'source_attestation_invalid',
    message: string,
  ) {
    super(message);
    this.name = 'SourceVerificationError';
  }
}

/** Stable byte sequence documented for connector implementations. */
export function sourceAttestationPayload(envelope: IngestionEnvelope): string {
  return [
    'cortex-source-attestation-v1',
    envelope.id,
    envelope.tenant_id,
    envelope.brain_id,
    envelope.source_id,
    envelope.captured_at,
    envelope.classification,
    envelope.content_hash,
    envelope.media_type,
    envelope.content_reference,
    envelope.idempotency_key,
    envelope.provenance.actor_id,
    envelope.provenance.system,
    envelope.provenance.correlation_id,
  ].join('\n');
}

export class SourceRegistry {
  readonly version: string;
  readonly #environment: string;
  readonly #sources: Map<string, SourceDefinition>;

  private constructor(document: SourceRegistryDocument, environment: string) {
    this.version = document.version;
    this.#environment = environment;
    this.#sources = new Map(document.sources.map((source) => [source.id, source]));
  }

  static async create(
    root: string,
    schemas: SchemaRegistry,
    environment: string,
  ): Promise<SourceRegistry> {
    const document = JSON.parse(
      await readFile(join(root, 'policies', 'source-registry.json'), 'utf8'),
    ) as SourceRegistryDocument;
    const report = schemas.validate('source-registry', document);
    if (!report.valid) {
      throw new Error(`Invalid trusted source registry: ${JSON.stringify(report.errors)}`);
    }
    if (new Set(document.sources.map((source) => source.id)).size !== document.sources.length) {
      throw new Error('Trusted source identifiers must be unique.');
    }
    for (const source of document.sources) {
      if (source.kind === 'test-fixture' && source.environments.includes('production')) {
        throw new Error(`Test fixture source '${source.id}' cannot be enabled in production.`);
      }
      if (source.attestation.method === 'none' && source.kind !== 'test-fixture') {
        throw new Error(
          `Operational source '${source.id}' must require cryptographic attestation.`,
        );
      }
    }
    return new SourceRegistry(document, environment);
  }

  verify(envelope: IngestionEnvelope, now = new Date()): SourceVerification {
    const source = this.#sources.get(envelope.source_id);
    if (!source) {
      throw new SourceVerificationError(
        'source_unregistered',
        `Source '${envelope.source_id}' is not in the trusted source registry.`,
      );
    }
    if (!source.environments.includes(this.#environment as never)) {
      throw new SourceVerificationError(
        'source_environment_denied',
        `Source '${source.id}' is not enabled in this environment.`,
      );
    }
    if (!source.tenant_ids.includes('*') && !source.tenant_ids.includes(envelope.tenant_id)) {
      throw new SourceVerificationError(
        'source_scope_denied',
        `Source '${source.id}' is not registered for this tenant.`,
      );
    }
    if (!source.provenance_systems.includes(envelope.provenance.system)) {
      throw new SourceVerificationError(
        'source_system_mismatch',
        'The provenance system does not match the trusted source registration.',
      );
    }
    if (
      CLASSIFICATION_RANK[envelope.classification] >
      CLASSIFICATION_RANK[source.maximum_classification]
    ) {
      throw new SourceVerificationError(
        'source_classification_denied',
        'The evidence classification exceeds the registered source ceiling.',
      );
    }

    const payload = sourceAttestationPayload(envelope);
    const signedPayloadHash = `sha256:${createHash('sha256').update(payload, 'utf8').digest('hex')}`;
    if (source.attestation.method === 'none') {
      if (source.kind !== 'test-fixture' || !['development', 'test'].includes(this.#environment)) {
        throw new SourceVerificationError(
          'source_attestation_required',
          'Unsigned evidence is permitted only for explicit conformance fixtures outside production.',
        );
      }
      return {
        source_id: source.id,
        registry_version: this.version,
        status: 'conformance-fixture',
        verified_at: now.toISOString(),
        key_id: null,
        signed_payload_hash: signedPayloadHash,
      };
    }

    const attestation = envelope.attestation;
    if (!attestation || attestation.method !== 'ed25519') {
      throw new SourceVerificationError(
        'source_attestation_required',
        'This source requires an Ed25519 attestation.',
      );
    }
    if (attestation.key_id !== source.attestation.key_id) {
      throw new SourceVerificationError(
        'source_attestation_invalid',
        'The attestation key is not registered for this source.',
      );
    }
    const signedAt = Date.parse(attestation.signed_at);
    const capturedAt = Date.parse(envelope.captured_at);
    if (
      !Number.isFinite(signedAt) ||
      !Number.isFinite(capturedAt) ||
      Math.abs(signedAt - capturedAt) > 5 * 60_000 ||
      signedAt > now.getTime() + 30_000
    ) {
      throw new SourceVerificationError(
        'source_attestation_invalid',
        'The attestation time is outside the accepted capture window.',
      );
    }
    let signature: Buffer;
    try {
      signature = Buffer.from(attestation.signature, 'base64url');
    } catch {
      throw new SourceVerificationError(
        'source_attestation_invalid',
        'The attestation signature encoding is invalid.',
      );
    }
    if (!verify(null, Buffer.from(payload, 'utf8'), source.attestation.public_key_pem, signature)) {
      throw new SourceVerificationError(
        'source_attestation_invalid',
        'The evidence attestation signature is invalid.',
      );
    }
    return {
      source_id: source.id,
      registry_version: this.version,
      status: 'cryptographically-attested',
      verified_at: now.toISOString(),
      key_id: source.attestation.key_id,
      signed_payload_hash: signedPayloadHash,
    };
  }
}
