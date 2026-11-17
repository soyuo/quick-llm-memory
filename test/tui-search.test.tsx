import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import React from 'react';
import { render } from 'ink-testing-library';
import { afterEach, describe, expect, it } from 'vitest';
import { rebuildProjectIndex } from '../src/database/reindex.js';
import { createMarkdownDocument } from '../src/markdown/repository.js';
import { initializeProject } from '../src/projects/manager.js';
import { TuiApp } from '../src/tui/app.js';
import { Search } from '../src/tui/search.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('TUI project search', () => {
  it('opens Search from the application navigation', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'qlm-tui-search-'));
    roots.push(dataRoot);
    const app = render(<TuiApp columns={100} rows={30} dataRoot={dataRoot} />);
    await flushInkEffects();
    for (let index = 0; index < 4; index += 1) {
      app.stdin.write('\u001b[B');
      await flushInkEffects();
    }
    app.stdin.write('\r');
    await flushInkEffects();

    expect(app.lastFrame()).toContain('Query [focus]: (type a query)');
    app.unmount();
  });

  it('accepts a query, previews ranked results, and opens a source document', async () => {
    const { dataRoot, project, knowledgeRoot } = createProject('alpha');
    createDocument(knowledgeRoot, 'guide.md', 'Search guide', 'needle matches this body.');
    rebuildProjectIndex(join(dataRoot, 'projects', 'alpha'), project);
    const app = render(
      <Search dataRoot={dataRoot} initialProjectName="alpha" refreshVersion={0} />,
    );
    await flushInkEffects();
    app.stdin.write('needle');
    await flushInkEffects();
    app.stdin.write('\r');
    await flushInkEffects();

    expect(app.lastFrame()).toContain('Mode: hybrid | Project: alpha');
    expect(app.lastFrame()).toContain('Search guide (guide.md)');
    expect(app.lastFrame()).toContain('Rank score (RRF, not probability):');
    expect(app.lastFrame()).toContain('Preview: # Search guide needle matches this body.');

    app.stdin.write('\r');
    await flushInkEffects();
    expect(app.lastFrame()).toContain('Path: guide.md');
    expect(app.lastFrame()).toContain('needle matches this body.');
    app.stdin.write('\u001b');
    await waitForFrame(app.lastFrame, 'Results [focus]');
    app.unmount();
  });

  it('allows q in query text instead of treating it as quit', async () => {
    const { dataRoot, project, knowledgeRoot } = createProject('alpha');
    createDocument(knowledgeRoot, 'quick.md', 'Quick guide', 'quick search content.');
    rebuildProjectIndex(join(dataRoot, 'projects', 'alpha'), project);
    let exited = false;
    const app = render(
      <Search
        dataRoot={dataRoot}
        initialProjectName="alpha"
        refreshVersion={0}
        onExit={() => { exited = true; }}
      />,
    );
    await flushInkEffects();
    app.stdin.write('quick');
    await flushInkEffects();
    expect(exited).toBe(false);
    expect(app.lastFrame()).toContain('Query [focus]: quick');
    app.stdin.write('\r');
    await flushInkEffects();
    expect(app.lastFrame()).toContain('Quick guide (quick.md)');
    app.unmount();
  });

  it('changes project scope from the keyboard and keeps results project-local', async () => {
    const { dataRoot, project: alpha } = createProject('alpha');
    const { project: beta } = createProjectAt(dataRoot, 'beta');
    createDocument(join(dataRoot, 'projects', 'alpha', 'knowledge'), 'alpha.md', 'Alpha note', 'shared search term.');
    createDocument(join(dataRoot, 'projects', 'beta', 'knowledge'), 'beta.md', 'Beta note', 'shared search term.');
    rebuildProjectIndex(join(dataRoot, 'projects', 'alpha'), alpha);
    rebuildProjectIndex(join(dataRoot, 'projects', 'beta'), beta);
    const app = render(
      <Search dataRoot={dataRoot} initialProjectName="alpha" refreshVersion={0} />,
    );
    await flushInkEffects();
    app.stdin.write('shared');
    await flushInkEffects();
    app.stdin.write('\r');
    await flushInkEffects();
    expect(app.lastFrame()).toContain('Alpha note (alpha.md)');
    expect(app.lastFrame()).not.toContain('Beta note (beta.md)');

    app.stdin.write('\t');
    await flushInkEffects();
    app.stdin.write('\t');
    await flushInkEffects();
    app.stdin.write('\t');
    await flushInkEffects();
    expect(app.lastFrame()).toContain('Project [focus]: alpha');
    app.stdin.write('\u001b[C');
    await flushInkEffects();
    expect(app.lastFrame()).toContain('Project [focus]: beta');
    app.stdin.write('\r');
    await flushInkEffects();
    expect(app.lastFrame()).toContain('Project: beta');
    expect(app.lastFrame()).toContain('Beta note (beta.md)');
    expect(app.lastFrame()).not.toContain('Alpha note (alpha.md)');
    app.unmount();
  });
});

function createProject(name: string): { dataRoot: string; project: ReturnType<typeof initializeProject>; knowledgeRoot: string } {
  const dataRoot = mkdtempSync(join(tmpdir(), 'qlm-tui-search-'));
  roots.push(dataRoot);
  const project = initializeProject(dataRoot, name);
  const knowledgeRoot = join(dataRoot, 'projects', name, 'knowledge');
  mkdirSync(knowledgeRoot, { recursive: true });
  return { dataRoot, project, knowledgeRoot };
}

function createProjectAt(dataRoot: string, name: string): { project: ReturnType<typeof initializeProject>; knowledgeRoot: string } {
  const project = initializeProject(dataRoot, name);
  const knowledgeRoot = join(dataRoot, 'projects', name, 'knowledge');
  mkdirSync(knowledgeRoot, { recursive: true });
  return { project, knowledgeRoot };
}

function createDocument(knowledgeRoot: string, path: string, title: string, body: string): void {
  createMarkdownDocument(knowledgeRoot, path, {
    metadata: { schema_version: 1, title, type: 'document', depth: 1, status: 'draft' },
    body: `\n# ${title}\n${body}\n`,
  });
}

function flushInkEffects(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitForFrame(lastFrame: () => string | undefined, text: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!lastFrame()?.includes(text) && Date.now() < deadline) {
    await flushInkEffects();
  }
  expect(lastFrame()).toContain(text);
}
