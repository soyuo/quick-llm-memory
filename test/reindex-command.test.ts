import Database from 'better-sqlite3';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runCli } from '../src/cli.js';
import { settingsSchema } from '../src/config/schema.js';
import { resolveProjectDatabasePath } from '../src/database/database.js';
import { createApplicationLogger } from '../src/logging/logger.js';
import { createMarkdownDocument } from '../src/markdown/repository.js';
import { initializeProject } from '../src/projects/manager.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('qlm reindex command', () => {
  it('rebuilds a project index and reports the indexed counts', async () => {
    const { dataRoot, project, projectRoot } = createProject();
    createMarkdownDocument(join(projectRoot, 'knowledge'), 'note.md', {
      metadata: {
        schema_version: 1,
        title: 'Note',
        type: 'document',
        depth: 1,
        status: 'draft',
      },
      body: '\n# Note\n',
    });
    const result = await run(dataRoot, ['--project', project.name]);

    expect(result.exitCode).toBe(0);
    expect(result.output).toBe(
      'Reindexed project demo: 1 document(s), 0 category row(s), 0 relation(s).\n',
    );
    expect(result.errorOutput).toBe('');
    const database = new Database(resolveProjectDatabasePath(projectRoot), {
      readonly: true,
    });
    try {
      expect(database.prepare('SELECT id, project_id, path FROM documents').get()).toMatchObject({
        id: expect.any(String),
        project_id: project.id,
        path: 'note.md',
      });
      expect(database.prepare('SELECT provider_id, model, dimensions FROM project_embedding_metadata').get())
        .toEqual({ provider_id: 'fake', model: 'test-embeddings', dimensions: 2 });
      expect(database.prepare('SELECT kind, vector_json FROM document_embeddings').get())
        .toEqual({ kind: 'document', vector_json: '[0.1,0.2]' });
    } finally {
      database.close();
    }
  });

  it('returns a typed nonzero error when the project does not exist', async () => {
    const { dataRoot } = createProject();
    const result = await run(dataRoot, ['--project', 'missing']);

    expect(result.exitCode).toBe(1);
    expect(result.errorOutput).toContain('[QLM_INPUT_ERROR]');
    expect(result.errorOutput).toContain('Project not found: missing');
  });

  it('does not create an index when Markdown is malformed', async () => {
    const { dataRoot, projectRoot } = createProject();
    const knowledgeRoot = join(projectRoot, 'knowledge');
    mkdirSync(knowledgeRoot, { recursive: true });
    const sourcePath = join(knowledgeRoot, 'invalid.md');
    const source = '---\ntype: document\ntitle: Missing fields\n---\n';
    writeFileSync(sourcePath, source, 'utf8');

    const result = await run(dataRoot, ['--project', 'demo']);

    expect(result.exitCode).toBe(1);
    expect(result.errorOutput).toContain('[QLM_CONFIG_ERROR]');
    expect(existsSync(resolveProjectDatabasePath(projectRoot))).toBe(false);
    expect(readFileSync(sourcePath, 'utf8')).toBe(source);
  });
});

function createProject() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'qlm-reindex-cli-'));
  temporaryDirectories.push(dataRoot);
  const project = initializeProject(dataRoot, 'demo');
  return {
    dataRoot,
    project,
    projectRoot: join(dataRoot, 'projects', project.name),
  };
}

async function run(dataRoot: string, args: string[]) {
  const output: string[] = [];
  const errorOutput: string[] = [];
  const exitCode = await runCli(
    ['node', 'qlm', 'reindex', ...args],
    {
      writeOut: (text) => output.push(text),
      writeError: (text) => errorOutput.push(text),
    },
    {
      runtimeFactory: () => ({
        dataRoot,
        logger: createApplicationLogger({ dataRoot, level: 'fatal' }),
        settings: settingsSchema.parse({ ai: { embedding_model: 'test-embeddings' } }),
      }),
      providerFactory: () => ({
        id: 'fake',
        listModels: async () => [],
        generate: async () => ({ model: 'fake', text: '' }),
        generateStructured: async <T,>() => ({}) as T,
        countTokens: async (text: string) => ({ count: Math.ceil(text.length / 4), isEstimate: true }),
        embed: async (texts: string[]) => texts.map(() => [0.1, 0.2]),
      }),
    },
  );
  return { exitCode, output: output.join(''), errorOutput: errorOutput.join('') };
}

