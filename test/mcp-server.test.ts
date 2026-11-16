import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { describe, expect, it, vi } from 'vitest';
import { runCli } from '../src/cli.js';
import { serveMcpStdio } from '../src/mcp/server.js';

describe('MCP server bootstrap', () => {
  it('connects a local client and closes the MCP server', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const handle = serveMcpStdio({ transport: serverTransport });
    const client = new Client({ name: 'qlm-test-client', version: '1.0.0' });

    try {
      await client.connect(clientTransport);
      await expect(client.ping()).resolves.toBeDefined();
    } finally {
      await client.close();
      await handle.close();
    }
  });

  it('reports transport errors through the injected error handler', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const onError = vi.fn();
    const handle = serveMcpStdio({ transport: serverTransport, onError });
    const error = new Error('transport failure');

    serverTransport.onerror?.(error);

    expect(onError).toHaveBeenCalledWith(error);
    await handle.close();
    await clientTransport.close();
  });

  it('uses stdio by default and accepts the explicit stdio option', async () => {
    const serveStdio = vi.fn(() => ({ close: async () => {} }));
    const output: string[] = [];
    const errors: string[] = [];
    for (const args of [
      ['node', 'qlm', 'mcp', 'serve'],
      ['node', 'qlm', 'mcp', 'serve', '--transport', 'stdio'],
    ]) {
      const exitCode = await runCli(
        args,
        {
          writeOut: (text) => output.push(text),
          writeError: (text) => errors.push(text),
        },
        { serveStdio },
      );
      expect(exitCode).toBe(0);
    }

    expect(serveStdio).toHaveBeenCalledTimes(2);
    expect(output.join('')).toBe('');
    expect(errors.join('')).toBe('');
  });

  it('rejects unsupported transports without starting the server', async () => {
    const serveStdio = vi.fn(() => ({ close: async () => {} }));
    const errors: string[] = [];
    const exitCode = await runCli(
      ['node', 'qlm', 'mcp', 'serve', '--transport', 'http'],
      { writeError: (text) => errors.push(text) },
      { serveStdio },
    );

    expect(exitCode).toBe(1);
    expect(serveStdio).not.toHaveBeenCalled();
    expect(errors.join('')).toContain('Unsupported MCP transport');
  });
});
