import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DatasetCore, Quad } from '@rdfjs/types';
import { loadManifest } from './manifest.js';
import type { ActionDefinition, PolicyBundle } from './policy.js';
import { loadOntology, loadShapes, mergeDatasets } from './rdf.js';

export type CortexGraphNodeKind =
  | 'action'
  | 'capability'
  | 'class'
  | 'classification'
  | 'concept'
  | 'datatype-property'
  | 'effect'
  | 'external'
  | 'object-property'
  | 'obligation'
  | 'ontology'
  | 'permission'
  | 'policy-bundle'
  | 'policy-rule'
  | 'precondition'
  | 'role'
  | 'shape';

export interface CortexGraphNode {
  id: string;
  label: string;
  kind: CortexGraphNodeKind;
  module: string;
  description: string | null;
  degree: number;
}

export interface CortexGraphEdge {
  id: string;
  source: string;
  target: string;
  label: string;
  predicate: string;
  kind: 'rdf' | 'policy';
}

export interface CortexGraphSnapshot {
  version: string;
  nodes: CortexGraphNode[];
  edges: CortexGraphEdge[];
  stats: {
    node_count: number;
    edge_count: number;
    module_count: number;
    modules: string[];
    by_kind: Record<string, number>;
  };
}

interface ActionRegistryDocument {
  version: string;
  actions: ActionDefinition[];
}

interface MutableEdge extends Omit<CortexGraphEdge, 'id'> {}

const ONTOLOGY_PREFIX = 'https://github.com/diogocaspary/cortex-universal/ontology/';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
const RDFS_COMMENT = 'http://www.w3.org/2000/01/rdf-schema#comment';
const SKOS_DEFINITION = 'http://www.w3.org/2004/02/skos/core#definition';
const SKOS_PREF_LABEL = 'http://www.w3.org/2004/02/skos/core#prefLabel';
const DCTERMS_TITLE = 'http://purl.org/dc/terms/title';
const DCTERMS_DESCRIPTION = 'http://purl.org/dc/terms/description';
const OWL_CLASS = 'http://www.w3.org/2002/07/owl#Class';
const OWL_OBJECT_PROPERTY = 'http://www.w3.org/2002/07/owl#ObjectProperty';
const OWL_DATATYPE_PROPERTY = 'http://www.w3.org/2002/07/owl#DatatypeProperty';
const OWL_ONTOLOGY = 'http://www.w3.org/2002/07/owl#Ontology';
const SH_NODE_SHAPE = 'http://www.w3.org/ns/shacl#NodeShape';

function localName(value: string): string {
  const separator = Math.max(
    value.lastIndexOf('#'),
    value.lastIndexOf('/'),
    value.lastIndexOf(':'),
  );
  const local = separator >= 0 ? value.slice(separator + 1) : value;
  try {
    return decodeURIComponent(local) || value;
  } catch {
    return local || value;
  }
}

