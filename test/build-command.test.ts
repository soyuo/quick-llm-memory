import Database from 'better-sqlite3';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { settingsSchema } from '../src/config/schema.js';
import { resolveProjectDatabasePath } from '../src/database/database.js';
import { readProjectSourceSnapshot } from '../src/database/source-snapshot.js';
import { rebuildProjectIndex } from '../src/database/reindex.js';
import { runCli } from '../src/cli.js';
import {
  BUILD_PROGRESS_STAGES,
  BuildCancelledError,
  buildProjectKnowledge,
  prepareProjectKnowledgeBuild,
  type BuildProgressStage,
} from '../src/knowledge/builder.js';
import type { HierarchyNode } from '../src/knowledge/planner.js';
import { loadMarkdownSources } from '../src/knowledge/source.js';
import { MarkdownDocumentParser } from '../src/knowledge/markdown-parser.js';
import { createApplicationLogger } from '../src/logging/logger.js';
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

describe('qlm build command', () => {
  it('generates source-tracked documents and rebuilds the project index', async () => {
    const { dataRoot, project, projectRoot } = createProject();
    const sourcePath = createSourceFile();
    const source = loadMarkdownSources(sourcePath)[0];
    if (source === undefined) {
      throw new Error('Expected a Markdown source fixture.');
    }
    const parsed = await new MarkdownDocumentParser().parse(source);
    if (parsed.sections.length === 0) {
      throw new Error('Expected a parsed source section.');
    }
    const hierarchy = createHierarchy(parsed.sections.map(({ id }) => id));
    const provider = new FakeBuildProvider(hierarchy);
    const configuredSettings = settingsSchema.parse({
      ai: { provider: 'openai', model: 'test-model' },
    });
    let configuredModel: string | undefined;
    const result = await runBuild(dataRoot, sourcePath, {
      settings: configuredSettings,
      providerFactory: (settings) => {
        configuredModel = settings.ai?.model;
        return provider;
      },
    });

    expect(result.exitCode, result.errorOutput).toBe(0);
    expect(result.errorOutput).toBe('');
    expect(result.output).toContain(`Built project demo: 1 source(s), ${parsed.sections.length} section(s), 1 category, 1 document(s); index has 1 document(s).`);
    expect(result.output).toContain('Created: security/authentication.md');
    expect(progressTransitions(result.output)).toEqual([
      'queued',
      'parsing',
      'comparing',
      'planning',
      'validating',
      'awaiting_approval',
      'generating',
      'verifying',
      'committing',
      'indexing',
      'completed',
    ]);
    expect(configuredModel).toBe('test-model');
    expect(provider.requests.map(({ schemaName }) => schemaName)).toEqual([
      'qlm_knowledge_hierarchy',
      'qlm_generated_document_content',
    ]);
    expect(readFileSync(sourcePath, 'utf8')).toContain('Bearer tokens authenticate callers.');
    const generatedMarkdown = readFileSync(
      join(projectRoot, 'knowledge', 'security', 'authentication.md'),
      'utf8',
    );
    for (const section of parsed.sections) {
      expect(generatedMarkdown).toContain(`${source.id}:${section.id}`);
    }

    const database = new Database(resolveProjectDatabasePath(projectRoot), { readonly: true });
    try {
      expect(database.prepare('SELECT id, path FROM documents').all()).toEqual([
        { id: 'security-authentication', path: 'security/authentication.md' },
      ]);
      expect(database.prepare(
        'SELECT provider_id, model, dimensions FROM project_embedding_metadata',
      ).get()).toEqual({
        provider_id: 'fake-provider',
        model: 'text-embedding-3-small',
        dimensions: 3,
      });
    } finally {
      database.close();
    }

    const savedSnapshot = readProjectSourceSnapshot(
      projectRoot,
      project,
      realpathSync(sourcePath),
    );
    expect(savedSnapshot?.files).toEqual([
      { sourceId: source.id, path: 'design.md', contentHash: source.hash },
    ]);
    expect(savedSnapshot?.sections).toHaveLength(parsed.sections.length);

    const repeatProvider = new FakeBuildProvider(hierarchy);
    const repeated = await prepareProjectKnowledgeBuild({
      sourcePath,
      projectRoot,
      knowledgeRoot: join(projectRoot, 'knowledge'),
      project,
      provider: repeatProvider,
      model: 'test-model',
    });
    expect(repeated.sourceChanges.files.map(({ status }) => status)).toEqual(['unchanged']);
    expect(repeated.sourceChanges.sections.map(({ status }) => status)).toEqual(
      parsed.sections.map(() => 'unchanged'),
    );
    expect(repeatProvider.requests.map(({ schemaName }) => schemaName)).toEqual([
      'qlm_knowledge_hierarchy',
    ]);
  });

  it('honors the setting that disables response caching for sensitive sources', async () => {
    const { dataRoot } = createProject();
    const sourcePath = createSourceFile();
    const parsed = await new MarkdownDocumentParser().parse(loadMarkdownSources(sourcePath)[0]!);
    const hierarchy = createHierarchy(parsed.sections.map(({ id }) => id));
    const settings = settingsSchema.parse({ ai: { provider: 'openai', model: 'test-model', cache_generation: false } });
    const firstProvider = new FakeBuildProvider(hierarchy);
    const secondProvider = new FakeBuildProvider(hierarchy);

    expect((await runBuild(dataRoot, sourcePath, { settings, providerFactory: () => firstProvider })).exitCode).toBe(0);
    expect((await runBuild(dataRoot, sourcePath, { settings, providerFactory: () => secondProvider })).exitCode).toBe(0);

    expect(firstProvider.requests.map(({ schemaName }) => schemaName)).toEqual([
      'qlm_knowledge_hierarchy',
      'qlm_generated_document_content',
    ]);
    expect(secondProvider.requests.map(({ schemaName }) => schemaName)).toEqual([
      'qlm_knowledge_hierarchy',
      'qlm_generated_document_content',
    ]);
    expect(existsSync(join(dataRoot, 'cache'))).toBe(false);
  });

  it('leaves existing Markdown and index rows untouched when hierarchy validation fails', async () => {
    const { dataRoot, project, projectRoot, knowledgeRoot } = createProject();
    const sourcePath = createSourceFile();
    mkdirSync(knowledgeRoot, { recursive: true });
    const existingPath = join(knowledgeRoot, 'existing.md');
    const existingMarkdown = existingDocument('existing', 'Existing');
    writeFileSync(existingPath, existingMarkdown, 'utf8');
    rebuildProjectIndex(projectRoot, project);
    const invalidHierarchy = createHierarchy(['unknown-section']);
    const result = await runBuild(dataRoot, sourcePath, {
      settings: settingsSchema.parse({ ai: { model: 'test-model' } }),
      providerFactory: () => new FakeBuildProvider(invalidHierarchy),
    });

    expect(result.exitCode).toBe(1);
    expect(result.errorOutput).toContain('[QLM_INPUT_ERROR]');
    expect(progressTransitions(result.output).at(-1)).toBe('failed');
    expect(readFileSync(existingPath, 'utf8')).toBe(existingMarkdown);
    const database = new Database(resolveProjectDatabasePath(projectRoot), { readonly: true });
    try {
      expect(database.prepare('SELECT id, path FROM documents').all()).toEqual([
        { id: 'existing', path: 'existing.md' },
      ]);
    } finally {
      database.close();
    }
    expect(existsSync(join(knowledgeRoot, 'security', 'authentication.md'))).toBe(false);
  });

  it('prepares a validated hierarchy without generating documents or touching the project', async () => {
    const { project, projectRoot, knowledgeRoot } = createProject();
    const sourcePath = createSourceFile();
    const source = loadMarkdownSources(sourcePath)[0];
    if (source === undefined) throw new Error('Expected a source fixture.');
    const parsed = await new MarkdownDocumentParser().parse(source);
    const order: string[] = [];
    const provider = new FakeBuildProvider(
      createHierarchy(parsed.sections.map(({ id }) => id)),
      () => order.push('provider-request'),
    );
    const events: BuildProgressStage[] = [];

    const prepared = await prepareProjectKnowledgeBuild({
      sourcePath,
      projectRoot,
      knowledgeRoot,
      project,
      provider,
      model: 'test-model',
      onProgress: ({ stage }) => {
        events.push(stage);
        order.push(stage);
      },
    });

    expect(prepared.hierarchy).toHaveLength(1);
    expect(prepared.sourceChanges.files.map(({ status }) => status)).toEqual(['added']);
    expect(prepared.sourceChanges.sections.map(({ status }) => status)).toEqual(
      parsed.sections.map(() => 'added'),
    );
    expect(events).toEqual(['queued', 'parsing', 'parsing', 'comparing', 'planning', 'validating', 'awaiting_approval']);
    expect(order.indexOf('comparing')).toBeLessThan(order.indexOf('provider-request'));
    expect(provider.requests.map(({ schemaName }) => schemaName)).toEqual(['qlm_knowledge_hierarchy']);
    expect(existsSync(knowledgeRoot)).toBe(false);
    expect(existsSync(resolveProjectDatabasePath(projectRoot))).toBe(false);
  });

  it('reports a typed configuration error when no model is configured', async () => {
    const { dataRoot } = createProject();
    let providerCreated = false;
    const result = await runBuild(dataRoot, 'unused.md', {
      settings: settingsSchema.parse({}),
      providerFactory: () => {
        providerCreated = true;
        return new FakeBuildProvider([]);
      },
    });

    expect(result.exitCode).toBe(1);
    expect(result.errorOutput).toContain('[QLM_CONFIG_ERROR]');
    expect(result.errorOutput).toContain('Set ai.model in config.yaml');
    expect(providerCreated).toBe(false);
  });

  it('emits a cancelled terminal event when the injected signal aborts a build', async () => {
    const { project, projectRoot, knowledgeRoot } = createProject();
    const sourcePath = createSourceFile();
    const controller = new AbortController();
    const events: BuildProgressStage[] = [];

    await expect(
      buildProjectKnowledge({
        sourcePath,
        projectRoot,
        knowledgeRoot,
        project,
        provider: new FakeBuildProvider([]),
        model: 'test-model',
        signal: controller.signal,
        onProgress: ({ stage }) => {
          events.push(stage);
          if (stage === 'queued') {
            controller.abort();
          }
        },
      }),
    ).rejects.toBeInstanceOf(BuildCancelledError);

    expect(events).toEqual(['queued', 'cancelled']);
    expect(existsSync(knowledgeRoot)).toBe(false);
    expect(existsSync(resolveProjectDatabasePath(projectRoot))).toBe(false);
  });

  it('turns Ctrl+C into a cancelled CLI state without reporting completion', async () => {
    const { dataRoot, knowledgeRoot, projectRoot } = createProject();
    const sourcePath = createSourceFile();
    const provider = new FakeBuildProvider([]);
    const result = await runBuild(dataRoot, sourcePath, {
      settings: settingsSchema.parse({ ai: { model: 'test-model' } }),
      providerFactory: () => provider,
      writeOutObserver: (text) => {
        if (text === 'Progress: planning\n') {
          process.emit('SIGINT');
        }
      },
    });

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('Progress: cancelled');
    expect(result.output).not.toContain('Progress: completed');
    expect(result.errorOutput).toContain('[QLM_CANCELLED]');
    expect(provider.requests).toHaveLength(0);
    expect(existsSync(knowledgeRoot)).toBe(false);
    expect(existsSync(resolveProjectDatabasePath(projectRoot))).toBe(false);
  });
});

