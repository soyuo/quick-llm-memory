import { Command, Option } from 'commander';
import type { StdioServerHandle } from '@modelcontextprotocol/server/stdio';
import { InputError } from '../errors/qlm-error.js';
import {
  createMcpClientConfig,
  formatMcpClientConfig,
  type McpClient,
  type McpStdioServerConfig,
} from './client-config.js';
import { serveMcpStdio } from './server.js';

export interface McpCommandOptions {
  serveStdio?: () => StdioServerHandle | Promise<StdioServerHandle>;
  stdioServerConfig?: McpStdioServerConfig;
  writeOut?: (text: string) => void;
}

export function registerMcpCommands(
  cli: Command,
  options: McpCommandOptions = {},
): void {
  const startStdioServer = options.serveStdio ?? serveMcpStdio;

  const mcp = cli
    .command('mcp')
    .description('Manage MCP integration');

  mcp
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

  mcp
    .command('config <client>')
    .description('Print a mergeable stdio config snippet for an MCP client')
    .action((clientName: string) => {
      if (!isMcpClient(clientName)) {
        throw new InputError(
          `Unsupported MCP client: ${clientName}. Use claude-code, cursor, or vscode.`,
        );
      }

      const server = options.stdioServerConfig ?? {
        command: process.execPath,
        args: [process.argv[1] ?? 'qlm', 'mcp', 'serve', '--transport', 'stdio'],
      };
      const generated = createMcpClientConfig(clientName, server);
      const writeOut = options.writeOut ?? ((text: string) => process.stdout.write(text));
      writeOut(
        `Target: ${generated.path}\n` +
          'Merge this snippet under mcpServers in the existing client configuration; keep other settings.\n' +
          'Install quick-llm-memory where this command can run.\n' +
          `${formatMcpClientConfig(generated)}\n`,
      );
    });
}

function isMcpClient(value: string): value is McpClient {
  return value === 'claude-code' || value === 'cursor' || value === 'vscode';
}
