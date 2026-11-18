import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getExpectedManagedCommandIdentity,
  getManagedHttpServerStatus,
  startManagedHttpServer,
  stopManagedHttpServer,
} from '../../src/mcp/process-manager.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('managed MCP HTTP process lifecycle', () => {
  it('starts detached, persists verified process metadata, reports status, and stops gracefully', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'qlm-mcp-process-'));
    roots.push(dataRoot);
    const entryPoint = resolve('dist/index.js');
    let pid = 43210;
    let identity: Record<string, unknown> | undefined;
    let stopped = false;
    let spawnOptions: Record<string, unknown> | undefined;
    const spawnProcess = ((_: string, args: string[], options: Record<string, unknown>) => {
      spawnOptions = options;
      const emitter = new EventEmitter() as EventEmitter & {
        pid: number;
        exitCode: number | null;
        signalCode: NodeJS.Signals | null;
        unref: () => void;
        kill: () => boolean;
      };
      emitter.pid = pid;
      emitter.exitCode = null;
      emitter.signalCode = null;
      emitter.unref = vi.fn();
      emitter.kill = vi.fn(() => true);
      const host = args[args.indexOf('--host') + 1] ?? '127.0.0.1';
      const port = Number(args[args.indexOf('--port') + 1]);
      const instanceId = args[args.indexOf('--managed-instance-id') + 1] ?? '';
      identity = {
        pid,
        startedAt: '2026-11-17T00:00:00.000Z',
        host,
        port,
        instanceId,
        commandIdentity: getExpectedManagedCommandIdentity(entryPoint, args.slice(1)),
      };
      queueMicrotask(() => emitter.emit('spawn'));
      return emitter as unknown as ChildProcess;
    }) as unknown as typeof import('node:child_process').spawn;

    const fetchImpl: typeof fetch = vi.fn(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/stop')) {
        stopped = true;
        return new Response(null, { status: 202 });
      }
      const sentId = new Headers(init?.headers).get('x-qlm-instance-id');
      if (stopped || sentId !== identity?.instanceId) return new Response(null, { status: 404 });
      return new Response(JSON.stringify(identity), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    const started = await startManagedHttpServer({
      dataRoot,
      entryPoint,
      spawnProcess,
      fetchImpl,
      startupTimeoutMs: 500,
    });
    expect(started).toMatchObject({ state: 'running', pid, host: '127.0.0.1', port: 8765 });
    expect(spawnOptions).toMatchObject({ detached: true, windowsHide: true });
    expect(readFileSync(join(dataRoot, 'mcp', 'http-server.json'), 'utf8')).not.toContain('OPENAI_API_KEY');

    await expect(getManagedHttpServerStatus({ dataRoot, fetchImpl }))
      .resolves.toMatchObject({ state: 'running', pid });
    await expect(stopManagedHttpServer({ dataRoot, fetchImpl, wait: async () => {} }))
      .resolves.toMatchObject({ state: 'stopped' });
    expect(stopped).toBe(true);
  });

  it('clears stale PID state without signaling an unverified process', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'qlm-mcp-stale-'));
    roots.push(dataRoot);
    const statePath = join(dataRoot, 'mcp', 'http-server.json');
    mkdirSync(join(dataRoot, 'mcp'), { recursive: true });
    writeFileSync(statePath, JSON.stringify({
      version: 1,
      pid: 43210,
      startedAt: '2026-11-17T00:00:00.000Z',
      host: '127.0.0.1',
      port: 8765,
      url: 'http://127.0.0.1:8765/mcp',
      instanceId: 'f6bf0dc0-c57a-4a95-8e19-ab6acfc7a0a1',
      commandIdentity: 'a'.repeat(64),
      logPath: join(dataRoot, 'logs', 'mcp-http.log'),
    }));
    const fetchImpl: typeof fetch = vi.fn(async () => new Response(null, { status: 404 }));
    await expect(stopManagedHttpServer({ dataRoot, fetchImpl }))
      .resolves.toMatchObject({ state: 'stale' });
  });

  it('does not contact a host from edited state and reports it stale', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'qlm-mcp-remote-state-'));
    roots.push(dataRoot);
    const statePath = join(dataRoot, 'mcp', 'http-server.json');
    mkdirSync(join(dataRoot, 'mcp'), { recursive: true });
    writeFileSync(statePath, JSON.stringify({
      version: 1, pid: 43210, startedAt: '2026-11-17T00:00:00.000Z', host: 'example.com',
      port: 8765, url: 'http://example.com:8765/mcp', instanceId: 'f6bf0dc0-c57a-4a95-8e19-ab6acfc7a0a1',
      commandIdentity: 'a'.repeat(64), logPath: join(dataRoot, 'logs', 'mcp-http.log'),
    }));
    const fetchImpl: typeof fetch = vi.fn();
    await expect(getManagedHttpServerStatus({ dataRoot, fetchImpl })).resolves.toMatchObject({ state: 'stale' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('classifies malformed existing metadata as stale', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'qlm-mcp-malformed-state-'));
    roots.push(dataRoot);
    const statePath = join(dataRoot, 'mcp', 'http-server.json');
    mkdirSync(join(dataRoot, 'mcp'), { recursive: true });
    writeFileSync(statePath, '{broken json');
    const fetchImpl: typeof fetch = vi.fn();
    await expect(stopManagedHttpServer({ dataRoot, fetchImpl })).resolves.toMatchObject({ state: 'stale' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects non-loopback start options before making network requests', async () => {
    const fetchImpl: typeof fetch = vi.fn();
    await expect(startManagedHttpServer({ dataRoot: tmpdir(), host: 'example.com', fetchImpl }))
      .rejects.toThrow('loopback host');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('classifies JSON null state as stale', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'qlm-mcp-null-state-'));
    roots.push(dataRoot);
    mkdirSync(join(dataRoot, 'mcp'), { recursive: true });
    writeFileSync(join(dataRoot, 'mcp', 'http-server.json'), 'null');
    await expect(getManagedHttpServerStatus({ dataRoot })).resolves.toMatchObject({ state: 'stale' });
  });

  it('never signals a still-responding PID after a shutdown request times out', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'qlm-mcp-force-'));
    roots.push(dataRoot);
    const statePath = join(dataRoot, 'mcp', 'http-server.json');
    mkdirSync(join(dataRoot, 'mcp'), { recursive: true });
    const saved = {
      version: 1,
      pid: 43210,
      startedAt: '2026-11-17T00:00:00.000Z',
      host: '127.0.0.1',
      port: 8765,
      url: 'http://127.0.0.1:8765/mcp',
      instanceId: 'f6bf0dc0-c57a-4a95-8e19-ab6acfc7a0a1',
      commandIdentity: 'a'.repeat(64),
      logPath: join(dataRoot, 'logs', 'mcp-http.log'),
    };
    writeFileSync(statePath, JSON.stringify(saved));
    let stopped = false;
    const fetchImpl: typeof fetch = vi.fn(async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/stop')) return new Response(null, { status: 202 });
      if (stopped) return new Response(null, { status: 404 });
      return new Response(JSON.stringify(saved), { status: 200 });
    });
    await expect(stopManagedHttpServer({
      dataRoot,
      fetchImpl,
      shutdownTimeoutMs: 0,
    })).resolves.toMatchObject({ state: 'stale' });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('starts and stops the built CLI as a detached process', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'qlm-mcp-cli-process-'));
    roots.push(dataRoot);
    const port = await reserveLoopbackPort();
    const entryPoint = resolve('dist/index.js');

    const started = await startManagedHttpServer({ dataRoot, entryPoint, port });
    expect(started).toMatchObject({ state: 'running', host: '127.0.0.1', port });
    if (started.state !== 'running') throw new Error('Managed server did not start.');

    try {
      await expect(getManagedHttpServerStatus({ dataRoot }))
        .resolves.toMatchObject({ state: 'running', pid: started.pid });
      await expect(stopManagedHttpServer({ dataRoot }))
        .resolves.toMatchObject({ state: 'stopped' });
      await expect(getManagedHttpServerStatus({ dataRoot }))
        .resolves.toMatchObject({ state: 'stopped' });
    } finally {
      await stopManagedHttpServer({ dataRoot }).catch(() => undefined);
    }
  }, 20_000);
});

async function reserveLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('No loopback TCP port.');
  const { port } = address;
  await new Promise<void>((resolveClose, reject) => {
    server.close((error) => error ? reject(error) : resolveClose());
  });
  return port;
}
