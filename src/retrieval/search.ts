import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { ConfigurationError } from '../config/error.js';
import { InputError, InternalError, QLMError } from '../errors/qlm-error.js';
import { readStoredMarkdownSource } from '../markdown/repository.js';
import { openProjectDatabaseReadOnly } from '../database/database.js';
import { rebuildProjectIndex } from '../database/reindex.js';
import type { EmbeddingProvider } from '../providers/provider.js';
import { ProviderError } from '../providers/provider-error.js';
import type { ProjectMetadata } from '../projects/schema.js';
import { reciprocalRankFusionRanker, type RankedSearchSource, type RetrievalRanker } from './ranker.js';

export type RetrievalMode = 'path' | 'hierarchical' | 'fulltext' | 'semantic' | 'hybrid';
export type SynchronousRetrievalMode = Exclude<RetrievalMode, 'semantic'>;

export interface SearchRequest {
  projectId: string;
  query: string;
  mode: RetrievalMode;
  maxResults?: number;
  maxDepth?: number;
  includeRelated?: boolean;
  maxRelatedResults?: number;
}

export interface RetrievalSearchRequest extends SearchRequest {
  projectRoot: string;
  project: ProjectMetadata;
  ranker?: RetrievalRanker;
  /** Disable automatic index rebuilding for read-only integrations such as MCP. */
  synchronizeStaleIndex?: boolean;
  embeddingProvider?: EmbeddingProvider;
  embeddingModel?: string;
}

export type SemanticRetrievalSearchRequest = RetrievalSearchRequest & {
  mode: 'semantic';
  embeddingProvider: EmbeddingProvider;
  embeddingModel: string;
};

export interface SearchResult {
  documentId: string;
  path: string;
  title: string;
  snippet: string;
  /** Reciprocal-rank score; it is an ordering signal, not a probability. */
  score: number;
  sourceIds: string[];
  matchedSections: string[];
  tokenCount: number;
  relatedFrom?: string[];
}

export type RetrievalSearchResult = SearchResult;

const DEFAULT_MAX_RESULTS = 10;
const MAX_MAX_RESULTS = 100;
const DEFAULT_MAX_DEPTH = 5;
const DEFAULT_MAX_RELATED_RESULTS = 5;
const MAX_RELATED_RESULTS = 20;
const MAX_SNIPPET_LENGTH = 160;
const MAX_SEMANTIC_QUERY_LENGTH = 8_192;

interface SemanticEmbeddingRow {
  document_id: string;
  path: string;
  content_hash: string;
  kind: 'document' | 'section';
  section_id: string;
  model: string;
  dimensions: number;
  vector_json: string;
}

interface SemanticCandidate {
  documentId: string;
  path: string;
  contentHash: string;
  score: number;
  matchedSections: string[];
}

