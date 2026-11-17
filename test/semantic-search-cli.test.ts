import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { settingsSchema } from '../src/config/schema.js';
import { runCli } from '../src/cli.js';
import { rebuildProjectIndexWithEmbeddings } from '../src/database/reindex.js';
import { createApplicationLogger } from '../src/logging/logger.js';
import { createMarkdownDocument } from '../src/markdown/repository.js';
import { initializeProject } from '../src/projects/manager.js';
import type {
  AIProvider,
  EmbeddingProvider,
  GenerateRequest,
  GenerateResponse,
  StructuredRequest,
} from '../src/providers/provider.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('CLI semantic search', () => {
  it('uses the configured embedding model and prints indexed semantic results', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'qlm-semantic-cli-'));
    roots.push(dataRoot);
    const project = initializeProject(dataRoot, 'semantic');
    const projectRoot = join(dataRoot, 'projects', project.name);
    createMarkdownDocument(join(projectRoot, 'knowledge'), 'security/rotation.md', {
      metadata: {
        schema_version: 1,
        title: 'Credential Rotation',
        type: 'document',
        depth: 1,
        status: 'draft',
        source_ids: ['source-test'],
        source_sections: ['source-test:section-1'],
      },
      body: '\n## Rotate access tokens\nRotate expired credentials.\n',
    });
    const provider = new FakeProvider();
    await rebuildProjectIndexWithEmbeddings(projectRoot, project, {
      provider,
      model: 'embedding-v1',
    });

    let output = '';
    let errorOutput = '';
    const code = await runCli(
      [
        'node', 'qlm', 'search', 'renew secret credentials',
        '--project', 'semantic', '--mode', 'semantic', '--max-results', '1',
      ],
      {
        writeOut: (text) => { output += text; },
        writeError: (text) => { errorOutput += text; },
      },
      {
        runtimeFactory: () => ({
          dataRoot,
          logger: createApplicationLogger({ dataRoot, level: 'fatal' }),
          settings: settingsSchema.parse({
            logging: { level: 'fatal' },
            ai: { provider: 'openai-compatible', embedding_model: 'embedding-v1' },
          }),
        }),
        providerFactory: () => provider,
      },
    );

    expect(code).toBe(0);
    expect(errorOutput).toBe('');
    expect(output).toContain('security/rotation.md');
    expect(output).toContain('sections: section-');

    output = '';
    errorOutput = '';
    const hybridCode = await runCli(
      [
        'node', 'qlm', 'search', 'renew secret credentials',
        '--project', 'semantic', '--mode', 'hybrid', '--max-results', '1',
      ],
      {
        writeOut: (text) => { output += text; },
        writeError: (text) => { errorOutput += text; },
      },
      {
        runtimeFactory: () => ({
          dataRoot,
          logger: createApplicationLogger({ dataRoot, level: 'fatal' }),
          settings: settingsSchema.parse({
            logging: { level: 'fatal' },
            ai: { provider: 'openai-compatible', embedding_model: 'embedding-v1' },
          }),
        }),
        providerFactory: () => provider,
      },
    );

    expect(hybridCode).toBe(0);
    expect(errorOutput).toBe('');
    expect(output).toContain('security/rotation.md');
  });
});

class FakeProvider implements AIProvider, EmbeddingProvider {
  readonly id = 'semantic-cli-test';

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map(() => [1, 0, 0]);
  }

  async listModels() {
    return [];
  }

  async generate(_request: GenerateRequest): Promise<GenerateResponse> {
    throw new Error('Chat generation is not used by semantic search.');
  }

  async generateStructured<T>(_request: StructuredRequest<T>): Promise<T> {
    throw new Error('Structured generation is not used by semantic search.');
  }

  async countTokens() {
    return { count: 0, isEstimate: true };
  }
}
