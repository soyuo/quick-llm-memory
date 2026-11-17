import React from 'react';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { resolveLogFilePath } from '../src/logging/logger.js';
import { TuiApp } from '../src/tui/app.js';
import { Logs } from '../src/tui/logs.js';

const roots: string[] = [];
const apps: Array<ReturnType<typeof render>> = [];

afterEach(() => {
  for (const app of apps.splice(0)) app.unmount();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('TUI application logs', () => {
  it('filters safe summaries and copies only a sanitized excerpt', async () => {
    const root = createRoot();
    const logPath = resolveLogFilePath(root);
    mkdirSync(dirname(logPath), { recursive: true });
    writeFileSync(logPath, [
      JSON.stringify({ time: 1_700_000_000_000, level: 30, event: 'project.created', msg: 'Project created', prompt: 'secret prompt' }),
      JSON.stringify({ time: 1_700_000_000_001, level: 50, event: 'application.error', msg: 'unsafe message', errorCode: 'QLM_INTERNAL_ERROR', content: 'secret content' }),
    ].join('\n'));
    const copied: string[] = [];
    const app = render(<Logs dataRoot={root} copyText={(text) => copied.push(text)} />);
    apps.push(app);

    expect(app.lastFrame()).toContain('Application error: QLM_INTERNAL_ERROR');
    app.stdin.write('\t');
    await flushInkEffects();
    expect(app.lastFrame()).toContain('View: operations');
    expect(app.lastFrame()).not.toContain('Application error: QLM_INTERNAL_ERROR');
    app.stdin.write('\t');
    await flushInkEffects();
    expect(app.lastFrame()).toContain('View: errors');
    app.stdin.write('x');
    await flushInkEffects();

    expect(copied).toHaveLength(1);
    expect(copied[0]).toContain('Application error: QLM_INTERNAL_ERROR');
    expect(copied[0]).not.toContain('secret');
    expect(copied[0]).not.toContain('unsafe message');
    app.stdin.write('\t');
    await flushInkEffects();
    expect(app.lastFrame()).toContain('View: mcp');
    expect(app.lastFrame()).toContain('MCP tool calls are not recorded');
  });

  it('opens no file when the configured editor command is malformed', async () => {
    const root = createRoot();
    const logPath = resolveLogFilePath(root);
    mkdirSync(dirname(logPath), { recursive: true });
    writeFileSync(logPath, `${JSON.stringify({ time: 1_700_000_000_000, level: 30, event: 'application.started' })}\n`);
    const app = render(<Logs dataRoot={root} editorCommand="'unfinished" />);
    apps.push(app);

    app.stdin.write('e');
    await flushInkEffects();

    expect(app.lastFrame()).toContain('configured editor command is invalid');
    expect(app.lastFrame()).not.toContain(logPath);
  });

  it('opens the Logs screen from application navigation', async () => {
    const root = createRoot();
    const app = render(<TuiApp dataRoot={root} />);
    apps.push(app);

    for (let index = 0; index < 12 && !(app.lastFrame() ?? '').includes('Logs [selected]'); index += 1) {
      app.stdin.write('\u001b[B');
      await flushInkEffects();
    }
    expect(app.lastFrame()).toContain('Logs [selected]');
    app.stdin.write('\r');
    await waitForFrame(app, 'Application Logs');
  });
});

function createRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'qlm-tui-logs-'));
  roots.push(root);
  return root;
}

async function flushInkEffects(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 5));
}

async function waitForFrame(app: ReturnType<typeof render>, text: string): Promise<void> {
  for (let attempt = 0; attempt < 20 && !(app.lastFrame() ?? '').includes(text); attempt += 1) {
    await flushInkEffects();
  }
  expect(app.lastFrame() ?? '').toContain(text);
}