export function searchProjectDocuments(
  request: SemanticRetrievalSearchRequest,
): Promise<RetrievalSearchResult[]>;
export function searchProjectDocuments(
  request: RetrievalSearchRequest & { mode: SynchronousRetrievalMode },
): RetrievalSearchResult[];
export function searchProjectDocuments(
  request: RetrievalSearchRequest,
): RetrievalSearchResult[] | Promise<RetrievalSearchResult[]>;
export function searchProjectDocuments(
  request: RetrievalSearchRequest,
): RetrievalSearchResult[] | Promise<RetrievalSearchResult[]> {
  if (!['path', 'hierarchical', 'fulltext', 'semantic', 'hybrid'].includes(request.mode)) {
    throw new InputError('Unsupported retrieval mode.', {
      suggestedAction: 'Use path, hierarchical, fulltext, semantic, or hybrid retrieval.',
    });
  }
  const maxResults = validateLimit(request.maxResults, DEFAULT_MAX_RESULTS, 'maxResults');
  if (maxResults > MAX_MAX_RESULTS) {
    throw new InputError(`maxResults must not exceed ${MAX_MAX_RESULTS}.`, {
      suggestedAction: `Choose a value between 0 and ${MAX_MAX_RESULTS}.`,
    });
  }
  const maxRelatedResults = validateLimit(
    request.maxRelatedResults,
    DEFAULT_MAX_RELATED_RESULTS,
    'maxRelatedResults',
  );
  if (maxRelatedResults > MAX_RELATED_RESULTS) {
    throw new InputError(`maxRelatedResults must not exceed ${MAX_RELATED_RESULTS}.`, {
      suggestedAction: `Choose a value between 0 and ${MAX_RELATED_RESULTS}.`,
    });
  }
  if (request.maxRelatedResults !== undefined && request.includeRelated !== true) {
    throw new InputError('maxRelatedResults requires includeRelated.');
  }
  const maxDepth = validateLimit(request.maxDepth, DEFAULT_MAX_DEPTH, 'maxDepth');
  if (request.maxDepth !== undefined && request.mode !== 'hierarchical') {
    throw new InputError('maxDepth is only supported for hierarchical retrieval.');
  }
  const query = request.query.trim();
  if (query.length === 0) {
    throw new InputError('Retrieval query must not be empty.');
  }
  if (request.projectId !== request.project.id) {
    throw new InputError('The retrieval project ID does not match project metadata.');
  }

  if (request.mode === 'semantic') {
    if (request.embeddingProvider === undefined || request.embeddingModel?.trim() === undefined ||
        request.embeddingModel.trim().length === 0) {
      throw new InputError('Semantic retrieval requires an embedding provider and model.', {
        suggestedAction: 'Configure an embedding provider and rebuild the project index with qlm reindex.',
      });
    }
    if (maxResults === 0) return Promise.resolve([]);
    return searchSemanticDocuments(request as SemanticRetrievalSearchRequest, query, maxResults);
  }

  return searchIndexedDocuments(
    request,
    query,
    maxDepth,
    maxResults,
    request.synchronizeStaleIndex !== false,
  );
}

