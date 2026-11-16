import React from 'react';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { render } from 'ink-testing-library';
import { afterEach, describe, expect, it } from 'vitest';
import { initializeProject, listProjects } from '../src/projects/manager.js';
import { TuiApp } from '../src/tui/app.js';

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('TUI project lifecycle actions', () => {
  it('creates and renames projects from the keyboard while preserving files', async () => {
    const dataRoot = createDataRoot();
    const app = render(<TuiApp columns={120} rows={30} dataRoot={dataRoot} />);
    await openProjects(app);

    app.stdin.write('c');
    await flushInkEffects();
    app.stdin.write('new-project');
    await flushInkEffects();
    app.stdin.write('\r');
    await flushInkEffects();
    expect(app.lastFrame()).toContain('Created project new-project.');
    expect(listProjects(dataRoot).map(({ name }) => name)).toEqual(['new-project']);

    const knowledgeDirectory = join(dataRoot, 'projects', 'new-project', 'knowledge');
    mkdirSync(knowledgeDirectory);
    writeFileSync(join(knowledgeDirectory, 'notes.md'), 'keep this document');
    app.stdin.write('n');
    await flushInkEffects();
    app.stdin.write('renamed-project');
    await flushInkEffects();
    app.stdin.write('\r');
    await flushInkEffects();

    expect(app.lastFrame()).toContain('Renamed project to renamed-project.');
    expect(listProjects(dataRoot).map(({ name }) => name)).toEqual(['renamed-project']);
    expect(readFileSync(
      join(dataRoot, 'projects', 'renamed-project', 'knowledge', 'notes.md'),
      'utf8',
    )).toBe('keep this document');
    app.unmount();
  });

  it('confirms archive and restore while leaving project data in place', async () => {
    const dataRoot = createDataRoot();
    initializeProject(dataRoot, 'saved');
    const knowledgeDirectory = join(dataRoot, 'projects', 'saved', 'knowledge');
    mkdirSync(knowledgeDirectory);
    writeFileSync(join(knowledgeDirectory, 'notes.md'), 'still here');
    const app = render(<TuiApp columns={120} rows={30} dataRoot={dataRoot} />);
    await openProjects(app);

    app.stdin.write('a');
    await flushInkEffects();
    expect(app.lastFrame()).toContain('Press y to confirm');
    app.stdin.write('n');
    await flushInkEffects();
    expect(listProjects(dataRoot)[0]?.archived_at).toBeUndefined();

    app.stdin.write('a');
    await flushInkEffects();
    app.stdin.write('y');
    await flushInkEffects();
    expect(app.lastFrame()).toContain('saved [archived]');
    expect(listProjects(dataRoot)[0]?.archived_at).toBeDefined();
    expect(readFileSync(join(knowledgeDirectory, 'notes.md'), 'utf8')).toBe('still here');

    app.stdin.write('a');
    await flushInkEffects();
    app.stdin.write('y');
    await flushInkEffects();
    expect(app.lastFrame()).not.toContain('saved [archived]');
    expect(listProjects(dataRoot)[0]?.archived_at).toBeUndefined();
    app.unmount();
  });

  it('requires exact project-name entry before deleting only that project', async () => {
    const dataRoot = createDataRoot();
    initializeProject(dataRoot, 'delete-me');
    const outsidePath = join(dataRoot, 'outside.txt');
    writeFileSync(outsidePath, 'keep this file');
    const app = render(<TuiApp columns={120} rows={30} dataRoot={dataRoot} />);
    await openProjects(app);

    app.stdin.write('d');
    await flushInkEffects();
    expect(app.lastFrame()).toContain('Type the exact name:');
    app.stdin.write('delete-me');
    await flushInkEffects();
    app.stdin.write('\r');
    await flushInkEffects();
    expect(app.lastFrame()).toContain('Deleted project delete-me.');
    expect(existsSync(join(dataRoot, 'projects', 'delete-me'))).toBe(false);
    expect(readFileSync(outsidePath, 'utf8')).toBe('keep this file');
    app.unmount();
  });

  it('imports and exports project directories through confirmed keyboard prompts', async () => {
    const dataRoot = createDataRoot();
    const sourceRoot = createDataRoot();
    const exportRoot = createDataRoot();
    initializeProject(sourceRoot, 'portable-project');
    const sourceDirectory = join(sourceRoot, 'projects', 'portable-project');
    mkdirSync(join(sourceDirectory, 'knowledge'));
    writeFileSync(join(sourceDirectory, 'knowledge', 'notes.md'), '# Portable');
    const exportDirectory = join(exportRoot, 'portable-export');
    const app = render(<TuiApp columns={120} rows={30} dataRoot={dataRoot} />);
    await openProjects(app);

    app.stdin.write('i');
    await flushInkEffects();
    app.stdin.write(sourceDirectory);
    await flushInkEffects();
    app.stdin.write('\r');
    await waitForFrame(app, 'Import as project name:');
    expect(app.lastFrame()).toContain('Import as project name: portable-project');
    app.stdin.write('\r');
    await flushInkEffects();
    expect(app.lastFrame()).toContain('Press y to copy');
    app.stdin.write('y');
    await waitForFrame(app, 'Imported project portable-project.');

    expect(readFileSync(
      join(dataRoot, 'projects', 'portable-project', 'knowledge', 'notes.md'),
      'utf8',
    )).toBe('# Portable');
    app.stdin.write('e');
    await flushInkEffects();
    app.stdin.write(exportDirectory);
    await flushInkEffects();
    app.stdin.write('\r');
    await flushInkEffects();
    expect(app.lastFrame()).toContain('Press y to copy');
    app.stdin.write('y');
    await waitForFrame(app, 'Exported project portable-project.');

    expect(readFileSync(join(exportDirectory, 'knowledge', 'notes.md'), 'utf8'))
      .toBe('# Portable');
    expect(existsSync(sourceDirectory)).toBe(true);
    app.unmount();
  });

  it('cancels import before commit without creating a project', async () => {
    const dataRoot = createDataRoot();
    const sourceRoot = createDataRoot();
    initializeProject(sourceRoot, 'cancel-source');
    const sourceDirectory = join(sourceRoot, 'projects', 'cancel-source');
    const app = render(<TuiApp columns={120} rows={30} dataRoot={dataRoot} />);
    await openProjects(app);

    app.stdin.write('i');
    await flushInkEffects();
    app.stdin.write(sourceDirectory);
    await flushInkEffects();
    app.stdin.write('\r');
    await waitForFrame(app, 'Import as project name:');
    app.stdin.write('\r');
    await waitForFrame(app, 'Press y to copy');
    app.stdin.write('\u001b');
    await waitForFrame(app, 'Project action cancelled.');
    expect(existsSync(join(dataRoot, 'projects', 'cancel-source'))).toBe(false);
    expect(existsSync(sourceDirectory)).toBe(true);
    app.unmount();
  });
});

function createDataRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'qlm-tui-project-actions-'));
  temporaryRoots.push(root);
  return root;
}

function openProjects(app: ReturnType<typeof render>): Promise<void> {
  app.stdin.write('\u001b[B');
  return flushInkEffects().then(() => {
    app.stdin.write('\r');
    return flushInkEffects();
  });
}

function flushInkEffects(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitForFrame(
  app: ReturnType<typeof render>,
  expected: string,
): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    if ((app.lastFrame() ?? '').includes(expected)) {
      return;
    }
  }
  throw new Error(`Timed out waiting for TUI output: ${expected}`);
}
