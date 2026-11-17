import React from 'react';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { render } from 'ink-testing-library';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveProjectDatabasePath } from '../src/database/database.js';
import { initializeProject, listProjects } from '../src/projects/manager.js';
import { MarkdownDocumentParser } from '../src/knowledge/markdown-parser.js';
import { loadMarkdownSources } from '../src/knowledge/source.js';
import type { HierarchyNode } from '../src/knowledge/planner.js';
import type { AIProvider, GenerateRequest, GenerateResponse, ModelInfo, StructuredRequest, TokenCount } from '../src/providers/provider.js';
import { TuiApp } from '../src/tui/app.js';
import { validateBuildWizardStep, type BuildWizardDraft } from '../src/tui/build-wizard.js';

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('TUI knowledge build setup wizard', () => {
  it('validates hierarchy and document setting relationships', () => {
    const draft: BuildWizardDraft = {
      projectName: 'valid-project',
      sourcePath: 'unused',
      provider: 'openai',
      model: 'test-model',
      minDepth: '3',
      maxDepth: '2',
      autoDepth: true,
      minTokens: '150',
      targetTokens: '1000',
      maxTokens: '2000',
      preserveCodeBlocks: true,
      preserveTables: true,
      theme: 'dark',
    };
    expect(validateBuildWizardStep('hierarchy', draft))
      .toBe('Maximum depth must be at least the minimum depth.');
    expect(validateBuildWizardStep('document', { ...draft, maxTokens: '900' }))
      .toBe('Token limits must satisfy minimum <= target <= maximum.');
    expect(validateBuildWizardStep('document', draft)).toBeUndefined();
  });

  it('previews without writing, requires confirmation, then refreshes the dashboard', async () => {
    const dataRoot = createTemporaryRoot('qlm-wizard-data-');
    const sourceRoot = createTemporaryRoot('qlm-wizard-source-');
    const sourceFile = join(sourceRoot, 'notes.md');
    writeFileSync(sourceFile, '# Notes\n\nSource material.\n');
    const project = initializeProject(dataRoot, 'quick-llm');
    const source = loadMarkdownSources(sourceFile)[0];
    if (source === undefined) throw new Error('Expected a Markdown source fixture.');
    const parsed = await new MarkdownDocumentParser().parse(source);
    const provider = new FakeWizardProvider([{
      id: 'notes', name: 'Notes', type: 'document', path: 'notes.md',
      description: 'Source notes.', sourceSectionIds: parsed.sections.map(({ id }) => id),
      relatedDocumentIds: [], children: [],
    }]);
    const settingsFile = join(dataRoot, 'config', 'config.yaml');
    mkdirSync(join(dataRoot, 'config'));
    writeFileSync(settingsFile, 'logging:\n  level: info\n');

    const app = render(
      <TuiApp columns={120} rows={30} dataRoot={dataRoot} buildProviderFactory={() => provider} />,
    );
    await openBuild(app);
    expect(app.lastFrame()).toContain('1/6 Project Name');

    app.stdin.write('\r');
    await flushInkEffects();
    expect(app.lastFrame()).toContain('lowercase letters');
    app.stdin.write('q');
    await flushInkEffects();
    expect(app.lastFrame()).toContain('projectName: q_');
    app.stdin.write('uick-llm');
    await flushInkEffects();
    app.stdin.write('\r');
    await flushInkEffects();
    expect(app.lastFrame()).toContain('2/6 Input Sources');

    app.stdin.write(sourceFile);
    await flushInkEffects();
    app.stdin.write('\r');
    await flushInkEffects();
    expect(app.lastFrame()).toContain('3/6 AI Provider');
    app.stdin.write('\r');
    await flushInkEffects();
    expect(app.lastFrame()).toContain('4/6 AI Model');

    app.stdin.write('test-model');
    await flushInkEffects();
    app.stdin.write('\r');
    await flushInkEffects();
    expect(app.lastFrame()).toContain('5/6 Hierarchy Settings');
    app.stdin.write('\t');
    await flushInkEffects();
    app.stdin.write('\x15');
    await flushInkEffects();
    app.stdin.write('4');
    await flushInkEffects();
    app.stdin.write('\r');
    await flushInkEffects();
    expect(app.lastFrame()).toContain('6/6 Document Settings');
    app.stdin.write('\x02');
    await flushInkEffects();
    expect(app.lastFrame()).toContain('maxDepth: 4');
    app.stdin.write('\r');
    await flushInkEffects();
    app.stdin.write('\r');
    await flushInkEffects();
    await waitForFrame(app, '8/12 Structure Preview');
    expect(app.lastFrame()).toContain('notes.md');
    expect(provider.requests.map(({ schemaName }) => schemaName)).toEqual(['qlm_knowledge_hierarchy']);
    expect(existsSync(join(dataRoot, 'projects', project.name, 'knowledge'))).toBe(false);
    expect(existsSync(resolveProjectDatabasePath(join(dataRoot, 'projects', project.name)))).toBe(false);

    app.stdin.write('\r');
    await flushInkEffects();
    expect(app.lastFrame()).toContain('9/12 Confirmation');
    app.stdin.write('\u001b');
    await waitForFrame(app, '8/12 Structure Preview');
    expect(app.lastFrame()).toContain('8/12 Structure Preview');
    expect(provider.requests).toHaveLength(1);
    expect(existsSync(join(dataRoot, 'projects', project.name, 'knowledge'))).toBe(false);

    app.stdin.write('\r');
    await flushInkEffects();
    app.stdin.write('y');
    await flushInkEffects();
    await waitForFrame(app, '12/12 Complete');
    expect(provider.requests.map(({ schemaName }) => schemaName)).toEqual([
      'qlm_knowledge_hierarchy', 'qlm_generated_document_content',
    ]);
    expect(readFileSync(join(dataRoot, 'projects', project.name, 'knowledge', 'notes.md'), 'utf8'))
      .toContain('Generated knowledge document.');
    expect(readFileSync(settingsFile, 'utf8')).toBe('logging:\n  level: info\n');
    app.stdin.write('\r');
    await flushInkEffects();
    expect(app.lastFrame()).toContain('Selected project: quick-llm');
    expect(app.lastFrame()).toContain('Knowledge: 0 categories, 1 documents');
    expect(listProjects(dataRoot)).toHaveLength(1);
    app.unmount();
  });

  it('blocks invalid source paths at the source step', async () => {
    const dataRoot = createTemporaryRoot('qlm-wizard-invalid-');
    const app = render(<TuiApp columns={120} rows={30} dataRoot={dataRoot} />);
    await openBuild(app);
    app.stdin.write('valid-project');
    await flushInkEffects();
    app.stdin.write('\r');
    await flushInkEffects();
    app.stdin.write('missing-source');
    await flushInkEffects();
    app.stdin.write('\r');
    await flushInkEffects();

    expect(app.lastFrame()).toContain('2/6 Input Sources');
    expect(app.lastFrame()).toContain('ENOENT');
    expect(listProjects(dataRoot)).toEqual([]);
    app.unmount();
  });

  it('cancels analysis without creating knowledge or index files', async () => {
    const dataRoot = createTemporaryRoot('qlm-wizard-cancel-data-');
    const sourceRoot = createTemporaryRoot('qlm-wizard-cancel-source-');
    const sourceFile = join(sourceRoot, 'notes.md');
    writeFileSync(sourceFile, '# Notes\n\nSource material.\n');
    initializeProject(dataRoot, 'quick-llm');

    let markPlanningStarted = (): void => {};
    const planningStarted = new Promise<void>((resolve) => {
      markPlanningStarted = resolve;
    });
    const provider = new FakeWizardProvider([{
      id: 'notes', name: 'Notes', type: 'document', path: 'notes.md',
      description: 'Source notes.', sourceSectionIds: ['source:section'],
      relatedDocumentIds: [], children: [],
    }], (request) => new Promise<void>((_resolve, reject) => {
      request.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      markPlanningStarted();
    }));
    const app = render(
      <TuiApp columns={120} rows={30} dataRoot={dataRoot} buildProviderFactory={() => provider} />,
    );
    await enterBuildAnalysis(app, sourceFile);
    await planningStarted;
    expect(app.lastFrame()).toContain('7/12 Analysis');

    app.stdin.write('\u001b');
    await waitForFrame(app, 'Analysis cancelled; no generated documents were written.');
    expect(existsSync(join(dataRoot, 'projects', 'quick-llm', 'knowledge'))).toBe(false);
    expect(existsSync(resolveProjectDatabasePath(join(dataRoot, 'projects', 'quick-llm')))).toBe(false);
    expect(provider.requests.map(({ schemaName }) => schemaName)).toEqual(['qlm_knowledge_hierarchy']);
    app.unmount();
  });
});

function createTemporaryRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

async function flushInkEffects(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

async function openBuild(app: ReturnType<typeof render>): Promise<void> {
  app.stdin.write('\u001b[B');
  await flushInkEffects();
  app.stdin.write('\u001b[B');
  await flushInkEffects();
  app.stdin.write('\r');
  await flushInkEffects();
}

async function waitForFrame(app: ReturnType<typeof render>, text: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (app.lastFrame()?.includes(text)) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  expect(app.lastFrame()).toContain(text);
}

class FakeWizardProvider implements AIProvider {
  readonly id = 'fake-wizard-provider';
  readonly requests: StructuredRequest<unknown>[] = [];

  constructor(
    private readonly hierarchy: HierarchyNode[],
    private readonly beforePlanning?: (request: StructuredRequest<unknown>) => Promise<void>,
  ) {}

  async listModels(): Promise<ModelInfo[]> { return []; }
  async generate(request: GenerateRequest): Promise<GenerateResponse> {
    return { model: request.model, text: '' };
  }
  async generateStructured<T>(request: StructuredRequest<T>): Promise<T> {
    this.requests.push(request as StructuredRequest<unknown>);
    if (request.schemaName === 'qlm_knowledge_hierarchy') {
      await this.beforePlanning?.(request as StructuredRequest<unknown>);
      return { hierarchy: this.hierarchy } as T;
    }
    return { body: 'Generated knowledge document.', inferences: [] } as T;
  }
  async countTokens(_text: string, _model: string): Promise<TokenCount> {
    return { count: 0, isEstimate: true };
  }
}

async function enterBuildAnalysis(app: ReturnType<typeof render>, sourceFile: string): Promise<void> {
  await openBuild(app);
  app.stdin.write('quick-llm');
  await flushInkEffects();
  app.stdin.write('\r');
  await flushInkEffects();
  app.stdin.write(sourceFile);
  await flushInkEffects();
  app.stdin.write('\r');
  await flushInkEffects();
  app.stdin.write('\r');
  await flushInkEffects();
  app.stdin.write('test-model');
  await flushInkEffects();
  app.stdin.write('\r');
  await flushInkEffects();
  app.stdin.write('\r');
  await flushInkEffects();
  app.stdin.write('\r');
  await flushInkEffects();
  await waitForFrame(app, '7/12 Analysis');
}
