import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveProjectDatabasePath } from '../../src/database/database.js';
import { rebuildProjectIndex, rebuildProjectIndexWithEmbeddings } from '../../src/database/reindex.js';
import type { EmbeddingProvider } from '../../src/providers/provider.js';
import { initializeProject } from '../../src/projects/manager.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('project embedding index synchronization', () => {
  it('stores document and deterministic heading-section vectors with source hashes', async () => {
    const fixture = createProject();
    const markdown = document('doc-a', 'Alpha', '# Introduction\nFirst body.\n\n## Details\nSecond body.');
    const file = join(fixture.knowledgeRoot, 'alpha.md');
    writeFileSync(file, markdown, 'utf8');
    const before = readFileSync(file, 'utf8');
    const provider = new FakeEmbeddingProvider();

    await rebuildProjectIndexWithEmbeddings(fixture.projectRoot, fixture.project, {
      provider,
      model: 'embedding-v1',
    });

    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]).toEqual([
      'Alpha\n\n# Introduction\nFirst body.\n\n## Details\nSecond body.',
      'Introduction\n\n# Introduction\nFirst body.',
      'Details\n\n## Details\nSecond body.',
    ]);
    const database = openReadOnly(fixture.projectRoot);
    try {
      expect(database.prepare('SELECT provider_id, model, dimensions FROM project_embedding_metadata').get())
        .toEqual({ provider_id: 'fake-embeddings', model: 'embedding-v1', dimensions: 3 });
      const rows = database.prepare(`
        SELECT kind, section_id, source_hash, model, dimensions, vector_json
        FROM document_embeddings ORDER BY kind, section_id
      `).all();
      expect(rows).toHaveLength(3);
      expect(rows).toEqual(expect.arrayContaining([
        expect.objectContaining({
          kind: 'document', section_id: '',
          source_hash: sha256(provider.calls[0]![0]!),
          model: 'embedding-v1', dimensions: 3, vector_json: '[1,2,3]',
        }),
        expect.objectContaining({
          kind: 'section', source_hash: sha256(provider.calls[0]![1]!),
          model: 'embedding-v1', dimensions: 3, vector_json: '[2,3,4]',
        }),
        expect.objectContaining({
          kind: 'section', source_hash: sha256(provider.calls[0]![2]!),
          model: 'embedding-v1', dimensions: 3, vector_json: '[3,4,5]',
        }),
      ]));
    } finally {
      database.close();
    }
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  it('uses bounded ordered batches and replaces stale vectors when text or model changes', async () => {
    const fixture = createProject();
    for (let index = 0; index < 18; index += 1) {
      writeFileSync(
        join(fixture.knowledgeRoot, `doc-${String(index).padStart(2, '0')}.md`),
        document(`doc-${index}`, `Document ${index}`, `# First ${index}\nText.\n\n## Second ${index}\nMore.`),
        'utf8',
      );
    }
    const provider = new FakeEmbeddingProvider();
    await rebuildProjectIndexWithEmbeddings(fixture.projectRoot, fixture.project, {
      provider,
      model: 'embedding-v1',
    });
    expect(provider.calls.map((batch) => batch.length)).toEqual([32, 22]);
    const firstRunInputs = provider.calls.flat();
    const repeatProvider = new FakeEmbeddingProvider();
    await rebuildProjectIndexWithEmbeddings(fixture.projectRoot, fixture.project, {
      provider: repeatProvider,
      model: 'embedding-v1',
    });
    expect(repeatProvider.calls.flat()).toEqual(firstRunInputs);

    const changedPath = join(fixture.knowledgeRoot, 'doc-00.md');
    const changedMarkdown = document('doc-0', 'Document 0', '# First changed\nUpdated.');
    writeFileSync(changedPath, changedMarkdown, 'utf8');
    const secondProvider = new FakeEmbeddingProvider(4);
    await rebuildProjectIndexWithEmbeddings(fixture.projectRoot, fixture.project, {
      provider: secondProvider,
      model: 'embedding-v2',
    });
    const database = openReadOnly(fixture.projectRoot);
    try {
      expect(database.prepare('SELECT DISTINCT model, dimensions FROM document_embeddings').all())
        .toEqual([{ model: 'embedding-v2', dimensions: 4 }]);
      expect(database.prepare('SELECT count(*) AS count FROM document_embeddings').get())
        .toEqual({ count: 53 });
      const changed = database.prepare(`
        SELECT source_hash, model, dimensions FROM document_embeddings
        WHERE document_id = 'doc-0' AND kind = 'document'
      `).get() as { source_hash: string; model: string; dimensions: number };
      expect(changed).toMatchObject({
        source_hash: sha256('Document 0\n\n# First changed\nUpdated.'),
        model: 'embedding-v2',
        dimensions: 4,
      });
    } finally {
      database.close();
    }
  });

  it('preserves unchanged vectors during offline reindex and clears them after content changes', async () => {
    const fixture = createProject();
    const file = join(fixture.knowledgeRoot, 'alpha.md');
    const initialMarkdown = document('doc-a', 'Alpha', '# Heading\nStable content.');
    writeFileSync(file, initialMarkdown, 'utf8');
    await rebuildProjectIndexWithEmbeddings(fixture.projectRoot, fixture.project, {
      provider: new FakeEmbeddingProvider(),
      model: 'embedding-v1',
    });
    const existing = readIndexState(fixture.projectRoot);

    rebuildProjectIndex(fixture.projectRoot, fixture.project);
    expect(readIndexState(fixture.projectRoot)).toEqual(existing);

    writeFileSync(file, document('doc-a', 'Alpha', '# Heading\nChanged content.'), 'utf8');
    rebuildProjectIndex(fixture.projectRoot, fixture.project);
    const database = openReadOnly(fixture.projectRoot);
    try {
      expect(database.prepare('SELECT count(*) AS count FROM document_embeddings').get())
        .toEqual({ count: 0 });
      expect(database.prepare('SELECT count(*) AS count FROM project_embedding_metadata').get())
        .toEqual({ count: 0 });
      expect(database.prepare('SELECT content_hash FROM documents').get())
        .toEqual({ content_hash: sha256(document('doc-a', 'Alpha', '# Heading\nChanged content.')) });
      expect(database.prepare('SELECT content_hash FROM documents').get())
        .not.toEqual({ content_hash: sha256(initialMarkdown) });
    } finally {
      database.close();
    }
  });

  it('leaves the previous index and vectors intact when embedding generation fails', async () => {
    const fixture = createProject();
    const file = join(fixture.knowledgeRoot, 'alpha.md');
    writeFileSync(file, document('doc-a', 'Alpha', '# Original\nOriginal text.'), 'utf8');
    await rebuildProjectIndexWithEmbeddings(fixture.projectRoot, fixture.project, {
      provider: new FakeEmbeddingProvider(),
      model: 'embedding-v1',
    });
    const before = readIndexState(fixture.projectRoot);
    const changed = document('doc-a', 'Alpha updated', '# Changed\nNew text.');
    writeFileSync(file, changed, 'utf8');
    const markdownBefore = readFileSync(file, 'utf8');
    const failing: EmbeddingProvider = {
      id: 'fake-embeddings',
      embed: async () => { throw new Error('injected provider failure'); },
    };

    await expect(rebuildProjectIndexWithEmbeddings(fixture.projectRoot, fixture.project, {
      provider: failing,
      model: 'embedding-v1',
    })).rejects.toThrow('Unable to generate project embeddings.');

    expect(readIndexState(fixture.projectRoot)).toEqual(before);
    expect(readFileSync(file, 'utf8')).toBe(markdownBefore);
  });

  it('aborts instead of indexing a stale snapshot when Markdown changes during embedding', async () => {
    const fixture = createProject();
    const file = join(fixture.knowledgeRoot, 'alpha.md');
    writeFileSync(file, document('doc-a', 'Alpha', '# Original\nOriginal text.'), 'utf8');
    await rebuildProjectIndexWithEmbeddings(fixture.projectRoot, fixture.project, {
      provider: new FakeEmbeddingProvider(),
      model: 'embedding-v1',
    });
    const before = readIndexState(fixture.projectRoot);
    writeFileSync(file, document('doc-a', 'Alpha', '# Planned\nPlanned text.'), 'utf8');
    const concurrentUpdate = document('doc-a', 'Alpha', '# Concurrent\nConcurrent text.');
    const mutatingProvider: EmbeddingProvider = {
      id: 'fake-embeddings',
      embed: async (texts) => {
        writeFileSync(file, concurrentUpdate, 'utf8');
        return texts.map(() => [0.1, 0.2, 0.3]);
      },
    };

    await expect(rebuildProjectIndexWithEmbeddings(fixture.projectRoot, fixture.project, {
      provider: mutatingProvider,
      model: 'embedding-v1',
    })).rejects.toThrow('Markdown changed while embeddings were being generated; the index was not updated.');

    expect(readIndexState(fixture.projectRoot)).toEqual(before);
    expect(readFileSync(file, 'utf8')).toBe(concurrentUpdate);
  });

  it('rejects malformed vectors before creating or replacing the database', async () => {
    const fixture = createProject();
    const file = join(fixture.knowledgeRoot, 'alpha.md');
    writeFileSync(file, document('doc-a', 'Alpha', '# Heading\nContent.'), 'utf8');
    const malformed: EmbeddingProvider = {
      id: 'fake-embeddings',
      embed: async (texts) => texts.map((_, index) => index === 0 ? [1, Number.POSITIVE_INFINITY] : [1, 2]),
    };

    await expect(rebuildProjectIndexWithEmbeddings(fixture.projectRoot, fixture.project, {
      provider: malformed,
      model: 'embedding-v1',
    })).rejects.toThrow('The embedding provider returned an invalid vector.');

    expect(existsSync(resolveProjectDatabasePath(fixture.projectRoot))).toBe(false);
    expect(readFileSync(file, 'utf8')).toContain('# Heading');
  });

  it('rolls back document, FTS, and vector replacement when the database rejects a vector', async () => {
    const fixture = createProject();
    const file = join(fixture.knowledgeRoot, 'alpha.md');
    writeFileSync(file, document('doc-a', 'Alpha', '# Original\nOriginal text.'), 'utf8');
    await rebuildProjectIndexWithEmbeddings(fixture.projectRoot, fixture.project, {
      provider: new FakeEmbeddingProvider(),
      model: 'embedding-v1',
    });
    const before = readIndexState(fixture.projectRoot);
    writeFileSync(file, document('doc-a', 'Alpha updated', '# Changed\nChanged text.'), 'utf8');
    const database = new Database(resolveProjectDatabasePath(fixture.projectRoot));
    database.exec(`
      CREATE TRIGGER reject_embedding_insert
      BEFORE INSERT ON document_embeddings
      BEGIN
        SELECT RAISE(ABORT, 'injected vector insert failure');
      END;
    `);
    database.close();

    await expect(rebuildProjectIndexWithEmbeddings(fixture.projectRoot, fixture.project, {
      provider: new FakeEmbeddingProvider(),
      model: 'embedding-v2',
    })).rejects.toThrow();

    expect(readIndexState(fixture.projectRoot)).toEqual(before);
  });
});