interface BuildRuntimeOptions {
  settings: ReturnType<typeof settingsSchema.parse>;
  providerFactory: (settings: ReturnType<typeof settingsSchema.parse>) => AIProvider;
  writeOutObserver?: (text: string) => void;
}

async function runBuild(
  dataRoot: string,
  sourcePath: string,
  options: BuildRuntimeOptions,
) {
  const output: string[] = [];
  const errorOutput: string[] = [];
  const exitCode = await runCli(
    ['node', 'qlm', 'build', '--project', 'demo', sourcePath],
    {
      writeOut: (text) => {
        output.push(text);
        options.writeOutObserver?.(text);
      },
      writeError: (text) => errorOutput.push(text),
    },
    {
      runtimeFactory: () => ({
        dataRoot,
        logger: createApplicationLogger({ dataRoot, level: 'fatal' }),
        settings: options.settings,
      }),
      providerFactory: options.providerFactory,
    },
  );
  return { exitCode, output: output.join(''), errorOutput: errorOutput.join('') };
}

function createProject() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'qlm-build-cli-'));
  temporaryDirectories.push(dataRoot);
  const project = initializeProject(dataRoot, 'demo');
  const projectRoot = join(dataRoot, 'projects', project.name);
  return { dataRoot, project, projectRoot, knowledgeRoot: join(projectRoot, 'knowledge') };
}