async function searchSemanticDocuments(
  request: SemanticRetrievalSearchRequest,
  query: string,
  maxResults: number,
): Promise<RetrievalSearchResult[]> {
  if (query.length > MAX_SEMANTIC_QUERY_LENGTH) {
    throw new InputError(`Semantic query must not exceed ${MAX_SEMANTIC_QUERY_LENGTH} characters.`);
  }
  const model = request.embeddingModel.trim();
  const metadata = readCurrentEmbeddingMetadata(request, model);
  if (metadata === undefined) return [];

  let queryVectors: number[][];
  try {
    queryVectors = await request.embeddingProvider.embed([query], model);
  } catch (cause) {
    if (cause instanceof QLMError) throw cause;
    throw new InternalError('Semantic query embedding failed.', {
      suggestedAction: 'Check the embedding provider configuration and retry the search.',
      cause,
    });
  }
  const queryVector = queryVectors[0];
  if (
    queryVectors.length !== 1 || queryVector === undefined ||
    queryVector.length !== metadata.dimensions || queryVector.length === 0 ||
    queryVector.some((value) => !Number.isFinite(value))
  ) {
    throw new ProviderError('The embedding provider returned an incompatible query vector.', {
      suggestedAction: 'Check the embedding model and rebuild the project index with qlm reindex.',
    });
  }

  const database = openProjectDatabaseReadOnly(request.projectRoot, request.project);
  const candidates = new Map<string, SemanticCandidate>();
  try {
    const currentMetadata = database.prepare(`
      SELECT provider_id, model, dimensions, updated_at
      FROM project_embedding_metadata WHERE project_id = ?
    `).get(request.project.id) as typeof metadata | undefined;
    if (
      currentMetadata === undefined || currentMetadata.updated_at !== metadata.updated_at ||
      currentMetadata.provider_id !== request.embeddingProvider.id ||
      currentMetadata.model !== model || currentMetadata.dimensions !== metadata.dimensions
    ) {
      throw staleEmbeddingIndexError();
    }
    const statement = database.prepare(`
      SELECT e.document_id, d.path, d.content_hash, e.kind, e.section_id,
        e.model, e.dimensions, e.vector_json
      FROM document_embeddings e
      JOIN documents d ON d.id = e.document_id AND d.project_id = e.project_id
      WHERE e.project_id = ?
      ORDER BY d.path, e.kind, e.section_id
    `);
    for (const row of statement.iterate(request.project.id) as Iterable<SemanticEmbeddingRow>) {
      if (row.model !== model || row.dimensions !== metadata.dimensions) {
        throw staleEmbeddingIndexError();
      }
      let vector: unknown;
      try {
        vector = JSON.parse(row.vector_json) as unknown;
      } catch {
        throw staleEmbeddingIndexError();
      }
      if (
        !Array.isArray(vector) || vector.length !== metadata.dimensions ||
        vector.length === 0 || vector.some((value) => typeof value !== 'number' || !Number.isFinite(value))
      ) {
        throw staleEmbeddingIndexError();
      }
      const score = cosineSimilarity(queryVector, vector as number[]);
      const current = candidates.get(row.document_id);
      if (current === undefined || score > current.score) {
        candidates.set(row.document_id, {
          documentId: row.document_id,
          path: row.path,
          contentHash: row.content_hash,
          score,
          matchedSections: row.kind === 'section' ? [row.section_id] : [],
        });
      } else if (score === current.score && row.kind === 'section') {
        current.matchedSections.push(row.section_id);
      }
    }
    const documentCount = database.prepare(
      'SELECT count(*) AS count FROM documents WHERE project_id = ?',
    ).get(request.project.id) as { count: number };
    const documentVectorCount = database.prepare(`
      SELECT count(*) AS count FROM document_embeddings
      WHERE project_id = ? AND kind = 'document'
    `).get(request.project.id) as { count: number };
    if (
      documentVectorCount.count !== documentCount.count ||
      candidates.size !== documentCount.count
    ) {
      throw staleEmbeddingIndexError();
    }
  } finally {
    database.close();
  }

  const ranked = [...candidates.values()].sort((left, right) =>
    right.score - left.score || left.path.localeCompare(right.path) ||
    left.documentId.localeCompare(right.documentId)
  ).slice(0, maxResults);
  const primaryResults = ranked.map((candidate) => {
    let source: ReturnType<typeof readStoredMarkdownSource>;
    try {
      source = readStoredMarkdownSource(joinKnowledgeRoot(request.projectRoot), candidate.path);
    } catch {
      throw staleIndexError(candidate.path);
    }
    const document = source.document;
    const contentHash = createHash('sha256').update(source.sourceText).digest('hex');
    if (
      document.metadata.type !== 'document' || document.metadata.id !== candidate.documentId ||
      contentHash !== candidate.contentHash
    ) {
      throw staleIndexError(candidate.path);
    }
    const content = document.body.replace(/\s+/g, ' ').trim();
    return {
      documentId: candidate.documentId,
      path: candidate.path,
      title: document.metadata.title,
      snippet: content.length <= MAX_SNIPPET_LENGTH
        ? content
        : `${content.slice(0, MAX_SNIPPET_LENGTH - 3).trimEnd()}...`,
      score: candidate.score,
      sourceIds: [...(document.metadata.source_ids ?? [])],
      matchedSections: [...new Set(candidate.matchedSections)].sort(),
      tokenCount: Math.max(1, Math.ceil(document.body.length / 4)),
    } satisfies RetrievalSearchResult;
  });
  return request.includeRelated === true
    ? appendRelatedResults(request, primaryResults, request.maxRelatedResults ?? DEFAULT_MAX_RELATED_RESULTS)
    : primaryResults;
}

