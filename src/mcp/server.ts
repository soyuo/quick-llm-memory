import { McpServer } from '@modelcontextprotocol/server';
import {
  serveStdio,
  type ServeStdioOptions,
  type StdioServerHandle,
} from '@modelcontextprotocol/server/stdio';
import { packageMetadata } from '../package-metadata.js';

export interface ServeMcpStdioOptions {
  transport?: ServeStdioOptions['transport'];
  onError?: (error: Error) => void;
}

export function createMcpServer(): McpServer {
  return new McpServer({
    name: 'quick-llm-memory',
    version: packageMetadata.version,
  });
}

export function serveMcpStdio(
  options: ServeMcpStdioOptions = {},
): StdioServerHandle {
  return serveStdio(createMcpServer, {
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
