import { lstatSync, readdirSync, type Dirent } from 'node:fs';
import { extname, join, relative, resolve, sep } from 'node:path';
import { ConfigurationError } from '../config/error.js';
import { InputError } from '../errors/qlm-error.js';
import { readMarkdownDocument } from './parser.js';
import { readStoredMarkdownDocument, resolveKnowledgeRoot } from './repository.js';

export interface KnowledgeTree {
  path: '';
  depth: 0;
  categories: CategoryTreeNode[];
  documents: DocumentTreeNode[];
  truncated?: boolean;
}

export interface KnowledgeTreeOptions {
  maxDepth?: number;
  maxEntries?: number;
}

interface TreeScanBudget {
  maxDepth: number;
  remaining: number;
  truncated: boolean;
}

export interface CategoryTreeNode {
  type: 'category';
  name: string;
  title: string;
  path: string;
  depth: number;
  categories: CategoryTreeNode[];
  documents: DocumentTreeNode[];
}

export interface DocumentTreeNode {
  type: 'document';
  name: string;
  id: string;
  title: string;
  path: string;
  depth: number;
}

interface DirectoryTreeContents {
  title: string;
  categories: CategoryTreeNode[];
  documents: DocumentTreeNode[];
}

export function buildKnowledgeTree(
  knowledgeRoot: string,
  options: KnowledgeTreeOptions = {},
): KnowledgeTree {
  if (knowledgeRoot.trim().length === 0) {
    throw new InputError('Knowledge root must be a non-empty path.');
  }
  if (
    options.maxDepth !== undefined
    && (!Number.isSafeInteger(options.maxDepth) || options.maxDepth < 0)
  ) {
    throw new InputError('Knowledge tree maxDepth must be a non-negative safe integer.');
  }
  if (
    options.maxEntries !== undefined
    && (!Number.isSafeInteger(options.maxEntries) || options.maxEntries < 1)
  ) {
    throw new InputError('Knowledge tree maxEntries must be a positive safe integer.');
  }

  const requestedRoot = resolve(knowledgeRoot);
  try {
    lstatSync(requestedRoot);
  } catch (cause) {
    if (isMissingPathError(cause)) {
      return createEmptyTree();
    }
    throw directoryReadError(requestedRoot, cause);
  }

  const root = resolveKnowledgeRoot(requestedRoot);
  const budget: TreeScanBudget = {
    maxDepth: options.maxDepth ?? Number.MAX_SAFE_INTEGER,
    remaining: options.maxEntries ?? Number.MAX_SAFE_INTEGER,
    truncated: false,
  };
  const contents = scanDirectory(root, root, '', budget);
  return {
    path: '',
    depth: 0,
    categories: contents.categories,
    documents: contents.documents,
    ...(options.maxDepth === undefined && options.maxEntries === undefined
      ? {}
      : { truncated: budget.truncated }),
  };
}

function scanDirectory(
  root: string,
  directoryPath: string,
  relativeDirectoryPath: string,
  budget: TreeScanBudget,
): DirectoryTreeContents {
  let entries: Dirent[];
  try {
    entries = readdirSync(directoryPath, { withFileTypes: true });
  } catch (cause) {
    throw directoryReadError(directoryPath, cause);
  }

  const categories: CategoryTreeNode[] = [];
  const documents: DocumentTreeNode[] = [];
  let title = relativeDirectoryPath.length === 0
    ? ''
    : relativeDirectoryPath.split('/').at(-1) ?? '';
  const depth = relativeDirectoryPath.length === 0
    ? 0
    : relativeDirectoryPath.split('/').length;

  for (const entry of entries.sort((left, right) => compareNames(left.name, right.name))) {
    if (entry.isSymbolicLink()) {
      continue;
    }

    const entryPath = join(directoryPath, entry.name);
    const relativePath = relativeDirectoryPath.length === 0
      ? entry.name
      : `${relativeDirectoryPath}/${entry.name}`;

    if (entry.isDirectory()) {
      const childDepth = depth + 1;
      if (childDepth > budget.maxDepth) {
        budget.truncated = true;
        continue;
      }
      if (budget.remaining === 0) {
        budget.truncated = true;
        break;
      }
      budget.remaining -= 1;
      const contents = scanDirectory(root, entryPath, relativePath, budget);
      categories.push({
        type: 'category',
        name: entry.name,
        title: contents.title || entry.name,
        path: relativePath,
        depth: depth + 1,
        categories: contents.categories,
        documents: contents.documents,
      });
      continue;
    }

    if (!entry.isFile() || extname(entry.name).toLowerCase() !== '.md') {
      continue;
    }

    if (entry.name.toLowerCase() === 'index.md') {
      if (relativeDirectoryPath.length === 0) {
        continue;
      }

      const index = readMarkdownDocument(entryPath);
      if (index.metadata.type !== 'category-index') {
        throw new ConfigurationError(
          `Category index must use type: category-index: ${entryPath}`,
          {
            filePath: entryPath,
            suggestedAction:
              'Use category-index frontmatter for a category index.md file.',
          },
        );
      }
      title = index.metadata.title;
      continue;
    }

    const documentDepth = depth + 1;
    if (documentDepth > budget.maxDepth) {
      budget.truncated = true;
      continue;
    }
    if (budget.remaining === 0) {
      budget.truncated = true;
      break;
    }
    budget.remaining -= 1;

    const documentPath = toPortableRelativePath(root, entryPath);
    const document = readStoredMarkdownDocument(root, documentPath);
    documents.push({
      type: 'document',
      name: entry.name,
      id: document.metadata.id,
      title: document.metadata.title,
      path: documentPath,
      depth: documentDepth,
    });
  }

  return { title, categories, documents };
}

function createEmptyTree(): KnowledgeTree {
  return { path: '', depth: 0, categories: [], documents: [] };
}

function toPortableRelativePath(root: string, filePath: string): string {
  return relative(root, filePath).split(sep).join('/');
}

function compareNames(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function directoryReadError(filePath: string, cause: unknown): ConfigurationError {
  return new ConfigurationError(`Unable to read knowledge directory: ${filePath}`, {
    filePath,
    cause,
    suggestedAction: 'Check that the project knowledge directory is accessible.',
  });
}

function isMissingPathError(error: unknown): error is NodeJS.ErrnoException {
  return (
    error instanceof Error &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}