function readCurrentEmbeddingMetadata(
  request: SemanticRetrievalSearchRequest,
  model: string,
): { provider_id: string; model: string; dimensions: number; updated_at: string } | undefined {
  let database: ReturnType<typeof openProjectDatabaseReadOnly>;
  try {
    database = openProjectDatabaseReadOnly(request.projectRoot, request.project);
  } catch {
    throw staleEmbeddingIndexError();
  }
  try {
    const documentCount = database.prepare(
      'SELECT count(*) AS count FROM documents WHERE project_id = ?',
    ).get(request.project.id) as { count: number };
    if (documentCount.count === 0) return undefined;
    const metadata = database.prepare(`
      SELECT provider_id, model, dimensions, updated_at
      FROM project_embedding_metadata WHERE project_id = ?
    `).get(request.project.id) as {
      provider_id: string; model: string; dimensions: number; updated_at: string;
    } | undefined;
    if (
      metadata === undefined || metadata.provider_id !== request.embeddingProvider.id ||
      metadata.model !== model || !Number.isSafeInteger(metadata.dimensions) || metadata.dimensions < 1
    ) {
      throw staleEmbeddingIndexError();
    }
    return metadata;
  } finally {
    database.close();
  }
}

function cosineSimilarity(left: number[], right: number[]): number {
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index]!;
    const rightValue = right[index]!;
    dot += leftValue * rightValue;
    leftMagnitude += leftValue * leftValue;
    rightMagnitude += rightValue * rightValue;
  }
  if (leftMagnitude === 0 || rightMagnitude === 0) return 0;
  const similarity = dot / Math.sqrt(leftMagnitude * rightMagnitude);
  if (!Number.isFinite(similarity)) throw staleEmbeddingIndexError();
  return similarity;
}

function staleEmbeddingIndexError(): InputError {
  return new InputError('The project embedding index is missing, stale, or incompatible.', {
    suggestedAction: 'Verify ai.embedding_model and run qlm reindex to rebuild the project vectors.',
  });
}

function searchIndexedDocuments(
  request: RetrievalSearchRequest,
  query: string,
  maxDepth: number,
  maxResults: number,
  canSynchronize: boolean,
): RetrievalSearchResult[] {
  const database = openProjectDatabaseReadOnly(request.projectRoot, request.project);
  let staleFullTextIndex = false;
  const rankedSources: RankedSearchSource[] = [];
  try {
    const candidateSources = findCandidateRows(
      database,
      request.project.id,
      request.mode,
      query,
      maxDepth,
      request.mode === 'hybrid' ? MAX_MAX_RESULTS : maxResults,
    );
    const resultsById = new Map<string, RetrievalSearchResult>();

    for (const candidateSource of candidateSources) {
      const sourceResults: RetrievalSearchResult[] = [];
      for (const row of candidateSource.rows) {
        const existing = resultsById.get(row.id);
        if (existing !== undefined) {
          sourceResults.push(existing);
          continue;
        }
        let source: ReturnType<typeof readStoredMarkdownSource>;
        try {
          source = readStoredMarkdownSource(joinKnowledgeRoot(request.projectRoot), row.path);
        } catch (cause) {
          if (
            canSynchronize && isSynchronizingMode(request.mode) &&
            cause instanceof ConfigurationError
          ) {
            staleFullTextIndex = true;
            break;
          }
          throw cause;
        }
        const document = source.document;
        const contentHash = createHash('sha256').update(source.sourceText).digest('hex');
        if (
          document.metadata.type !== 'document' || document.metadata.id !== row.id ||
          contentHash !== row.contentHash
        ) {
          if (canSynchronize && isSynchronizingMode(request.mode)) {
            staleFullTextIndex = true;
            break;
          }
          throw staleIndexError(row.path);
        }
        const content = document.body.replace(/\s+/g, ' ').trim();
        const result = {
          documentId: row.id,
          path: row.path,
          title: document.metadata.title,
          snippet: content.length <= MAX_SNIPPET_LENGTH
            ? content
            : `${content.slice(0, MAX_SNIPPET_LENGTH - 3).trimEnd()}...`,
          score: 0,
          sourceIds: [...(document.metadata.source_ids ?? [])],
          matchedSections: [...(document.metadata.source_sections ?? [])],
          tokenCount: Math.max(1, Math.ceil(document.body.length / 4)),
        } satisfies RetrievalSearchResult;
        resultsById.set(row.id, result);
        sourceResults.push(result);
      }
      rankedSources.push({ mode: candidateSource.mode, results: sourceResults });
      if (staleFullTextIndex) break;
    }
  } finally {
    database.close();
  }

  if (staleFullTextIndex) {
    if (!canSynchronize) {
      throw staleIndexError('project');
    }
    rebuildProjectIndex(request.projectRoot, request.project);
    return searchIndexedDocuments(request, query, maxDepth, maxResults, false);
  }
  const ranker = request.ranker ?? reciprocalRankFusionRanker;
  const primaryResults = ranker.rank(rankedSources, maxResults).slice(0, maxResults);
  return request.includeRelated === true
    ? appendRelatedResults(
      request,
      primaryResults,
      request.maxRelatedResults ?? DEFAULT_MAX_RELATED_RESULTS,
    )
    : primaryResults;
}

