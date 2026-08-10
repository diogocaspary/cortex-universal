import SHACLValidator from 'rdf-validate-shacl';
import type { DatasetCore, Term } from '@rdfjs/types';
import { loadOntology, loadShapes, mergeDatasets, parseTurtle } from './rdf.js';

export interface ShaclResult {
  focusNode: string;
  path: string | null;
  value: string | null;
  severity: string;
  sourceConstraintComponent: string;
  sourceShape: string;
  messages: string[];
}

export interface ShaclReport {
  conforms: boolean;
  resultCount: number;
  results: ShaclResult[];
}

function termValue(term: Term | null | undefined): string | null {
  return term ? term.value : null;
}

export class CortexShaclValidator {
  readonly #ontology: DatasetCore;
  readonly #shapes: DatasetCore;

  private constructor(ontology: DatasetCore, shapes: DatasetCore) {
    this.#ontology = ontology;
    this.#shapes = shapes;
  }

  static async create(root: string): Promise<CortexShaclValidator> {
    const [ontology, shapes] = await Promise.all([loadOntology(root), loadShapes(root)]);
    return new CortexShaclValidator(ontology, shapes);
  }

  async validateDataset(data: DatasetCore): Promise<ShaclReport> {
    // rdf-validate-shacl keeps mutable validation state, so every request gets
    // an isolated validator. This makes concurrent requests deterministic.
    const validator = new SHACLValidator(this.#shapes);
    const report = await validator.validate(mergeDatasets(this.#ontology, data));
    const results = report.results.map((result) => ({
      focusNode: result.focusNode.value,
      path: termValue(result.path),
      value: termValue(result.value),
      severity: result.severity.value,
      sourceConstraintComponent: result.sourceConstraintComponent.value,
      sourceShape: result.sourceShape.value,
      messages: result.message.map((message) => message.value),
    }));

    return { conforms: report.conforms, resultCount: results.length, results };
  }

  async validateTurtle(
    turtle: string,
    maximumBytes = 1_000_000,
    maximumQuads = 10_000,
  ): Promise<ShaclReport> {
    return this.validateDataset(await parseTurtle(turtle, maximumBytes, maximumQuads));
  }
}
