import { InputError } from '../errors/qlm-error.js';

export type McpClient = 'claude-code' | 'cursor' | 'vscode';

export interface McpStdioServerConfig {
  command: string;
  args: string[];
}

export interface McpClientConfigOutput {
  path: string;
  config: Record<string, unknown>;
}

const SERVER_NAME = 'quick-llm-memory';

export function createMcpClientConfig(
  client: McpClient,
  server: McpStdioServerConfig,
): McpClientConfigOutput {
  if (!server.command.trim() || server.args.length === 0) {
    throw new InputError('MCP stdio command and entry point are required.');
  }

  const entry: Record<string, unknown> = {
    ...(client === 'claude-code' ? {} : { type: 'stdio' }),
    command: server.command,
    args: [...server.args],
  };

  const path = client === 'claude-code'
    ? '.mcp.json'
    : client === 'cursor'
      ? '.cursor/mcp.json'
      : client === 'vscode'
        ? '$COPILOT_HOME/mcp-config.json (default: ~/.copilot/mcp-config.json)'
        : undefined;
  if (!path) {
    throw new InputError('Unsupported MCP client configuration target.');
  }

  return {
    path,
    config: { mcpServers: { [SERVER_NAME]: entry } },
  };
}

/** Merge a generated server entry in memory without mutating existing config. */
export function mergeMcpClientConfig(
  existing: unknown,
  generated: McpClientConfigOutput,
): Record<string, unknown> {
  if (!isRecord(existing)) {
    throw new InputError('Existing MCP configuration must be a JSON object.');
  }

  const currentServers = existing.mcpServers === undefined
    ? {}
    : existing.mcpServers;
  if (!isRecord(currentServers)) {
    throw new InputError('Existing mcpServers configuration must be an object.');
  }

  const generatedServers = generated.config.mcpServers;
  if (!isRecord(generatedServers)) {
    throw new InputError('Generated MCP server configuration is invalid.');
  }
  const [name, entry] = Object.entries(generatedServers)[0] ?? [];
  if (!name || !entry) {
    throw new InputError('Generated MCP server configuration is empty.');
  }
  if (Object.hasOwn(currentServers, name)) {
    throw new InputError(`MCP server "${name}" already exists; merge it manually.`);
  }

  return {
    ...existing,
    mcpServers: { ...currentServers, [name]: entry },
  };
}

export function formatMcpClientConfig(output: McpClientConfigOutput): string {
  return JSON.stringify(output.config, null, 2);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
