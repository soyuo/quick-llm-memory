import { Command, Option } from 'commander';
import type { StdioServerHandle } from '@modelcontextprotocol/server/stdio';
import { InputError } from '../errors/qlm-error.js';
import { serveMcpStdio } from './server.js';

export interface McpCommandOptions {
  serveStdio?: () => StdioServerHandle | Promise<StdioServerHandle>;
}

export function registerMcpCommands(
  cli: Command,
  options: McpCommandOptions = {},
): void {
  const startStdioServer = options.serveStdio ?? serveMcpStdio;

  cli
    .command('mcp')
    .description('Manage MCP integration')
    .command('serve')
    .description('Serve the MCP endpoint over stdio')
    .addOption(
      new Option('--transport <transport>', 'MCP transport').default('stdio'),
    )
    .action(async ({ transport }: { transport: string }) => {
      if (transport !== 'stdio') {
        throw new InputError(`Unsupported MCP transport: ${transport}`, {
          suggestedAction: 'Use --transport stdio for the Phase 5 server.',
        });
      }

      await startStdioServer();
    });
}
