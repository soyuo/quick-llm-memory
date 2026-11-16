import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { InputError } from '../errors/qlm-error.js';
import { openProjectDatabaseReadOnly } from '../database/database.js';
import { readStoredMarkdownSource } from '../markdown/repository.js';
import type { ProjectMetadata } from '../projects/schema.js';
import {
  searchProjectDocuments,
  type RetrievalSearchRequest,
  type RetrievalSearchResult,
} from './search.js';
import { selectCandidatesWithinTokenBudget } from './token-budget.js';

export interface RetrievalContextRequest extends RetrievalSearchRequest {
  maxTokens: number;
}

export interface ContextDocumentReference {
  documentId: string;
  path: string;
  title: string;
  score: number;
  relatedFrom?: string[];
}

export interface ContextSourceReference {
  documentId: string;
  path: string;
  sourceIds: string[];
  sourceSections: string[];
}

export interface RetrievalContextResult {
  context: string;
  documents: ContextDocumentReference[];
  sources: ContextSourceReference[];
  maxTokens: number;
  consumedTokens: number;
  tokenCountsAreEstimates: true;
  omittedResults: number;
}

interface IndexedContentHash {
  content_hash: string;
}

/** Builds source-aware context while reading only candidates that fit the budget. */
export function buildRetrievalContext(
  request: RetrievalContextRequest,
): RetrievalContextResult {
  validateMaxTokens(request.maxTokens);
  const candidates = deduplicateResults(searchProjectDocuments(request));
  const selection = selectCandidatesWithinTokenBudget(
    candidates,
    request.maxTokens,
    (selected) => estimateContextResponseTokens(
      selected,
      request.maxTokens,
      candidates.length - selected.length,
    ),
  );

  const documents: ContextDocumentReference[] = [];
  const sources: ContextSourceReference[] = [];
  const blocks: string[] = [];
  if (selection.results.length > 0) {
    const database = openProjectDatabaseReadOnly(request.projectRoot, request.project);
    try {
      const getContentHash = database.prepare(`
        SELECT content_hash
        FROM documents
        WHERE project_id = ? AND id = ? AND path = ?
      `);
      const knowledgeRoot = join(request.projectRoot, 'knowledge');
      for (const candidate of selection.results) {
        const stored = readStoredMarkdownSource(knowledgeRoot, candidate.path);
        const indexed = getContentHash.get(
          request.projectId,
          candidate.documentId,
          candidate.path,
        ) as IndexedContentHash | undefined;
        const currentHash = createHash('sha256').update(stored.sourceText).digest('hex');
        if (
          stored.document.metadata.type !== 'document' ||
          stored.document.metadata.id !== candidate.documentId ||
          stored.document.metadata.title !== candidate.title ||
          indexed?.content_hash !== currentHash
        ) {
          throw staleContextError(candidate.path);
        }

        const reference: ContextDocumentReference = {
          documentId: candidate.documentId,
          path: candidate.path,
          title: candidate.title,
          score: candidate.score,
          ...(candidate.relatedFrom === undefined
            ? {}
            : { relatedFrom: [...candidate.relatedFrom] }),
        };
        const sourceReference: ContextSourceReference = {
          documentId: candidate.documentId,
          path: candidate.path,
          sourceIds: [...(stored.document.metadata.source_ids ?? [])],
          sourceSections: [...(stored.document.metadata.source_sections ?? [])],
        };
        documents.push(reference);
        sources.push(sourceReference);
        blocks.push(renderDocumentContext(reference, sourceReference, stored.document.body));
      }
    } finally {
      database.close();
    }
  }

  const context = blocks.join('\n---\n\n');
  const consumedTokens = estimateResponseTokens(
    context,
    documents,
    sources,
    request.maxTokens,
    candidates.length - documents.length,
  );
  if (consumedTokens > request.maxTokens) {
    throw new InputError('The selected Markdown changed while building retrieval context.', {
      suggestedAction: 'Run the search again or reindex the project before retrying.',
    });
  }

  return {
    context,
    documents,
    sources,
    maxTokens: request.maxTokens,
    consumedTokens,
    tokenCountsAreEstimates: true,
    omittedResults: candidates.length - documents.length,
  };
}

