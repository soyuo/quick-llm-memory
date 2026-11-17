import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import {
  Client,
  InMemoryTransport,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { describe, expect, it, vi } from 'vitest';
import { runCli } from '../src/cli.js';
import { serveMcpHttp } from '../src/mcp/http-server.js';
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

  it('serves a read-only MCP request over loopback Streamable HTTP and closes cleanly', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'qlm-mcp-http-'));
    const server = await serveMcpHttp({ host: '127.0.0.1', port: 0, dataRoot });
    const transport = new StreamableHTTPClientTransport(new URL(server.url));
    const client = new Client({ name: 'qlm-http-test-client', version: '1.0.0' });

    try {
      expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
      await client.connect(transport);
      await expect(client.ping()).resolves.toBeDefined();
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toContain('memory_list_projects');
      const result = await client.callTool({ name: 'memory_list_projects', arguments: {} });
      expect(result.isError).not.toBe(true);
      expect((result.structuredContent as { projects: unknown[] }).projects).toEqual([]);

      const missing = await fetch(new URL('/not-mcp', server.url));
      expect(missing.status).toBe(404);
    } finally {
      await client.close().catch(() => {});
      await server.close();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it('rejects non-loopback hosts and invalid HTTP ports', async () => {
    await expect(serveMcpHttp({ host: '0.0.0.0', port: 0 }))
      .rejects.toThrow('loopback hosts only');
    await expect(serveMcpHttp({ host: '127.0.0.1', port: 65_536 }))
      .rejects.toThrow('Invalid MCP HTTP port');
  });

  it('serves an in-process client over stdio streams with protocol-only output', async () => {
    const clientInput = new PassThrough();
    const serverOutput = new PassThrough();
    const outputMessages: unknown[] = [];
    const errors: Error[] = [];
    let inputBuffer = '';
    let outputText = '';
    const clientTransport = {
      onclose: undefined as (() => void) | undefined,
      onerror: undefined as ((error: Error) => void) | undefined,
      onmessage: undefined as ((message: unknown) => void) | undefined,
      async start() {
        serverOutput.on('data', (chunk: Buffer) => {
          outputText += chunk.toString('utf8');
          inputBuffer += chunk.toString('utf8');
          const lines = inputBuffer.split('\n');
          inputBuffer = lines.pop() ?? '';
          for (const line of lines) {
            if (!line) continue;
            try {
              const message: unknown = JSON.parse(line);
              outputMessages.push(message);
              this.onmessage?.(message);
            } catch (error) {
              this.onerror?.(error as Error);
            }
          }
        });
      },
      async send(message: unknown) {
        clientInput.write(`${JSON.stringify(message)}\n`);
      },
      async close() {
        clientInput.end();
        this.onclose?.();
      },
    };
    const handle = serveMcpStdio({
      transport: new StdioServerTransport(clientInput, serverOutput),
      onError: (error) => errors.push(error),
    });
    const client = new Client({ name: 'qlm-stdio-test', version: '1.0.0' });

    try {
      await client.connect(clientTransport);
      await client.ping();
      await client.close();
      await handle.close();
    } finally {
      await client.close().catch(() => {});
      await handle.close();
    }

    expect(errors).toEqual([]);
    expect(outputMessages.length).toBeGreaterThan(0);
    expect(outputMessages.every((message) => (
      typeof message === 'object'
      && message !== null
      && 'jsonrpc' in message
      && message.jsonrpc === '2.0'
    ))).toBe(true);
    expect(outputText.trim().split('\n')).toHaveLength(outputMessages.length);
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

  it('starts HTTP with loopback defaults and reports the endpoint on stderr', async () => {
    const serveHttp = vi.fn(async ({ host = '127.0.0.1', port = 8765 }: {
      host?: string;
      port?: number;
    }) => ({
      host,
      port,
      url: `http://${host}:${port}/mcp`,
      close: async () => {},
    }));
    const errors: string[] = [];
    const exitCode = await runCli(
      ['node', 'qlm', 'mcp', 'serve', '--transport', 'http'],
      { writeError: (text) => errors.push(text) },
      { serveHttp, writeError: (text) => errors.push(text) },
    );

    expect(exitCode).toBe(0);
    expect(serveHttp).toHaveBeenCalledWith({ host: '127.0.0.1', port: 8765 });
    expect(errors.join('')).toContain('http://127.0.0.1:8765/mcp');
  });

  it('rejects unsupported transports without starting the server', async () => {
    const serveStdio = vi.fn(() => ({ close: async () => {} }));
    const errors: string[] = [];
    const exitCode = await runCli(
      ['node', 'qlm', 'mcp', 'serve', '--transport', 'sse'],
      { writeError: (text) => errors.push(text) },
      { serveStdio },
    );

    expect(exitCode).toBe(1);
    expect(serveStdio).not.toHaveBeenCalled();
    expect(errors.join('')).toContain('Unsupported MCP transport');
  });
});
