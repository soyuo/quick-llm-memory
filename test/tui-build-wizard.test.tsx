import React from 'react';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { render } from 'ink-testing-library';
import { afterEach, describe, expect, it } from 'vitest';
import { openProjectDatabaseReadOnly, resolveProjectDatabasePath } from '../src/database/database.js';
import { rebuildProjectIndex } from '../src/database/reindex.js';
import { replaceProjectSourceSnapshot } from '../src/database/source-snapshot.js';
import { initializeProject, listProjects } from '../src/projects/manager.js';
import { MarkdownDocumentParser } from '../src/knowledge/markdown-parser.js';
import { createProjectSourceSnapshot } from '../src/knowledge/source-changes.js';
import { loadMarkdownSources } from '../src/knowledge/source.js';
import type { HierarchyNode } from '../src/knowledge/planner.js';
import type { AIProvider, GenerateRequest, GenerateResponse, ModelInfo, StructuredRequest, TokenCount } from '../src/providers/provider.js';
import { TuiApp } from '../src/tui/app.js';
import { validateBuildWizardStep, type BuildWizardDraft } from '../src/tui/build-wizard.js';
import { updateGeneratedDocumentBaseline } from '../src/knowledge/document-generator.js';
import { buildProjectKnowledge } from '../src/knowledge/builder.js';

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
    const projectRoot = join(dataRoot, 'projects', project.name);
    const knowledgeRoot = join(projectRoot, 'knowledge');
    mkdirSync(join(knowledgeRoot, 'security'), { recursive: true });
    const existingDocumentPath = join(knowledgeRoot, 'security', 'related.md');
    const existingDocumentMarkdown = trackedDocument('related', 'Related', source.id, parsed.sections[0]?.id ?? 'section');
    writeFileSync(existingDocumentPath, existingDocumentMarkdown);
    writeFileSync(join(knowledgeRoot, 'security', 'index.md'), categoryIndex('security', 'Security'));
    const unrelatedDocumentPath = join(knowledgeRoot, 'unrelated.md');
    writeFileSync(unrelatedDocumentPath, existingDocument('unrelated', 'Unrelated'));
    rebuildProjectIndex(projectRoot, project);
    replaceProjectSourceSnapshot(
      projectRoot,
      project,
      createProjectSourceSnapshot(realpathSync(sourceFile), [source], parsed.sections),
    );
    writeFileSync(sourceFile, '# Notes\n\nUpdated source material.\n');
    const updatedSource = loadMarkdownSources(sourceFile)[0];
    if (updatedSource === undefined) throw new Error('Expected the updated Markdown source fixture.');
    const updatedParsed = await new MarkdownDocumentParser().parse(updatedSource);
    const databasePath = resolveProjectDatabasePath(projectRoot);
    const originalDatabase = readFileSync(databasePath);
    const provider = new FakeWizardProvider([{
      id: 'security', name: 'Security', type: 'category', path: 'security',
      description: 'Security topics.', sourceSectionIds: [], relatedDocumentIds: [],
      children: [{
        id: 'related', name: 'Related', type: 'document', path: 'security/related.md',
        description: 'Related source notes.', sourceSectionIds: updatedParsed.sections.map(({ id }) => id),
        relatedDocumentIds: [], children: [],
      }],
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
    const previewFrame = (app.lastFrame() ?? '').replace(/\s+/gu, ' ');
    expect(app.lastFrame()).toContain('notes.md');
    expect(app.lastFrame()).toContain('[Modified] source file: notes.md');
    expect(app.lastFrame()).toContain('[Modified] section: notes.md');
    expect(previewFrame).toContain('Impact plan: 1 document(s) to regenerate, 0 edited document(s) need review, 1 unaffected, 0 output(s) pending removal review, 1 parent index(es), 0 removed source(s) for review.');
    expect(app.lastFrame()).toContain('[Regenerate] security/related.md');
    expect(app.lastFrame()).toContain('[Update index] security/index.md');
    expect(provider.requests.map(({ schemaName }) => schemaName)).toEqual(['qlm_knowledge_hierarchy']);
    expect(provider.requests[0]?.prompt).toContain('between 1 and 4, inclusive');
    expect(readFileSync(existingDocumentPath, 'utf8')).toBe(existingDocumentMarkdown);
    expect(readFileSync(unrelatedDocumentPath, 'utf8')).toBe(existingDocument('unrelated', 'Unrelated'));
    expect(readFileSync(databasePath)).toEqual(originalDatabase);

    app.stdin.write('\r');
    await flushInkEffects();
    expect(app.lastFrame()).toContain('9/12 Confirmation');
    app.stdin.write('\u001b');
    await waitForFrame(app, '8/12 Structure Preview');
    expect(app.lastFrame()).toContain('8/12 Structure Preview');
    expect(provider.requests).toHaveLength(1);
    expect(readFileSync(existingDocumentPath, 'utf8')).toBe(existingDocumentMarkdown);
    expect(readFileSync(databasePath)).toEqual(originalDatabase);

    app.stdin.write('\r');
    await flushInkEffects();
    app.stdin.write('y');
    await flushInkEffects();
    await waitForFrame(app, '12/12 Complete');
    expect(provider.requests.map(({ schemaName }) => schemaName)).toEqual([
      'qlm_knowledge_hierarchy', 'qlm_generated_document_content',
    ]);
    expect(provider.requests[1]?.maxTokens).toBe(2000);
    expect(provider.requests[1]?.prompt).toContain('Aim for approximately 1000 tokens.');
    expect(provider.requests[1]?.prompt).toContain('Preserve source code blocks intact');
    expect(provider.requests[1]?.prompt).toContain('Preserve source tables');
    expect(readFileSync(existingDocumentPath, 'utf8'))
      .toContain('Generated knowledge document.');
    expect(readFileSync(settingsFile, 'utf8')).toBe('logging:\n  level: info\n');
    app.stdin.write('\r');
    await flushInkEffects();
    expect(app.lastFrame()).toContain('Selected project: quick-llm');
    expect(app.lastFrame()).toContain('Knowledge: 1 categories, 2 documents');
    expect(listProjects(dataRoot)).toHaveLength(1);
    app.unmount();
  }, 15_000);

  it('compares and explicitly applies an edited document only after Edited Document Review', async () => {
    const fixture = await createTuiConflictFixture();
    const app = render(
      <TuiApp columns={120} rows={30} dataRoot={fixture.dataRoot} buildProviderFactory={() => fixture.provider} />,
    );
    await enterBuildAnalysis(app, fixture.sourceFile);
    await waitForFrame(app, '8/12 Structure Preview');
    expect(app.lastFrame()).toContain('[Edited document: content changed] notes.md');
    expect(readFileSync(fixture.documentPath, 'utf8')).toBe(fixture.editedMarkdown);

    app.stdin.write('\r');
    await flushInkEffects();
    app.stdin.write('y');
    await flushInkEffects();
    await waitForFrame(app, 'Edited Document Review');
    expect(app.lastFrame()).toContain('Choice: keep');
    expect(readFileSync(fixture.documentPath, 'utf8')).toBe(fixture.editedMarkdown);

    app.stdin.write('c');
    await flushInkEffects();
    expect(app.lastFrame()).toContain('Compare current and generated: notes.md');
    expect(app.lastFrame()).toContain('- My manual addition.');
    app.stdin.write('\u001b');
    await waitForFrame(app, 'Choice: keep');
    app.stdin.write('a');
    await flushInkEffects();
    app.stdin.write('\r');
    await waitForFrame(app, '12/12 Complete');
    const finalMarkdown = readFileSync(fixture.documentPath, 'utf8');
    expect(finalMarkdown).toContain('Generated knowledge document.');
    expect(finalMarkdown).not.toContain('My manual addition.');
    app.unmount();
  }, 15_000);

  it('opens the manual merge editor with only the selected project document and candidate', async () => {
    const fixture = await createTuiConflictFixture();
    let editorInputs: string[] = [];
    const app = render(
      <TuiApp
        columns={120}
        rows={30}
        dataRoot={fixture.dataRoot}
        buildProviderFactory={() => fixture.provider}
        buildMergeEditor={async (currentMarkdown, candidateMarkdown) => {
          editorInputs = [currentMarkdown, candidateMarkdown];
          return candidateMarkdown.replace(
            'Generated knowledge document.',
            'Generated knowledge document.\n\nMy manual addition.\n\nMerged manual addition.',
          );
        }}
      />,
    );
    await enterBuildAnalysis(app, fixture.sourceFile);
    await waitForFrame(app, '8/12 Structure Preview');
    app.stdin.write('\r');
    await flushInkEffects();
    app.stdin.write('y');
    await flushInkEffects();
    await waitForFrame(app, 'Edited Document Review');
    app.stdin.write('m');
    await waitForFrame(app, 'manual merge ready');
    expect(editorInputs[0]).toBe(fixture.editedMarkdown);
    expect(editorInputs[1]).toContain('Generated knowledge document.');
    app.stdin.write('\r');
    await waitForFrame(app, '12/12 Complete');
    const finalMarkdown = readFileSync(fixture.documentPath, 'utf8');
    expect(finalMarkdown).toContain('Merged manual addition.');
    expect(finalMarkdown).toContain('My manual addition.');
    app.unmount();
  }, 15_000);

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

  it('shows generation failures and preserves existing knowledge and index rows', async () => {
    const dataRoot = createTemporaryRoot('qlm-wizard-failure-data-');
    const sourceRoot = createTemporaryRoot('qlm-wizard-failure-source-');
    const sourceFile = join(sourceRoot, 'notes.md');
    writeFileSync(sourceFile, '# Notes\n\nSource material.\n');
    const project = initializeProject(dataRoot, 'quick-llm');
    const projectRoot = join(dataRoot, 'projects', project.name);
    const knowledgeRoot = join(projectRoot, 'knowledge');
    mkdirSync(knowledgeRoot, { recursive: true });
    const existingPath = join(knowledgeRoot, 'existing.md');
    const existingMarkdown = existingDocument('existing', 'Existing');
    writeFileSync(existingPath, existingMarkdown);
    rebuildProjectIndex(projectRoot, project);
    const source = loadMarkdownSources(sourceFile)[0];
    if (source === undefined) throw new Error('Expected a Markdown source fixture.');
    const parsed = await new MarkdownDocumentParser().parse(source);
    const provider = new FakeWizardProvider([{
      id: 'notes', name: 'Notes', type: 'document', path: 'notes.md',
      description: 'Source notes.', sourceSectionIds: parsed.sections.map(({ id }) => id),
      relatedDocumentIds: [], children: [],
    }], undefined, true);
    const app = render(
      <TuiApp columns={120} rows={30} dataRoot={dataRoot} buildProviderFactory={() => provider} />,
    );

    await enterBuildAnalysis(app, sourceFile);
    await waitForFrame(app, '8/12 Structure Preview');
    app.stdin.write('\r');
    await flushInkEffects();
    app.stdin.write('y');
    await waitForFrame(app, 'Build Failed');

    expect(app.lastFrame()).toContain('Simulated document generation failure.');
    expect(readFileSync(existingPath, 'utf8')).toBe(existingMarkdown);
    const database = openProjectDatabaseReadOnly(projectRoot, project);
    try {
      expect(database.prepare('SELECT id, path FROM documents').all()).toEqual([
        { id: 'existing', path: 'existing.md' },
      ]);
    } finally {
      database.close();
    }
    expect(existsSync(join(knowledgeRoot, 'notes.md'))).toBe(false);
    app.unmount();
  });
});

