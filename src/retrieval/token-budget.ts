import { InputError } from '../errors/qlm-error.js';
import type { RetrievalSearchResult } from './search.js';

export interface TokenBudgetSelection {
  results: RetrievalSearchResult[];
  maxTokens: number;
  consumedTokens: number;
  tokenCountsAreEstimates: true;
  /** Estimated serialized context cost for each returned result, in the same order. */
  resultTokenCounts: number[];
}

/** Uses the repository's documented four-characters-per-token estimate. */
export function estimateRetrievalResultTokens(result: RetrievalSearchResult): number {
  return estimateSerializedContext([result]);
}

/** Keeps complete ranked results that fit, continuing after any oversized result. */
export function selectRetrievalResultsWithinTokenBudget(
  candidates: readonly RetrievalSearchResult[],
  maxTokens: number,
): TokenBudgetSelection {
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 0) {
    throw new InputError('maxTokens must be a non-negative safe integer.', {
      suggestedAction: 'Provide a whole-number token budget of 0 or more.',
    });
  }

  const results: RetrievalSearchResult[] = [];
  const resultTokenCounts: number[] = [];
  let consumedTokens = 0;
  for (const candidate of candidates) {
    const nextResults = [...results, candidate];
    const nextConsumedTokens = estimateSerializedContext(nextResults);
    if (nextConsumedTokens > maxTokens) continue;
    results.push(candidate);
    resultTokenCounts.push(nextConsumedTokens - consumedTokens);
    consumedTokens = nextConsumedTokens;
  }

  return {
    results,
    maxTokens,
    consumedTokens,
    tokenCountsAreEstimates: true,
    resultTokenCounts,
  };
}

function estimateSerializedContext(results: readonly RetrievalSearchResult[]): number {
  if (results.length === 0) return 0;
  return Math.ceil(JSON.stringify(results).length / 4);
}
