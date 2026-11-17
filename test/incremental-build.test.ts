import { createHash } from 'node:crypto';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveProjectDatabasePath } from '../src/database/database.js';
import {
  buildProjectKnowledge,
  executePreparedKnowledgeBuild,
  prepareProjectKnowledgeBuild,
} from '../src/knowledge/builder.js';
import { hashGeneratedDocumentContent } from '../src/knowledge/document-generator.js';
import { MarkdownDocumentParser } from '../src/knowledge/markdown-parser.js';
import { validateKnowledgeHierarchy } from '../src/knowledge/hierarchy-validator.js';
import type { HierarchyNode } from '../src/knowledge/planner.js';
import { loadMarkdownSources } from '../src/knowledge/source.js';
import { initializeProject } from '../src/projects/manager.js';
import type {
  AIProvider,
  GenerateRequest,
  GenerateResponse,
  ModelInfo,
  StructuredRequest,
  TokenCount,
} from '../src/providers/provider.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('incremental knowledge builds', () => {
  it('treats legacy generated documents without a baseline as conflicts', async () => {
    const fixture = createFixture();
    const originalSections = await parseSections(fixture.sourcePath);
    await buildProjectKnowledge({
      ...fixture,
      provider: new IncrementalProvider(createHierarchy(originalSections)),
      model: 'test-model',
    });
    const documentPath = join(fixture.knowledgeRoot, 'alpha.md');
    const legacyMarkdown = readFileSync(documentPath, 'utf8').replace(/^  baseline_hash: [0-9a-f]{64}\r?\n/mu, '');
    writeFileSync(documentPath, legacyMarkdown, 'utf8');
    writeFileSync(fixture.sourcePath, sourceText('Alpha content revised.', 'Beta content remains.'), 'utf8');
    const changedSections = await parseSections(fixture.sourcePath);
    const provider = new IncrementalProvider(createHierarchy(changedSections));
    const prepared = await prepareProjectKnowledgeBuild({
      ...fixture,
      provider,
      model: 'test-model',
      incremental: true,
    });

    expect(prepared.documentConflicts).toEqual([{ path: 'alpha.md', reason: 'missing-baseline' }]);
  });

  it('keeps edited documents by default and reports the unresolved-content choice', async () => {
    const { fixture, prepared, provider, documentPath, editedMarkdown } = await createEditedDocumentBuild();
    expect(prepared.documentConflicts).toEqual([{ path: 'alpha.md', reason: 'edited' }]);
    const result = await executePreparedKnowledgeBuild(prepared, {
      ...fixture,
      provider,
      model: 'test-model',
      incremental: true,
    });

    expect(result.conflictResolutions).toEqual([{ path: 'alpha.md', action: 'keep' }]);
    expect(result.documents).toBe(0);
    expect(readFileSync(documentPath, 'utf8')).toBe(editedMarkdown);
    expect(result.index.documents).toBe(2);
  });

  it('applies an explicitly approved candidate and updates its baseline', async () => {
    const { fixture, prepared, provider, documentPath } = await createEditedDocumentBuild();
    const result = await executePreparedKnowledgeBuild(prepared, {
      ...fixture,
      provider,
      model: 'test-model',
      incremental: true,
      onDocumentConflicts: async (conflicts) => {
        expect(conflicts).toHaveLength(1);
        expect(conflicts[0]?.currentMarkdown).toContain('My manual clarification.');
        return { 'alpha.md': { action: 'apply' } };
      },
    });

    const current = readFileSync(documentPath, 'utf8');
    const parsed = (await import('../src/markdown/parser.js')).parseMarkdownDocument(current, 'alpha.md');
    expect(result.conflictResolutions).toEqual([{ path: 'alpha.md', action: 'apply' }]);
    expect(current).toContain('Generated verified summary.');
    expect(current).not.toContain('My manual clarification.');
    expect(parsed.metadata.type === 'document' ? parsed.metadata.generation?.baseline_hash : undefined)
      .toBe(hashGeneratedDocumentContent(current));
  });

  it('commits a manually merged candidate with a new baseline and leaves excluded edits untouched', async () => {
    const mergedBuild = await createEditedDocumentBuild();
    const mergedResult = await executePreparedKnowledgeBuild(mergedBuild.prepared, {
      ...mergedBuild.fixture,
      provider: mergedBuild.provider,
      model: 'test-model',
      incremental: true,
      onDocumentConflicts: async ([conflict]) => ({
        'alpha.md': {
          action: 'merge',
          mergedMarkdown: conflict?.candidate.markdown.replace(
            'Generated verified summary.',
            'Generated verified summary.\n\nMy manual clarification.',
          ),
        },
      }),
    });
    const mergedMarkdown = readFileSync(mergedBuild.documentPath, 'utf8');
    const merged = (await import('../src/markdown/parser.js')).parseMarkdownDocument(mergedMarkdown, 'alpha.md');
    expect(mergedResult.conflictResolutions).toEqual([{ path: 'alpha.md', action: 'merge' }]);
    expect(mergedMarkdown).toContain('My manual clarification.');
    expect(merged.metadata.type === 'document' ? merged.metadata.generation?.baseline_hash : undefined)
      .toBe(hashGeneratedDocumentContent(mergedMarkdown));

    const excludedBuild = await createEditedDocumentBuild();
    const before = readFileSync(excludedBuild.documentPath, 'utf8');
    const excludedResult = await executePreparedKnowledgeBuild(excludedBuild.prepared, {
      ...excludedBuild.fixture,
      provider: excludedBuild.provider,
      model: 'test-model',
      incremental: true,
      onDocumentConflicts: async () => ({ 'alpha.md': { action: 'exclude' } }),
    });
    expect(excludedResult.conflictResolutions).toEqual([{ path: 'alpha.md', action: 'exclude' }]);
    expect(readFileSync(excludedBuild.documentPath, 'utf8')).toBe(before);
  });

  it('cancels conflict review before changing documents or the index', async () => {
    const { fixture, prepared, provider, documentPath, editedMarkdown } = await createEditedDocumentBuild();
    const databasePath = resolveProjectDatabasePath(fixture.projectRoot);
    const databaseBefore = hashFile(databasePath);
    const controller = new AbortController();
    await expect(executePreparedKnowledgeBuild(prepared, {
      ...fixture,
      provider,
      model: 'test-model',
      incremental: true,
      signal: controller.signal,
      onDocumentConflicts: async () => {
        controller.abort(new Error('User cancelled review.'));
        return {};
      },
    })).rejects.toThrow('The knowledge build was cancelled.');
    expect(readFileSync(documentPath, 'utf8')).toBe(editedMarkdown);
    expect(hashFile(databasePath)).toBe(databaseBefore);
  });

  it('rolls back when an edited document changes after review but before commit', async () => {
    const { fixture, prepared, provider, documentPath } = await createEditedDocumentBuild();
    const databasePath = resolveProjectDatabasePath(fixture.projectRoot);
    const databaseBefore = hashFile(databasePath);
    const changedAfterReview = readFileSync(documentPath, 'utf8').replace(
      'My manual clarification.',
      'A newer concurrent edit.',
    );
    await expect(executePreparedKnowledgeBuild(prepared, {
      ...fixture,
      provider,
      model: 'test-model',
      incremental: true,
      onDocumentConflicts: async () => {
        writeFileSync(documentPath, changedAfterReview, 'utf8');
        return { 'alpha.md': { action: 'apply' } };
      },
    })).rejects.toThrow('The document changed after conflict review: alpha.md.');
    expect(readFileSync(documentPath, 'utf8')).toBe(changedAfterReview);
    expect(hashFile(databasePath)).toBe(databaseBefore);
  });

  it('regenerates only impacted outputs and preserves unrelated Markdown', async () => {
    const fixture = createFixture();
    const originalSections = await parseSections(fixture.sourcePath);
    const validation = validateKnowledgeHierarchy(createHierarchy(originalSections), originalSections);
    expect(validation.valid, JSON.stringify(validation)).toBe(true);
    await buildProjectKnowledge({
      ...fixture,
      provider: new IncrementalProvider(createHierarchy(originalSections)),
      model: 'test-model',
    });

    const betaPath = join(fixture.knowledgeRoot, 'beta.md');
    const betaBefore = readFileSync(betaPath);
    writeFileSync(fixture.sourcePath, sourceText('Alpha content revised.', 'Beta content remains.'), 'utf8');
    const changedSections = await parseSections(fixture.sourcePath);
    const provider = new IncrementalProvider(createHierarchy(changedSections));
    const prepared = await prepareProjectKnowledgeBuild({
      ...fixture,
      provider,
      model: 'test-model',
      incremental: true,
    });

    expect(prepared.regenerationPaths).toEqual(['alpha.md']);
    expect(prepared.noOp).toBe(false);
    const result = await executePreparedKnowledgeBuild(prepared, {
      ...fixture,
      provider,
      model: 'test-model',
      incremental: true,
    });

    expect(provider.requests.map(({ schemaName }) => schemaName)).toEqual([
      'qlm_knowledge_hierarchy',
      'qlm_generated_document_content',
    ]);
    expect(result.commit.updated).toEqual(['alpha.md']);
    expect(result.commit.removed).toEqual([]);
    expect(readFileSync(betaPath)).toEqual(betaBefore);
    expect(readFileSync(join(fixture.knowledgeRoot, 'alpha.md'), 'utf8')).toContain('Generated verified summary.');
    const database = new Database(resolveProjectDatabasePath(fixture.projectRoot), { readonly: true });
    try {
      expect(database.prepare('SELECT id, path FROM documents ORDER BY path').all()).toEqual([
        { id: 'alpha-doc', path: 'alpha.md' },
        { id: 'beta-doc', path: 'beta.md' },
      ]);
    } finally {
      database.close();
    }
  });

  it('skips provider requests and all writes for an unchanged impact plan', async () => {
    const fixture = createFixture();
    const sections = await parseSections(fixture.sourcePath);
    await buildProjectKnowledge({
      ...fixture,
      provider: new IncrementalProvider(createHierarchy(sections)),
      model: 'test-model',
    });
    const databasePath = resolveProjectDatabasePath(fixture.projectRoot);
    const filesBefore = ['alpha.md', 'beta.md'].map((name) =>
      readFileSync(join(fixture.knowledgeRoot, name)),
    );
    const databaseBefore = hashFile(databasePath);
    const provider = new IncrementalProvider(createHierarchy(sections));
    const prepared = await prepareProjectKnowledgeBuild({
      ...fixture,
      provider,
      model: 'test-model',
      incremental: true,
    });

    expect(prepared.noOp).toBe(true);
    expect(provider.requests).toHaveLength(0);
    const result = await executePreparedKnowledgeBuild(prepared, {
      ...fixture,
      provider,
      model: 'test-model',
      incremental: true,
    });

    expect(result.noOp).toBe(true);
    expect(provider.requests).toHaveLength(0);
    expect(['alpha.md', 'beta.md'].map((name) => readFileSync(join(fixture.knowledgeRoot, name)))).toEqual(filesBefore);
    expect(hashFile(databasePath)).toBe(databaseBefore);
  });

  it('keeps outputs for deleted source sections unchanged pending review', async () => {
    const fixture = createFixture();
    const originalSections = await parseSections(fixture.sourcePath);
    await buildProjectKnowledge({
      ...fixture,
      provider: new IncrementalProvider(createHierarchy(originalSections)),
      model: 'test-model',
    });
    const databasePath = resolveProjectDatabasePath(fixture.projectRoot);
    const filesBefore = ['alpha.md', 'beta.md'].map((name) =>
      readFileSync(join(fixture.knowledgeRoot, name)),
    );
    const databaseBefore = hashFile(databasePath);
    writeFileSync(fixture.sourcePath, '# Product\n\n## Beta\n\nBeta content remains.\n', 'utf8');
    const provider = new IncrementalProvider([]);
    const prepared = await prepareProjectKnowledgeBuild({
      ...fixture,
      provider,
      model: 'test-model',
      incremental: true,
    });

    expect(prepared.pendingOnly).toBe(true);
    expect(prepared.noOp).toBe(false);
    expect(prepared.regenerationPaths).toEqual([]);
    expect(prepared.pendingRemovalPaths).toEqual(['alpha.md']);
    expect(provider.requests).toHaveLength(0);
    const result = await executePreparedKnowledgeBuild(prepared, {
      ...fixture,
      provider,
      model: 'test-model',
      incremental: true,
    });

    expect(result.pendingRemovalPaths).toEqual(['alpha.md']);
    expect(result.commit).toEqual({ created: [], updated: [], removed: [] });
    expect(provider.requests).toHaveLength(0);
    expect(['alpha.md', 'beta.md'].map((name) => readFileSync(join(fixture.knowledgeRoot, name)))).toEqual(filesBefore);
    expect(hashFile(databasePath)).toBe(databaseBefore);
  });

  it('preserves existing files and index when generation fails', async () => {
    const fixture = createFixture();
    const originalSections = await parseSections(fixture.sourcePath);
    await buildProjectKnowledge({
      ...fixture,
      provider: new IncrementalProvider(createHierarchy(originalSections)),
      model: 'test-model',
    });
    writeFileSync(fixture.sourcePath, sourceText('Alpha content revised.', 'Beta content remains.'), 'utf8');
    const changedSections = await parseSections(fixture.sourcePath);
    const provider = new IncrementalProvider(createHierarchy(changedSections), true);
    const filesBefore = ['alpha.md', 'beta.md'].map((name) =>
      readFileSync(join(fixture.knowledgeRoot, name)),
    );
    const databasePath = resolveProjectDatabasePath(fixture.projectRoot);
    const databaseBefore = hashFile(databasePath);
    const prepared = await prepareProjectKnowledgeBuild({
      ...fixture,
      provider,
      model: 'test-model',
      incremental: true,
    });

    await expect(executePreparedKnowledgeBuild(prepared, {
      ...fixture,
      provider,
      model: 'test-model',
      incremental: true,
    })).rejects.toThrow('injected generation failure');
    expect(['alpha.md', 'beta.md'].map((name) => readFileSync(join(fixture.knowledgeRoot, name)))).toEqual(filesBefore);
    expect(hashFile(databasePath)).toBe(databaseBefore);
  });

  it('rolls back selected files when the atomic commit fails', async () => {
    const fixture = createFixture();
    const originalSections = await parseSections(fixture.sourcePath);
    await buildProjectKnowledge({
      ...fixture,
      provider: new IncrementalProvider(createHierarchy(originalSections)),
      model: 'test-model',
    });
    writeFileSync(fixture.sourcePath, sourceText('Alpha content revised.', 'Beta content remains.'), 'utf8');
    const changedSections = await parseSections(fixture.sourcePath);
    const provider = new IncrementalProvider(createHierarchy(changedSections));
    const prepared = await prepareProjectKnowledgeBuild({
      ...fixture,
      provider,
      model: 'test-model',
      incremental: true,
    });
    const filesBefore = ['alpha.md', 'beta.md'].map((name) =>
      readFileSync(join(fixture.knowledgeRoot, name)),
    );
    const databasePath = resolveProjectDatabasePath(fixture.projectRoot);
    const databaseBefore = hashFile(databasePath);
    const originalLink = fs.linkSync;
    let failedInstall = false;
    fs.linkSync = ((source: string, destination: string) => {
      if (!failedInstall && source.endsWith('.stage') && destination.endsWith('alpha.md')) {
        failedInstall = true;
        throw new Error('injected commit failure');
      }
      originalLink(source, destination);
    }) as typeof fs.linkSync;
    syncBuiltinESMExports();
    try {
      await expect(executePreparedKnowledgeBuild(prepared, {
        ...fixture,
        provider,
        model: 'test-model',
        incremental: true,
      })).rejects.toThrow('Unable to commit generated Markdown documents.');
    } finally {
      fs.linkSync = originalLink;
      syncBuiltinESMExports();
    }
    expect(failedInstall).toBe(true);
    expect(['alpha.md', 'beta.md'].map((name) => readFileSync(join(fixture.knowledgeRoot, name)))).toEqual(filesBefore);
    expect(hashFile(databasePath)).toBe(databaseBefore);
  });
});

