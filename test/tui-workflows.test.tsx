import React from 'react';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { render } from 'ink-testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveProjectDatabasePath } from '../src/database/database.js';
import { MarkdownDocumentParser } from '../src/knowledge/markdown-parser.js';
import { loadMarkdownSources } from '../src/knowledge/source.js';
import { initializeProject, listProjects } from '../src/projects/manager.js';
import type {
  AIProvider,
  GenerateRequest,
  GenerateResponse,
  ModelInfo,
  StructuredRequest,
  TokenCount,
} from '../src/providers/provider.js';
import { getTuiLayout, TuiApp } from '../src/tui/app.js';

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('keyboard-only TUI workflows', () => {
  it('creates, builds, explores, searches, and reviews local MCP guidance', async () => {
    const fixture = await createFixture();
    const provider = new WorkflowProvider(fixture.hierarchy, { pauseGeneration: true });
    const mcpProbe = vi.fn(async () => ['memory_list_projects', 'memory_get_tree']);
    const app = render(
      <TuiApp
        columns={120}
        rows={30}
        dataRoot={fixture.dataRoot}
        buildProviderFactory={() => provider}
        mcpConnectionCheck={mcpProbe}
      />,
    );

    expect(getTuiLayout(120, 30)).toBe('wide');
    expect(getTuiLayout(80, 20)).toBe('compact');
    expect(getTuiLayout(59, 24)).toBe('too-small');
    app.rerender(<TuiApp columns={50} rows={12} dataRoot={fixture.dataRoot} />);
    expect(app.lastFrame()).toContain('minimum is 60x16');
    app.rerender(
      <TuiApp
        columns={120}
        rows={30}
        dataRoot={fixture.dataRoot}
        buildProviderFactory={() => provider}
        mcpConnectionCheck={mcpProbe}
      />,
    );
    await waitForFrame(app, 'Navigation [focus]');

    await openScreen(app, 1, 'Projects');
    await key(app, 'c');
    await key(app, 'e2e-project');
    await key(app, '\r');
    expect(app.lastFrame()).toContain('Created project e2e-project.');
    expect(listProjects(fixture.dataRoot).map(({ name }) => name)).toEqual(['e2e-project']);

    await key(app, '\u001b');
    await waitForFrame(app, 'Navigation [focus]');
    await key(app, '\u001b[B');
    await key(app, '\r');
    await waitForFrame(app, 'Build [focus]');
    await enterBuildSetup(app, fixture.sourceFile);
    await waitForFrame(app, '8/12 Structure Preview');
    expect(app.lastFrame()).toContain('notes.md');
    expect(provider.requests.map(({ schemaName }) => schemaName)).toEqual([
      'qlm_knowledge_hierarchy',
    ]);
    expect(existsSync(join(fixture.dataRoot, 'projects', 'e2e-project', 'knowledge'))).toBe(false);
    expect(existsSync(resolveProjectDatabasePath(join(fixture.dataRoot, 'projects', 'e2e-project')))).toBe(false);

    await key(app, '\r');
    await waitForFrame(app, '9/12 Confirmation');
    await key(app, 'y');
    await provider.generationStarted;
    await waitForFrame(app, '10/12 Generation');
    expect(app.lastFrame()).toContain('generating (0/1)');
    expect(existsSync(join(fixture.dataRoot, 'projects', 'e2e-project', 'knowledge', 'notes.md'))).toBe(false);
    provider.releaseGeneration();
    await waitForFrame(app, '12/12 Complete');
    expect(app.lastFrame()).toContain('Validation passed; the generated documents were committed and indexed.');
    expect(readFileSync(join(fixture.dataRoot, 'projects', 'e2e-project', 'knowledge', 'notes.md'), 'utf8'))
      .toContain('Generated knowledge about deterministic keyboard workflows.');

    await key(app, '\r');
    await waitForFrame(app, 'Selected project: e2e-project');
    expect(app.lastFrame()).toContain('Knowledge: 0 categories, 1 documents');

    await openScreen(app, 1, 'Explorer');
    await waitForFrame(app, 'notes.md');
    await key(app, '\r');
    await waitForFrame(app, 'Notes');
    expect(app.lastFrame()).toContain('Generated knowledge about deterministic keyboard workflows.');
    await key(app, '\u001b');
    await waitForFrame(app, '↑/↓ select; → expand; ← collapse; Enter expand/open');
    await key(app, '\u001b');
    await waitForFrame(app, 'Navigation [focus]');

    await openScreen(app, 1, 'Search');
    await key(app, 'deterministic');
    await key(app, '\r');
    await waitForFrame(app, 'Results');
    expect(app.lastFrame()).toContain('Notes (notes.md)');
    await key(app, '\r');
    await waitForFrame(app, 'Generated knowledge about deterministic keyboard workflows.');
    await key(app, '\u001b');
    await waitForFrame(app, 'Results');
    await key(app, '\u001b');
    await waitForFrame(app, 'Navigation [focus]');

    await openScreen(app, 1, 'MCP Manager');
    expect(app.lastFrame()).toContain('Transport: stdio.');
    expect(app.lastFrame()).toContain('The selected MCP client launches');
    expect(app.lastFrame()).toContain('stops its own server');
    await key(app, 't');
    await waitForFrame(app, 'Connection test passed; temporary server stopped.');
    expect(app.lastFrame()).toContain('memory_list_projects, memory_get_tree');
    expect(mcpProbe).toHaveBeenCalledOnce();
    await key(app, '\u001b');
    await waitForFrame(app, 'Navigation [focus]');
    app.unmount();
  }, 20_000);

  it('shows deterministic build errors without creating partial project data', async () => {
    const fixture = await createFixture();
    initializeProject(fixture.dataRoot, 'error-project');
    const provider = new WorkflowProvider(fixture.hierarchy, { failGeneration: true });
    const app = render(
      <TuiApp
        columns={120}
        rows={30}
        dataRoot={fixture.dataRoot}
        buildProviderFactory={() => provider}
      />,
    );

    await openScreen(app, 2, 'Build');
    await enterBuildSetup(app, fixture.sourceFile, 'error-project');
    await waitForFrame(app, '8/12 Structure Preview');
    await key(app, '\r');
    await waitForFrame(app, '9/12 Confirmation');
    await key(app, 'y');
    await waitForFrame(app, 'Build Failed');

    expect(app.lastFrame()).toContain('Fixture generation failed.');
    expect(existsSync(join(fixture.dataRoot, 'projects', 'error-project', 'knowledge'))).toBe(false);
    expect(existsSync(resolveProjectDatabasePath(join(fixture.dataRoot, 'projects', 'error-project')))).toBe(false);
    expect(provider.requests.map(({ schemaName }) => schemaName)).toEqual([
      'qlm_knowledge_hierarchy', 'qlm_generated_document_content',
    ]);
    app.unmount();
  }, 15_000);
});

