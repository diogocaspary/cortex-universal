import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { repositoryRoot } from '../src/paths.js';
import { CortexShaclValidator } from '../src/shacl.js';

const root = repositoryRoot();
let validator: CortexShaclValidator;

beforeAll(async () => {
  validator = await CortexShaclValidator.create(root);
});

async function turtle(path: string): Promise<string> {
  return readFile(join(root, path), 'utf8');
}

describe('SHACL boundary', () => {
  it('accepts the complete business graph', async () => {
    const report = await validator.validateTurtle(await turtle('examples/valid/sample.ttl'));
    expect(report).toMatchObject({ conforms: true, resultCount: 0 });
  });

  it('rejects claims without provenance', async () => {
    const report = await validator.validateTurtle(
      await turtle('examples/invalid/missing-provenance.ttl'),
    );
    expect(report.conforms).toBe(false);
    expect(report.results.some((result) => result.messages.join(' ').includes('provenance'))).toBe(
      true,
    );
  });

  it('rejects secret values embedded beside credential references', async () => {
    const report = await validator.validateTurtle(await turtle('examples/invalid/secret-leak.ttl'));
    expect(report.conforms).toBe(false);
    expect(
      report.results.some((result) =>
        result.sourceConstraintComponent.endsWith('ClosedConstraintComponent'),
      ),
    ).toBe(true);
  });

  it('rejects unbounded metacognitive confidence', async () => {
    const report = await validator.validateTurtle(`
      @prefix cubo: <https://github.com/diogocaspary/cortex-universal/ontology/core#> .
      @prefix meta: <https://github.com/diogocaspary/cortex-universal/ontology/metacognition#> .
      @prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
      <urn:judgment:1> a meta:ConfidenceJudgment ;
        cubo:identifier "judgment:1" ;
        cubo:hasTenant <urn:tenant:1> ;
        cubo:hasClassification cubo:Internal ;
        cubo:supportedBy <urn:evidence:1> ;
        cubo:observedAt "2026-08-09T12:00:00Z"^^xsd:dateTime ;
        meta:reportedConfidence 1.4 ;
        meta:wasCorrect false .
      <urn:tenant:1> a cubo:Tenant .
      <urn:evidence:1> a cubo:Evidence .
    `);
    expect(report.conforms).toBe(false);
    expect(report.results.some((result) => result.path?.endsWith('reportedConfidence'))).toBe(true);
  });

  it('enforces the payload size before parsing', async () => {
    await expect(validator.validateTurtle(' '.repeat(101), 100)).rejects.toThrow('exceeds');
  });

  it('enforces the RDF quad limit', async () => {
    const triples = Array.from(
      { length: 101 },
      (_, index) => `<urn:test:subject:${index}> <urn:test:predicate> <urn:test:object> .`,
    ).join('\n');
    await expect(validator.validateTurtle(triples, 100_000, 100)).rejects.toThrow('quad limit');
  });

  it('isolates concurrent SHACL validations', async () => {
    const [valid, invalid] = await Promise.all([
      turtle('examples/valid/sample.ttl'),
      turtle('examples/invalid/missing-provenance.ttl'),
    ]);
    const reports = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        validator.validateTurtle(index % 2 === 0 ? valid : invalid),
      ),
    );
    expect(reports.every((report, index) => report.conforms === (index % 2 === 0))).toBe(true);
  });
});