async function createEditedDocumentBuild() {
  const fixture = createFixture();
  const originalSections = await parseSections(fixture.sourcePath);
  await buildProjectKnowledge({
    ...fixture,
    provider: new IncrementalProvider(createHierarchy(originalSections)),
    model: 'test-model',
  });
  const documentPath = join(fixture.knowledgeRoot, 'alpha.md');
  const editedMarkdown = readFileSync(documentPath, 'utf8').replace(
    'Generated verified summary.',
    'My manual clarification.',
  );
  writeFileSync(documentPath, editedMarkdown, 'utf8');
  writeFileSync(fixture.sourcePath, sourceText('Alpha content revised.', 'Beta content remains.'), 'utf8');
  const changedSections = await parseSections(fixture.sourcePath);
  const provider = new IncrementalProvider(createHierarchy(changedSections));
  const prepared = await prepareProjectKnowledgeBuild({
    ...fixture,
    provider,
    model: 'test-model',
    incremental: true,
  });
  return { fixture, provider, prepared, documentPath, editedMarkdown };
}

function createFixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'qlm-incremental-build-'));
  temporaryDirectories.push(dataRoot);
  const project = initializeProject(dataRoot, 'demo');
  const projectRoot = join(dataRoot, 'projects', project.name);
  const knowledgeRoot = join(projectRoot, 'knowledge');
  const sourceDirectory = mkdtempSync(join(tmpdir(), 'qlm-incremental-source-'));
  temporaryDirectories.push(sourceDirectory);
  const sourcePath = join(sourceDirectory, 'source.md');
  writeFileSync(sourcePath, sourceText('Alpha content original.', 'Beta content remains.'), 'utf8');
  return { projectRoot, knowledgeRoot, sourcePath, project };
}

