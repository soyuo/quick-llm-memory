import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import {
  Client,
  InMemoryTransport,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { describe, expect, it, vi } from 'vitest';
import { runCli } from '../../src/cli.js';
import { serveMcpHttp } from '../../src/mcp/http-server.js';
import { mcpRequestSignal, serveMcpStdio } from '../../src/mcp/server.js';
import { initializeProject } from '../../src/projects/manager.js';
import { createKnowledgeRoot, createMarkdownDocument } from '../../src/markdown/repository.js';

describe('MCP server bootstrap', () => {
  it('enforces restricted permissions over stdio and HTTP transports', async () => {
    const restrictedPermissions = new Set(['METADATA'] as const);
    const [stdioClientTransport, stdioServerTransport] = InMemoryTransport.createLinkedPair();
    const stdioHandle = serveMcpStdio({
      transport: stdioServerTransport,
      serverOptions: { permissions: restrictedPermissions },
    });
    const stdioClient = new Client({ name: 'restricted-stdio', version: '1.0.0' });
    const dataRoot = mkdtempSync(join(tmpdir(), 'qlm-mcp-permissions-'));
    const httpServer = await serveMcpHttp({
      host: '127.0.0.1', port: 0, dataRoot, permissions: restrictedPermissions,
    });
    const httpClient = new Client({ name: 'restricted-http', version: '1.0.0' });
    try {
      await stdioClient.connect(stdioClientTransport);
      const stdioResult = await stdioClient.callTool({ name: 'memory_list_projects', arguments: {} });
      expect(stdioResult.isError).toBe(true);

      await httpClient.connect(new StreamableHTTPClientTransport(new URL(httpServer.url)));
      const httpResult = await httpClient.callTool({ name: 'memory_list_projects', arguments: {} });
      expect(httpResult.isError).toBe(true);
    } finally {
      await stdioClient.close().catch(() => {});
      await stdioHandle.close();
      await httpClient.close().catch(() => {});
      await httpServer.close();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

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

  it('allows proposal permission without mutating Markdown or the index', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'qlm-mcp-proposal-'));
    const project = initializeProject(dataRoot, 'proposal-project');
    const knowledgeRoot = createKnowledgeRoot(join(dataRoot, 'projects', project.name, 'knowledge'));
    createMarkdownDocument(knowledgeRoot, 'notes.md', {
      metadata: { schema_version: 1, title: 'Notes', type: 'document', status: 'active', depth: 1 },
      body: '\nOriginal text\n',
    });
    const sourcePath = join(knowledgeRoot, 'notes.md');
    const before = readFileSync(sourcePath, 'utf8');
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const handle = serveMcpStdio({ serverOptions: {
      dataRoot,
      permissions: new Set(['READ', 'PROPOSE_WRITE']),
    }, transport: serverTransport });
    const client = new Client({ name: 'qlm-proposal-test', version: '1.0.0' });
    try {
      await client.connect(clientTransport);
      const result = await client.callTool({
        name: 'memory_propose_document_update',
        arguments: {
          project: project.name,
          path: 'notes.md',
          metadata: { schema_version: 1, title: 'Proposed notes', type: 'document', status: 'active', depth: 1 },
          body: '\nProposed text\n',
        },
      });
      expect(result.isError).not.toBe(true);
      expect(JSON.stringify(result)).toContain('Proposed text');
      expect(readFileSync(sourcePath, 'utf8')).toBe(before);
    } finally {
      await client.close().catch(() => {});
      await handle.close();
      rmSync(dataRoot, { recursive: true, force: true });
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

  it('accepts a body at the configured limit and rejects one byte above it', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'qlm-mcp-body-limit-'));
    const server = await serveMcpHttp({
      host: '127.0.0.1', port: 0, dataRoot, maxRequestBodySize: 64,
    });
    try {
      const response = await new Promise<{ statusCode: number | undefined; body: string }>((resolve, reject) => {
        const request = httpRequest(server.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'content-length': '65' },
        }, (incoming) => {
          let body = '';
          incoming.setEncoding('utf8');
          incoming.on('data', (chunk: string) => { body += chunk; });
          incoming.on('end', () => resolve({ statusCode: incoming.statusCode, body }));
        });
        request.on('error', reject);
        request.end('x'.repeat(65));
      });
      expect(response.statusCode).toBe(413);
      const boundaryBody = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' });
      const atLimit = await new Promise<number | undefined>((resolve, reject) => {
        const request = httpRequest(server.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'content-length': '64' },
        }, (incoming) => {
          incoming.resume();
          incoming.on('end', () => resolve(incoming.statusCode));
        });
        request.on('error', reject);
        request.end(boundaryBody.padEnd(64, ' '));
      });
      expect(atLimit).not.toBe(413);
    } finally {
      await server.close();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it('rejects new HTTP work when the in-flight MCP request limit is full', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'qlm-mcp-concurrency-limit-'));
    const server = await serveMcpHttp({
      host: '127.0.0.1', port: 0, dataRoot, maxConcurrentRequests: 1,
    });
    const stalled = httpRequest(server.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': '100' },
    });
    stalled.on('error', () => {});
    try {
      await new Promise<void>((resolve, reject) => stalled.write('{', (error) => {
        if (error) reject(error);
        else resolve();
      }));
      const saturated = await fetch(server.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      expect(saturated.status).toBe(503);
    } finally {
      stalled.destroy();
      await server.close();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it('times out stalled request bodies and continues serving MCP requests', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'qlm-mcp-request-timeout-'));
    const server = await serveMcpHttp({
      host: '127.0.0.1', port: 0, dataRoot, requestTimeoutMs: 100,
    });
    try {
      const timeoutStatus = await new Promise<number | undefined>((resolve, reject) => {
        const request = httpRequest(server.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'content-length': '100' },
        }, (response) => {
          response.resume();
          response.once('end', () => resolve(response.statusCode));
        });
        request.once('error', (error) => {
          if ((error as NodeJS.ErrnoException).code === 'ECONNRESET') resolve(undefined);
          else reject(error);
        });
        request.write('{');
      });
      expect(timeoutStatus).toBe(504);
      const transport = new StreamableHTTPClientTransport(new URL(server.url));
      const client = new Client({ name: 'qlm-timeout-recovery', version: '1.0.0' });
      try {
        await client.connect(transport);
        await expect(client.ping()).resolves.toBeDefined();
      } finally {
        await client.close();
      }
    } finally {
      await server.close();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it('keeps timed-out handler work within capacity until it settles', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'qlm-mcp-handler-timeout-'));
    let markStarted!: () => void;
    let toolCalls = 0;
    let abortObserved = false;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const server = await serveMcpHttp({
      host: '127.0.0.1', port: 0, dataRoot, requestTimeoutMs: 500, maxConcurrentRequests: 1,
      serverFactory: (onToolExecutionChange) => {
        const mcp = new McpServer({ name: 'timeout-test', version: '1.0.0' });
        mcp.registerTool('wait_for_abort', {
          description: 'Wait longer than the HTTP response timeout.',
          inputSchema: {},
        }, async (_args) => {
          onToolExecutionChange?.(1);
          toolCalls += 1;
          markStarted();
          try {
            if (toolCalls > 1) return { content: [{ type: 'text', text: 'recovered' }] };
            await new Promise<void>((resolve, reject) => {
              const signal = mcpRequestSignal.getStore();
              if (signal?.aborted) return resolve();
              const timer = setTimeout(resolve, 5_000);
              signal?.addEventListener('abort', () => {
                abortObserved = true;
                clearTimeout(timer);
                resolve();
              }, { once: true });
            });
          } finally {
            onToolExecutionChange?.(-1);
          }
          return { content: [{ type: 'text', text: 'finished' }] };
        });
        return mcp;
      },
    });
    const transport = new StreamableHTTPClientTransport(new URL(server.url));
    const client = new Client({ name: 'qlm-timeout-client', version: '1.0.0' });
    try {
      await client.connect(transport);
      const slowCall = client.callTool({ name: 'wait_for_abort', arguments: {} });
      await started;
      await Promise.allSettled([slowCall]);
      expect(abortObserved).toBe(true);
      await expect(client.callTool({ name: 'wait_for_abort', arguments: {} })).resolves.toMatchObject({
        content: [{ text: 'recovered' }],
      });
      expect(toolCalls).toBe(2);
      await expect(client.ping()).resolves.toBeDefined();
    } finally {
      await client.close();
      await server.close();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it('exposes an instance-verified management status and graceful stop route', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'qlm-mcp-managed-'));
    const instanceId = randomUUID();
    const server = await serveMcpHttp({
      host: '127.0.0.1',
      port: 0,
      dataRoot,
      managedInstanceId: instanceId,
    });
    const statusUrl = new URL('/__qlm/manager/status', server.url);
    const identityHeader = { 'x-qlm-instance-id': instanceId };

    try {
      const denied = await fetch(statusUrl, {
        headers: { 'x-qlm-instance-id': randomUUID() },
      });
      expect(denied.status).toBe(404);

      const rejectedOrigin = await fetch(server.url, {
        method: 'GET',
        headers: { origin: 'http://attacker.example' },
      });
      expect(rejectedOrigin.status).toBe(403);

      const status = await fetch(statusUrl, { headers: identityHeader });
      expect(status.status).toBe(200);
      await expect(status.json()).resolves.toMatchObject({
        pid: process.pid,
        host: '127.0.0.1',
        port: server.port,
        instanceId,
        commandIdentity: expect.stringMatching(/^[a-f0-9]{64}$/),
        startedAt: expect.stringMatching(/^\d{4}-\d\d-/),
      });

      const stopped = await fetch(new URL('/__qlm/manager/stop', server.url), {
        method: 'POST',
        headers: identityHeader,
      });
      expect(stopped.status).toBe(202);
      await server.close();
      await expect(fetch(statusUrl, { headers: identityHeader })).rejects.toThrow();
    } finally {
      await server.close().catch(() => {});
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it('rejects over-limit MCP calls before invoking tools', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'qlm-mcp-rate-'));
    let calls = 0;
    const server = await serveMcpHttp({
      host: '127.0.0.1', port: 0, dataRoot, maxRequestsPerMinute: 4,
      serverFactory: () => {
        const mcp = new McpServer({ name: 'rate-test', version: '1.0.0' });
        mcp.registerTool('count', { description: 'Count calls.', inputSchema: {} }, () => {
          calls += 1;
          return { content: [{ type: 'text' as const, text: 'ok' }] };
        });
        return mcp;
      },
    });
    const transport = new StreamableHTTPClientTransport(new URL(server.url));
    const client = new Client({ name: 'rate-test-client', version: '1.0.0' });
    try {
      await client.connect(transport);
      await expect(client.callTool({ name: 'count', arguments: {} })).resolves.toBeDefined();
      await expect(client.callTool({ name: 'count', arguments: {} })).rejects.toThrow();
      expect(calls).toBe(1);
    } finally {
      await client.close();
      await server.close();
      const accessLogs = readFileSync(join(dataRoot, 'logs', 'application.log'), 'utf8');
      expect(accessLogs).toContain('MCP HTTP access');
      expect(accessLogs).toContain('"method":"POST"');
      expect(accessLogs).not.toContain('authorization');
      expect(accessLogs).not.toContain('Bearer');
      expect(accessLogs).not.toContain('arguments');
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it('closes the application log when HTTP startup fails', async () => {
    const occupied = await serveMcpHttp({ host: '127.0.0.1', port: 0 });
    const dataRoot = mkdtempSync(join(tmpdir(), 'qlm-mcp-listen-failure-'));
    try {
      await expect(serveMcpHttp({ host: '127.0.0.1', port: occupied.port, dataRoot })).rejects.toThrow();
      const log = join(dataRoot, 'logs', 'application.log');
      expect(readFileSync(log, 'utf8')).toContain('Application started');
      rmSync(dataRoot, { recursive: true, force: true });
    } finally {
      await occupied.close();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it('rate limits invalid bearer attempts before MCP authentication', async () => {
    const server = await serveMcpHttp({ host: '127.0.0.1', port: 0, bearerToken: 'secret-token-that-is-long-enough-123', maxRequestsPerMinute: 1 });
    try {
      const request = () => fetch(server.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer wrong', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      });
      expect((await request()).status).toBe(401);
      expect((await request()).status).toBe(429);
    } finally {
      await server.close();
    }
  });

  it('keeps concurrent HTTP clients independent when one disconnects', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'qlm-mcp-concurrent-'));
    initializeProject(dataRoot, 'alpha');
    initializeProject(dataRoot, 'beta');
    const server = await serveMcpHttp({ host: '127.0.0.1', port: 0, dataRoot });
    const alphaClient = new Client({ name: 'qlm-alpha-client', version: '1.0.0' });
    const betaClient = new Client({ name: 'qlm-beta-client', version: '1.0.0' });
    const alphaTransport = new StreamableHTTPClientTransport(new URL(server.url));
    const betaTransport = new StreamableHTTPClientTransport(new URL(server.url));

    try {
      await Promise.all([
        alphaClient.connect(alphaTransport),
        betaClient.connect(betaTransport),
      ]);
      const [alphaResult, betaResult] = await Promise.all([
        alphaClient.callTool({
          name: 'memory_get_tree',
          arguments: { project: 'alpha' },
        }),
        betaClient.callTool({
          name: 'memory_get_tree',
          arguments: { project: 'beta' },
        }),
      ]);

      expect(alphaResult.isError).not.toBe(true);
      expect(betaResult.isError).not.toBe(true);
      expect((alphaResult.structuredContent as { project: string }).project).toBe('alpha');
      expect((betaResult.structuredContent as { project: string }).project).toBe('beta');

      await alphaClient.close();
      await expect(betaClient.ping()).resolves.toBeDefined();
      const betaAfterDisconnect = await betaClient.callTool({
        name: 'memory_get_tree',
        arguments: { project: 'beta' },
      });
      expect(betaAfterDisconnect.isError).not.toBe(true);
      expect((betaAfterDisconnect.structuredContent as { project: string }).project)
        .toBe('beta');
    } finally {
      await alphaClient.close().catch(() => {});
      await betaClient.close().catch(() => {});
      await server.close();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it('requires explicit remote exposure confirmation and allowlists', async () => {
    await expect(serveMcpHttp({ host: '0.0.0.0', port: 0 }))
      .rejects.toThrow('--allow-remote and --confirm-remote-exposure');
    await expect(serveMcpHttp({ host: '0.0.0.0', port: 0, allowRemote: true, confirmRemoteExposure: true }))
      .rejects.toThrow('explicit allowed Host and Origin lists');
    await expect(serveMcpHttp({ host: '0.0.0.0', port: 0, allowRemote: true, confirmRemoteExposure: true,
      allowedHosts: ['bad host'], allowedOrigins: ['example.com'], bearerToken: 'test-secret-token-for-mcp-http-auth-0001' }))
      .rejects.toThrow('Invalid allowed Host hostname');
    await expect(serveMcpHttp({ host: '0.0.0.0', port: 0, allowRemote: true, confirmRemoteExposure: true,
      allowedHosts: ['example.com'], allowedOrigins: ['example.com'] }))
      .rejects.toThrow('QLM_MCP_HTTP_BEARER_TOKEN');
    await expect(serveMcpHttp({ host: '0.0.0.0', port: 0, allowRemote: true, confirmRemoteExposure: true,
      allowedHosts: ['example.com'], allowedOrigins: ['example.com'], bearerToken: 'short' }))
      .rejects.toThrow('at least 32 characters');
    await expect(serveMcpHttp({ host: '127.0.0.1', port: 65_536 }))
      .rejects.toThrow('Invalid MCP HTTP port');
    await expect(serveMcpHttp({ host: '127.0.0.1', port: 0, requestTimeoutMs: 2_147_483_648 }))
      .rejects.toThrow('no greater than 2147483647');
  });

  it('enforces remote Host and Origin allowlists before MCP dispatch', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'qlm-mcp-origin-'));
    initializeProject(dataRoot, 'sensitive-project');
    const server = await serveMcpHttp({
      host: '0.0.0.0', port: 0, allowRemote: true, confirmRemoteExposure: true,
      allowedHosts: ['127.0.0.1'], allowedOrigins: ['trusted.example'],
      dataRoot,
      bearerToken: 'test-secret-token-for-mcp-http-auth-0001',
    });
    const url = `http://127.0.0.1:${server.port}/mcp`;
    const trustedHeaders = {
      host: `127.0.0.1:${server.port}`,
      origin: 'https://trusted.example',
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: 'Bearer test-secret-token-for-mcp-http-auth-0001',
    };
    try {
      const initialized = await requestJson(url, trustedHeaders, {
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'origin-test', version: '1.0.0' } },
      });
      expect(initialized.status).not.toBe(403);
      const toolCall = { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'memory_list_projects', arguments: {} } };
      const allowed = await requestJson(url, trustedHeaders, toolCall);
      expect(allowed.status).toBe(200);
      expect(allowed.body).toContain('sensitive-project');
      const unauthorized = await requestJson(url, { ...trustedHeaders, authorization: 'Bearer wrong-token' }, toolCall);
      expect(unauthorized.status).toBe(401);
      expect(unauthorized.body).not.toContain('sensitive-project');
      expect(unauthorized.body).not.toContain('wrong-token');
      const hostileOrigin = await requestJson(url, { ...trustedHeaders, origin: 'https://evil.example' }, toolCall);
      expect(hostileOrigin.status).toBe(403);
      expect(hostileOrigin.body).not.toContain('sensitive-project');
      const malformedOrigin = await fetch(url, { method: 'GET', headers: { host: `127.0.0.1:${server.port}`, origin: 'not-an-origin' } });
      expect(malformedOrigin.status).toBe(403);
      const hostileHost = await requestJson(url, {
        ...trustedHeaders,
        host: `evil.example:${server.port}`,
      }, toolCall);
      expect(hostileHost.status).toBe(403);
      expect(hostileHost.body).not.toContain('sensitive-project');
      const missingOrigin = await fetch(url, { method: 'GET', headers: { host: `127.0.0.1:${server.port}` } });
      expect(missingOrigin.status).not.toBe(403);
    } finally {
      await server.close();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it('supports IPv6 loopback where available', async ({ skip }) => {
    let server;
    try {
      server = await serveMcpHttp({ host: '::1', port: 0 });
    } catch {
      skip();
      return;
    }
    try {
      expect(server.url).toMatch(/^http:\/\/\[::1\]:\d+\/mcp$/);
      const rejected = await fetch(server.url, { method: 'GET', headers: { origin: 'https://evil.example' } });
      expect(rejected.status).toBe(403);
    } finally {
      await server.close();
    }
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
    const previousToken = process.env.QLM_MCP_HTTP_BEARER_TOKEN;
    process.env.QLM_MCP_HTTP_BEARER_TOKEN = 'test-secret-token-for-mcp-http-auth-0001';
    let shutdown: (() => Promise<void>) | undefined;
    const close = vi.fn(async () => {});
    const serveHttp = vi.fn(async ({ host = '127.0.0.1', port = 8765 }: {
      host?: string;
      port?: number;
    }) => ({
      host,
      port,
      url: `http://${host}:${port}/mcp`,
      close,
    }));
    const errors: string[] = [];
    const exitCode = await runCli(
      ['node', 'qlm', 'mcp', 'serve', '--transport', 'http'],
      { writeError: (text) => errors.push(text) },
      {
        serveHttp,
        writeError: (text) => errors.push(text),
        registerHttpShutdown: (handler) => {
          shutdown = handler;
          return () => {};
        },
      },
    );
    if (previousToken === undefined) delete process.env.QLM_MCP_HTTP_BEARER_TOKEN;
    else process.env.QLM_MCP_HTTP_BEARER_TOKEN = previousToken;

    expect(exitCode).toBe(0);
    expect(serveHttp).toHaveBeenCalledWith({ host: '127.0.0.1', port: 8765, allowRemote: false,
      confirmRemoteExposure: false, allowedHosts: [], allowedOrigins: [], bearerToken: 'test-secret-token-for-mcp-http-auth-0001' });
    expect(errors.join('')).toContain('http://127.0.0.1:8765/mcp');
    await shutdown?.();
    expect(close).toHaveBeenCalledOnce();
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

function requestJson(
  url: string,
  headers: Record<string, string>,
  payload: Record<string, unknown>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const requestUrl = new URL(url);
    const request = httpRequest({
      host: requestUrl.hostname,
      port: Number(requestUrl.port),
      path: requestUrl.pathname,
      method: 'POST',
      headers: { ...headers, 'content-length': Buffer.byteLength(JSON.stringify(payload)) },
    }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => { body += chunk; });
      response.once('end', () => resolve({ status: response.statusCode ?? 0, body }));
    });
    request.once('error', reject);
    request.end(JSON.stringify(payload));
  });
}