function appendRelatedResults(
  request: RetrievalSearchRequest,
  primaryResults: RetrievalSearchResult[],
  maxRelatedResults: number,
): RetrievalSearchResult[] {
  if (primaryResults.length === 0 || maxRelatedResults === 0) {
    return primaryResults;
  }

  const primaryIds = primaryResults.map(({ documentId }) => documentId);
  const placeholders = primaryIds.map(() => '?').join(', ');
  const primaryById = new Map(primaryResults.map((result) => [result.documentId, result]));
  const database = openProjectDatabaseReadOnly(request.projectRoot, request.project);
  try {
    const existingLinks = database.prepare(`
      SELECT source_id AS sourceId, target_id AS targetId
      FROM document_relations
      WHERE relation_type = 'related'
        AND source_id IN (${placeholders})
        AND target_id IN (${placeholders})
      ORDER BY target_id COLLATE BINARY, source_id COLLATE BINARY
    `).all(...primaryIds, ...primaryIds) as Array<{ sourceId: string; targetId: string }>;
    for (const link of existingLinks) {
      const target = primaryById.get(link.targetId);
      if (target !== undefined) {
        target.relatedFrom = [...new Set([...(target.relatedFrom ?? []), link.sourceId])];
      }
    }

    const relatedRows = database.prepare(`
      SELECT DISTINCT target.id, target.path, target.content_hash AS contentHash
      FROM document_relations AS relation
      JOIN documents AS target ON target.id = relation.target_id
      WHERE relation.relation_type = 'related'
        AND relation.source_id IN (${placeholders})
        AND target.project_id = ?
        AND target.id NOT IN (${placeholders})
      ORDER BY target.path COLLATE BINARY, target.id COLLATE BINARY
      LIMIT ?
    `).all(...primaryIds, request.project.id, ...primaryIds, maxRelatedResults) as IndexedDocumentRow[];

    const relatedResults = relatedRows.map((row) => {
      const sourceIds = database.prepare(`
        SELECT source_id AS sourceId
        FROM document_relations
        WHERE relation_type = 'related'
          AND target_id = ?
          AND source_id IN (${placeholders})
        ORDER BY source_id COLLATE BINARY
      `).all(row.id, ...primaryIds) as Array<{ sourceId: string }>;
      return createRelatedSearchResult(request.projectRoot, row, sourceIds.map(({ sourceId }) => sourceId));
    });
    return [...primaryResults, ...relatedResults];
  } finally {
    database.close();
  }
}

