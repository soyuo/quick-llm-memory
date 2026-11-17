import { describe, expect, it } from 'vitest';
import { checkLocalMcpStdioServer } from '../src/mcp/stdio-probe.js';

describe('MCP local stdio check', () => {
  it('launches a local stdio server, lists tools, and closes it', async () => {
    const serverScript = [
      "import { McpServer } from '@modelcontextprotocol/server';",
      "import { serveStdio } from '@modelcontextprotocol/server/stdio';",
      "import { z } from 'zod';",
      "const server = new McpServer({ name: 'probe-fixture', version: '1.0.0' });",
      "server.registerTool('probe_read', { inputSchema: z.object({}) }, () => ({ content: [] }));",
      'serveStdio(() => server);',
    ].join('\n');

    await expect(checkLocalMcpStdioServer({
      server: {
        command: process.execPath,
        args: ['--input-type=module', '-e', serverScript],
      },
    })).resolves.toEqual(['probe_read']);
  }, 10_000);

  it('stops waiting and returns a path-free error when the server does not speak MCP', async () => {
    const startedAt = Date.now();
    await expect(checkLocalMcpStdioServer({
      server: {
        command: process.execPath,
        args: ['-e', 'setInterval(() => {}, 1000)'],
      },
      timeoutMs: 150,
    })).rejects.toThrow('Local stdio check failed or timed out. Check the installation and try again.');
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  }, 10_000);
});
