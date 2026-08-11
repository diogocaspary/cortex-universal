import { describe, expect, it } from 'vitest';
import {
  detectKnowledgeGaps,
  queryTokens,
  reciprocalRankFusion,
  vectorMaximumDistance,
} from '../src/retrieval.js';

describe('hybrid retrieval primitives', () => {
  it('keeps only discriminative query terms, and never returns an empty query', () => {
    expect(queryTokens('Qual é a situação do cliente 42 hoje?')).toEqual([
      'situação',
      'cliente',
      '42',
      'hoje',
    ]);
    expect(queryTokens('Where is the refund from that customer?')).toEqual(['refund', 'customer']);
    // Every adapter must tokenize identically, so a query cannot mean two things.
    expect(queryTokens('CLIENTE  cliente')).toEqual(['cliente']);
    // A query made only of function words falls back to its raw tokens instead of vanishing.
    expect(queryTokens('o que é isso')).toEqual(['que', 'isso']);
    expect(queryTokens('   ')).toEqual([]);
  });

  it('bounds vector neighbours so an unrelated question becomes an explicit gap', () => {
    // O padrão veio de medição: documento correto entre 0,25 e 0,37 de distância, documento
    // errado a partir de 0,59, pergunta alheia a partir de 0,70.
    expect(vectorMaximumDistance()).toBe(0.55);
    expect(vectorMaximumDistance('0.4')).toBe(0.4);
    expect(() => vectorMaximumDistance('0')).toThrow('CORTEX_VECTOR_MAX_DISTANCE');
    expect(() => vectorMaximumDistance('nao-numero')).toThrow('CORTEX_VECTOR_MAX_DISTANCE');
  });

  it('fuses ranked channels with deterministic scores and duplicate suppression', () => {
    const channels = [
      { name: 'keyword', weight: 1, items: [{ id: 'b' }, { id: 'a' }, { id: 'a' }] },
      { name: 'graph', weight: 2, items: [{ id: 'a' }, { id: 'c' }] },
    ];
    const first = reciprocalRankFusion(channels, { rankConstant: 10, limit: 3 });
    const second = reciprocalRankFusion(channels, { rankConstant: 10, limit: 3 });

    expect(first).toEqual(second);
    expect(first.map((result) => result.id)).toEqual(['a', 'c', 'b']);
    expect(first.find((result) => result.id === 'a')?.contributions).toHaveLength(2);
  });

  it('rejects invalid fusion configuration', () => {
    expect(() => reciprocalRankFusion([], { rankConstant: 0 })).toThrow('rankConstant');
    expect(() =>
      reciprocalRankFusion([
        { name: 'graph', weight: 1, items: [] },
        { name: 'graph', weight: 1, items: [] },
      ]),
    ).toThrow('unique');
  });

  it('reports missing, uncited, stale, and contradictory evidence explicitly', () => {
    expect(detectKnowledgeGaps([], '2026-08-09T12:00:00Z')[0]?.code).toBe('no_results');
    const gaps = detectKnowledgeGaps(
      [
        {
          id: 'claim-a',
          citations: [],
          valid_until: '2026-08-08T12:00:00Z',
          contradicts: ['claim-b'],
        },
        {
          id: 'claim-b',
          citations: ['urn:source:b'],
          valid_until: null,
          contradicts: [],
        },
      ],
      '2026-08-09T12:00:00Z',
    );
    expect(gaps.map((gap) => gap.code)).toEqual([
      'uncited_result',
      'stale_result',
      'contradictory_results',
    ]);
  });

  it('rejects an invalid evidence validity window', () => {
    expect(() =>
      detectKnowledgeGaps(
        [{ id: 'claim-a', citations: [], valid_until: 'not-a-date', contradicts: [] }],
        '2026-08-09T12:00:00Z',
      ),
    ).toThrow('valid_until');
  });
});
