import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigurationError } from '../config/error.js';
import { assertNoSymlinkComponents } from '../markdown/filesystem.js';
import { readStoredMarkdownDocument, readStoredMarkdownResource, resolveKnowledgeRoot } from '../markdown/repository.js';
import type { ProjectMetadata } from '../projects/schema.js';
import { openProjectDatabaseReadOnly } from '../database/database.js';
import { resolveProjectDatabasePath } from '../database/database.js';
import type { SourceChangeSet, SourceFileChange, SourceSectionChange } from './source-changes.js';

export interface KnowledgeImpactDocument {
  id: string;
  path: string;
  title: string;
  action: 'regenerate' | 'unaffected';
  reasons: string[];
}

export interface RemovedSourceCandidate {
  sourceId: string;
  path: string;
  documentIds: string[];
  action: 'review-removed-source';
}

export interface KnowledgeImpactPlan {
  documents: KnowledgeImpactDocument[];
  categoryIndexes: Array<{ path: string; affectedDocumentIds: string[] }>;
  removedSources: RemovedSourceCandidate[];
}

interface IndexedDocumentRow {
  id: string;
  path: string;
  category_id: string | null;
}

interface CategoryRow {
  id: string;
  path: string;
}

interface RelationRow {
  source_id: string;
  target_id: string;
}

interface DocumentInfo extends IndexedDocumentRow {
  title: string;
  sourceIds: Set<string>;
  sourceSections: Set<string>;
  relatedIds: string[];
}

/** Build a stable impact plan from the existing index and source comparison. This function is read-only and makes no provider calls. */
export function planProjectKnowledgeImpact(
  projectRoot: string,
  project: ProjectMetadata,
  knowledgeRoot: string,
  sourceChanges: SourceChangeSet,
): KnowledgeImpactPlan {
  const deletedSources = sourceChanges.files
    .filter((change) => change.status === 'deleted')
    .map(toRemovedSourceCandidate);
  try {
    const rootInfo = lstatSync(knowledgeRoot);
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
      throw new ConfigurationError('The project knowledge root must be a regular directory.');
    }
  } catch (cause) {
    if (isMissingPath(cause)) return emptyPlan(deletedSources);
    throw cause;
  }
  const root = resolveKnowledgeRoot(knowledgeRoot);
  try {
    lstatSync(resolveProjectDatabasePath(projectRoot));
  } catch (cause) {
    if (isMissingPath(cause)) return emptyPlan(deletedSources);
    throw cause;
  }
  const database = openProjectDatabaseReadOnly(projectRoot, project);
  try {
    const documentRows = database.prepare(`
      SELECT id, path, category_id
      FROM documents
      WHERE project_id = ?
      ORDER BY path, id
    `).all(project.id) as IndexedDocumentRow[];
    const documents = documentRows.map((row): DocumentInfo => {
      const markdown = readStoredMarkdownDocument(root, row.path);
      const metadata = markdown.metadata;
      if (metadata.type !== 'document') {
        throw new ConfigurationError(`Expected a generated document: ${markdown.sourcePath}`, {
          filePath: markdown.sourcePath,
        });
      }
      return {
        ...row,
        title: metadata.title,
        sourceIds: new Set(metadata.source_ids ?? []),
        sourceSections: new Set(metadata.source_sections ?? []),
        relatedIds: [...(metadata.related ?? [])],
      };
    });
    const docsById = new Map(documents.map((document) => [document.id, document]));
    const reasonsById = new Map<string, Set<string>>();

    const addReason = (documentId: string, reason: string): void => {
      const reasons = reasonsById.get(documentId) ?? new Set<string>();
      reasons.add(reason);
      reasonsById.set(documentId, reasons);
    };

    const addedOrDeletedSources = new Set(
      sourceChanges.files
        .filter((change) => change.status === 'added' || change.status === 'deleted')
        .map((change) => change.sourceId),
    );
    for (const sourceId of addedOrDeletedSources) {
      for (const document of documents) {
        if (document.sourceIds.has(sourceId) || hasSourceReference(document.sourceSections, sourceId)) {
          addReason(document.id, `source:${sourceId}`);
        }
      }
    }

    for (const change of sourceChanges.sections) {
      if (change.status === 'unchanged') continue;
      for (const document of documents) {
        if (matchesChangedSection(document, change)) {
          addReason(document.id, `section:${change.sectionId}`);
        }
      }
    }

    const adjacency = new Map<string, Set<string>>();
    const addEdge = (left: string, right: string): void => {
      if (!docsById.has(left) || !docsById.has(right) || left === right) return;
      const leftEdges = adjacency.get(left) ?? new Set<string>();
      const rightEdges = adjacency.get(right) ?? new Set<string>();
      leftEdges.add(right);
      rightEdges.add(left);
      adjacency.set(left, leftEdges);
      adjacency.set(right, rightEdges);
    };
    const relations = database.prepare(`
      SELECT source_id, target_id
      FROM document_relations
      WHERE relation_type = 'related'
      ORDER BY source_id, target_id
    `).all() as RelationRow[];
    for (const relation of relations) addEdge(relation.source_id, relation.target_id);
    for (const document of documents) {
      for (const relatedId of document.relatedIds) addEdge(document.id, relatedId);
    }

    const impacted = new Set(reasonsById.keys());
    const queue = [...impacted].sort(compareStrings);
    for (let index = 0; index < queue.length; index += 1) {
      const currentId = queue[index];
      if (currentId === undefined) continue;
      const relatedIds = [...(adjacency.get(currentId) ?? [])].sort(compareStrings);
      for (const relatedId of relatedIds) {
        if (impacted.has(relatedId)) continue;
        impacted.add(relatedId);
        addReason(relatedId, `related:${currentId}`);
        queue.push(relatedId);
      }
    }

    const categoryRows = database.prepare(`
      SELECT id, path FROM categories WHERE project_id = ? ORDER BY path, id
    `).all(project.id) as CategoryRow[];
    const categoryByPath = new Map(categoryRows.map((category) => [category.path, category]));
    const affectedByIndex = new Map<string, Set<string>>();
    for (const documentId of [...impacted].sort(compareStrings)) {
      const document = docsById.get(documentId);
      if (document?.category_id === null || document === undefined) continue;
      const category = categoryRows.find(({ id }) => id === document.category_id);
      if (category === undefined) continue;
      const segments = category.path.split('/');
      for (let length = 1; length <= segments.length; length += 1) {
        const categoryPath = segments.slice(0, length).join('/');
        if (!categoryByPath.has(categoryPath)) continue;
        const indexPath = `${categoryPath}/index.md`;
        if (!hasCategoryIndex(root, indexPath)) continue;
        const ids = affectedByIndex.get(indexPath) ?? new Set<string>();
        ids.add(documentId);
        affectedByIndex.set(indexPath, ids);
      }
    }

    const removedSources = deletedSources
      .map((source) => ({
        ...source,
        documentIds: documents
          .filter((document) =>
            document.sourceIds.has(source.sourceId) ||
            hasSourceReference(document.sourceSections, source.sourceId),
          )
          .map(({ id }) => id)
          .sort(compareStrings),
        action: 'review-removed-source' as const,
      }))
      .sort((left, right) => compareStrings(left.path, right.path) || compareStrings(left.sourceId, right.sourceId));

    return {
      documents: documents.map((document) => ({
        id: document.id,
        path: document.path,
        title: document.title,
        action: impacted.has(document.id) ? 'regenerate' : 'unaffected',
        reasons: [...(reasonsById.get(document.id) ?? [])].sort(compareStrings),
      })),
      categoryIndexes: [...affectedByIndex.entries()]
        .map(([path, ids]) => ({ path, affectedDocumentIds: [...ids].sort(compareStrings) }))
        .sort((left, right) => compareStrings(left.path, right.path)),
      removedSources,
    };
  } finally {
    database.close();
  }
}

