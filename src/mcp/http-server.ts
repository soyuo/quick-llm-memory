import { createServer, type Server } from 'node:http';
import { isIP, type AddressInfo } from 'node:net';
import { createHash } from 'node:crypto';
import { createMcpHandler } from '@modelcontextprotocol/server';
import {
  localhostHostValidation,
  localhostOriginValidation,
  toNodeHandler,
} from '@modelcontextprotocol/node';
import { InputError, InternalError } from '../errors/qlm-error.js';
import { createMcpServer, type CreateMcpServerOptions } from './server.js';

export interface ServeMcpHttpOptions extends CreateMcpServerOptions {
  host?: string;
  port?: number;
  managedInstanceId?: string;
}

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
  assertLoopbackHost(host);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new InputError('Invalid MCP HTTP port.', {
      suggestedAction: 'Choose a port between 1 and 65535.',
    });
  }

  const handler = createMcpHandler(() => createMcpServer(options));
  const handleNodeRequest = toNodeHandler(handler);
  const validateHost = localhostHostValidation();
  const validateOrigin = localhostOriginValidation();
  const startedAt = options.managedInstanceId === undefined
    ? undefined
    : new Date().toISOString();
  const commandIdentity = options.managedInstanceId === undefined
    ? undefined
    : getCurrentCommandIdentity();
  let closePromise: Promise<void> | undefined;
  let managedCloseTimer: NodeJS.Timeout | undefined;
  const server = createServer((request, response) => {
    if (!validateHost(request, response) || !validateOrigin(request, response)) {
      return;
    }

    const pathname = (request.url ?? '/').split('?', 1)[0];
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

    void handleNodeRequest(request, response).catch(() => {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('MCP request failed.\n');
    });
  });

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
    .update(JSON.stringify([process.execPath, ...process.argv]))
    .digest('hex');
}

function assertLoopbackHost(host: string): void {
  const family = isIP(host);
  const isLoopback = host.toLowerCase() === 'localhost'
    || (family === 4 && host.split('.')[0] === '127')
    || (family === 6 && host === '::1');
  if (!isLoopback) {
    throw new InputError('MCP HTTP currently accepts loopback hosts only.', {
      suggestedAction: 'Use 127.0.0.1, ::1, or localhost.',
    });
  }
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