function estimateContextResponseTokens(
  candidates: readonly RetrievalSearchResult[],
  maxTokens: number,
  omittedResults: number,
): number {
  if (candidates.length === 0) return 0;
  let contextCharacters = 0;
  for (const [index, candidate] of candidates.entries()) {
    if (index > 0) contextCharacters += '\n---\n\n'.length;
    contextCharacters += renderDocumentHeader(
      candidate,
      candidate.sourceIds,
      candidate.matchedSections,
    ).length;
    contextCharacters += candidate.tokenCount * 4 + 1;
  }
  return estimateResponseTokens(
    contextCharacters,
    candidates.map(toDocumentReference),
    candidates.map(toSourceReference),
    maxTokens,
    omittedResults,
  );
}

function estimateResponseTokens(
  context: string | number,
  documents: readonly ContextDocumentReference[],
  sources: readonly ContextSourceReference[],
  maxTokens: number,
  omittedResults: number,
): number {
  if (documents.length === 0) return 0;
  const contextCharacters = typeof context === 'string' ? context.length : context;
  const responseMetadata = JSON.stringify({
    documents,
    sources,
    maxTokens,
    consumedTokens: Number.MAX_SAFE_INTEGER,
    tokenCountsAreEstimates: true,
    omittedResults,
  });
  return Math.ceil((contextCharacters + responseMetadata.length) / 4);
}

function renderDocumentContext(
  document: ContextDocumentReference,
  source: ContextSourceReference,
  body: string,
): string {
  return `${renderDocumentHeader(document, source.sourceIds, source.sourceSections)}${body.trim()}\n`;
}

function renderDocumentHeader(
  document: Pick<RetrievalSearchResult, 'title' | 'path'>,
  sourceIds: readonly string[],
  sourceSections: readonly string[],
): string {
  return `## ${document.title}\nPath: ${document.path}\n` +
    `Sources: ${sourceIds.join(', ') || 'none'}\n` +
    `Source sections: ${sourceSections.join(', ') || 'none'}\n\n`;
}

function toDocumentReference(result: RetrievalSearchResult): ContextDocumentReference {
  return {
    documentId: result.documentId,
    path: result.path,
    title: result.title,
    score: result.score,
    ...(result.relatedFrom === undefined ? {} : { relatedFrom: result.relatedFrom }),
  };
}

function toSourceReference(result: RetrievalSearchResult): ContextSourceReference {
  return {
    documentId: result.documentId,
    path: result.path,
    sourceIds: result.sourceIds,
    sourceSections: result.matchedSections,
  };
}

function deduplicateResults(
  results: readonly RetrievalSearchResult[],
): RetrievalSearchResult[] {
  const byId = new Map<string, RetrievalSearchResult>();
  for (const result of results) {
    const existing = byId.get(result.documentId);
    if (existing === undefined) {
      byId.set(result.documentId, {
        ...result,
        sourceIds: [...new Set(result.sourceIds)],
        matchedSections: [...new Set(result.matchedSections)],
        ...(result.relatedFrom === undefined
          ? {}
          : { relatedFrom: [...new Set(result.relatedFrom)] }),
      });
      continue;
    }
    existing.sourceIds = [...new Set([...existing.sourceIds, ...result.sourceIds])];
    existing.matchedSections = [
      ...new Set([...existing.matchedSections, ...result.matchedSections]),
    ];
    existing.relatedFrom = [...new Set([
      ...(existing.relatedFrom ?? []),
      ...(result.relatedFrom ?? []),
    ])];
  }
  return [...byId.values()];
}

function validateMaxTokens(maxTokens: number): void {
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 0) {
    throw new InputError('maxTokens must be a non-negative safe integer.', {
      suggestedAction: 'Provide a whole-number token budget of 0 or more.',
    });
  }
}

function staleContextError(path: string): InputError {
  return new InputError(`The project search index is out of date for ${path}.`, {
    suggestedAction: 'Run qlm reindex to synchronize the project index with Markdown.',
  });
}
