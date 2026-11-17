import { createServer, type Server } from 'node:http';
import { isIP, type AddressInfo } from 'node:net';
import { createHash, timingSafeEqual } from 'node:crypto';
import { createMcpHandler } from '@modelcontextprotocol/server';
import {
  hostHeaderValidation,
  localhostHostValidation,
  localhostOriginValidation,
  originValidation,
  toNodeHandler,
} from '@modelcontextprotocol/node';
import { InputError, InternalError } from '../errors/qlm-error.js';
import { createMcpServer, mcpRequestSignal, type CreateMcpServerOptions } from './server.js';

export interface ServeMcpHttpOptions extends CreateMcpServerOptions {
  host?: string;
  port?: number;
  managedInstanceId?: string;
  allowRemote?: boolean;
  confirmRemoteExposure?: boolean;
  allowedHosts?: string[];
  allowedOrigins?: string[];
  bearerToken?: string;
  maxRequestBodySize?: number;
  maxConcurrentRequests?: number;
  requestTimeoutMs?: number;
  serverFactory?: (onToolExecutionChange?: (delta: 1 | -1) => void) => ReturnType<typeof createMcpServer>;
}

const DEFAULT_MAX_REQUEST_BODY_SIZE = 1_048_576;
const DEFAULT_MAX_CONCURRENT_REQUESTS = 32;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export interface McpHttpServerHandle {
  readonly host: string;
  readonly port: number;
  readonly url: string;
  readonly startedAt?: string;
  readonly commandIdentity?: string;
  close(): Promise<void>;
}

export async function serveMcpHttp(
  options: ServeMcpHttpOptions = {},
): Promise<McpHttpServerHandle> {
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 8765;
  const maxRequestBodySize = options.maxRequestBodySize ?? DEFAULT_MAX_REQUEST_BODY_SIZE;
  const maxConcurrentRequests = options.maxConcurrentRequests ?? DEFAULT_MAX_CONCURRENT_REQUESTS;
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  if (!Number.isSafeInteger(maxRequestBodySize) || maxRequestBodySize < 1) {
    throw new InputError('MCP HTTP request body limit must be a positive safe integer.');
  }
  if (!Number.isSafeInteger(maxConcurrentRequests) || maxConcurrentRequests < 1) {
    throw new InputError('MCP HTTP concurrency limit must be a positive safe integer.');
  }
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > 2_147_483_647) {
    throw new InputError('MCP HTTP request timeout must be a positive integer no greater than 2147483647.');
  }
  const loopback = isLoopbackHost(host);
  const bearerToken = options.bearerToken;
  if (bearerToken !== undefined && (bearerToken.length < 32 || bearerToken.trim() !== bearerToken)) {
    throw new InputError('MCP HTTP bearer token must be at least 32 characters and contain no surrounding whitespace.');
  }
  if (!loopback && (!options.allowRemote || !options.confirmRemoteExposure)) {
    throw new InputError('Remote MCP HTTP binding requires --allow-remote and --confirm-remote-exposure.');
  }
  if (!loopback && (!options.allowedHosts?.length || !options.allowedOrigins?.length)) {
    throw new InputError('Remote MCP HTTP binding requires explicit allowed Host and Origin lists.');
  }
  if (!loopback && bearerToken === undefined) {
    throw new InputError('Remote MCP HTTP binding requires QLM_MCP_HTTP_BEARER_TOKEN.');
  }
  const allowedHosts = normalizeAllowlist(options.allowedHosts ?? [], 'Host');
  const allowedOrigins = normalizeAllowlist(options.allowedOrigins ?? [], 'Origin');
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new InputError('Invalid MCP HTTP port.', {
      suggestedAction: 'Choose a port between 1 and 65535.',
    });
  }

  let activeToolExecutions = 0;
  const handler = createMcpHandler(() => {
    if (options.serverFactory !== undefined) {
      return options.serverFactory((delta) => { activeToolExecutions += delta; });
    }
    return createMcpServer({
      ...options,
      onToolExecutionChange: (delta) => { activeToolExecutions += delta; },
    });
  });
  const handleNodeRequest = toNodeHandler(handler, { maxRequestBodySize });
  const validateHost = loopback ? localhostHostValidation() : hostHeaderValidation(allowedHosts);
  const validateOrigin = loopback ? localhostOriginValidation() : originValidation(allowedOrigins);
  const expectedTokenHash = bearerToken === undefined
    ? undefined
    : createHash('sha256').update(bearerToken).digest();
  const startedAt = options.managedInstanceId === undefined
    ? undefined
    : new Date().toISOString();
  const commandIdentity = options.managedInstanceId === undefined
    ? undefined
    : getCurrentCommandIdentity();
  let closePromise: Promise<void> | undefined;
  let managedCloseTimer: NodeJS.Timeout | undefined;
  let activeMcpRequests = 0;
  const server = createServer((request, response) => {
    if (!validateHost(request, response) || !validateOrigin(request, response)) {
      return;
    }

    const pathname = (request.url ?? '/').split('?', 1)[0];
    if (pathname === '/mcp' && expectedTokenHash !== undefined) {
      const authorization = request.headers.authorization ?? '';
      const match = /^Bearer (\S+)$/i.exec(authorization);
      const providedHash = createHash('sha256').update(match?.[1] ?? '').digest();
      if (match === null || !timingSafeEqual(providedHash, expectedTokenHash)) {
        response.writeHead(401, { 'content-type': 'application/json', 'www-authenticate': 'Bearer' });
        response.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }
    }

    if (options.managedInstanceId !== undefined && startedAt !== undefined && commandIdentity !== undefined
      && request.headers['x-qlm-instance-id'] === options.managedInstanceId) {
      if (pathname === '/__qlm/manager/status' && request.method === 'GET') {
        const currentAddress = server.address();
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({
          pid: process.pid,
          startedAt,
          host,
          port: currentAddress !== null && typeof currentAddress !== 'string'
            ? currentAddress.port
            : port,
          instanceId: options.managedInstanceId,
          commandIdentity,
        }));
        return;
      }
      if (pathname === '/__qlm/manager/stop' && request.method === 'POST') {
        response.writeHead(202).end();
        managedCloseTimer = setTimeout(() => {
          server.closeAllConnections();
          process.exitCode = 1;
          const forceExitTimer = setTimeout(() => process.exit(1), 100);
          forceExitTimer.unref();
        }, 5_000);
        managedCloseTimer.unref();
        setImmediate(() => {
          closePromise ??= closeServer(server, handler);
          void closePromise.catch(() => {
            process.exitCode = 1;
          }).finally(() => {
            if (managedCloseTimer !== undefined) clearTimeout(managedCloseTimer);
          });
        });
        return;
      }
    }

    if (pathname !== '/mcp') {
      response.writeHead(404).end();
      return;
    }

    if (activeMcpRequests >= maxConcurrentRequests || activeToolExecutions >= maxConcurrentRequests) {
      response.writeHead(503, { 'content-type': 'application/json; charset=utf-8', connection: 'close' });
      response.end(JSON.stringify({ error: 'MCP request capacity is temporarily exhausted.' }));
      return;
    }
    activeMcpRequests += 1;
    const requestAbort = new AbortController();
    const handlerTimeout = setTimeout(() => {
      requestAbort.abort(new Error('MCP request timed out.'));
      if (response.destroyed || response.writableEnded) return;
      if (response.headersSent) {
        response.destroy();
        return;
      }
      response.writeHead(504, { 'content-type': 'application/json; charset=utf-8', connection: 'close' });
      response.end(JSON.stringify({ error: 'MCP request exceeded the configured time limit.' }));
    }, requestTimeoutMs);

    void mcpRequestSignal.run(requestAbort.signal, () => handleNodeRequest(request, response)).catch(() => {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('MCP request failed.\n');
    }).finally(() => {
      clearTimeout(handlerTimeout);
      activeMcpRequests -= 1;
    });
  });
  server.requestTimeout = requestTimeoutMs;
  server.setTimeout(requestTimeoutMs, (socket) => socket.destroy());

  await listen(server, port, host, handler);
  const address = server.address();
  if (address === null || typeof address === 'string') {
    await handler.close();
    throw new InternalError('MCP HTTP server did not report a TCP address.');
  }

  const actualPort = address.port;
  return {
    host,
    port: actualPort,
    url: `http://${formatUrlHost(host)}:${actualPort}/mcp`,
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(commandIdentity === undefined ? {} : { commandIdentity }),
    close() {
      closePromise ??= closeServer(server, handler);
      return closePromise;
    },
  };
}