function matchesChangedSection(document: DocumentInfo, change: SourceSectionChange): boolean {
  if (change.status === 'added') {
    return document.sourceIds.has(change.sourceId) ||
      hasSourceReference(document.sourceSections, change.sourceId);
  }
  const references = [change.previousParserSectionId, change.currentParserSectionId]
    .filter((reference): reference is string => reference !== null);
  if (references.some((reference) => document.sourceSections.has(reference))) return true;
  const hasLegacySide = change.status === 'deleted'
    ? change.previousParserSectionId === null
    : change.previousParserSectionId === null || change.currentParserSectionId === null;
  return hasLegacySide && (
    document.sourceIds.has(change.sourceId) || hasSourceReference(document.sourceSections, change.sourceId)
  );
}

function hasSourceReference(references: Set<string>, sourceId: string): boolean {
  const prefix = `${sourceId}:`;
  for (const reference of references) if (reference.startsWith(prefix)) return true;
  return false;
}

function hasCategoryIndex(root: string, relativePath: string): boolean {
  const segments = relativePath.split('/');
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
    throw new ConfigurationError('The project index contains an invalid category path.');
  }
  const indexPath = join(root, ...segments);
  assertNoSymlinkComponents(root, indexPath);
  let info;
  try {
    info = lstatSync(indexPath);
  } catch (cause) {
    if (typeof cause === 'object' && cause !== null && 'code' in cause && cause.code === 'ENOENT') {
      return false;
    }
    throw cause;
  }
  if (!info.isFile() || info.isSymbolicLink()) return false;
  const parsed = readStoredMarkdownResource(root, relativePath).document;
  if (parsed.metadata.type !== 'category-index') {
    throw new ConfigurationError(`Expected category-index frontmatter: ${indexPath}`, { filePath: indexPath });
  }
  return true;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function toRemovedSourceCandidate(change: SourceFileChange): RemovedSourceCandidate {
  return {
    sourceId: change.sourceId,
    path: change.path,
    documentIds: [],
    action: 'review-removed-source',
  };
}

function emptyPlan(removedSources: RemovedSourceCandidate[]): KnowledgeImpactPlan {
  return { documents: [], categoryIndexes: [], removedSources };
}

function isMissingPath(cause: unknown): boolean {
  return typeof cause === 'object' && cause !== null && 'code' in cause && cause.code === 'ENOENT';
}
