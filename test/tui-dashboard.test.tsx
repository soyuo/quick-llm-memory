import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import React from 'react';
import { render } from 'ink-testing-library';
import { afterEach, describe, expect, it } from 'vitest';
import { InputError } from '../src/errors/qlm-error.js';
import {
  createApplicationLogger,
  logApplicationError,
  logProjectCreated,
  logProjectReindexed,
} from '../src/logging/logger.js';
import { createMarkdownDocument } from '../src/markdown/repository.js';
import { initializeProject } from '../src/projects/manager.js';
import { TuiApp } from '../src/tui/app.js';
import { loadTuiDashboardSnapshot } from '../src/tui/dashboard.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('TUI dashboard and project selector', () => {
  it('summarizes projects and counts documents and categories', () => {
    const dataRoot = createDataRoot();
    const project = initializeProject(dataRoot, 'alpha');
    const knowledgeRoot = join(dataRoot, 'projects', 'alpha', 'knowledge');
    createDocument(knowledgeRoot, 'overview.md', 'Overview', 1);
    createDocument(knowledgeRoot, 'security/auth.md', 'Authentication', 2);

    const snapshot = loadTuiDashboardSnapshot(dataRoot);

    expect(snapshot.projects).toHaveLength(1);
    expect(snapshot.selectedProject?.name).toBe('alpha');
    expect(snapshot.documentCount).toBe(2);
    expect(snapshot.categoryCount).toBe(1);
    expect(snapshot.projectSummaryAvailable).toBe(true);
    expect(snapshot.mcpSummary).toContain('client-managed');
    expect(JSON.stringify(snapshot)).not.toContain(dataRoot);
    expect(project.name).toBe('alpha');
  });

  it('shows safe recent project and error summaries from the log tail', async () => {
    const dataRoot = createDataRoot();
    const project = initializeProject(dataRoot, 'alpha');
    const logger = createApplicationLogger({ dataRoot, level: 'info' });
    logProjectCreated(logger, project.id);
    logProjectReindexed(logger, project.id, { categories: 2, documents: 3, relations: 1 });
    logApplicationError(logger, new InputError('A private path should not appear.'));
    const malformedError = new Error('hidden in safe summary');
    malformedError.name = dataRoot;
    logApplicationError(logger, malformedError);
    await logger.close();

    const snapshot = loadTuiDashboardSnapshot(dataRoot);

    expect(snapshot.recentActivities.map(({ summary }) => summary)).toEqual([
      'Recent error: Unexpected error',
      'Recent error: QLM_INPUT_ERROR',
      'Project reindexed: alpha (3 documents)',
      'Project created: alpha',
    ]);
    expect(JSON.stringify(snapshot)).not.toContain(dataRoot);
    expect(JSON.stringify(snapshot)).not.toContain('private path');
    expect(snapshot.buildSummary).toContain('not recorded');
  });

  it('reports unavailable project data without exposing filesystem paths', () => {
    const dataRoot = createDataRoot();
    const projectsPath = join(dataRoot, 'projects');
    writeFileSync(projectsPath, 'not a directory');

    const snapshot = loadTuiDashboardSnapshot(dataRoot);

    expect(snapshot.error).toBe('Project information is unavailable.');
    expect(JSON.stringify(snapshot)).not.toContain(dataRoot);
  });

  it('shows a generic unavailable summary for an invalid project tree', () => {
    const dataRoot = createDataRoot();
    initializeProject(dataRoot, 'broken');
    const knowledgeRoot = join(dataRoot, 'projects', 'broken', 'knowledge');
    mkdirSync(knowledgeRoot, { recursive: true });
    writeFileSync(join(knowledgeRoot, 'broken.md'), '---\ntitle: [bad\n---\n');

    const snapshot = loadTuiDashboardSnapshot(dataRoot, 'broken');

    expect(snapshot.projectSummaryAvailable).toBe(false);
    expect(snapshot.error).toBeUndefined();
    expect(JSON.stringify(snapshot)).not.toContain(dataRoot);
  });

  it('lets keyboard users change the selected project', async () => {
    const dataRoot = createDataRoot();
    initializeProject(dataRoot, 'alpha');
    initializeProject(dataRoot, 'beta');
    const initiallySelected = loadTuiDashboardSnapshot(dataRoot).selectedProject?.name;
    const otherProject = initiallySelected === 'alpha' ? 'beta' : 'alpha';
    const app = render(<TuiApp columns={120} rows={30} dataRoot={dataRoot} />);
    await flushInkEffects();
    app.stdin.write('\u001b[B');
    await flushInkEffects();
    app.stdin.write('\r');
    await flushInkEffects();
    app.stdin.write('\u001b[B');
    await flushInkEffects();
    app.stdin.write('\r');
    await flushInkEffects();

    expect(app.lastFrame()).toContain(`Selected project: ${otherProject}`);
    app.unmount();
  });

  it('reconciles the selected project and list cursor after refresh', async () => {
    const dataRoot = createDataRoot();
    initializeProject(dataRoot, 'alpha');
    initializeProject(dataRoot, 'beta');
    initializeProject(dataRoot, 'gamma');
    const removedProject = loadTuiDashboardSnapshot(dataRoot).selectedProject;
    expect(removedProject).toBeDefined();

    const app = render(<TuiApp columns={120} rows={30} dataRoot={dataRoot} />);
    await flushInkEffects();
    app.stdin.write('\u001b[B');
    await flushInkEffects();
    app.stdin.write('\r');
    await flushInkEffects();

    rmSync(join(dataRoot, 'projects', removedProject!.name), { recursive: true });
    app.stdin.write('r');
    await flushInkEffects();
    app.stdin.write('\r');
    await flushInkEffects();

    const fallbackProject = loadTuiDashboardSnapshot(dataRoot).selectedProject;
    expect(fallbackProject).toBeDefined();
    expect(app.lastFrame()).toContain('Projects: 2');
    expect(app.lastFrame()).toContain(`Selected project: ${fallbackProject!.name}`);
    expect(app.lastFrame()).not.toContain(`Selected project: ${removedProject!.name}`);
    app.unmount();
  });

  it('preserves a still-existing project cursor when the list changes', async () => {
    const dataRoot = createDataRoot();
    initializeProject(dataRoot, 'alpha');
    initializeProject(dataRoot, 'beta');
    initializeProject(dataRoot, 'gamma');
    const beforeRefresh = loadTuiDashboardSnapshot(dataRoot);
    const removedProject = beforeRefresh.selectedProject!;

    const app = render(<TuiApp columns={120} rows={30} dataRoot={dataRoot} />);
    await flushInkEffects();
    app.stdin.write('\u001b[B');
    await flushInkEffects();
    app.stdin.write('\r');
    await flushInkEffects();

    rmSync(join(dataRoot, 'projects', removedProject.name), { recursive: true });
    const afterRefresh = loadTuiDashboardSnapshot(dataRoot);
    const cursorProject = afterRefresh.projects.find(
      ({ name }) => name !== afterRefresh.selectedProject?.name,
    );
    expect(cursorProject).toBeDefined();

    const startIndex = beforeRefresh.projects.findIndex(
      ({ name }) => name === removedProject.name,
    );
    const targetIndex = beforeRefresh.projects.findIndex(
      ({ name }) => name === cursorProject!.name,
    );
    const steps = (targetIndex - startIndex + beforeRefresh.projects.length)
      % beforeRefresh.projects.length;
    for (let step = 0; step < steps; step += 1) {
      app.stdin.write('\u001b[B');
      await flushInkEffects();
    }

    app.stdin.write('r');
    await flushInkEffects();
    app.stdin.write('\r');
    await flushInkEffects();

    expect(app.lastFrame()).toContain(`Selected project: ${cursorProject!.name}`);
    app.unmount();
  });

  it('refreshes project and knowledge counts after project changes', async () => {
    const dataRoot = createDataRoot();
    const app = render(<TuiApp columns={120} rows={30} dataRoot={dataRoot} />);
    expect(app.lastFrame()).toContain('Projects: 0');
    initializeProject(dataRoot, 'new-project');
    createDocument(
      join(dataRoot, 'projects', 'new-project', 'knowledge'),
      'guide.md',
      'Guide',
      1,
    );
    await flushInkEffects();
    app.stdin.write('r');
    await flushInkEffects();

    expect(app.lastFrame()).toContain('Projects: 1');
    expect(app.lastFrame()).toContain('Selected project: new-project');
    expect(app.lastFrame()).toContain('Knowledge: 0 categories, 1 documents');
    app.unmount();
  });
});

function createDataRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'qlm-tui-dashboard-'));
  roots.push(root);
  return root;
}

function createDocument(
  knowledgeRoot: string,
  path: string,
  title: string,
  depth: number,
): void {
  createMarkdownDocument(knowledgeRoot, path, {
    metadata: { schema_version: 1, title, type: 'document', depth, status: 'draft' },
    body: `\n# ${title}\n`,
  });
}

function flushInkEffects(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