class FakeEmbeddingProvider implements EmbeddingProvider {
  readonly id = 'fake-embeddings';
  readonly calls: string[][] = [];

  constructor(private readonly dimensions = 3) {}

  async embed(texts: string[]): Promise<number[][]> {
    this.calls.push([...texts]);
    return texts.map((_, index) =>
      Array.from({ length: this.dimensions }, (_, component) => index + component + 1),
    );
  }
}

function createProject() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'qlm-embedding-reindex-'));
  temporaryDirectories.push(dataRoot);
  const project = initializeProject(dataRoot, 'demo');
  const projectRoot = join(dataRoot, 'projects', project.name);
  const knowledgeRoot = join(projectRoot, 'knowledge');
  mkdirSync(knowledgeRoot, { recursive: true });
  return { project, projectRoot, knowledgeRoot };
}

function document(id: string, title: string, body: string): string {
  return [
    '---',
    'schema_version: 1',
    `id: ${id}`,
    `title: ${title}`,
    'type: document',
    'depth: 1',
    'status: generated',
    '---',
    body,
    '',
  ].join('\n');
}

function openReadOnly(projectRoot: string): Database.Database {
  return new Database(resolveProjectDatabasePath(projectRoot), { readonly: true });
}

function readIndexState(projectRoot: string): unknown {
  const database = openReadOnly(projectRoot);
  try {
    return {
      documents: database.prepare('SELECT * FROM documents ORDER BY id').all(),
      fts: database.prepare('SELECT * FROM document_fts ORDER BY document_id').all(),
      metadata: database.prepare('SELECT * FROM project_embedding_metadata').all(),
      embeddings: database.prepare('SELECT * FROM document_embeddings ORDER BY document_id, kind, section_id').all(),
    };
  } finally {
    database.close();
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
