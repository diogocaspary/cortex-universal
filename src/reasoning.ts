import type { DatasetCore, Quad } from '@rdfjs/types';
import { loadOntology } from './rdf.js';

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const RDFS_SUBCLASS = 'http://www.w3.org/2000/01/rdf-schema#subClassOf';
const RDFS_SUBPROPERTY = 'http://www.w3.org/2000/01/rdf-schema#subPropertyOf';
const RDFS_DOMAIN = 'http://www.w3.org/2000/01/rdf-schema#domain';
const RDFS_RANGE = 'http://www.w3.org/2000/01/rdf-schema#range';
const OWL_EQUIVALENT_CLASS = 'http://www.w3.org/2002/07/owl#equivalentClass';
const OWL_EQUIVALENT_PROPERTY = 'http://www.w3.org/2002/07/owl#equivalentProperty';
const OWL_INVERSE_OF = 'http://www.w3.org/2002/07/owl#inverseOf';
const OWL_DISJOINT_WITH = 'http://www.w3.org/2002/07/owl#disjointWith';
const OWL_TRANSITIVE_PROPERTY = 'http://www.w3.org/2002/07/owl#TransitiveProperty';
const OWL_FUNCTIONAL_PROPERTY = 'http://www.w3.org/2002/07/owl#FunctionalProperty';
const OWL_NOTHING = 'http://www.w3.org/2002/07/owl#Nothing';
const OWL_SAME_AS = 'http://www.w3.org/2002/07/owl#sameAs';

interface Triple {
  subject: string;
  predicate: string;
  object: string;
}

export interface Inference extends Triple {
  rule: string;
  support: string[];
}

export interface ReasoningDiagnostic {
  severity: 'warning' | 'violation';
  code: 'disjoint_type_conflict' | 'owl_nothing_instance' | 'functional_value_ambiguity';
  subject: string;
  predicate: string;
  values: string[];
  message: string;
}

export interface ReasoningReport {
  profile: 'cortex-rdfs-owl-rl-subset-v1';
  complete_owl_reasoner: false;
  generated_at: string;
  explicit_triples: number;
  inferred_triples: number;
  iterations: number;
  truncated: boolean;
  consistent: boolean;
  inferences: Inference[];
  diagnostics: ReasoningDiagnostic[];
}

function key(triple: Triple): string {
  return `${triple.subject}\u0000${triple.predicate}\u0000${triple.object}`;
}

function display(triple: Triple): string {
  return `${triple.subject} ${triple.predicate} ${triple.object}`;
}

function namedTriples(dataset: DatasetCore): Triple[] {
  return [...dataset].flatMap((quad: Quad) =>
    quad.subject.termType === 'NamedNode' && quad.object.termType === 'NamedNode'
      ? [
          {
            subject: quad.subject.value,
            predicate: quad.predicate.value,
            object: quad.object.value,
          },
        ]
      : [],
  );
}

function objects(index: Map<string, Set<string>>, left: string, predicate: string): Set<string> {
  return index.get(`${left}\u0000${predicate}`) ?? new Set<string>();
}

function indexTriples(triples: Iterable<Triple>): {
  bySubjectPredicate: Map<string, Set<string>>;
  byPredicate: Map<string, Triple[]>;
} {
  const bySubjectPredicate = new Map<string, Set<string>>();
  const byPredicate = new Map<string, Triple[]>();
  for (const triple of triples) {
    const indexKey = `${triple.subject}\u0000${triple.predicate}`;
    const values = bySubjectPredicate.get(indexKey) ?? new Set<string>();
    values.add(triple.object);
    bySubjectPredicate.set(indexKey, values);
    const rows = byPredicate.get(triple.predicate) ?? [];
    rows.push(triple);
    byPredicate.set(triple.predicate, rows);
  }
  return { bySubjectPredicate, byPredicate };
}

/**
 * Deterministic, bounded and explainable RDFS/OWL-RL subset. It never silently mutates trusted
 * ontology files and deliberately reports that it is not a complete OWL 2 DL reasoner.
 */