function sourceText(alpha: string, beta: string): string {
  return `# Product\n\n## Alpha\n\n${alpha}\n\n## Beta\n\n${beta}\n`;
}

async function parseSections(sourcePath: string) {
  const source = loadMarkdownSources(sourcePath)[0];
  if (source === undefined) throw new Error('Expected source fixture.');
  return (await new MarkdownDocumentParser().parse(source)).sections;
}

function createHierarchy(sections: Awaited<ReturnType<typeof parseSections>>): HierarchyNode[] {
  const alpha = sections.find(({ title }) => title === 'Alpha');
  const beta = sections.find(({ title }) => title === 'Beta');
  const product = sections.find(({ title }) => title === 'Product');
  if (alpha === undefined || beta === undefined || product === undefined) {
    throw new Error('Expected the product, Alpha, and Beta source sections.');
  }
  return [
    createDocument('alpha-doc', 'Alpha', 'alpha.md', [product.id, alpha.id]),
    createDocument('beta-doc', 'Beta', 'beta.md', [beta.id]),
  ];
}

function createDocument(id: string, name: string, path: string, sectionIds: string[]): HierarchyNode {
  return {
    id,
    name,
    type: 'document',
    path,
    description: `${name} reference.`,
    sourceSectionIds: sectionIds,
    relatedDocumentIds: [],
    children: [],
  };
}

function hashFile(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

class IncrementalProvider implements AIProvider {
  readonly id = 'incremental-test-provider';
  readonly requests: StructuredRequest<unknown>[] = [];

  constructor(
    private readonly hierarchy: HierarchyNode[],
    private readonly failGeneration = false,
  ) {}

  async listModels(): Promise<ModelInfo[]> { return []; }
  async generate(request: GenerateRequest): Promise<GenerateResponse> {
    return { model: request.model, text: '' };
  }
  async generateStructured<T>(request: StructuredRequest<T>): Promise<T> {
    this.requests.push(request as StructuredRequest<unknown>);
    if (request.schemaName === 'qlm_knowledge_hierarchy') return { hierarchy: this.hierarchy } as T;
    if (this.failGeneration) throw new Error('injected generation failure');
    return { body: 'Generated verified summary.', inferences: [] } as T;
  }
  async countTokens(_text: string, _model: string): Promise<TokenCount> {
    return { count: 0, isEstimate: true };
  }
}
