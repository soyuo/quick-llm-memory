import { McpServer } from '@modelcontextprotocol/server';
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

export interface ServeMcpStdioOptions {
  transport?: ServeStdioOptions['transport'];
  onError?: (error: Error) => void;
}

export interface CreateMcpServerOptions {
  dataRoot?: string;
  embeddingProviderFactory?: () => { provider: EmbeddingProvider; model: string };
}

export function createMcpServer(options: CreateMcpServerOptions = {}): McpServer {
  const server = new McpServer({
    name: 'quick-llm-memory',
    version: packageMetadata.version,
  });
  const paths = resolveSettingsPaths();
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
  registerMcpResources(server, { dataRoot });
  registerMcpPrompts(server);
  return server;
}

export function serveMcpStdio(
  options: ServeMcpStdioOptions = {},
): StdioServerHandle {
  return serveStdio(() => createMcpServer(), {
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
