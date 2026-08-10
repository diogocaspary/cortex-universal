import { createHmac, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import type { IngestionEnvelope } from '../src/brain/engine.js';
import { repositoryRoot } from '../src/paths.js';
import { SchemaRegistry } from '../src/schema.js';
import { IdentityError, IdentityResolver } from '../src/security/identity.js';
import {
  SourceRegistry,
  SourceVerificationError,
  sourceAttestationPayload,
} from '../src/security/source-registry.js';

function signedIdentity(secret: string, issuedAt: string, expiresAt: string) {
  const document = {
    id: 'service:gateway-agent',
    tenant_ids: ['tenant:one'],
    roles: ['semantic-service'],
    permissions: ['ontology.read'],
    allowed_classifications: ['public', 'internal'],
    issued_at: issuedAt,
    expires_at: expiresAt,
  };
  const encoded = Buffer.from(JSON.stringify(document), 'utf8').toString('base64url');
  return {
    'x-cortex-identity': encoded,
    'x-cortex-identity-signature': createHmac('sha256', secret).update(encoded).digest('base64url'),
  };
}

describe('trusted identities and evidence sources', () => {
  it('accepts a current gateway identity and rejects tampering and expiry', () => {
    const secret = 'gateway-secret-that-is-longer-than-thirty-two-bytes';
    const resolver = new IdentityResolver({
      environment: 'production',
      mode: 'gateway-hmac',
      gatewaySecret: secret,
    });
    const now = new Date('2026-08-09T18:00:00.000Z');
    const headers = signedIdentity(secret, '2026-08-09T17:59:00.000Z', '2026-08-09T18:05:00.000Z');
    expect(resolver.resolve(headers, now)).toMatchObject({
      id: 'service:gateway-agent',
      tenant_ids: ['tenant:one'],
      authentication_method: 'signed-gateway',
    });
    expect(() =>
      resolver.resolve({ ...headers, 'x-cortex-identity-signature': 'tampered' }, now),
    ).toThrow(IdentityError);
    const expired = signedIdentity(secret, '2026-08-09T17:00:00.000Z', '2026-08-09T17:05:00.000Z');
    expect(() => resolver.resolve(expired, now)).toThrow(/expired/iu);
  });

  it('verifies Ed25519 evidence and rejects payload mutation', async () => {
    const schemas = await SchemaRegistry.create(repositoryRoot());
    const directory = await mkdtemp(join(tmpdir(), 'cortex-source-test-'));
    await mkdir(join(directory, 'policies'));
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    await writeFile(
      join(directory, 'policies', 'source-registry.json'),
      JSON.stringify({
        version: '0.5.0',
        sources: [
          {
            id: 'crm-primary',
            kind: 'system-of-record',
            environments: ['production'],
            tenant_ids: ['tenant:one'],
            provenance_systems: ['crm-primary'],
            maximum_classification: 'confidential',
            attestation: {
              method: 'ed25519',
              key_id: 'crm-key-2026',
              public_key_pem: publicKey.export({ type: 'spki', format: 'pem' }),
            },
          },
        ],
      }),
    );
    const registry = await SourceRegistry.create(directory, schemas, 'production');
    const envelope: IngestionEnvelope = {
      id: 'evidence:crm-9001',
      tenant_id: 'tenant:one',
      brain_id: 'brain:one',
      source_id: 'crm-primary',
      captured_at: '2026-08-09T18:00:00.000Z',
      classification: 'confidential',
      content_hash: `sha256:${'a'.repeat(64)}`,
      media_type: 'application/json',
      content_reference: 'urn:crm:event:9001',
      idempotency_key: 'crm-event-9001-immutable',
      provenance: {
        actor_id: 'service:crm-connector',
        system: 'crm-primary',
        correlation_id: 'correlation:crm-9001',
      },
    };
    envelope.attestation = {
      method: 'ed25519',
      key_id: 'crm-key-2026',
      signed_at: envelope.captured_at,
      signature: sign(null, Buffer.from(sourceAttestationPayload(envelope)), privateKey).toString(
        'base64url',
      ),
    };
    expect(registry.verify(envelope, new Date('2026-08-09T18:00:10.000Z'))).toMatchObject({
      status: 'cryptographically-attested',
      key_id: 'crm-key-2026',
    });
    const tampered = structuredClone(envelope);
    tampered.content_reference = 'urn:crm:event:other';
    expect(() => registry.verify(tampered, new Date('2026-08-09T18:00:10.000Z'))).toThrow(
      SourceVerificationError,
    );
  });
});
