import { join } from 'node:path';
import { InputError } from '../errors/qlm-error.js';
import { readStoredMarkdownDocument } from '../markdown/repository.js';
import { openProjectDatabaseReadOnly } from '../database/database.js';
import type { ProjectMetadata } from '../projects/schema.js';

export type RetrievalMode = 'path' | 'hierarchical';

export interface SearchRequest {
  projectId: string;
  query: string;
  mode: RetrievalMode;
  maxResults?: number;
  maxDepth?: number;
}

export interface RetrievalSearchRequest extends SearchRequest {
  projectRoot: string;
  project: ProjectMetadata;
}

export interface SearchResult {
  documentId: string;
  path: string;
  title: string;
  snippet: string;
  score: number;
  sourceIds: string[];
  matchedSections: string[];
  tokenCount: number;
}

export type RetrievalSearchResult = SearchResult;

const DEFAULT_MAX_RESULTS = 10;
const DEFAULT_MAX_DEPTH = 5;
const MAX_SNIPPET_LENGTH = 160;

export function searchProjectDocuments(
  request: RetrievalSearchRequest,
): RetrievalSearchResult[] {
  const maxResults = validateLimit(request.maxResults, DEFAULT_MAX_RESULTS, 'maxResults');
  const maxDepth = validateLimit(request.maxDepth, DEFAULT_MAX_DEPTH, 'maxDepth');
  const query = request.query.trim();
  if (query.length === 0) {
    throw new InputError('Retrieval query must not be empty.');
  }
  if (request.projectId !== request.project.id) {
    throw new InputError('The retrieval project ID does not match project metadata.');
  }

  const database = openProjectDatabaseReadOnly(request.projectRoot, request.project);
  try {
    const rows = request.mode === 'path'
      ? findPathMatch(database, request.project.id, query)
      : findHierarchyMatches(database, request.project.id, query, maxDepth, maxResults);

    return rows.slice(0, maxResults).map((row) => {
      const document = readStoredMarkdownDocument(joinKnowledgeRoot(request.projectRoot), row.path);
      if (document.metadata.type !== 'document' || document.metadata.id !== row.id) {
        throw new InputError(`The project index is out of date for ${row.path}.`, {
          suggestedAction: 'Run qlm reindex to rebuild the project index.',
        });
      }
      const content = document.body.replace(/\s+/g, ' ').trim();
      return {
        documentId: row.id,
        path: row.path,
        title: document.metadata.title,
        snippet: content.length <= MAX_SNIPPET_LENGTH
          ? content
          : `${content.slice(0, MAX_SNIPPET_LENGTH - 3).trimEnd()}...`,
        score: request.mode === 'path' ? 1 : 0,
        sourceIds: [...(document.metadata.source_ids ?? [])],
        matchedSections: [...(document.metadata.source_sections ?? [])],
        tokenCount: Math.max(1, Math.ceil(document.body.length / 4)),
      };
    });
  } finally {
    database.close();
  }
}

interface IndexedDocumentRow {
  id: string;
  path: string;
}

function findPathMatch(
  database: ReturnType<typeof openProjectDatabaseReadOnly>,
  projectId: string,
  query: string,
): IndexedDocumentRow[] {
  const path = normalizeQueryPath(query, 'document');
  const row = database
    .prepare('SELECT id, path FROM documents WHERE project_id = ? AND path = ?')
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
    SELECT documents.id, documents.path
    FROM documents
    LEFT JOIN subtree ON subtree.id = documents.category_id
    WHERE documents.project_id = ?
      AND (length(documents.path) - length(replace(documents.path, '/', '')) + 1) <= ?
      AND (subtree.id IS NOT NULL OR (? = 1 AND documents.category_id IS NULL))
    ORDER BY documents.path COLLATE BINARY
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
