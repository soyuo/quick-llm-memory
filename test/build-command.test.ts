import Database from 'better-sqlite3';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { settingsSchema } from '../src/config/schema.js';
import { resolveProjectDatabasePath } from '../src/database/database.js';
import { rebuildProjectIndex } from '../src/database/reindex.js';
import { runCli } from '../src/cli.js';
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
    const { dataRoot, projectRoot } = createProject();
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
    } finally {
      database.close();
    }
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
});

interface BuildRuntimeOptions {
  settings: ReturnType<typeof settingsSchema.parse>;
  providerFactory: (settings: ReturnType<typeof settingsSchema.parse>) => AIProvider;
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
      writeOut: (text) => output.push(text),
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

  constructor(private readonly hierarchy: HierarchyNode[]) {}

  async listModels(): Promise<ModelInfo[]> {
    return [];
  }

  async generate(request: GenerateRequest): Promise<GenerateResponse> {
    return { model: request.model, text: '' };
  }

  async generateStructured<T>(request: StructuredRequest<T>): Promise<T> {
    this.requests.push(request as StructuredRequest<unknown>);
    if (request.schemaName === 'qlm_knowledge_hierarchy') {
      return { hierarchy: this.hierarchy } as T;
    }
    return { body: 'Bearer tokens are sent with API requests.', inferences: [] } as T;
  }

  async countTokens(_text: string, _model: string): Promise<TokenCount> {
    return { count: 0, isEstimate: true };
  }
}
