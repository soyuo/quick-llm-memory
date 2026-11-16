import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { InputError } from '../errors/qlm-error.js';
import { assertMcpOperationAllowed, readMcpProjectDocument, resolveMcpProjectScope } from './access.js';
import type { RegisterMcpToolsOptions } from './tools.js';

const DEFAULT_READ_MANY_MAX_TOKENS = 4000;
const MAX_READ_MANY_MAX_TOKENS = 100_000;
const MAX_READ_MANY_PATHS = 100;

interface ReadDocument {
  path: string;
  metadata: ReturnType<typeof readMcpProjectDocument>['metadata'];
  body: string;
}

export function registerMcpDocumentTools(
  server: McpServer,
  options: RegisterMcpToolsOptions,
): void {
  server.registerTool(
    'memory_read',
    {
      description: 'Read one Markdown document from a selected project.',
      inputSchema: z.object({
        project: z.string().min(1).max(64),
        path: z.string().min(1).max(512),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    ({ project, path }) => {
      assertMcpOperationAllowed('read');
      try {
        const scope = resolveMcpProjectScope(options.dataRoot, project);
        const document = readMcpProjectDocument(scope, path);
        return structuredResult({ project: scope.project.name, document });
      } catch (error) {
        return safeError(error);
      }
    },
  );

  server.registerTool(
    'memory_read_many',
    {
      description: 'Read an ordered set of project Markdown documents within a token budget.',
      inputSchema: z.object({
        project: z.string().min(1).max(64),
        paths: z.array(z.string().min(1).max(512)).min(1).max(MAX_READ_MANY_PATHS),
        max_tokens: z.number().int().min(0).max(MAX_READ_MANY_MAX_TOKENS)
          .default(DEFAULT_READ_MANY_MAX_TOKENS),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    ({ project, paths, max_tokens: maxTokens }) => {
      assertMcpOperationAllowed('read');
      try {
        const scope = resolveMcpProjectScope(options.dataRoot, project);
        const sortedPaths = [...new Set(paths)].sort(comparePaths);
        if (maxTokens === 0) {
          return structuredResult({
            project: scope.project.name,
            documents: [],
            maxTokens,
            consumedTokens: 0,
            tokenCountsAreEstimates: true,
            omittedCount: sortedPaths.length,
          });
        }

        const documents: ReadDocument[] = [];
        for (const path of sortedPaths) {
          const document = readMcpProjectDocument(scope, path);
          const candidateDocuments = [...documents, document];
          const remainingOmitted = sortedPaths.length - candidateDocuments.length;
          if (
            estimateReadManyTokens(
              scope.project.name,
              candidateDocuments,
              maxTokens,
              remainingOmitted,
            ) <= maxTokens
          ) {
            documents.push(document);
          }
        }

        const omittedCount = sortedPaths.length - documents.length;
        const consumedTokens = documents.length === 0
          ? 0
          : estimateReadManyTokens(scope.project.name, documents, maxTokens, omittedCount);
        return structuredResult({
          project: scope.project.name,
          documents,
          maxTokens,
          consumedTokens,
          tokenCountsAreEstimates: true,
          omittedCount,
        });
      } catch (error) {
        return safeError(error);
      }
    },
  );

  server.registerTool(
    'memory_get_metadata',
    {
      description: 'Read validated frontmatter metadata for one project document.',
      inputSchema: z.object({
        project: z.string().min(1).max(64),
        path: z.string().min(1).max(512),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    ({ project, path }) => {
      assertMcpOperationAllowed('read');
      try {
        const scope = resolveMcpProjectScope(options.dataRoot, project);
        const document = readMcpProjectDocument(scope, path);
        return structuredResult({
          project: scope.project.name,
          path: document.path,
          metadata: document.metadata,
        });
      } catch (error) {
        return safeError(error);
      }
    },
  );
}

function estimateReadManyTokens(
  project: string,
  documents: readonly ReadDocument[],
  maxTokens: number,
  omittedCount: number,
): number {
  const response = JSON.stringify({
    project,
    documents,
    maxTokens,
    consumedTokens: Number.MAX_SAFE_INTEGER,
    tokenCountsAreEstimates: true,
    omittedCount,
  });
  return Math.ceil(response.length / 4);
}

function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
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
        : 'The requested project document is unavailable.',
    }],
    isError: true,
  };
}
