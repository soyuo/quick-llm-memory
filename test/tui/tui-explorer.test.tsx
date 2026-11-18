import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import React from 'react';
import { render } from 'ink-testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMarkdownDocument } from '../../src/markdown/repository.js';
import { initializeProject } from '../../src/projects/manager.js';
import { Explorer } from '../../src/tui/explorer.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('TUI knowledge explorer', () => {
  it('expands categories and reads a document with metadata and related navigation', async () => {
    const { dataRoot, knowledgeRoot } = createProjectRoot();
    const related = createDocument(knowledgeRoot, 'security/related.md', 'Related note', 2, '\nRelated body.\n');
    const source = createMarkdownDocument(knowledgeRoot, 'security/overview.md', {
      metadata: {
        schema_version: 1,
        title: 'Security overview',
        type: 'document',
        depth: 2,
        status: 'reviewed',
        description: 'Security summary',
        source_ids: ['source-1'],
        source_sections: ['Part A'],
        related: [related.metadata.id],
      },
      body: '\n# Security overview\nSafe body line.\n',
    });
    const app = render(
      <Explorer dataRoot={dataRoot} projectName="alpha" refreshVersion={0} />,
    );
    await flushInkEffects();

    expect(app.lastFrame()).toContain('security/');
    app.stdin.write('\r');
    await flushInkEffects();
    app.stdin.write('\u001b[B');
    await flushInkEffects();
    app.stdin.write('\r');
    await flushInkEffects();

    expect(app.lastFrame()).toContain('Security overview');
    expect(app.lastFrame()).toContain('Path: security/overview.md');
    expect(app.lastFrame()).toContain('Status: reviewed');
    expect(app.lastFrame()).toContain('Sources: source-1');
    expect(app.lastFrame()).toContain('Source sections: Part A');
    expect(app.lastFrame()).toContain('Safe body line.');
    expect(source.metadata.id).toBeTruthy();

    app.stdin.write('\t');
    await flushInkEffects();
    app.stdin.write('\r');
    await flushInkEffects();
    expect(app.lastFrame()).toContain('Related note');
    expect(app.lastFrame()).toContain('Related body.');
    app.unmount();
  });

  it('copies a document path and reports an unconfigured editor safely', async () => {
    const { dataRoot, knowledgeRoot } = createProjectRoot();
    const document = createDocument(knowledgeRoot, 'readme.md', 'Read me', 1);
    const copyPath = vi.fn();
    const app = render(
      <Explorer
        dataRoot={dataRoot}
        projectName="alpha"
        refreshVersion={0}
        copyPath={copyPath}
        editorCommand=""
      />,
    );
    await flushInkEffects();
    app.stdin.write('\r');
    await flushInkEffects();
    app.stdin.write('c');
    await flushInkEffects();
    expect(copyPath).toHaveBeenCalledWith(join(knowledgeRoot, 'readme.md'));
    app.stdin.write('e');
    await flushInkEffects();
    expect(app.lastFrame()).toContain('Set EDITOR or VISUAL');
    app.unmount();
  });

  it('shows a safe actionable error when the selected document disappears', async () => {
    const { dataRoot, knowledgeRoot } = createProjectRoot();
    createDocument(knowledgeRoot, 'note.md', 'Note', 1);
    const app = render(
      <Explorer dataRoot={dataRoot} projectName="alpha" refreshVersion={0} />,
    );
    await flushInkEffects();
    app.stdin.write('\r');
    await flushInkEffects();
    rmSync(join(knowledgeRoot, 'note.md'));
    app.stdin.write('r');
    await flushInkEffects();

    expect(app.lastFrame()).toContain('Could not read this document');
    expect(app.lastFrame()).not.toContain(dataRoot);
    app.unmount();
  });

  it('strips terminal control characters from document metadata and body', async () => {
    const { dataRoot, knowledgeRoot } = createProjectRoot();
    createDocument(knowledgeRoot, 'note.md', 'Safe\u001b]52;c;ZXZpbA==\u0007 title', 1, '\nBody\u001b[31m text\u009b2J\u0007\n');
    const app = render(
      <Explorer dataRoot={dataRoot} projectName="alpha" refreshVersion={0} />,
    );
    await flushInkEffects();
    app.stdin.write('\r');
    await flushInkEffects();

    expect(app.lastFrame()).toContain('Safe ]52;c;ZXZpbA==  title');
    expect(app.lastFrame()).toContain('Body [31m text 2J');
    expect(app.lastFrame()).not.toContain('\u001b');
    expect(app.lastFrame()).not.toContain('\u009b');
    app.unmount();
  });

  it('shows a safe message when no project is selected', () => {
    const { dataRoot } = createProjectRoot();
    const app = render(<Explorer dataRoot={dataRoot} refreshVersion={0} />);
    expect(app.lastFrame()).toContain('No project is selected');
    app.unmount();
  });

  it('reports a safe actionable message when the configured editor cannot start', async () => {
    const { dataRoot, knowledgeRoot } = createProjectRoot();
    createDocument(knowledgeRoot, 'note.md', 'Note', 1);
    const app = render(
      <Explorer
        dataRoot={dataRoot}
        projectName="alpha"
        refreshVersion={0}
        editorCommand="qlm-editor-that-does-not-exist"
      />,
    );
    await flushInkEffects();
    app.stdin.write('\r');
    await flushInkEffects();
    app.stdin.write('e');
    await waitForFrame(app.lastFrame, 'Could not open the external editor');

    expect(app.lastFrame()).not.toContain(dataRoot);
    app.unmount();
  });
});

function createProjectRoot(): { dataRoot: string; knowledgeRoot: string } {
  const dataRoot = mkdtempSync(join(tmpdir(), 'qlm-tui-explorer-'));
  roots.push(dataRoot);
  initializeProject(dataRoot, 'alpha');
  const knowledgeRoot = join(dataRoot, 'projects', 'alpha', 'knowledge');
  mkdirSync(knowledgeRoot, { recursive: true });
  return { dataRoot, knowledgeRoot };
}

function createDocument(
  knowledgeRoot: string,
  path: string,
  title: string,
  depth: number,
  body = `\n# ${title}\n`,
) {
  return createMarkdownDocument(knowledgeRoot, path, {
    metadata: { schema_version: 1, title, type: 'document', depth, status: 'draft' },
    body,
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
