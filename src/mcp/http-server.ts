import { createServer, type Server } from 'node:http';
import { isIP, type AddressInfo } from 'node:net';
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
}

export interface McpHttpServerHandle {
  readonly host: string;
  readonly port: number;
  readonly url: string;
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
  const server = createServer((request, response) => {
    if (!validateHost(request, response) || !validateOrigin(request, response)) {
      return;
    }

    if ((request.url ?? '/').split('?', 1)[0] !== '/mcp') {
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
  let closePromise: Promise<void> | undefined;
  return {
    host,
    port: actualPort,
    url: `http://${formatUrlHost(host)}:${actualPort}/mcp`,
    close() {
      closePromise ??= closeServer(server, handler);
      return closePromise;
    },
  };
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
