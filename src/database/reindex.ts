import { createHash } from 'node:crypto';
import { existsSync, lstatSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { ConfigurationError } from '../config/error.js';
import { InputError, InternalError, QLMError } from '../errors/qlm-error.js';
import {
  readStoredMarkdownSource,
  resolveKnowledgeRoot,
} from '../markdown/repository.js';
import { readMarkdownDocument } from '../markdown/parser.js';
import {
  buildKnowledgeTree,
  type CategoryTreeNode,
  type DocumentTreeNode,
  type KnowledgeTree,
} from '../markdown/tree.js';
import type { DocumentFrontmatter } from '../markdown/schema.js';
import type { ProjectMetadata } from '../projects/schema.js';
import { extractMarkdownSections } from '../knowledge/markdown-parser.js';
import type { SourceDocument } from '../knowledge/source.js';
import { ProviderError } from '../providers/provider-error.js';
import type { EmbeddingProvider } from '../providers/provider.js';
import {
  openProjectDatabase,
  openProjectDatabaseReadOnly,
  resolveProjectDatabasePath,
} from './database.js';

interface IndexedCategory {
  id: string;
  parentId: string | null;
  name: string;
  path: string;
  depth: number;
}

interface IndexedDocument {
  metadata: DocumentFrontmatter;
  path: string;
  body: string;
  contentHash: string;
  categoryId: string | null;
}

export interface ProjectIndexRebuildResult {
  categories: number;
  documents: number;
  relations: number;
}

export interface ProjectEmbeddingSyncOptions {
  provider: EmbeddingProvider;
  model: string;
}

interface PreparedProjectIndex {
  categories: IndexedCategory[];
  documents: IndexedDocument[];
  relations: Array<{ sourceId: string; targetId: string; relationType: string }>;
}

interface PreparedEmbedding {
  documentId: string;
  kind: 'document' | 'section';
  sectionId: string;
  sourceHash: string;
  vector: number[];
}

interface EmbeddingInput {
  documentId: string;
  kind: 'document' | 'section';
  sectionId: string;
  sourceHash: string;
  text: string;
}

interface StoredEmbeddingSnapshot {
  metadata: {
    provider_id: string;
    model: string;
    dimensions: number;
    updated_at: string;
  };
  rows: Array<{
    document_id: string;
    kind: 'document' | 'section';
    section_id: string;
    source_hash: string;
    model: string;
    dimensions: number;
    vector_json: string;
  }>;
}

export function rebuildProjectIndex(
  projectRoot: string,
  project: ProjectMetadata,
): ProjectIndexRebuildResult {
  const index = prepareProjectIndex(projectRoot, project);
  return commitProjectIndex(projectRoot, project, index);
}

/** Generate all document/section vectors before the atomic index replacement. */
export async function rebuildProjectIndexWithEmbeddings(
  projectRoot: string,
  project: ProjectMetadata,
  embedding: ProjectEmbeddingSyncOptions,
): Promise<ProjectIndexRebuildResult> {
  const index = prepareProjectIndex(projectRoot, project);
  if (embedding.model.trim().length === 0) {
    throw new InputError('Embedding model must not be empty.');
  }
  const prepared = await createProjectEmbeddings(index.documents, embedding);
  assertPreparedIndexUnchanged(projectRoot, project, index);
  return commitProjectIndex(projectRoot, project, index, {
    providerId: embedding.provider.id,
    model: embedding.model,
    dimensions: prepared.dimensions,
    rows: prepared.rows,
  });
}

export function projectEmbeddingsAreCurrent(
  projectRoot: string,
  project: ProjectMetadata,
  providerId: string,
  model: string,
): boolean {
  const inputs = createProjectEmbeddingInputs(prepareProjectIndex(projectRoot, project).documents);
  const databasePath = resolveProjectDatabasePath(projectRoot);
  if (!existsSync(databasePath)) return inputs.length === 0;

  let database: ReturnType<typeof openProjectDatabaseReadOnly>;
  try {
    database = openProjectDatabaseReadOnly(projectRoot, project);
  } catch {
    return false;
  }
  try {
    const metadata = database.prepare(`
      SELECT provider_id, model, dimensions FROM project_embedding_metadata WHERE project_id = ?
    `).get(project.id) as { provider_id: string; model: string; dimensions: number } | undefined;
    if (inputs.length === 0) return metadata === undefined;
    if (
      metadata === undefined ||
      metadata.provider_id !== providerId ||
      metadata.model !== model
    ) {
      return false;
    }

    const rows = database.prepare(`
      SELECT document_id, kind, section_id, source_hash, model, dimensions, vector_json
      FROM document_embeddings WHERE project_id = ?
    `).all(project.id) as StoredEmbeddingSnapshot['rows'];
    if (rows.length !== inputs.length) return false;
    const rowsByIdentity = new Map<string, StoredEmbeddingSnapshot['rows'][number]>();
    for (const row of rows) {
      const identity = JSON.stringify([row.document_id, row.kind, row.section_id]);
      if (rowsByIdentity.has(identity)) return false;
      rowsByIdentity.set(identity, row);
    }
    return inputs.every((input) => {
      const row = rowsByIdentity.get(JSON.stringify([input.documentId, input.kind, input.sectionId]));
      if (
        row === undefined ||
        row.source_hash !== input.sourceHash ||
        row.model !== model ||
        row.dimensions !== metadata.dimensions
      ) {
        return false;
      }
      try {
        const vector: unknown = JSON.parse(row.vector_json) as unknown;
        return Array.isArray(vector) && vector.length === metadata.dimensions &&
          vector.every((value) => typeof value === 'number' && Number.isFinite(value));
      } catch {
        return false;
      }
    });
  } finally {
    database.close();
  }
}

function assertPreparedIndexUnchanged(
  projectRoot: string,
  project: ProjectMetadata,
  expected: PreparedProjectIndex,
): void {
  const current = prepareProjectIndex(projectRoot, project);
  if (getProjectIndexFingerprint(current) !== getProjectIndexFingerprint(expected)) {
    throw new InputError('Markdown changed while embeddings were being generated; the index was not updated.', {
      suggestedAction: 'Run the index rebuild again to use the current Markdown content.',
    });
  }
}

function getProjectIndexFingerprint(index: PreparedProjectIndex): string {
  return JSON.stringify({
    categories: index.categories,
    documents: index.documents.map((document) => ({
      id: document.metadata.id,
      path: document.path,
      contentHash: document.contentHash,
      categoryId: document.categoryId,
    })),
    relations: index.relations,
  });
}

function prepareProjectIndex(projectRoot: string, project: ProjectMetadata): PreparedProjectIndex {
  const knowledgeRoot = join(projectRoot, 'knowledge');
  const tree = buildKnowledgeTree(knowledgeRoot);
  const canonicalKnowledgeRoot = existsSync(resolve(knowledgeRoot))
    ? resolveKnowledgeRoot(knowledgeRoot)
    : resolve(knowledgeRoot);

  const categories: IndexedCategory[] = [];
  const categoryIdsByPath = new Map<string, string>();
  collectCategories(
    tree,
    canonicalKnowledgeRoot,
    null,
    categories,
    categoryIdsByPath,
  );

  const documents = collectDocuments(
    tree,
    canonicalKnowledgeRoot,
    project,
    categoryIdsByPath,
  );
  const relations = documents.flatMap(({ metadata }) =>
    [...new Set(metadata.related ?? [])].map((targetId) => ({
      sourceId: metadata.id,
      targetId,
      relationType: 'related',
    })),
  );

  return { categories, documents, relations };
}

function commitProjectIndex(
  projectRoot: string,
  project: ProjectMetadata,
  { categories, documents, relations }: PreparedProjectIndex,
  embedding?: { providerId: string; model: string; dimensions?: number; rows: PreparedEmbedding[] },
): ProjectIndexRebuildResult {
  const database = openProjectDatabase(projectRoot, project);
  try {
    const rebuild = database.transaction(() => {
      const preservedEmbeddings = embedding === undefined
        ? captureUnchangedEmbeddings(database, project.id, documents)
        : undefined;
      database.prepare('DELETE FROM project_embedding_metadata WHERE project_id = ?').run(project.id);
      database.prepare('DELETE FROM document_relations').run();
      database.prepare('DELETE FROM document_fts').run();
      database.prepare('DELETE FROM documents WHERE project_id = ?').run(project.id);

      const existingCategoryIds = database
        .prepare('SELECT id FROM categories WHERE project_id = ? ORDER BY depth DESC, path DESC')
        .all(project.id) as Array<{ id: string }>;
      const deleteCategory = database.prepare('DELETE FROM categories WHERE id = ?');
      for (const category of existingCategoryIds) {
        deleteCategory.run(category.id);
      }

      const insertCategory = database.prepare(`
        INSERT INTO categories (id, project_id, parent_id, name, path, depth)
        VALUES (@id, @projectId, @parentId, @name, @path, @depth)
      `);
      for (const category of categories) {
        insertCategory.run({ ...category, projectId: project.id });
      }

      const insertDocument = database.prepare(`
        INSERT INTO documents (
          id, project_id, path, title, category_id, depth, content_hash,
          status, created_at, updated_at
        ) VALUES (
          @id, @projectId, @path, @title, @categoryId, @depth, @contentHash,
          @status, @createdAt, @updatedAt
        )
      `);
      const insertFtsDocument = database.prepare(`
        INSERT INTO document_fts (
          document_id, title, path, tags, description, content
        ) VALUES (@id, @title, @path, @tags, @description, @content)
      `);
      for (const document of documents) {
        insertDocument.run({
          id: document.metadata.id,
          projectId: project.id,
          path: document.path,
          title: document.metadata.title,
          categoryId: document.categoryId,
          depth: document.metadata.depth,
          contentHash: document.contentHash,
          status: document.metadata.status,
          createdAt: document.metadata.created_at ?? project.created_at,
          updatedAt: document.metadata.updated_at ?? project.created_at,
        });
        insertFtsDocument.run({
          id: document.metadata.id,
          title: document.metadata.title,
          path: document.path,
          tags: (document.metadata.tags ?? []).join(' '),
          description: document.metadata.description ?? '',
          content: document.body,
        });
      }

      const insertRelation = database.prepare(`
        INSERT INTO document_relations (source_id, target_id, relation_type)
        VALUES (@sourceId, @targetId, @relationType)
      `);
      for (const relation of relations) {
        insertRelation.run(relation);
      }

      if (embedding !== undefined && embedding.dimensions !== undefined) {
        database.prepare(`
          INSERT INTO project_embedding_metadata (project_id, provider_id, model, dimensions, updated_at)
          VALUES (?, ?, ?, ?, ?)
        `).run(project.id, embedding.providerId, embedding.model, embedding.dimensions, project.updated_at);
        const insertEmbedding = database.prepare(`
          INSERT INTO document_embeddings (
            project_id, document_id, kind, section_id, source_hash, model, dimensions, vector_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const row of embedding.rows) {
          insertEmbedding.run(
            project.id, row.documentId, row.kind, row.sectionId, row.sourceHash,
            embedding.model, embedding.dimensions, JSON.stringify(row.vector),
          );
        }
      } else if (preservedEmbeddings !== undefined) {
        database.prepare(`
          INSERT INTO project_embedding_metadata (project_id, provider_id, model, dimensions, updated_at)
          VALUES (?, ?, ?, ?, ?)
        `).run(
          project.id,
          preservedEmbeddings.metadata.provider_id,
          preservedEmbeddings.metadata.model,
          preservedEmbeddings.metadata.dimensions,
          preservedEmbeddings.metadata.updated_at,
        );
        const insertEmbedding = database.prepare(`
          INSERT INTO document_embeddings (
            project_id, document_id, kind, section_id, source_hash, model, dimensions, vector_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const row of preservedEmbeddings.rows) {
          insertEmbedding.run(
            project.id, row.document_id, row.kind, row.section_id, row.source_hash,
            row.model, row.dimensions, row.vector_json,
          );
        }
      }
    });

    rebuild();
  } catch (cause) {
    if (cause instanceof QLMError) {
      throw cause;
    }
    throw new InternalError('Unable to rebuild the project SQLite index.', {
      cause,
      details: { projectId: project.id, projectRoot },
      suggestedAction:
        'Check the project database and Markdown metadata, then run qlm reindex again.',
    });
  } finally {
    database.close();
  }

  return {
    categories: categories.length,
    documents: documents.length,
    relations: relations.length,
  };
}

function captureUnchangedEmbeddings(
  database: ReturnType<typeof openProjectDatabase>,
  projectId: string,
  documents: IndexedDocument[],
): StoredEmbeddingSnapshot | undefined {
  const existingDocuments = database.prepare(`
    SELECT id, content_hash FROM documents WHERE project_id = ? ORDER BY id
  `).all(projectId) as Array<{ id: string; content_hash: string }>;
  const nextDocuments = [...documents]
    .map(({ metadata, contentHash }) => ({ id: metadata.id, content_hash: contentHash }))
    .sort((left, right) => left.id.localeCompare(right.id));
  if (
    existingDocuments.length !== nextDocuments.length ||
    existingDocuments.some((document, index) => {
      const next = nextDocuments[index];
      return next === undefined || document.id !== next.id || document.content_hash !== next.content_hash;
    })
  ) {
    return undefined;
  }

  const metadata = database.prepare(`
    SELECT provider_id, model, dimensions, updated_at
    FROM project_embedding_metadata WHERE project_id = ?
  `).get(projectId) as StoredEmbeddingSnapshot['metadata'] | undefined;
  if (metadata === undefined) return undefined;
  const rows = database.prepare(`
    SELECT document_id, kind, section_id, source_hash, model, dimensions, vector_json
    FROM document_embeddings WHERE project_id = ?
    ORDER BY document_id, kind, section_id
  `).all(projectId) as StoredEmbeddingSnapshot['rows'];
  if (rows.length === 0) return undefined;

  for (const row of rows) {
    let vector: unknown;
    try {
      vector = JSON.parse(row.vector_json) as unknown;
    } catch {
      return undefined;
    }
    if (
      row.model !== metadata.model ||
      row.dimensions !== metadata.dimensions ||
      !Array.isArray(vector) ||
      vector.length !== metadata.dimensions ||
      !vector.every((value) => typeof value === 'number' && Number.isFinite(value))
    ) {
      return undefined;
    }
  }
  return { metadata, rows };
}

const EMBEDDING_BATCH_SIZE = 32;

async function createProjectEmbeddings(
  documents: IndexedDocument[],
  { provider, model }: ProjectEmbeddingSyncOptions,
): Promise<{ dimensions?: number; rows: PreparedEmbedding[] }> {
  const inputs = createProjectEmbeddingInputs(documents);
  if (inputs.length === 0) {
    return { rows: [] };
  }

  const rows: PreparedEmbedding[] = [];
  let dimensions: number | undefined;
  for (let offset = 0; offset < inputs.length; offset += EMBEDDING_BATCH_SIZE) {
    const batch = inputs.slice(offset, offset + EMBEDDING_BATCH_SIZE);
    let vectors: number[][];
    try {
      vectors = await provider.embed(batch.map(({ text }) => text), model);
    } catch (cause) {
      if (cause instanceof QLMError) throw cause;
      throw new InternalError('Unable to generate project embeddings.', {
        cause,
        suggestedAction: 'Check the configured embedding provider and retry the index rebuild.',
      });
    }

    if (!Array.isArray(vectors) || vectors.length !== batch.length) {
      throw new ProviderError('The embedding provider returned an unexpected number of vectors.');
    }
    for (let index = 0; index < batch.length; index += 1) {
      const input = batch[index];
      const vector = vectors[index];
      if (
        input === undefined ||
        !Array.isArray(vector) ||
        vector.length === 0 ||
        !vector.every((value) => typeof value === 'number' && Number.isFinite(value))
      ) {
        throw new ProviderError('The embedding provider returned an invalid vector.');
      }
      if (dimensions === undefined) {
        dimensions = vector.length;
      } else if (vector.length !== dimensions) {
        throw new ProviderError('The embedding provider returned inconsistent vector dimensions.');
      }
      rows.push({ ...input, vector });
    }
  }
  return { dimensions, rows };
}

function createProjectEmbeddingInputs(documents: IndexedDocument[]): EmbeddingInput[] {
  const inputs: EmbeddingInput[] = [];
  for (const document of documents) {
    const documentText = [
      document.metadata.title,
      document.metadata.description ?? '',
      (document.metadata.tags ?? []).join(' '),
      document.body.trim(),
    ].filter(Boolean).join('\n\n').trim();
    inputs.push({
      documentId: document.metadata.id,
      kind: 'document',
      sectionId: '',
      sourceHash: createHash('sha256').update(documentText, 'utf8').digest('hex'),
      text: documentText,
    });

    const source: SourceDocument = {
      id: document.metadata.id,
      path: document.path,
      format: 'markdown',
      content: document.body,
      hash: document.contentHash,
      size: Buffer.byteLength(document.body, 'utf8'),
      modifiedAt: document.metadata.updated_at ?? document.metadata.created_at ?? '',
      metadata: {},
    };
    for (const section of extractMarkdownSections(source)) {
      const text = [section.title, section.content.trim()].filter(Boolean).join('\n\n');
      inputs.push({
        documentId: document.metadata.id,
        kind: 'section',
        sectionId: section.id,
        sourceHash: createHash('sha256').update(text, 'utf8').digest('hex'),
        text,
      });
    }
  }
  return inputs;
}

function collectCategories(
  tree: KnowledgeTree | CategoryTreeNode,
  knowledgeRoot: string,
  parentId: string | null,
  output: IndexedCategory[],
  idsByPath: Map<string, string>,
): void {
  for (const category of tree.categories) {
    const indexPath = join(knowledgeRoot, ...category.path.split('/'), 'index.md');
    let id = `qlm-category:${category.path}`;
    let indexIsRegularFile = false;
    try {
      const info = lstatSync(indexPath);
      indexIsRegularFile = info.isFile() && !info.isSymbolicLink();
    } catch (cause) {
      if (!isMissingPathError(cause)) {
        throw new ConfigurationError(`Unable to inspect category index: ${indexPath}`, {
          filePath: indexPath,
          cause,
          suggestedAction: 'Check that the category directory is accessible.',
        });
      }
    }
    if (indexIsRegularFile) {
      const index = readMarkdownDocument(indexPath);
      if (index.metadata.type !== 'category-index') {
        throw new ConfigurationError(
          `Category index must use type: category-index: ${indexPath}`,
          {
            filePath: indexPath,
            suggestedAction: 'Use category-index frontmatter for category index files.',
          },
        );
      }
      id = index.metadata.id;
    }

    if (idsByPath.has(category.path)) {
      throw new ConfigurationError(`Category path appears more than once: ${category.path}`, {
        filePath: indexPath,
      });
    }
    idsByPath.set(category.path, id);
    output.push({
      id,
      parentId,
      name: category.name,
      path: category.path,
      depth: category.depth,
    });
    collectCategories(
      category,
      knowledgeRoot,
      id,
      output,
      idsByPath,
    );
  }
}

function collectDocuments(
  tree: KnowledgeTree,
  knowledgeRoot: string,
  project: ProjectMetadata,
  categoryIdsByPath: Map<string, string>,
): IndexedDocument[] {
  const indexed: IndexedDocument[] = [];
  const visit = (node: KnowledgeTree | CategoryTreeNode): void => {
    for (const document of node.documents) {
      indexed.push(indexDocument(document, knowledgeRoot, project, categoryIdsByPath));
    }
    for (const category of node.categories) {
      visit(category);
    }
  };
  visit(tree);
  return indexed;
}

function indexDocument(
  treeDocument: DocumentTreeNode,
  knowledgeRoot: string,
  project: ProjectMetadata,
  categoryIdsByPath: Map<string, string>,
): IndexedDocument {
  const source = readStoredMarkdownSource(knowledgeRoot, treeDocument.path);
  if (source.document.metadata.type !== 'document') {
    throw new ConfigurationError(`Expected a document: ${source.document.sourcePath}`, {
      filePath: source.document.sourcePath,
    });
  }

  const physicalCategoryPath = dirname(treeDocument.path).replaceAll('\\', '/');
  const parentPath = physicalCategoryPath === '.' ? '' : physicalCategoryPath;
  const categoryId = resolveDocumentCategory(
    source.document.metadata,
    parentPath,
    categoryIdsByPath,
    source.document.sourcePath,
  );

  return {
    metadata: source.document.metadata,
    path: treeDocument.path,
    body: source.document.body,
    contentHash: createHash('sha256').update(source.sourceText).digest('hex'),
    categoryId,
  };
}

function resolveDocumentCategory(
  metadata: DocumentFrontmatter,
  parentPath: string,
  categoryIdsByPath: Map<string, string>,
  sourcePath: string,
): string | null {
  if (metadata.category === undefined) {
    return categoryIdsByPath.get(parentPath) ?? null;
  }

  const directMatch = categoryIdsByPath.get(metadata.category);
  if (directMatch !== undefined) {
    return directMatch;
  }

  const nameMatches = [...categoryIdsByPath.entries()].filter(([path]) =>
    path.split('/').at(-1) === metadata.category,
  );
  if (nameMatches.length === 1) {
    return nameMatches[0]![1];
  }
  if (nameMatches.length > 1) {
    throw new ConfigurationError(
      `Document category is ambiguous: ${metadata.category}`,
      {
        filePath: sourcePath,
        suggestedAction: 'Use the full category path in document frontmatter.',
      },
    );
  }

  throw new ConfigurationError(`Document category does not exist: ${metadata.category}`, {
    filePath: sourcePath,
    suggestedAction: 'Create the category or correct the document category field.',
  });
}

function isMissingPathError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
