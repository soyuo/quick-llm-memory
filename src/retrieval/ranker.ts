import { InputError } from '../errors/qlm-error.js';
import type { RetrievalMode, SearchResult } from './search.js';

export type RankedSearchMode = Exclude<RetrievalMode, 'hybrid'>;

export interface RankedSearchSource {
  mode: RankedSearchMode;
  results: readonly SearchResult[];
}

export interface RetrievalRanker {
  rank(sources: readonly RankedSearchSource[], maxResults: number): SearchResult[];
}

export const RRF_K = 60;
const MAX_RESULTS = 100;

export const reciprocalRankFusionRanker: RetrievalRanker = {
  rank(sources, maxResults) {
    if (!Number.isSafeInteger(maxResults) || maxResults < 0 || maxResults > MAX_RESULTS) {
      throw new InputError(`maxResults must be between 0 and ${MAX_RESULTS}.`);
    }

    const candidates = new Map<string, RankedCandidate>();
    for (const source of sources) {
      const seen = new Set<string>();
      for (const result of source.results) {
        const existing = candidates.get(result.documentId);
        if (seen.has(result.documentId)) {
          if (existing !== undefined) {
            for (const sourceId of result.sourceIds) existing.sourceIds.add(sourceId);
            for (const section of result.matchedSections) existing.matchedSections.add(section);
          }
          continue;
        }
        seen.add(result.documentId);
        const contribution = 1 / (RRF_K + seen.size);
        if (existing === undefined) {
          candidates.set(result.documentId, {
            result: { ...result },
            score: contribution,
            sourceIds: new Set(result.sourceIds),
            matchedSections: new Set(result.matchedSections),
          });
        } else {
          existing.score += contribution;
          for (const sourceId of result.sourceIds) existing.sourceIds.add(sourceId);
          for (const section of result.matchedSections) existing.matchedSections.add(section);
        }
      }
    }

    return [...candidates.values()]
      .map(({ result, score, sourceIds, matchedSections }) => ({
        ...result,
        score,
        sourceIds: [...sourceIds],
        matchedSections: [...matchedSections],
      }))
      .sort((left, right) =>
        right.score - left.score || compareCodePoints(left.path, right.path) ||
        compareCodePoints(left.documentId, right.documentId))
      .slice(0, maxResults);
  },
};

interface RankedCandidate {
  result: SearchResult;
  score: number;
  sourceIds: Set<string>;
  matchedSections: Set<string>;
}

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
