import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { QLMError, InputError } from '../errors/qlm-error.js';
import { validateInternalLinks } from '../markdown/link-validator.js';
import { searchProjectDocuments } from '../retrieval/search.js';
import { buildRetrievalContext } from '../retrieval/context-builder.js';
import { assertMcpOperationAllowed, resolveMcpProjectScope } from './access.js';
import type { RegisterMcpToolsOptions } from './tools.js';

const MAX_CONTEXT_TOKENS = 10_000;
const MAX_RELATED_DOCUMENTS = 20;

export function registerMcpKnowledgeTools(
  server: McpServer,
  options: RegisterMcpToolsOptions,
): void {
  server.registerTool(
    'memory_get_context',
    {
      description: 'Build bounded source-aware Markdown context for a project query.',
      inputSchema: z.object({
        project: z.string().min(1).max(64),
        query: z.string().trim().min(1).max(500),
        mode: z.enum(['path', 'hierarchical', 'fulltext', 'hybrid']).default('hybrid'),
        max_tokens: z.number().int().min(0).max(MAX_CONTEXT_TOKENS).default(3000),
        max_results: z.number().int().min(0).max(100).default(10),
        max_depth: z.number().int().min(0).max(5).optional(),
        include_related: z.boolean().default(false),
        max_related_results: z.number().int().min(0).max(MAX_RELATED_DOCUMENTS).optional(),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    ({ project, query, mode, max_tokens, max_results, max_depth, include_related, max_related_results }) => {
      assertMcpOperationAllowed('read');
      try {
        if (max_depth !== undefined && mode !== 'hierarchical') {
          throw new InputError('max_depth applies only to hierarchical retrieval.');
        }
        const scope = resolveMcpProjectScope(options.dataRoot, project);
        const context = buildRetrievalContext({
          projectId: scope.project.id,
          projectRoot: scope.projectRoot,
          project: scope.project,
          query,
          mode,
          maxTokens: max_tokens,
          maxResults: max_results,
          includeRelated: include_related,
          synchronizeStaleIndex: false,
          ...(max_depth === undefined ? {} : { maxDepth: max_depth }),
          ...(max_related_results === undefined
            ? {}
            : { maxRelatedResults: max_related_results }),
        });
        return structuredResult({ project: scope.project.name, ...context });
      } catch (error) {
        return safeError(error);
      }
    },
  );

  server.registerTool(
    'memory_get_related',
    {
      description: 'List one level of directed related Markdown documents.',
      inputSchema: z.object({
        project: z.string().min(1).max(64),
        path: z.string().min(1).max(512),
        max_results: z.number().int().min(0).max(MAX_RELATED_DOCUMENTS).default(5),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    ({ project, path, max_results }) => {
      assertMcpOperationAllowed('read');
      try {
        const scope = resolveMcpProjectScope(options.dataRoot, project);
        const results = searchProjectDocuments({
          projectId: scope.project.id,
          projectRoot: scope.projectRoot,
          project: scope.project,
          query: path,
          mode: 'path',
          maxResults: 1,
          includeRelated: true,
          maxRelatedResults: max_results,
          synchronizeStaleIndex: false,
        });
        const primaryId = results[0]?.documentId;
        const related = primaryId === undefined
          ? []
          : results.filter((result) => result.documentId !== primaryId);
        return structuredResult({ project: scope.project.name, path, related });
      } catch (error) {
        return safeError(error);
      }
    },
  );

  server.registerTool(
    'memory_validate',
    {
      description: 'Check project Markdown internal links without modifying files or indexes.',
      inputSchema: z.object({ project: z.string().min(1).max(64) }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    ({ project }) => {
      assertMcpOperationAllowed('read');
      try {
        const scope = resolveMcpProjectScope(options.dataRoot, project);
        const result = validateInternalLinks(scope.knowledgeRoot);
        const brokenLinks = result.brokenLinks.map((link) => ({
          sourcePath: link.sourcePath,
          line: link.line,
          reason: link.reason,
          ...(link.reason === 'missing' ? { target: link.target } : {}),
        }));
        return structuredResult({
          project: scope.project.name,
          valid: brokenLinks.length === 0,
          filesScanned: result.filesScanned,
          linksChecked: result.linksChecked,
          brokenLinks,
        });
      } catch (error) {
        return safeError(error);
      }
    },
  );
}

function structuredResult(value: Record<string, unknown>) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

function safeError(error: unknown) {
  return {
    content: [{
      type: 'text' as const,
      text: error instanceof InputError
        ? 'The MCP request has invalid or unavailable project input.'
        : error instanceof QLMError
          ? 'The requested project data is unavailable.'
          : 'The MCP request could not be completed.',
    }],
    isError: true,
  };
}
