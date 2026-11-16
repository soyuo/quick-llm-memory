import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/server';
import { InputError } from '../errors/qlm-error.js';
import { buildKnowledgeTree, type CategoryTreeNode, type DocumentTreeNode } from '../markdown/tree.js';
import { readStoredMarkdownResource } from '../markdown/repository.js';
import { listProjects } from '../projects/manager.js';
import { validateProjectName } from '../projects/schema.js';
import { assertMcpOperationAllowed, resolveMcpProjectScope } from './access.js';

export interface KnowledgeResourceUri {
  project: string;
  path: string;
}

export interface RegisterMcpResourcesOptions {
  dataRoot: string;
}

export function parseKnowledgeResourceUri(uri: string): KnowledgeResourceUri {
  const match = /^qlm:\/\/([^/?#]+)(\/[^?#]*)$/i.exec(uri);
  if (match === null) {
    throw new InputError('Invalid project knowledge resource URI.');
  }

  const project = validateProjectName(match[1]!);
  const segments = match[2]!.slice(1).split('/').map(decodeUriSegment);
  if (
    segments.length === 0
    || segments.some((segment) => (
      segment.length === 0
      || segment === '.'
      || segment === '..'
      || segment.includes('/')
      || segment.includes('\\')
      || /[\u0000-\u001f\u007f]/.test(segment)
    ))
  ) {
    throw new InputError('Invalid project knowledge resource URI.');
  }

  const relativePath = segments.join('/');
  if (!relativePath.toLowerCase().endsWith('.md')) {
    throw new InputError('Knowledge resources must reference Markdown files.');
  }

  return { project, path: relativePath };
}

export function createKnowledgeResourceUri(project: string, relativePath: string): string {
  const path = relativePath.split('/').map((segment) => encodeURIComponent(segment)).join('/');
  return `qlm://${encodeURIComponent(project)}/${path}`;
}

export function registerMcpResources(
  server: McpServer,
  options: RegisterMcpResourcesOptions,
): void {
  assertMcpOperationAllowed('read');
  server.registerResource(
    'project-knowledge-markdown',
    new ResourceTemplate('qlm://{project}{+path}', {
      list: async () => {
        try {
          return { resources: listKnowledgeResources(options.dataRoot) };
        } catch {
          throw new Error('Unable to list project knowledge resources.');
        }
      },
    }),
    {
      title: 'Project knowledge Markdown',
      description: 'Read-only Markdown documents and category indexes in initialized projects.',
      mimeType: 'text/markdown',
    },
    async (uri) => {
      try {
        const resource = parseKnowledgeResourceUri(uri.href);
        const scope = resolveMcpProjectScope(options.dataRoot, resource.project);
        assertMcpOperationAllowed('read');
        const stored = readStoredMarkdownResource(scope.knowledgeRoot, resource.path);
        return {
          contents: [{
            uri: createKnowledgeResourceUri(resource.project, resource.path),
            mimeType: 'text/markdown',
            text: stored.sourceText,
          }],
        };
      } catch {
        throw new Error('Requested project knowledge resource is unavailable.');
      }
    },
  );
}

export function listKnowledgeResources(dataRoot: string) {
  const resources: Array<{
    uri: string;
    name: string;
    title: string;
    description: string;
    mimeType: string;
  }> = [];

  for (const project of listProjects(dataRoot)) {
    const scope = resolveMcpProjectScope(dataRoot, project.name);
    const tree = buildKnowledgeTree(scope.knowledgeRoot);
    const paths = new Set<string>();

    const rootIndex = regularMarkdownFile(scope.knowledgeRoot, 'index.md');
    if (rootIndex) {
      const index = readStoredMarkdownResource(scope.knowledgeRoot, 'index.md');
      if (index.document.metadata.type === 'category-index') {
        paths.add('index.md');
      }
    }

    collectCategoryResources(scope.knowledgeRoot, tree.categories, paths);
    collectDocumentResources(tree.documents, paths);

    for (const path of [...paths].sort(comparePaths)) {
      resources.push({
        uri: createKnowledgeResourceUri(project.name, path),
        name: `${project.name}/${path}`,
        title: path,
        description: 'Project knowledge Markdown resource.',
        mimeType: 'text/markdown',
      });
    }
  }

  return resources.sort((left, right) => comparePaths(left.uri, right.uri));
}

function collectCategoryResources(
  knowledgeRoot: string,
  categories: readonly CategoryTreeNode[],
  paths: Set<string>,
): void {
  for (const category of categories) {
    const indexPath = `${category.path}/index.md`;
    if (regularMarkdownFile(knowledgeRoot, indexPath)) {
      paths.add(indexPath);
    }
    collectDocumentResources(category.documents, paths);
    collectCategoryResources(knowledgeRoot, category.categories, paths);
  }
}

function collectDocumentResources(
  documents: readonly DocumentTreeNode[],
  paths: Set<string>,
): void {
  for (const document of documents) {
    paths.add(document.path);
  }
}

function regularMarkdownFile(root: string, relativePath: string): boolean {
  try {
    const info = lstatSync(join(root, ...relativePath.split('/')));
    return info.isFile() && !info.isSymbolicLink();
  } catch (error) {
    if (isMissingPathError(error)) {
      return false;
    }
    throw error;
  }
}

function decodeUriSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    throw new InputError('Invalid project knowledge resource URI.');
  }
}

function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isMissingPathError(error: unknown): boolean {
  return (
    error instanceof Error
    && 'code' in error
    && (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}
