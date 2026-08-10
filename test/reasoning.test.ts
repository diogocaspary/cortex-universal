import { describe, expect, it } from 'vitest';
import { parseTurtle } from '../src/rdf.js';
import { reasonDataset } from '../src/reasoning.js';

describe('bounded explainable ontology reasoning', () => {
  it('infers subclass types and reports explicit disjointness conflicts', async () => {
    const dataset = await parseTurtle(`
      @prefix ex: <https://example.test/> .
      @prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
      @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
      @prefix owl: <http://www.w3.org/2002/07/owl#> .
      ex:Manager rdfs:subClassOf ex:Employee .
      ex:Employee owl:disjointWith ex:ExternalParty .
      ex:alice rdf:type ex:Manager, ex:ExternalParty .
    `);
    const report = reasonDataset(dataset);
    expect(report.inferences).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          subject: 'https://example.test/alice',
          predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type',
          object: 'https://example.test/Employee',
          rule: 'rdfs-type-inheritance',
        }),
      ]),
    );
    expect(report.consistent).toBe(false);
    expect(report.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'disjoint_type_conflict' })]),
    );
    expect(report.complete_owl_reasoner).toBe(false);
  });

  it('stops at configured inference bounds and reports truncation', async () => {
    const dataset = await parseTurtle(`
      @prefix ex: <https://example.test/> .
      @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
      ex:A rdfs:subClassOf ex:B .
      ex:B rdfs:subClassOf ex:C .
      ex:C rdfs:subClassOf ex:D .
    `);
    const report = reasonDataset(dataset, { maximumInferences: 1, maximumIterations: 10 });
    expect(report.inferred_triples).toBe(1);
    expect(report.truncated).toBe(true);
  });
});
