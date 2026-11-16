import { McpServer } from '@modelcontextprotocol/server';
import {
  serveStdio,
  type ServeStdioOptions,
  type StdioServerHandle,
} from '@modelcontextprotocol/server/stdio';
import { packageMetadata } from '../package-metadata.js';
import { resolveSettingsPaths } from '../config/paths.js';
import { registerMcpTools } from './tools.js';
import { registerMcpResources } from './resources.js';
import { registerMcpPrompts } from './prompts.js';

export interface ServeMcpStdioOptions {
  transport?: ServeStdioOptions['transport'];
  onError?: (error: Error) => void;
}

export interface CreateMcpServerOptions {
  dataRoot?: string;
}

export function createMcpServer(options: CreateMcpServerOptions = {}): McpServer {
  const server = new McpServer({
    name: 'quick-llm-memory',
    version: packageMetadata.version,
  });
  const dataRoot = options.dataRoot ?? resolveSettingsPaths().dataRoot;
  registerMcpTools(server, { dataRoot });
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