export function getCurrentCommandIdentity(): string {
  return createHash('sha256')
    .update(JSON.stringify([process.execPath, ...process.argv.slice(1)]))
    .digest('hex');
}

function isLoopbackHost(host: string): boolean {
  const family = isIP(host);
  return host.toLowerCase() === 'localhost'
    || (family === 4 && host.split('.')[0] === '127')
    || (family === 6 && host === '::1');
}

function normalizeAllowlist(values: string[], label: string): string[] {
  const normalized = values.map((value) => value.trim().toLowerCase());
  if (normalized.some((value) => value.length === 0 || value.includes('*') || /[\s/@?#]/.test(value)
    || (value.includes(':') && !(value.startsWith('[') && value.endsWith(']') && isIP(value.slice(1, -1)) === 6)))) {
    throw new InputError(`Invalid allowed ${label} hostname.`);
  }
  return [...new Set(normalized)];
}

function formatUrlHost(host: string): string {
  return host.includes(':') ? `[${host}]` : host;
}

function listen(
  server: Server,
  port: number,
  host: string,
  handler: ReturnType<typeof createMcpHandler>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening);
      void handler.close().then(() => reject(error), () => reject(error));
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

async function closeServer(
  server: Server,
  handler: ReturnType<typeof createMcpHandler>,
): Promise<void> {
  const results = await Promise.allSettled([
    handler.close(),
    new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error !== undefined) reject(error);
        else resolve();
      });
    }),
  ]);
  const failure = results.find((result) => result.status === 'rejected');
  if (failure?.status === 'rejected') {
    throw failure.reason;
  }
}
