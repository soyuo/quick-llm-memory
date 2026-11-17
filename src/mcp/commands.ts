import { Command, Option } from 'commander';
import type { StdioServerHandle } from '@modelcontextprotocol/server/stdio';
import { InputError } from '../errors/qlm-error.js';
import {
  createMcpClientConfig,
  createDefaultMcpStdioServerConfig,
  formatMcpClientConfig,
  type McpClient,
  type McpStdioServerConfig,
} from './client-config.js';
import { serveMcpStdio } from './server.js';
import { serveMcpHttp, type McpHttpServerHandle } from './http-server.js';
import type { ServeMcpHttpOptions } from './http-server.js';

export interface McpCommandOptions {
  serveStdio?: () => StdioServerHandle | Promise<StdioServerHandle>;
  serveHttp?: (options: Pick<ServeMcpHttpOptions, 'host' | 'port' | 'managedInstanceId' | 'allowRemote' | 'confirmRemoteExposure' | 'allowedHosts' | 'allowedOrigins' | 'bearerToken'>) =>
    McpHttpServerHandle | Promise<McpHttpServerHandle>;
  registerHttpShutdown?: (handler: () => Promise<void>) => () => void;
  stdioServerConfig?: McpStdioServerConfig;
  writeOut?: (text: string) => void;
  writeError?: (text: string) => void;
}

export function registerMcpCommands(
  cli: Command,
  options: McpCommandOptions = {},
): void {
  const startStdioServer = options.serveStdio ?? serveMcpStdio;
  const startHttpServer = options.serveHttp ?? serveMcpHttp;

  const mcp = cli
    .command('mcp')
    .description('Manage MCP integration');

  mcp
    .command('serve')
    .description('Serve the MCP endpoint over stdio or Streamable HTTP')
    .addOption(
      new Option('--transport <transport>', 'MCP transport').default('stdio'),
    )
    .addOption(
      new Option('--host <host>', 'HTTP bind host (loopback by default)')
        .default('127.0.0.1'),
    )
    .addOption(
      new Option('--port <port>', 'HTTP bind port')
        .argParser(parseHttpPort)
        .default(8765),
    )
    .addOption(
      new Option('--managed-instance-id <id>').hideHelp(),
    )
    .option('--allow-remote', 'Permit binding outside loopback')
    .option('--confirm-remote-exposure', 'Confirm exposure of the MCP HTTP endpoint')
    .option('--allowed-host <hostname>', 'Allowed Host header hostname (repeatable)', (value, previous: string[] = []) => [...previous, value])
    .option('--allowed-origin <hostname>', 'Allowed Origin hostname (repeatable)', (value, previous: string[] = []) => [...previous, value])
    .action(async ({ transport, host, port, managedInstanceId, allowRemote, confirmRemoteExposure, allowedHost, allowedOrigin }: {
      transport: string;
      host: string;
      port: number;
      managedInstanceId?: string;
      allowRemote?: boolean;
      confirmRemoteExposure?: boolean;
      allowedHost?: string[];
      allowedOrigin?: string[];
    }) => {
      if (transport === 'stdio') {
        await startStdioServer();
        return;
      }

      if (transport === 'http') {
        if (managedInstanceId !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(managedInstanceId)) {
          throw new InputError('Invalid managed MCP instance identity.');
        }
        const handle = await startHttpServer({
          host,
          port,
          ...(managedInstanceId === undefined ? {} : { managedInstanceId }),
          allowRemote: allowRemote ?? false,
          confirmRemoteExposure: confirmRemoteExposure ?? false,
          allowedHosts: allowedHost ?? [],
          allowedOrigins: allowedOrigin ?? [],
          ...(process.env.QLM_MCP_HTTP_BEARER_TOKEN === undefined
            ? {}
            : { bearerToken: process.env.QLM_MCP_HTTP_BEARER_TOKEN }),
        });
        const writeError = options.writeError ?? ((text) => process.stderr.write(text));
        writeError(`MCP HTTP server listening at ${handle.url}\n`);
        let removeShutdownHandlers = () => {};
        const registerShutdownHandlers = options.registerHttpShutdown
          ?? registerHttpShutdownHandlers;
        removeShutdownHandlers = registerShutdownHandlers(async () => {
          try {
            await handle.close();
          } catch {
            process.exitCode = 1;
            writeError('MCP HTTP server failed to shut down cleanly.\n');
          } finally {
            removeShutdownHandlers();
          }
        });
        return;
      }

      throw new InputError(`Unsupported MCP transport: ${transport}`, {
        suggestedAction: 'Use --transport stdio or --transport http.',
      });
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

      const server = options.stdioServerConfig ?? createDefaultMcpStdioServerConfig();
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

function parseHttpPort(value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new InputError('Invalid MCP HTTP port.', {
      suggestedAction: 'Choose a port between 1 and 65535.',
    });
  }
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new InputError('Invalid MCP HTTP port.', {
      suggestedAction: 'Choose a port between 1 and 65535.',
    });
  }
  return port;
}

function registerHttpShutdownHandlers(handler: () => Promise<void>): () => void {
  const onSignal = () => {
    void handler();
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  return () => {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  };
}
