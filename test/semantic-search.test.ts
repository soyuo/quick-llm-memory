import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { InputError } from '../src/errors/qlm-error.js';
import { ProviderError } from '../src/providers/provider-error.js';
import type { EmbeddingProvider } from '../src/providers/provider.js';
import { rebuildProjectIndex, rebuildProjectIndexWithEmbeddings } from '../src/database/reindex.js';
import { createMarkdownDocument } from '../src/markdown/repository.js';
import { initializeProject } from '../src/projects/manager.js';
import { searchProjectDocuments } from '../src/retrieval/search.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('semantic retrieval', () => {
  it('ranks by cosine similarity, returns matched section identities, and applies the result limit', async () => {
    const fixture = createProject();
    const credentialDocument = addDocument(fixture.knowledgeRoot, 'security/rotation.md', 'Credential Rotation',
      '\n## Rotate access tokens\nRotate expired credentials and replace secret keys.\n');
    addDocument(fixture.knowledgeRoot, 'storage/backup.md', 'Database Backups',
      '\n## Restore a backup\nRestore the database from a verified archive.\n');
    const provider = new FakeEmbeddingProvider();
    await rebuildProjectIndexWithEmbeddings(fixture.projectRoot, fixture.project, {
      provider,
      model: 'embedding-v1',
    });

    const request = {
      ...fixture,
      projectId: fixture.project.id,
      query: 'renew secret credentials',
      mode: 'semantic' as const,
      maxResults: 1,
      embeddingProvider: provider,
      embeddingModel: 'embedding-v1',
      synchronizeStaleIndex: false,
    };
    const results = await searchProjectDocuments(request);
    const repeated = await searchProjectDocuments(request);
    const callsBeforeZeroLimit = provider.calls.length;
    const noResults = await searchProjectDocuments({ ...request, maxResults: 0 });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      documentId: credentialDocument.documentId,
      path: 'security/rotation.md',
      title: 'Credential Rotation',
    });
    expect(results[0]?.matchedSections.length).toBeGreaterThan(0);
    expect(repeated).toEqual(results);
    expect(noResults).toEqual([]);
    expect(provider.calls).toHaveLength(callsBeforeZeroLimit);
  });

  it('fails before provider calls when vectors are missing or use another model', async () => {
    const missing = createProject();
    addDocument(missing.knowledgeRoot, 'security/rotation.md', 'Credential Rotation',
      '\n## Rotate access tokens\nRotate expired credentials.\n');
    rebuildProjectIndex(missing.projectRoot, missing.project);
    const provider = new FakeEmbeddingProvider();
    await expect(searchProjectDocuments({
      ...missing,
      projectId: missing.project.id,
      query: 'rotate credentials',
      mode: 'semantic',
      embeddingProvider: provider,
      embeddingModel: 'embedding-v1',
    })).rejects.toBeInstanceOf(InputError);
    expect(provider.calls).toHaveLength(0);

    await rebuildProjectIndexWithEmbeddings(missing.projectRoot, missing.project, {
      provider,
      model: 'embedding-v1',
    });
    await expect(searchProjectDocuments({
      ...missing,
      projectId: missing.project.id,
      query: 'rotate credentials',
      mode: 'semantic',
      embeddingProvider: provider,
      embeddingModel: 'embedding-v2',
    })).rejects.toMatchObject({ suggestedAction: expect.stringContaining('qlm reindex') });
    expect(provider.calls).toHaveLength(1);
  });

  it('rejects provider vectors with incompatible dimensions', async () => {
    const fixture = createProject();
    addDocument(fixture.knowledgeRoot, 'security/rotation.md', 'Credential Rotation',
      '\n## Rotate access tokens\nRotate expired credentials.\n');
    const indexProvider = new FakeEmbeddingProvider();
    await rebuildProjectIndexWithEmbeddings(fixture.projectRoot, fixture.project, {
      provider: indexProvider,
      model: 'embedding-v1',
    });
    const malformed = new FakeEmbeddingProvider(() => [1, 2]);

    await expect(searchProjectDocuments({
      ...fixture,
      projectId: fixture.project.id,
      query: 'rotate credentials',
      mode: 'semantic',
      embeddingProvider: malformed,
      embeddingModel: 'embedding-v1',
    })).rejects.toBeInstanceOf(ProviderError);
  });

  it('does not serve a vector match when the selected Markdown changed after indexing', async () => {
    const fixture = createProject();
    const { path: documentPath } = addDocument(
      fixture.knowledgeRoot,
      'security/rotation.md',
      'Credential Rotation',
      '\n## Rotate access tokens\nRotate expired credentials.\n',
    );
    const provider = new FakeEmbeddingProvider();
    await rebuildProjectIndexWithEmbeddings(fixture.projectRoot, fixture.project, {
      provider,
      model: 'embedding-v1',
    });
    writeFileSync(documentPath, readFileSync(documentPath, 'utf8').replace('expired', 'rotated'), 'utf8');

    await expect(searchProjectDocuments({
      ...fixture,
      projectId: fixture.project.id,
      query: 'rotate credentials',
      mode: 'semantic',
      embeddingProvider: provider,
      embeddingModel: 'embedding-v1',
      synchronizeStaleIndex: false,
    })).rejects.toMatchObject({ suggestedAction: expect.stringContaining('qlm reindex') });
  });

});

class FakeEmbeddingProvider implements EmbeddingProvider {
  readonly id = 'fake-embeddings';
  readonly calls: string[][] = [];

  constructor(private readonly override?: (text: string) => number[]) {}

  async embed(texts: string[]): Promise<number[][]> {
    this.calls.push([...texts]);
    return texts.map((text) => this.override?.(text) ?? vectorFor(text));
  }
}

function vectorFor(text: string): number[] {
  const normalized = text.toLowerCase();
  if (/credential|token|secret|rotation|renew/.test(normalized)) return [1, 0, 0];
  if (/database|backup|archive|restore/.test(normalized)) return [0, 1, 0];
  return [0, 0, 1];
}

function createProject() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'qlm-semantic-search-'));
  temporaryDirectories.push(dataRoot);
  const project = initializeProject(dataRoot, 'semantic');
  const projectRoot = join(dataRoot, 'projects', project.name);
  return { dataRoot, project, projectRoot, knowledgeRoot: join(projectRoot, 'knowledge') };
}

function addDocument(
  knowledgeRoot: string,
  path: string,
  title: string,
  body: string,
): { path: string; documentId: string } {
  const document = createMarkdownDocument(knowledgeRoot, path, {
    metadata: {
      schema_version: 1,
      title,
      type: 'document',
      depth: 1,
      status: 'draft',
      source_ids: ['source-test'],
      source_sections: ['source-test:section-1'],
    },
    body,
  });
  return { path: join(knowledgeRoot, path), documentId: document.metadata.id };
}

