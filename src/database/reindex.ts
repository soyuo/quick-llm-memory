import { createHash } from 'node:crypto';
import { existsSync, lstatSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { ConfigurationError } from '../config/error.js';
import { InternalError, QLMError } from '../errors/qlm-error.js';
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
import { openProjectDatabase } from './database.js';

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
  contentHash: string;
  categoryId: string | null;
}

export interface ProjectIndexRebuildResult {
  categories: number;
  documents: number;
  relations: number;
}

export function rebuildProjectIndex(
  projectRoot: string,
  project: ProjectMetadata,
): ProjectIndexRebuildResult {
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

  const database = openProjectDatabase(projectRoot, project);
  try {
    const rebuild = database.transaction(() => {
      database.prepare('DELETE FROM document_relations').run();
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
      }

      const insertRelation = database.prepare(`
        INSERT INTO document_relations (source_id, target_id, relation_type)
        VALUES (@sourceId, @targetId, @relationType)
      `);
      for (const relation of relations) {
        insertRelation.run(relation);
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