function createRelatedSearchResult(
  projectRoot: string,
  row: IndexedDocumentRow,
  relatedFrom: string[],
): RetrievalSearchResult {
  const source = readStoredMarkdownSource(joinKnowledgeRoot(projectRoot), row.path);
  const document = source.document;
  const contentHash = createHash('sha256').update(source.sourceText).digest('hex');
  if (
    document.metadata.type !== 'document' || document.metadata.id !== row.id ||
    contentHash !== row.contentHash
  ) {
    throw staleIndexError(row.path);
  }
  const content = document.body.replace(/\s+/g, ' ').trim();
  return {
    documentId: row.id,
    path: row.path,
    title: document.metadata.title,
    snippet: content.length <= MAX_SNIPPET_LENGTH
      ? content
      : `${content.slice(0, MAX_SNIPPET_LENGTH - 3).trimEnd()}...`,
    score: 0,
    sourceIds: [...(document.metadata.source_ids ?? [])],
    matchedSections: [...(document.metadata.source_sections ?? [])],
    tokenCount: Math.max(1, Math.ceil(document.body.length / 4)),
    relatedFrom,
  };
}

interface CandidateRows {
  mode: Exclude<RetrievalMode, 'hybrid'>;
  rows: IndexedDocumentRow[];
}

function findCandidateRows(
  database: ReturnType<typeof openProjectDatabaseReadOnly>,
  projectId: string,
  mode: RetrievalMode,
  query: string,
  maxDepth: number,
  maxResults: number,
): CandidateRows[] {
  if (mode === 'path') {
    return [{ mode, rows: findPathMatch(database, projectId, query) }];
  }
  if (mode === 'hierarchical') {
    return [{ mode, rows: findHierarchyMatches(database, projectId, query, maxDepth, maxResults) }];
  }
  if (mode === 'fulltext') {
    return [{ mode, rows: findFullTextMatches(database, projectId, query, maxResults) }];
  }

  const sources: CandidateRows[] = [];
  const isDocumentPath = /\.(?:md|markdown)$/i.test(query);
  if (isDocumentPath) {
    sources.push({ mode: 'path', rows: findPathMatch(database, projectId, query) });
  }
  sources.push({
    mode: 'hierarchical',
    rows: findHierarchyMatches(database, projectId, query, maxDepth, maxResults),
  });
  if (query !== '.' && query !== '/') {
    const fullTextQuery = isDocumentPath ? createPathTextQuery(query) : query;
    if (fullTextQuery.length === 0) {
      return sources;
    }
    sources.push({
      mode: 'fulltext',
      rows: findFullTextMatches(database, projectId, fullTextQuery, maxResults),
    });
  }
  return sources;
}

function createPathTextQuery(path: string): string {
  const withoutExtension = path.replace(/\.(?:md|markdown)$/i, '').replace(/[\\/_.-]+/g, ' ');
  const terms = withoutExtension.match(/[\p{L}\p{N}]+/gu) ?? [];
  return terms.map((term) => `"${term}"`).join(' OR ');
}

function isSynchronizingMode(mode: RetrievalMode): boolean {
  return mode === 'fulltext' || mode === 'hybrid';
}

function staleIndexError(path: string): InputError {
  return new InputError(`The project search index is out of date for ${path}.`, {
    suggestedAction: 'Run qlm reindex to synchronize the search index with Markdown.',
  });
}

interface IndexedDocumentRow {
  id: string;
  path: string;
  contentHash: string;
}

function findPathMatch(
  database: ReturnType<typeof openProjectDatabaseReadOnly>,
  projectId: string,
  query: string,
): IndexedDocumentRow[] {
  const path = normalizeQueryPath(query, 'document');
  const row = database
    .prepare(`
      SELECT id, path, content_hash AS contentHash
      FROM documents WHERE project_id = ? AND path = ?
    `)
    .get(projectId, path) as IndexedDocumentRow | undefined;
  return row === undefined ? [] : [row];
}

