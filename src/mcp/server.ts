import { McpServer } from '@modelcontextprotocol/server';
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  serveStdio,
  type ServeStdioOptions,
  type StdioServerHandle,
} from '@modelcontextprotocol/server/stdio';
import { packageMetadata } from '../package-metadata.js';
import { resolveSettingsPaths } from '../config/paths.js';
import { loadSettings } from '../config/settings.js';
import { createConfiguredEmbeddingProvider } from '../providers/configured-build-provider.js';
import type { EmbeddingProvider } from '../providers/provider.js';
import { registerMcpTools } from './tools.js';
import { registerMcpResources } from './resources.js';
import { registerMcpPrompts } from './prompts.js';
import { runWithMcpPermissions, type McpPermission } from './access.js';

export const mcpRequestSignal = new AsyncLocalStorage<AbortSignal>();

export interface ServeMcpStdioOptions {
  transport?: ServeStdioOptions['transport'];
  onError?: (error: Error) => void;
  serverOptions?: CreateMcpServerOptions;
}

export interface CreateMcpServerOptions {
  dataRoot?: string;
  embeddingProviderFactory?: () => { provider: EmbeddingProvider; model: string };
  onToolExecutionChange?: (delta: 1 | -1) => void;
  permissions?: ReadonlySet<McpPermission>;
}

export function createMcpServer(options: CreateMcpServerOptions = {}): McpServer {
  const paths = resolveSettingsPaths();
  const permissions = options.permissions ?? new Set<McpPermission>(loadSettings({ paths }).mcp.permissions);
  const server = new McpServer({
    name: 'quick-llm-memory',
    version: packageMetadata.version,
  });
  {
    const registerTool = server.registerTool.bind(server) as (...args: unknown[]) => unknown;
    server.registerTool = ((...args: unknown[]) => {
      const last = args.length - 1;
      const callback = args[last];
      if (typeof callback === 'function') {
        args[last] = async (...callbackArgs: unknown[]) => {
          options.onToolExecutionChange?.(1);
          try {
            const signal = mcpRequestSignal.getStore();
            if (signal !== undefined) {
              const context = callbackArgs[1];
              callbackArgs[1] = typeof context === 'object' && context !== null
                ? { ...context, signal }
                : { signal };
            }
            return await runWithMcpPermissions(
              permissions,
              () => callback(...callbackArgs),
            );
          } finally {
            options.onToolExecutionChange?.(-1);
          }
        };
      }
      return registerTool(...args);
    }) as typeof server.registerTool;
  }
  const dataRoot = options.dataRoot ?? paths.dataRoot;
  registerMcpTools(server, {
    dataRoot,
    embeddingProviderFactory: options.embeddingProviderFactory ?? (() => {
      const settings = loadSettings({ paths });
      return {
        provider: createConfiguredEmbeddingProvider(settings),
        model: settings.ai?.embedding_model ?? 'text-embedding-3-small',
      };
    }),
  });
  registerMcpResources(server, { dataRoot, permissions });
  registerMcpPrompts(server);
  return server;
}

export function serveMcpStdio(
  options: ServeMcpStdioOptions = {},
): StdioServerHandle {
  return serveStdio(() => createMcpServer(options.serverOptions), {
    transport: options.transport,
    onerror: (error) => {
      if (options.onError !== undefined) {
        options.onError(error);
        return;
      }

      process.stderr.write('MCP transport error.\n');
    },
  });
}