function moduleName(id: string): string {
  if (!id.startsWith(ONTOLOGY_PREFIX))
    return id.startsWith('urn:cortex:') ? 'policy-runtime' : 'external';
  const local = id.slice(ONTOLOGY_PREFIX.length).split(/[\/#]/u)[0];
  return local || 'core';
}

function nodeKind(id: string, types: Set<string> | undefined): CortexGraphNodeKind {
  if (types?.has(OWL_CLASS)) return 'class';
  if (types?.has(OWL_OBJECT_PROPERTY)) return 'object-property';
  if (types?.has(OWL_DATATYPE_PROPERTY)) return 'datatype-property';
  if (types?.has(OWL_ONTOLOGY)) return 'ontology';
  if (types?.has(SH_NODE_SHAPE)) return 'shape';
  if (id.startsWith(ONTOLOGY_PREFIX)) return 'concept';
  return 'external';
}

function chooseLiteral(quads: Quad[], predicates: Set<string>): Map<string, string> {
  const values = new Map<string, string>();
  for (const quad of quads) {
    if (
      quad.subject.termType !== 'NamedNode' ||
      quad.object.termType !== 'Literal' ||
      !predicates.has(quad.predicate.value)
    ) {
      continue;
    }
    const current = values.get(quad.subject.value);
    if (!current || quad.object.language === 'en' || quad.object.language === '') {
      values.set(quad.subject.value, quad.object.value);
    }
  }
  return values;
}

function rdfProjection(dataset: DatasetCore): {
  nodes: Map<string, CortexGraphNode>;
  edges: MutableEdge[];
} {
  const quads = [...dataset];
  const labels = chooseLiteral(quads, new Set([RDFS_LABEL, SKOS_PREF_LABEL, DCTERMS_TITLE]));
  const descriptions = chooseLiteral(
    quads,
    new Set([RDFS_COMMENT, SKOS_DEFINITION, DCTERMS_DESCRIPTION]),
  );
  const types = new Map<string, Set<string>>();
  for (const quad of quads) {
    if (
      quad.subject.termType === 'NamedNode' &&
      quad.predicate.value === RDF_TYPE &&
      quad.object.termType === 'NamedNode'
    ) {
      const subjectTypes = types.get(quad.subject.value) ?? new Set<string>();
      subjectTypes.add(quad.object.value);
      types.set(quad.subject.value, subjectTypes);
    }
  }

  const ids = new Set<string>();
  const edges: MutableEdge[] = [];
  for (const quad of quads) {
    if (quad.subject.termType !== 'NamedNode') continue;
    ids.add(quad.subject.value);
    if (quad.object.termType !== 'NamedNode') continue;
    ids.add(quad.object.value);
    edges.push({
      source: quad.subject.value,
      target: quad.object.value,
      label: localName(quad.predicate.value),
      predicate: quad.predicate.value,
      kind: 'rdf',
    });
  }

  const nodes = new Map<string, CortexGraphNode>();
  for (const id of [...ids].sort()) {
    nodes.set(id, {
      id,
      label: labels.get(id) ?? localName(id),
      kind: nodeKind(id, types.get(id)),
      module: moduleName(id),
      description: descriptions.get(id) ?? null,
      degree: 0,
    });
  }
  return { nodes, edges };
}

function virtualId(kind: string, value: string): string {
  return `urn:cortex:${kind}:${encodeURIComponent(value)}`;
}

function addVirtualNode(
  nodes: Map<string, CortexGraphNode>,
  kind: CortexGraphNodeKind,
  value: string,
  description: string | null = null,
): string {
  const id = virtualId(kind, value);
  if (!nodes.has(id)) {
    nodes.set(id, { id, label: value, kind, module: 'policy-runtime', description, degree: 0 });
  }
  return id;
}

function addPolicyEdge(edges: MutableEdge[], source: string, target: string, label: string): void {
  edges.push({
    source,
    target,
    label,
    predicate: virtualId('relation', label),
    kind: 'policy',
  });
}

function policyProjection(
  registry: ActionRegistryDocument,
  bundle: PolicyBundle,
  nodes: Map<string, CortexGraphNode>,
  edges: MutableEdge[],
): void {
  const bundleId = addVirtualNode(
    nodes,
    'policy-bundle',
    `policy-${bundle.version}`,
    'Trusted default-deny policy bundle.',
  );
  const actionIds = new Map<string, string>();
  for (const action of registry.actions) {
    const actionId = addVirtualNode(
      nodes,
      'action',
      action.action_key,
      `Risk ${action.risk_level}; approval ${action.approval_policy}; verification ${action.verification_action}.`,
    );
    actionIds.set(action.action_key, actionId);
    const capabilityId = addVirtualNode(nodes, 'capability', action.capability);
    addPolicyEdge(edges, actionId, capabilityId, 'provides capability');
    for (const permission of action.required_permissions) {
      addPolicyEdge(
        edges,
        actionId,
        addVirtualNode(nodes, 'permission', permission),
        'requires permission',
      );
    }
    for (const precondition of action.preconditions) {
      addPolicyEdge(
        edges,
        actionId,
        addVirtualNode(nodes, 'precondition', precondition),
        'requires precondition',
      );
    }
    for (const effect of action.expected_effects) {
      addPolicyEdge(edges, actionId, addVirtualNode(nodes, 'effect', effect), 'declares effect');
    }
  }

  for (const rule of bundle.rules) {
    const ruleId = addVirtualNode(nodes, 'policy-rule', rule.id, `${rule.effect} rule.`);
    addPolicyEdge(edges, bundleId, ruleId, 'contains rule');
    for (const actionKey of rule.actions) {
      const actionId = actionIds.get(actionKey);
      if (actionId) addPolicyEdge(edges, ruleId, actionId, rule.effect);
    }
    for (const role of rule.roles) {
      addPolicyEdge(edges, ruleId, addVirtualNode(nodes, 'role', role), 'applies to role');
    }
    for (const classification of rule.classifications) {
      addPolicyEdge(
        edges,
        ruleId,
        addVirtualNode(nodes, 'classification', classification),
        'allows classification',
      );
    }
    for (const obligation of rule.obligations) {
      addPolicyEdge(
        edges,
        ruleId,
        addVirtualNode(nodes, 'obligation', obligation),
        'imposes obligation',
      );
    }
  }
}

export async function createCortexGraphSnapshot(root: string): Promise<CortexGraphSnapshot> {
  const [manifest, ontology, shapes, registryText, bundleText] = await Promise.all([
    loadManifest(root),
    loadOntology(root),
    loadShapes(root),
    readFile(join(root, 'policies', 'action-registry.json'), 'utf8'),
    readFile(join(root, 'policies', 'default-policy.json'), 'utf8'),
  ]);
  const registry = JSON.parse(registryText) as ActionRegistryDocument;
  const bundle = JSON.parse(bundleText) as PolicyBundle;
  const { nodes, edges } = rdfProjection(mergeDatasets(ontology, shapes));
  policyProjection(registry, bundle, nodes, edges);

  const uniqueEdges = new Map<string, MutableEdge>();
  for (const edge of edges) {
    uniqueEdges.set(`${edge.source}\0${edge.predicate}\0${edge.target}`, edge);
  }
  const sortedEdges = [...uniqueEdges.values()].sort((left, right) =>
    `${left.source}\0${left.predicate}\0${left.target}`.localeCompare(
      `${right.source}\0${right.predicate}\0${right.target}`,
    ),
  );
  for (const edge of sortedEdges) {
    const source = nodes.get(edge.source);
    const target = nodes.get(edge.target);
    if (source) source.degree += 1;
    if (target) target.degree += 1;
  }

  const finalNodes = [...nodes.values()].sort((left, right) => left.id.localeCompare(right.id));
  const finalEdges = sortedEdges.map((edge, index) => ({ id: `edge-${index + 1}`, ...edge }));
  const modules = [...new Set(finalNodes.map((node) => node.module))].sort();
  const byKind = Object.fromEntries(
    [...new Set(finalNodes.map((node) => node.kind))]
      .sort()
      .map((kind) => [kind, finalNodes.filter((node) => node.kind === kind).length]),
  );

  return {
    version: manifest.version,
    nodes: finalNodes,
    edges: finalEdges,
    stats: {
      node_count: finalNodes.length,
      edge_count: finalEdges.length,
      module_count: modules.length,
      modules,
      by_kind: byKind,
    },
  };
}