async function createFixture(): Promise<{
  dataRoot: string;
  sourceFile: string;
  hierarchy: [{
    id: string;
    name: string;
    type: 'document';
    path: string;
    description: string;
    sourceSectionIds: string[];
    relatedDocumentIds: string[];
    children: [];
  }];
}> {
  const dataRoot = createTemporaryRoot('qlm-tui-workflow-data-');
  const sourceRoot = createTemporaryRoot('qlm-tui-workflow-source-');
  const sourceFile = join(sourceRoot, 'notes.md');
  writeFileSync(sourceFile, '# Notes\n\nA local deterministic fixture.\n');
  const source = loadMarkdownSources(sourceFile)[0];
  if (source === undefined) throw new Error('Expected the Markdown fixture to load.');
  const parsed = await new MarkdownDocumentParser().parse(source);
  return {
    dataRoot,
    sourceFile,
    hierarchy: [{
      id: 'notes',
      name: 'Notes',
      type: 'document',
      path: 'notes.md',
      description: 'A deterministic workflow fixture.',
      sourceSectionIds: parsed.sections.map(({ id }) => id),
      relatedDocumentIds: [],
      children: [],
    }],
  };
}

function createTemporaryRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

async function key(app: ReturnType<typeof render>, input: string): Promise<void> {
  app.stdin.write(input);
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

async function openScreen(
  app: ReturnType<typeof render>,
  downCount: number,
  screen: string,
): Promise<void> {
  for (let index = 0; index < downCount; index += 1) await key(app, '\u001b[B');
  await key(app, '\r');
  await waitForFrame(app, `${screen} [focus]`);
}

async function enterBuildSetup(
  app: ReturnType<typeof render>,
  sourceFile: string,
  projectName = 'e2e-project',
): Promise<void> {
  await waitForFrame(app, '1/6 Project Name');
  await key(app, projectName);
  await key(app, '\r');
  await waitForFrame(app, '2/6 Input Sources');
  await key(app, sourceFile);
  await key(app, '\r');
  await waitForFrame(app, '3/6 AI Provider');
  await key(app, '\r');
  await waitForFrame(app, '4/6 AI Model');
  await key(app, 'fixture-model');
  await key(app, '\r');
  await waitForFrame(app, '5/6 Hierarchy Settings');
  await key(app, '\r');
  await waitForFrame(app, '6/6 Document Settings');
  await key(app, '\r');
}

async function waitForFrame(app: ReturnType<typeof render>, expected: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if ((app.lastFrame() ?? '').includes(expected)) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  expect(app.lastFrame() ?? '').toContain(expected);
}

class WorkflowProvider implements AIProvider {
  readonly id = 'fixture-provider';
  readonly requests: StructuredRequest<unknown>[] = [];
  readonly generationStarted: Promise<void>;
  private markGenerationStarted!: () => void;
  private releaseGenerationGate!: () => void;
  private readonly generationGate: Promise<void>;

  constructor(
    private readonly hierarchy: [{
      id: string;
      name: string;
      type: 'document';
      path: string;
      description: string;
      sourceSectionIds: string[];
      relatedDocumentIds: string[];
      children: [];
    }],
    private readonly options: { pauseGeneration?: boolean; failGeneration?: boolean } = {},
  ) {
    this.generationStarted = new Promise((resolve) => { this.markGenerationStarted = resolve; });
    this.generationGate = new Promise((resolve) => { this.releaseGenerationGate = resolve; });
  }

  releaseGeneration(): void {
    this.releaseGenerationGate();
  }

  async listModels(): Promise<ModelInfo[]> { return []; }
  async generate(request: GenerateRequest): Promise<GenerateResponse> {
    return { model: request.model, text: '' };
  }
  async generateStructured<T>(request: StructuredRequest<T>): Promise<T> {
    this.requests.push(request as StructuredRequest<unknown>);
    if (request.schemaName === 'qlm_knowledge_hierarchy') {
      return { hierarchy: this.hierarchy } as T;
    }
    this.markGenerationStarted();
    if (this.options.pauseGeneration) await this.generationGate;
    if (this.options.failGeneration) throw new Error('Fixture generation failed.');
    return {
      body: 'Generated knowledge about deterministic keyboard workflows.',
      inferences: [],
    } as T;
  }
  async countTokens(_text: string, _model: string): Promise<TokenCount> {
    return { count: 0, isEstimate: true };
  }
}
