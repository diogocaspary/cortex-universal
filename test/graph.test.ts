import { describe, expect, it } from 'vitest';
import { createCortexGraphSnapshot } from '../src/graph.js';
import { repositoryRoot } from '../src/paths.js';
import { SchemaRegistry } from '../src/schema.js';

const root = repositoryRoot();

describe('Cortex visualization graph', () => {
  it('is deterministic, connected by valid endpoints, and contract-valid', async () => {
    const [first, second, schemas] = await Promise.all([
      createCortexGraphSnapshot(root),
      createCortexGraphSnapshot(root),
      SchemaRegistry.create(root),
    ]);
    expect(first).toEqual(second);
    expect(schemas.validate('graph-snapshot', first).valid).toBe(true);

    const nodeIds = new Set(first.nodes.map((node) => node.id));
    expect(first.edges.every((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target))).toBe(
      true,
    );
    expect(new Set(first.nodes.map((node) => node.id)).size).toBe(first.nodes.length);
    expect(new Set(first.edges.map((edge) => edge.id)).size).toBe(first.edges.length);
    expect(first.stats.node_count).toBe(first.nodes.length);
    expect(first.stats.edge_count).toBe(first.edges.length);
    expect(first.stats.module_count).toBe(first.stats.modules.length);
    expect(first.nodes.some((node) => node.id.includes('/example'))).toBe(false);
    expect(first.nodes.some((node) => /\bexample\b/iu.test(node.label))).toBe(false);
  });

  it('projects the cognitive modules and governed policy runtime', async () => {
    const snapshot = await createCortexGraphSnapshot(root);
    expect(snapshot.stats.modules).toEqual(
      expect.arrayContaining([
        'attention',
        'cognition',
        'learning',
        'memory',
        'metacognition',
        'policy-runtime',
        'retrieval',
        'world-model',
      ]),
    );
    expect(snapshot.nodes.some((node) => node.kind === 'action')).toBe(true);
    expect(snapshot.nodes.some((node) => node.kind === 'policy-rule')).toBe(true);
    expect(snapshot.edges.some((edge) => edge.kind === 'policy')).toBe(true);
  });
});