function findHierarchyMatches(
  database: ReturnType<typeof openProjectDatabaseReadOnly>,
  projectId: string,
  query: string,
  maxDepth: number,
  maxResults: number,
): IndexedDocumentRow[] {
  const categoryPath = normalizeQueryPath(query, 'category');
  if (categoryPath.length > 0) {
    const category = database
      .prepare('SELECT depth FROM categories WHERE project_id = ? AND path = ?')
      .get(projectId, categoryPath) as { depth: number } | undefined;
    if (category === undefined || category.depth > maxDepth) {
      return [];
    }
  }

  const anchor = categoryPath.length === 0
    ? 'SELECT id FROM categories WHERE project_id = ? AND parent_id IS NULL AND depth <= ?'
    : 'SELECT id FROM categories WHERE project_id = ? AND path = ?';
  const anchorParameters: unknown[] = categoryPath.length === 0
    ? [projectId, maxDepth]
    : [projectId, categoryPath];
  return database.prepare(`
    WITH RECURSIVE subtree(id) AS (
      ${anchor}
      UNION
      SELECT child.id
      FROM categories AS child
      JOIN subtree AS parent ON child.parent_id = parent.id
      WHERE child.project_id = ? AND child.depth <= ?
    )
    SELECT documents.id, documents.path, documents.content_hash AS contentHash
    FROM documents
    LEFT JOIN subtree ON subtree.id = documents.category_id
    WHERE documents.project_id = ?
      AND (length(documents.path) - length(replace(documents.path, '/', '')) + 1) <= ?
      AND (subtree.id IS NOT NULL OR (? = 1 AND documents.category_id IS NULL))
    ORDER BY documents.depth ASC, documents.path COLLATE BINARY
    LIMIT ?
  `).all(
    ...anchorParameters,
    projectId,
    maxDepth,
    projectId,
    maxDepth,
    categoryPath.length === 0 ? 1 : 0,
    maxResults,
  ) as IndexedDocumentRow[];
}

function findFullTextMatches(
  database: ReturnType<typeof openProjectDatabaseReadOnly>,
  projectId: string,
  query: string,
  maxResults: number,
): IndexedDocumentRow[] {
  try {
    return database.prepare(`
      SELECT documents.id, documents.path, documents.content_hash AS contentHash
      FROM document_fts
      JOIN documents ON documents.id = document_fts.document_id
      WHERE document_fts MATCH ? AND documents.project_id = ?
      ORDER BY bm25(document_fts) ASC, documents.path COLLATE BINARY
      LIMIT ?
    `).all(query, projectId, maxResults) as IndexedDocumentRow[];
  } catch (cause) {
    if (
      cause instanceof Error &&
      /^(?:fts5:|no such column:|unterminated string$)/i.test(cause.message)
    ) {
      throw new InputError('The full-text query is malformed.', {
        suggestedAction: 'Check quotes, column filters, and FTS operators in the query.',
      });
    }
    throw cause;
  }
}

function normalizeQueryPath(query: string, kind: 'document' | 'category'): string {
  if (kind === 'category' && (query === '.' || query === '/')) {
    return '';
  }
  const path = query.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/$/, '');
  if (
    path.length === 0 ||
    path.startsWith('/') ||
    /^[A-Za-z]:/.test(path) ||
    path.split('/').some((segment) => segment.length === 0 || segment === '.' || segment === '..')
  ) {
    throw new InputError(`The ${kind} path must be a safe project-relative path.`, {
      suggestedAction: `Provide a relative ${kind} path without traversal segments.`,
    });
  }
  if (kind === 'document' && !/\.(?:md|markdown)$/i.test(path)) {
    throw new InputError('Path mode only supports Markdown documents.');
  }
  return path;
}

function validateLimit(value: number | undefined, fallback: number, name: string): number {
  const limit = value ?? fallback;
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw new InputError(`${name} must be a non-negative integer.`);
  }
  return limit;
}

function joinKnowledgeRoot(projectRoot: string): string {
  return join(projectRoot, 'knowledge');
}