export function reasonDataset(
  dataset: DatasetCore,
  options: { maximumInferences?: number; maximumIterations?: number } = {},
): ReasoningReport {
  const maximumInferences = options.maximumInferences ?? 20_000;
  const maximumIterations = options.maximumIterations ?? 24;
  if (
    !Number.isInteger(maximumInferences) ||
    maximumInferences < 1 ||
    maximumInferences > 100_000
  ) {
    throw new Error('maximumInferences must be an integer from 1 to 100000.');
  }
  if (!Number.isInteger(maximumIterations) || maximumIterations < 1 || maximumIterations > 100) {
    throw new Error('maximumIterations must be an integer from 1 to 100.');
  }
  const explicit = namedTriples(dataset);
  const known = new Map(explicit.map((triple) => [key(triple), triple]));
  const inferred = new Map<string, Inference>();
  let iterations = 0;
  let truncated = false;

  const add = (triple: Triple, rule: string, support: Triple[]): boolean => {
    const tripleKey = key(triple);
    if (known.has(tripleKey)) return false;
    if (inferred.size >= maximumInferences) {
      truncated = true;
      return false;
    }
    known.set(tripleKey, triple);
    inferred.set(tripleKey, {
      ...triple,
      rule,
      support: support.map(display).sort(),
    });
    return true;
  };

  let changed = true;
  while (changed && iterations < maximumIterations && !truncated) {
    changed = false;
    iterations += 1;
    const all = [...known.values()];
    const { bySubjectPredicate, byPredicate } = indexTriples(all);

    for (const equivalent of byPredicate.get(OWL_EQUIVALENT_CLASS) ?? []) {
      changed =
        add(
          { subject: equivalent.subject, predicate: RDFS_SUBCLASS, object: equivalent.object },
          'owl-equivalent-class-left',
          [equivalent],
        ) || changed;
      changed =
        add(
          { subject: equivalent.object, predicate: RDFS_SUBCLASS, object: equivalent.subject },
          'owl-equivalent-class-right',
          [equivalent],
        ) || changed;
    }
    for (const equivalent of byPredicate.get(OWL_EQUIVALENT_PROPERTY) ?? []) {
      changed =
        add(
          { subject: equivalent.subject, predicate: RDFS_SUBPROPERTY, object: equivalent.object },
          'owl-equivalent-property-left',
          [equivalent],
        ) || changed;
      changed =
        add(
          { subject: equivalent.object, predicate: RDFS_SUBPROPERTY, object: equivalent.subject },
          'owl-equivalent-property-right',
          [equivalent],
        ) || changed;
    }

    for (const relation of byPredicate.get(RDFS_SUBCLASS) ?? []) {
      for (const parent of objects(bySubjectPredicate, relation.object, RDFS_SUBCLASS)) {
        changed =
          add(
            { subject: relation.subject, predicate: RDFS_SUBCLASS, object: parent },
            'rdfs-subclass-transitive',
            [relation, { subject: relation.object, predicate: RDFS_SUBCLASS, object: parent }],
          ) || changed;
      }
    }
    for (const relation of byPredicate.get(RDFS_SUBPROPERTY) ?? []) {
      for (const parent of objects(bySubjectPredicate, relation.object, RDFS_SUBPROPERTY)) {
        changed =
          add(
            { subject: relation.subject, predicate: RDFS_SUBPROPERTY, object: parent },
            'rdfs-subproperty-transitive',
            [relation, { subject: relation.object, predicate: RDFS_SUBPROPERTY, object: parent }],
          ) || changed;
      }
    }
    for (const typed of byPredicate.get(RDF_TYPE) ?? []) {
      for (const parent of objects(bySubjectPredicate, typed.object, RDFS_SUBCLASS)) {
        changed =
          add(
            { subject: typed.subject, predicate: RDF_TYPE, object: parent },
            'rdfs-type-inheritance',
            [typed, { subject: typed.object, predicate: RDFS_SUBCLASS, object: parent }],
          ) || changed;
      }
    }
    for (const triple of all) {
      for (const domain of objects(bySubjectPredicate, triple.predicate, RDFS_DOMAIN)) {
        changed =
          add({ subject: triple.subject, predicate: RDF_TYPE, object: domain }, 'rdfs-domain', [
            triple,
            { subject: triple.predicate, predicate: RDFS_DOMAIN, object: domain },
          ]) || changed;
      }
      for (const range of objects(bySubjectPredicate, triple.predicate, RDFS_RANGE)) {
        changed =
          add({ subject: triple.object, predicate: RDF_TYPE, object: range }, 'rdfs-range', [
            triple,
            { subject: triple.predicate, predicate: RDFS_RANGE, object: range },
          ]) || changed;
      }
      for (const parent of objects(bySubjectPredicate, triple.predicate, RDFS_SUBPROPERTY)) {
        changed =
          add(
            { subject: triple.subject, predicate: parent, object: triple.object },
            'rdfs-subproperty-use',
            [triple, { subject: triple.predicate, predicate: RDFS_SUBPROPERTY, object: parent }],
          ) || changed;
      }
      for (const inverse of objects(bySubjectPredicate, triple.predicate, OWL_INVERSE_OF)) {
        changed =
          add(
            { subject: triple.object, predicate: inverse, object: triple.subject },
            'owl-inverse-property',
            [triple, { subject: triple.predicate, predicate: OWL_INVERSE_OF, object: inverse }],
          ) || changed;
      }
    }
    const transitive = new Set(
      (byPredicate.get(RDF_TYPE) ?? [])
        .filter((triple) => triple.object === OWL_TRANSITIVE_PROPERTY)
        .map((triple) => triple.subject),
    );
    for (const predicate of transitive) {
      for (const left of byPredicate.get(predicate) ?? []) {
        for (const target of objects(bySubjectPredicate, left.object, predicate)) {
          changed =
            add({ subject: left.subject, predicate, object: target }, 'owl-transitive-property', [
              left,
              { subject: left.object, predicate, object: target },
            ]) || changed;
        }
      }
    }
  }
  if (changed && iterations >= maximumIterations) truncated = true;

  const all = [...known.values()];
  const { bySubjectPredicate, byPredicate } = indexTriples(all);
  const diagnostics: ReasoningDiagnostic[] = [];
  const disjointPairs = (byPredicate.get(OWL_DISJOINT_WITH) ?? []).flatMap((triple) => [
    [triple.subject, triple.object] as const,
    [triple.object, triple.subject] as const,
  ]);
  for (const typed of byPredicate.get(RDF_TYPE) ?? []) {
    if (typed.object === OWL_NOTHING) {
      diagnostics.push({
        severity: 'violation',
        code: 'owl_nothing_instance',
        subject: typed.subject,
        predicate: RDF_TYPE,
        values: [OWL_NOTHING],
        message: 'An entity is inferred to be an instance of owl:Nothing.',
      });
    }
    const types = objects(bySubjectPredicate, typed.subject, RDF_TYPE);
    for (const [left, right] of disjointPairs) {
      if (types.has(left) && types.has(right) && left < right) {
        diagnostics.push({
          severity: 'violation',
          code: 'disjoint_type_conflict',
          subject: typed.subject,
          predicate: RDF_TYPE,
          values: [left, right],
          message: 'An entity belongs to two explicitly disjoint classes.',
        });
      }
    }
  }
  const functional = new Set(
    (byPredicate.get(RDF_TYPE) ?? [])
      .filter((triple) => triple.object === OWL_FUNCTIONAL_PROPERTY)
      .map((triple) => triple.subject),
  );
  for (const predicate of functional) {
    const subjects = new Set((byPredicate.get(predicate) ?? []).map((triple) => triple.subject));
    for (const subject of subjects) {
      const values = [...objects(bySubjectPredicate, subject, predicate)].sort();
      if (values.length <= 1) continue;
      const allSame = values.every((left) =>
        values.every(
          (right) =>
            left === right ||
            objects(bySubjectPredicate, left, OWL_SAME_AS).has(right) ||
            objects(bySubjectPredicate, right, OWL_SAME_AS).has(left),
        ),
      );
      if (!allSame) {
        diagnostics.push({
          severity: 'warning',
          code: 'functional_value_ambiguity',
          subject,
          predicate,
          values,
          message:
            'OWL functional semantics may imply equality; use SHACL maxCount for closed-world rejection.',
        });
      }
    }
  }
  const uniqueDiagnostics = new Map(
    diagnostics.map((diagnostic) => [
      `${diagnostic.code}\u0000${diagnostic.subject}\u0000${diagnostic.predicate}\u0000${diagnostic.values.join('\u0000')}`,
      diagnostic,
    ]),
  );
  const finalDiagnostics = [...uniqueDiagnostics.values()].sort((left, right) =>
    `${left.code}\u0000${left.subject}`.localeCompare(`${right.code}\u0000${right.subject}`),
  );
  return {
    profile: 'cortex-rdfs-owl-rl-subset-v1',
    complete_owl_reasoner: false,
    generated_at: new Date().toISOString(),
    explicit_triples: explicit.length,
    inferred_triples: inferred.size,
    iterations,
    truncated,
    consistent: !finalDiagnostics.some((diagnostic) => diagnostic.severity === 'violation'),
    inferences: [...inferred.values()].sort((left, right) => key(left).localeCompare(key(right))),
    diagnostics: finalDiagnostics,
  };
}

export async function reasonOntology(root: string): Promise<ReasoningReport> {
  return reasonDataset(await loadOntology(root));
}
