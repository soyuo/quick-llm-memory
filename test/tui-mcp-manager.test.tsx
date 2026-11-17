import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { TuiApp } from '../src/tui/app.js';

const apps: Array<ReturnType<typeof render>> = [];

afterEach(() => {
  for (const app of apps.splice(0)) {
    app.unmount();
  }
});

describe('TUI MCP Manager', () => {
  it('shows client setup, copies a snippet, and reports a bounded stdio check accurately', async () => {
    const copyText = vi.fn();
    const mcpConnectionCheck = vi.fn(async () => ['memory_list_projects', 'memory_read']);
    const app = render(
      <TuiApp dataRoot="C:\\qlm-data" copyText={copyText} mcpConnectionCheck={mcpConnectionCheck} />,
    );
    apps.push(app);

    await openMcpManager(app);
    expect(app.lastFrame()).toContain('Connection status: client-managed');
    expect(app.lastFrame()).toContain('Client: claude-code');
    expect(app.lastFrame()).toContain('Config target: .mcp.json');
    expect(app.lastFrame()).toContain('memory_get_context');
    expect(app.lastFrame()).toContain('MCP tool-call execution logs are not recorded yet.');
    expect(app.lastFrame()).not.toContain('server is running');

    app.stdin.write('c');
    await flushInkEffects();
    expect(copyText).toHaveBeenCalledOnce();
    expect(copyText.mock.calls[0]?.[0]).toContain('"quick-llm-memory"');

    app.stdin.write('t');
    await waitForFrame(app, 'Connection test passed;');
    expect(mcpConnectionCheck).toHaveBeenCalledOnce();
    expect(app.lastFrame()).toContain('temporary server stopped');
    expect(app.lastFrame()).toContain('memory_list_projects, memory_read');
  });

  it('changes client config target and shows a safe failure message', async () => {
    const mcpConnectionCheck = vi.fn(async () => {
      throw new Error('C:\\private\\installation\\failure');
    });
    const app = render(<TuiApp dataRoot="C:\\qlm-data" mcpConnectionCheck={mcpConnectionCheck} />);
    apps.push(app);

    await openMcpManager(app);
    app.stdin.write('\u001b[C');
    await flushInkEffects();
    expect(app.lastFrame()).toContain('Client: cursor');
    expect(app.lastFrame()).toContain('Config target: .cursor/mcp.json');

    app.stdin.write('t');
    await waitForFrame(app, 'Local stdio check failed or timed out.');
    expect(app.lastFrame()).not.toContain('private');
  });

  it('aborts a running check when returning to navigation', async () => {
    let signal: AbortSignal | undefined;
    const mcpConnectionCheck = vi.fn((checkSignal: AbortSignal) => {
      signal = checkSignal;
      return new Promise<string[]>((_resolve, reject) => {
        checkSignal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
      });
    });
    const app = render(<TuiApp dataRoot="C:\\qlm-data" mcpConnectionCheck={mcpConnectionCheck} />);
    apps.push(app);

    await openMcpManager(app);
    app.stdin.write('t');
    await waitForFrame(app, 'Checking local stdio connection');
    app.stdin.write('\u001b');
    await waitForFrame(app, 'Navigation [focus]');

    expect(signal?.aborted).toBe(true);
  });

  it('starts, refreshes, and stops the managed HTTP server', async () => {
    const getStatus = vi.fn(async () => ({ state: 'stopped' as const, message: 'HTTP server is stopped.' }));
    const start = vi.fn(async () => ({
      state: 'running' as const,
      pid: 1234,
      startedAt: '2026-11-17T00:00:00.000Z',
      host: '127.0.0.1',
      port: 8765,
      url: 'http://127.0.0.1:8765/mcp',
      logPath: 'C:\\qlm-data\\logs\\mcp-http.log',
    }));
    const stop = vi.fn(async () => ({ state: 'stopped' as const, message: 'HTTP server is stopped.' }));
    const app = render(
      <TuiApp dataRoot="C:\\qlm-data" mcpHttpStatus={getStatus} mcpHttpStart={start} mcpHttpStop={stop} />,
    );
    apps.push(app);

    await openMcpManager(app);
    await waitForFrame(app, 'Managed HTTP server: stopped');
    app.stdin.write('s');
    await waitForFrame(app, 'Managed HTTP server: running');
    expect(app.lastFrame()).toContain('http://127.0.0.1:8765/mcp');
    expect(start).toHaveBeenCalledOnce();

    app.stdin.write('u');
    await flushInkEffects();
    expect(getStatus).toHaveBeenCalledTimes(2);
    app.stdin.write('x');
    await waitForFrame(app, 'Managed HTTP server: stopped');
    expect(stop).toHaveBeenCalledOnce();
  });
});

async function openMcpManager(app: ReturnType<typeof render>): Promise<void> {
  await flushInkEffects();
  for (let index = 0; index < 5; index += 1) {
    app.stdin.write('\u001b[B');
    await flushInkEffects();
  }
  app.stdin.write('\r');
  await waitForFrame(app, 'MCP Manager [focus]');
}

function flushInkEffects(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitForFrame(app: ReturnType<typeof render>, expected: string): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if ((app.lastFrame() ?? '').includes(expected)) {
      return;
    }
    await flushInkEffects();
  }
  expect(app.lastFrame() ?? '').toContain(expected);
}
