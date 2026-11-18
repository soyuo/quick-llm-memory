import React from 'react';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { TuiApp } from '../../src/tui/app.js';

const apps: Array<ReturnType<typeof render>> = [];
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const app of apps.splice(0)) {
    app.unmount();
  }
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('TUI Settings', () => {
  it('edits supported values, persists them, and reloads them on a new screen', async () => {
    const paths = createPaths();
    mkdirSync(paths.configDir, { recursive: true });
    writeFileSync(paths.configFile, 'ai:\n  provider: openai\n  model: old\nlogging:\n  level: info\n');
    const app = render(<TuiApp dataRoot={paths.dataRoot} settingsPaths={paths} />);
    apps.push(app);

    await openSettings(app);
    expect(app.lastFrame()).toContain('AI Model: old');
    app.stdin.write('\u001b[C');
    await flushInkEffects();
    app.stdin.write('\u001b[B');
    await flushInkEffects();
    app.stdin.write('\r');
    await flushInkEffects();
    for (let index = 0; index < 3; index += 1) {
      app.stdin.write('\u007f');
      await flushInkEffects();
    }
    for (const character of 'quick-model') {
      app.stdin.write(character);
      await flushInkEffects();
    }
    app.stdin.write('\r');
    await flushInkEffects();
    app.stdin.write('\u001b[B');
    await waitForFrame(app, 'Embedding model: text-embedding-3-small');
    app.stdin.write('\r');
    await flushInkEffects();
    for (let index = 0; index < 'text-embedding-3-small'.length; index += 1) {
      app.stdin.write('\u007f');
      await flushInkEffects();
    }
    for (const character of 'text-embedding-3-large') {
      app.stdin.write(character);
      await flushInkEffects();
    }
    app.stdin.write('\r');
    await flushInkEffects();
    app.stdin.write('\u001b[B');
    await flushInkEffects();
    app.stdin.write('\u001b[C');
    await flushInkEffects();
    app.stdin.write('\u001b[B');
    await flushInkEffects();
    app.stdin.write('\u001b[C');
    await flushInkEffects();
    app.stdin.write('s');
    await waitForFrame(app, 'Settings saved to config.yaml.');

    expect(readFileSync(paths.configFile, 'utf8')).toContain('provider: openai-compatible');
    expect(readFileSync(paths.configFile, 'utf8')).toContain('model: quick-model');
    expect(readFileSync(paths.configFile, 'utf8')).toContain('embedding_model: text-embedding-3-large');
    expect(readFileSync(paths.configFile, 'utf8')).toContain('level: debug');
    expect(readFileSync(paths.configFile, 'utf8')).toContain('cache_generation: false');

    app.stdin.write('\u001b');
    await waitForFrame(app, 'Navigation [focus]');
    await openSettings(app);
    expect(app.lastFrame()).toContain('AI Provider: openai-compatible');
    expect(app.lastFrame()).toContain('AI Model: quick-model');
    expect(app.lastFrame()).toContain('Embedding model: text-embedding-3-large');
    expect(app.lastFrame()).toContain('Logging level: debug');
    expect(app.lastFrame()).toContain('Generation response cache: Disabled');
  }, 15_000);

  it('does not display or rewrite credentials found in existing config', async () => {
    const paths = createPaths();
    mkdirSync(paths.configDir, { recursive: true });
    const original = 'ai:\n  provider: openai\n  model: safe-model\n  api_key: do-not-display\nlogging:\n  level: info\n';
    writeFileSync(paths.configFile, original);
    const app = render(<TuiApp dataRoot={paths.dataRoot} settingsPaths={paths} />);
    apps.push(app);

    await openSettings(app);
    expect(app.lastFrame()).not.toContain('do-not-display');
    app.stdin.write('s');
    await waitForFrame(app, 'Settings were not saved.');
    expect(readFileSync(paths.configFile, 'utf8')).toBe(original);
  });
});

function createPaths() {
  const directory = mkdtempSync(join(tmpdir(), 'qlm-tui-settings-'));
  temporaryDirectories.push(directory);
  const configDir = join(directory, 'config');
  return {
    dataRoot: join(directory, 'data'),
    configDir,
    configFile: join(configDir, 'config.yaml'),
  };
}

async function openSettings(app: ReturnType<typeof render>): Promise<void> {
  await flushInkEffects();
  for (let index = 0; index < 10 && !(app.lastFrame() ?? '').includes('Settings [selected]'); index += 1) {
    app.stdin.write('\u001b[B');
    await waitForFrame(app, 'Navigation [focus]');
    await flushInkEffects();
  }
  expect(app.lastFrame() ?? '').toContain('Settings [selected]');
  app.stdin.write('\r');
  await waitForFrame(app, 'AI Provider:');
}

function flushInkEffects(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitForFrame(app: ReturnType<typeof render>, expected: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if ((app.lastFrame() ?? '').includes(expected)) {
      return;
    }
    await flushInkEffects();
  }
  expect(app.lastFrame() ?? '').toContain(expected);
}
