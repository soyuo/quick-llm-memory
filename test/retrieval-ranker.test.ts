import { describe, expect, it } from 'vitest';
import type { SearchResult } from '../src/retrieval/search.js';
import { reciprocalRankFusionRanker, RRF_K, type RankedSearchSource } from '../src/retrieval/ranker.js';

describe('reciprocal rank fusion', () => {
  it('combines source ranks, merges provenance, and sorts ties deterministically', () => {
    const sources: RankedSearchSource[] = [
      {
        mode: 'fulltext',
        results: [result('a', 'alpha.md', ['source-1'], ['section-1']), result('b', 'beta.md')],
      },
      {
        mode: 'hierarchical',
        results: [result('b', 'beta.md'), result('a', 'alpha.md', ['source-2'], ['section-2'])],
      },
    ];

    const ranked = reciprocalRankFusionRanker.rank(sources, 10);

    expect(reciprocalRankFusionRanker.rank(sources, 10)).toEqual(ranked);
    expect(ranked.map(({ documentId }) => documentId)).toEqual(['a', 'b']);
    expect(ranked[0]).toMatchObject({
      score: 1 / (RRF_K + 1) + 1 / (RRF_K + 2),
      sourceIds: ['source-1', 'source-2'],
      matchedSections: ['section-1', 'section-2'],
    });
    expect(ranked[1]?.score).toBe(1 / (RRF_K + 2) + 1 / (RRF_K + 1));
  });

  it('applies the result limit after scoring candidates and validates the limit', () => {
    const sources: RankedSearchSource[] = [{
      mode: 'fulltext',
      results: [result('b', 'beta.md'), result('a', 'alpha.md'), result('c', 'gamma.md')],
    }];

    expect(reciprocalRankFusionRanker.rank(sources, 2).map(({ documentId }) => documentId))
      .toEqual(['b', 'a']);
    expect(() => reciprocalRankFusionRanker.rank(sources, 101)).toThrow(/between 0 and 100/);
  });
});

function result(
  documentId: string,
  path: string,
  sourceIds: string[] = [],
  matchedSections: string[] = [],
): SearchResult {
  return {
    documentId,
    path,
    title: documentId,
    snippet: documentId,
    score: 0,
    sourceIds,
    matchedSections,
    tokenCount: 1,
  };
}