function existingDocument(id: string, title: string): string {
  return [
    '---',
    'schema_version: 1',
    `id: ${id}`,
    `title: ${title}`,
    'type: document',
    'depth: 1',
    'status: draft',
    'source_ids: []',
    'source_sections: []',
    'related: []',
    '---',
    '',
    `# ${title}`,
    '',
    'Existing verified content.',
    '',
  ].join('\n');
}

function trackedDocument(id: string, title: string, sourceId: string, sectionId: string): string {
  return updateGeneratedDocumentBaseline([
    '---',
    'schema_version: 1',
    `id: ${id}`,
    `title: ${title}`,
    'type: document',
    'depth: 2',
    'status: draft',
    `source_ids: [${sourceId}]`,
    `source_sections: [${sourceId}:${sectionId}]`,
    'related: []',
    'generation:',
    '  provider: fake-provider',
    '  model: previous-model',
    '  revision: 1',
    '---',
    '',
    `# ${title}`,
    '',
    'Existing tracked content.',
    '',
  ].join('\n'));
}

function categoryIndex(id: string, title: string): string {
  return [
    '---',
    `id: ${id}`,
    `title: ${title}`,
    'type: category-index',
    'depth: 1',
    '---',
    '',
    `# ${title}`,
    '',
  ].join('\n');
}

function createTemporaryRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

async function createTuiConflictFixture() {
  const dataRoot = createTemporaryRoot('qlm-wizard-conflict-data-');
  const sourceRoot = createTemporaryRoot('qlm-wizard-conflict-source-');
  const sourceFile = join(sourceRoot, 'notes.md');
  writeFileSync(sourceFile, '# Notes\n\nOriginal source material.\n');
  const project = initializeProject(dataRoot, 'quick-llm');
  const projectRoot = join(dataRoot, 'projects', project.name);
  const knowledgeRoot = join(projectRoot, 'knowledge');
  const source = loadMarkdownSources(sourceFile)[0];
  if (source === undefined) throw new Error('Expected the original Markdown source.');
  const parsed = await new MarkdownDocumentParser().parse(source);
  const hierarchy: HierarchyNode[] = [{
    id: 'notes',
    name: 'Notes',
    type: 'document',
    path: 'notes.md',
    description: 'Project notes.',
    sourceSectionIds: parsed.sections.map(({ id }) => id),
    relatedDocumentIds: [],
    children: [],
  }];
  await buildProjectKnowledge({
    sourcePath: sourceFile,
    projectRoot,
    knowledgeRoot,
    project,
    provider: new FakeWizardProvider(hierarchy),
    model: 'test-model',
  });
  const documentPath = join(knowledgeRoot, 'notes.md');
  const editedMarkdown = readFileSync(documentPath, 'utf8').replace(
    'Generated knowledge document.',
    'My manual addition.',
  );
  writeFileSync(documentPath, editedMarkdown, 'utf8');
  writeFileSync(sourceFile, '# Notes\n\nUpdated source material.\n');
  const updatedSource = loadMarkdownSources(sourceFile)[0];
  if (updatedSource === undefined) throw new Error('Expected the updated Markdown source.');
  const updated = await new MarkdownDocumentParser().parse(updatedSource);
  const updatedHierarchy: HierarchyNode[] = [{
    ...hierarchy[0]!,
    sourceSectionIds: updated.sections.map(({ id }) => id),
  }];
  return {
    dataRoot,
    sourceFile,
    documentPath,
    editedMarkdown,
    provider: new FakeWizardProvider(updatedHierarchy),
  };
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

async function waitForFrameContainingAny(
  app: ReturnType<typeof render>,
  texts: readonly string[],
): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (texts.some((text) => app.lastFrame()?.includes(text))) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  expect(texts.some((text) => app.lastFrame()?.includes(text))).toBe(true);
}

class FakeWizardProvider implements AIProvider {
  readonly id = 'fake-wizard-provider';
  readonly requests: StructuredRequest<unknown>[] = [];

  constructor(
    private readonly hierarchy: HierarchyNode[],
    private readonly beforePlanning?: (request: StructuredRequest<unknown>) => Promise<void>,
    private readonly failDocumentGeneration = false,
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
    if (this.failDocumentGeneration) throw new Error('Simulated document generation failure.');
    return { body: 'Generated knowledge document.', inferences: [] } as T;
  }
  async countTokens(_text: string, _model: string): Promise<TokenCount> {
    return { count: 0, isEstimate: true };
  }
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map(() => [0.1, 0.2, 0.3]);
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
  await waitForFrameContainingAny(app, ['7/12 Analysis', '8/12 Structure Preview']);
}
