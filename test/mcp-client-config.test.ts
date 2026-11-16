import { describe, expect, it } from 'vitest';
import { runCli } from '../src/cli.js';
import {
  createMcpClientConfig,
  formatMcpClientConfig,
  mergeMcpClientConfig,
  type McpClient,
} from '../src/mcp/client-config.js';

const server = {
  command: 'node',
  args: ['C:/tools/qlm/dist/index.js', 'mcp', 'serve', '--transport', 'stdio'],
};

describe('MCP client configuration adapters', () => {
  it.each([
    {
      client: 'claude-code' as const,
      path: '.mcp.json',
      expected: {
        mcpServers: {
          'quick-llm-memory': {
            command: server.command,
            args: server.args,
          },
        },
      },
    },
    {
      client: 'cursor' as const,
      path: '.cursor/mcp.json',
      expected: {
        mcpServers: {
          'quick-llm-memory': {
            type: 'stdio',
            command: server.command,
            args: server.args,
          },
        },
      },
    },
    {
      client: 'vscode' as const,
      path: '$COPILOT_HOME/mcp-config.json (default: ~/.copilot/mcp-config.json)',
      expected: {
        mcpServers: {
          'quick-llm-memory': {
            type: 'stdio',
            command: server.command,
            args: server.args,
          },
        },
      },
    },
  ])('generates exact $client config', ({ client, path, expected }) => {
    const output = createMcpClientConfig(client, server);
    expect(output.path).toBe(path);
    expect(output.config).toEqual(expected);
    expect(JSON.parse(formatMcpClientConfig(output))).toEqual(expected);
    expect(formatMcpClientConfig(output)).toBe(JSON.stringify(expected, null, 2));
  });

  it('merges without mutating or replacing existing settings and servers', () => {
    const existing = {
      version: 1,
      mcpServers: { existing: { command: 'other-server', args: [] } },
      unrelatedSetting: { enabled: true },
    };
    const generated = createMcpClientConfig('cursor', server);
    const generatedServers = generated.config.mcpServers as Record<string, unknown>;
    const merged = mergeMcpClientConfig(existing, generated);

    expect(merged).toEqual({
      ...existing,
      mcpServers: {
        ...existing.mcpServers,
        'quick-llm-memory': generatedServers['quick-llm-memory'],
      },
    });
    expect(existing).toEqual({
      version: 1,
      mcpServers: { existing: { command: 'other-server', args: [] } },
      unrelatedSetting: { enabled: true },
    });
  });

  it('refuses to silently replace an existing server entry', () => {
    const generated = createMcpClientConfig('claude-code', server);
    expect(() =>
      mergeMcpClientConfig(
        { mcpServers: { 'quick-llm-memory': { command: 'custom' } } },
        generated,
      ),
    ).toThrow(/already exists/);
  });

  it.each(['claude-code', 'cursor', 'vscode'] as McpClient[])(
    'prints a mergeable snippet for %s without writing a file',
    async (client) => {
      let output = '';
      let error = '';
      const code = await runCli(
        ['node', 'qlm', 'mcp', 'config', client],
        {
          writeOut: (text) => { output += text; },
          writeError: (text) => { error += text; },
        },
        { stdioServerConfig: server },
      );

      expect(code).toBe(0);
      expect(error).toBe('');
      expect(output).toContain('Merge this snippet under mcpServers');
      const configText = output.slice(output.indexOf('{'));
      const config = JSON.parse(configText) as {
        mcpServers: Record<string, { args: string[] }>;
      };
      expect(config).toEqual(createMcpClientConfig(client, server).config);
      expect(config.mcpServers['quick-llm-memory'].args).toContain('mcp');
      expect(config.mcpServers['quick-llm-memory'].args).toContain('serve');
    },
  );

  it('rejects unknown clients with a typed CLI error', async () => {
    let error = '';
    const code = await runCli(
      ['node', 'qlm', 'mcp', 'config', 'unknown'],
      { writeError: (text) => { error += text; } },
    );
    expect(code).toBe(1);
    expect(error).toContain('QLM_INPUT_ERROR');
    expect(error).toContain('claude-code, cursor, or vscode');
  });
});