function createSourceFile(): string {
  const sourceDirectory = mkdtempSync(join(tmpdir(), 'qlm-build-source-'));
  temporaryDirectories.push(sourceDirectory);
  const sourcePath = join(sourceDirectory, 'design.md');
  writeFileSync(
    sourcePath,
    '# Design specification\n\n## Authentication\n\nBearer tokens authenticate callers.\n',
    'utf8',
  );
  return sourcePath;
}

function progressTransitions(output: string): BuildProgressStage[] {
  const stages = output
    .split('\n')
    .filter((line) => line.startsWith('Progress: '))
    .map((line) => line.slice('Progress: '.length).split(/[ (:]/u)[0])
    .filter((stage): stage is BuildProgressStage =>
      BUILD_PROGRESS_STAGES.includes(stage as BuildProgressStage),
    );
  return stages.filter((stage, index) => stage !== stages[index - 1]);
}

function createHierarchy(sectionIds: string[]): HierarchyNode[] {
  return [
    {
      id: 'security',
      name: 'Security',
      type: 'category',
      path: 'security',
      description: 'Security topics.',
      sourceSectionIds: [],
      relatedDocumentIds: [],
      children: [
        {
          id: 'security-authentication',
          name: 'Authentication',
          type: 'document',
          path: 'security/authentication.md',
          description: 'Authentication behavior.',
          sourceSectionIds: sectionIds,
          relatedDocumentIds: [],
          children: [],
        },
      ],
    },
  ];
}

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

class FakeBuildProvider implements AIProvider {
  readonly id = 'fake-provider';
  readonly requests: StructuredRequest<unknown>[] = [];

  constructor(
    private readonly hierarchy: HierarchyNode[],
    private readonly onRequest?: () => void,
  ) {}

  async listModels(): Promise<ModelInfo[]> {
    return [];
  }

  async generate(request: GenerateRequest): Promise<GenerateResponse> {
    return { model: request.model, text: '' };
  }

  async generateStructured<T>(request: StructuredRequest<T>): Promise<T> {
    this.requests.push(request as StructuredRequest<unknown>);
    this.onRequest?.();
    if (request.schemaName === 'qlm_knowledge_hierarchy') {
      return { hierarchy: this.hierarchy } as T;
    }
    return { body: 'Bearer tokens are sent with API requests.', inferences: [] } as T;
  }

  async countTokens(_text: string, _model: string): Promise<TokenCount> {
    return { count: 0, isEstimate: true };
  }

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map(() => [0.1, 0.2, 0.3]);
  }
}
