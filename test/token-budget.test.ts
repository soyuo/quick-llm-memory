import { describe, expect, it } from 'vitest';
import { InputError } from '../src/errors/qlm-error.js';
import {
  estimateRetrievalResultTokens,
  selectRetrievalResultsWithinTokenBudget,
} from '../src/retrieval/token-budget.js';
import type { RetrievalSearchResult } from '../src/retrieval/search.js';

describe('retrieval token budget', () => {
  it('accounts for result metadata and source attribution in complete context units', () => {
    const minimal = createResult('one', 'a.md', 'Title', 'Body');
    const withProvenance = {
      ...minimal,
      sourceIds: ['source-one', 'source-two'],
      matchedSections: ['section-a', 'section-b'],
      relatedFrom: ['primary-one'],
    };

    expect(estimateRetrievalResultTokens(withProvenance))
      .toBeGreaterThan(estimateRetrievalResultTokens(minimal));
  });

  it('selects in ranked order, skips an oversized candidate, and reports estimates', () => {
    const candidates = [
      createResult('large', 'large.md', 'Large', 'x'.repeat(400)),
      createResult('small-a', 'a.md', 'A', 'short'),
      createResult('small-b', 'b.md', 'B', 'short'),
    ];
    const perSmall = estimateRetrievalResultTokens(candidates[1]!);
    const selection = selectRetrievalResultsWithinTokenBudget(candidates, perSmall * 2);

    expect(selection.results.map(({ documentId }) => documentId)).toEqual(['small-a', 'small-b']);
    expect(selection.resultTokenCounts).toEqual([perSmall, perSmall]);
    expect(selection.consumedTokens).toBe(perSmall * 2);
    expect(selection.resultTokenCounts.reduce((sum, count) => sum + count, 0))
      .toBe(selection.consumedTokens);
    expect(selection.consumedTokens).toBeLessThanOrEqual(selection.maxTokens);
    expect(selection.tokenCountsAreEstimates).toBe(true);
    expect(candidates[0]!.snippet).toBe('x'.repeat(400));
  });

  it('returns an empty selection for a zero budget', () => {
    const selection = selectRetrievalResultsWithinTokenBudget(
      [createResult('one', 'one.md', 'One', 'Body')],
      0,
    );
    expect(selection.results).toEqual([]);
    expect(selection.resultTokenCounts).toEqual([]);
    expect(selection.consumedTokens).toBe(0);
  });

  it('accepts an exact fit and rejects a budget one token below it', () => {
    const candidate = createResult('one', 'one.md', 'One', 'Body');
    const exactCost = estimateRetrievalResultTokens(candidate);

    expect(selectRetrievalResultsWithinTokenBudget([candidate], exactCost).results)
      .toEqual([candidate]);
    expect(selectRetrievalResultsWithinTokenBudget([candidate], exactCost - 1).results)
      .toEqual([]);
  });

  it.each([-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid budget %s',
    (maxTokens) => {
      expect(() => selectRetrievalResultsWithinTokenBudget([], maxTokens)).toThrow(InputError);
    },
  );
});

function createResult(
  documentId: string,
  path: string,
  title: string,
  snippet: string,
): RetrievalSearchResult {
  return {
    documentId,
    path,
    title,
    snippet,
    score: 1,
    sourceIds: ['source-one'],
    matchedSections: ['section-one'],
    tokenCount: Math.max(1, Math.ceil(snippet.length / 4)),
  };
}
