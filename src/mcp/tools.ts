import { lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { InputError, QLMError } from '../errors/qlm-error.js';
import { buildKnowledgeTree } from '../markdown/tree.js';
import { listProjects } from '../projects/manager.js';
import { validateProjectName } from '../projects/schema.js';
import { searchProjectDocuments } from '../retrieval/search.js';
import { assertMcpOperationAllowed, resolveMcpProjectScope } from './access.js';
import { registerMcpDocumentTools } from './document-tools.js';

export interface RegisterMcpToolsOptions {
  dataRoot: string;
}

const MAX_TREE_DEPTH = 5;

export function registerMcpTools(
  server: McpServer,
  options: RegisterMcpToolsOptions,
): void {
  server.registerTool(
    'memory_list_projects',
    {
      description: 'List initialized projects available in the configured data directory.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    () => {
      assertMcpOperationAllowed('read');
      try {
        const projects = listSafeProjects(options.dataRoot);
        return structuredResult({ projects });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'memory_get_tree',
    {
      description: 'Browse a project knowledge tree using relative Markdown paths.',
      inputSchema: z.object({
        project: z.string().min(1).max(64),
        maxDepth: z.number().int().min(0).max(MAX_TREE_DEPTH).optional(),
        maxEntries: z.number().int().min(1).max(500).default(100),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    ({ project, maxDepth, maxEntries }) => {
      assertMcpOperationAllowed('read');
      try {
        const scope = resolveMcpProjectScope(options.dataRoot, project);
        const tree = buildKnowledgeTree(scope.knowledgeRoot, {
          maxDepth: maxDepth ?? MAX_TREE_DEPTH,
          maxEntries,
        });
        const { truncated = false, ...treeResult } = tree;
        return structuredResult({
          project: scope.project.name,
          tree: treeResult,
          truncated,
        });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'memory_search',
    {
      description: 'Search indexed Markdown documents in a project.',
      inputSchema: z.object({
        project: z.string().min(1).max(64),
        query: z.string().trim().min(1).max(500),
        mode: z.enum(['path', 'hierarchical', 'fulltext', 'hybrid']).default('hybrid'),
        maxResults: z.number().int().min(0).max(100).default(10),
        maxDepth: z.number().int().min(0).max(MAX_TREE_DEPTH).optional(),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    ({ project, query, mode, maxResults, maxDepth }) => {
      assertMcpOperationAllowed('read');
      try {
        const scope = resolveMcpProjectScope(options.dataRoot, project);
        const results = searchProjectDocuments({
          projectId: scope.project.id,
          projectRoot: scope.projectRoot,
          project: scope.project,
          query,
          mode,
          maxResults,
          synchronizeStaleIndex: false,
          ...(maxDepth === undefined ? {} : { maxDepth }),
        });
        return structuredResult({ project: scope.project.name, results });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  registerMcpDocumentTools(server, options);
}

function listSafeProjects(dataRoot: string) {
  assertMcpOperationAllowed('read');
  const projectsRoot = join(dataRoot, 'projects');
  try {
    const rootInfo = lstatSync(projectsRoot);
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
      throw new InputError('Project directory is unavailable.');
    }
  } catch (error) {
    if (isMissing(error)) return [];
    throw new InputError('Project directory is unavailable.', { cause: error });
  }

  for (const entry of readdirSync(projectsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      const name = validateProjectName(entry.name);
      const projectDirectory = join(projectsRoot, name);
      const projectInfo = lstatSync(projectDirectory);
      if (projectInfo.isSymbolicLink() || !projectInfo.isDirectory()) continue;
      const metadataInfo = lstatSync(join(projectDirectory, 'project.yaml'));
      if (metadataInfo.isSymbolicLink() || !metadataInfo.isFile()) {
        throw new InputError('Project metadata is unavailable.');
      }
    } catch (error) {
      if (isMissing(error)) continue;
      throw error;
    }
  }
  return listProjects(dataRoot).map((project) => ({
    id: project.id,
    name: project.name,
    createdAt: project.created_at,
    updatedAt: project.updated_at,
  }));
}

function structuredResult(value: Record<string, unknown>) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

function toolError(error: unknown) {
  const message = error instanceof InputError
    ? 'The MCP request has invalid or unavailable project input.'
    : error instanceof QLMError
      ? 'The requested project data is unavailable.'
      : 'The MCP request could not be completed.';
  return { content: [{ type: 'text' as const, text: message }], isError: true };
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT';
}
