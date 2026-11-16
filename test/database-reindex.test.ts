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
import { ConfigurationError } from '../src/config/error.js';
import { InternalError } from '../src/errors/qlm-error.js';
import { resolveProjectDatabasePath } from '../src/database/database.js';
import { rebuildProjectIndex } from '../src/database/reindex.js';
import { initializeProject } from '../src/projects/manager.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('project SQLite index rebuild', () => {
  it('rebuilds documents, categories, and relations from Markdown repeatably', () => {
    const { projectRoot, project, knowledgeRoot } = createProject();
    mkdirSync(join(knowledgeRoot, 'security', 'nested'), { recursive: true });
    writeFileSync(
      join(knowledgeRoot, 'security', 'index.md'),
      categoryIndex('security', 'Security', 1),
      'utf8',
    );
    writeFileSync(
      join(knowledgeRoot, 'security', 'overview.md'),
      document('doc-overview', 'Overview', 2, 'security', ['doc-detail']),
      'utf8',
    );
    writeFileSync(
      join(knowledgeRoot, 'security', 'nested', 'detail.md'),
      document('doc-detail', 'Detail', 3, 'security/nested'),
      'utf8',
    );

    const firstResult = rebuildProjectIndex(projectRoot, project);
    const firstSnapshot = readIndex(projectRoot);
    const secondResult = rebuildProjectIndex(projectRoot, project);
    const secondSnapshot = readIndex(projectRoot);

    expect(firstResult).toEqual({ categories: 2, documents: 2, relations: 1 });
    expect(secondResult).toEqual(firstResult);
    expect(secondSnapshot).toEqual(firstSnapshot);
    expect(secondSnapshot.categories).toEqual([
      {
        id: 'security',
        parent_id: null,
        name: 'security',
        path: 'security',
        depth: 1,
      },
      {
        id: 'qlm-category:security/nested',
        parent_id: 'security',
        name: 'nested',
        path: 'security/nested',
        depth: 2,
      },
    ]);
    expect(secondSnapshot.documents).toMatchObject([
      {
        id: 'doc-detail',
        path: 'security/nested/detail.md',
        category_id: 'qlm-category:security/nested',
        depth: 3,
        status: 'verified',
      },
      {
        id: 'doc-overview',
        path: 'security/overview.md',
        category_id: 'security',
        depth: 2,
        status: 'verified',
      },
    ]);
    expect(secondSnapshot.documents[0]?.content_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(secondSnapshot.relations).toEqual([
      { source_id: 'doc-overview', target_id: 'doc-detail', relation_type: 'related' },
    ]);
  });

  it('recreates a deleted database using Markdown alone', () => {
    const { projectRoot, project, knowledgeRoot } = createProject();
    writeFileSync(
      join(knowledgeRoot, 'note.md'),
      document('note-1', 'Note', 1),
      'utf8',
    );
    const databasePath = resolveProjectDatabasePath(projectRoot);
    mkdirSync(join(projectRoot, 'index'), { recursive: true });
    writeFileSync(databasePath, 'not a database', 'utf8');
    rmSync(databasePath);

    expect(rebuildProjectIndex(projectRoot, project)).toEqual({
      categories: 0,
      documents: 1,
      relations: 0,
    });
    expect(existsSync(databasePath)).toBe(true);
    expect(readIndex(projectRoot).documents.map(({ id }) => id)).toEqual(['note-1']);
  });

  it('preserves the current index and Markdown when source metadata is invalid', () => {
    const { projectRoot, project, knowledgeRoot } = createProject();
    const originalPath = join(knowledgeRoot, 'existing.md');
    writeFileSync(originalPath, document('existing', 'Existing', 1), 'utf8');
    rebuildProjectIndex(projectRoot, project);
    const indexedBefore = readIndex(projectRoot);
    const invalidPath = join(knowledgeRoot, 'invalid.md');
    const invalidContents = '---\ntype: document\ntitle: Missing schema\n---\n';
    writeFileSync(invalidPath, invalidContents, 'utf8');

    expect(() => rebuildProjectIndex(projectRoot, project)).toThrow(ConfigurationError);
    expect(readIndex(projectRoot)).toEqual(indexedBefore);
    expect(readFileSync(invalidPath, 'utf8')).toBe(invalidContents);
    expect(readFileSync(originalPath, 'utf8')).toBe(document('existing', 'Existing', 1));
  });

  it('rolls back all index rows when a SQLite constraint rejects the rebuild', () => {
    const { projectRoot, project, knowledgeRoot } = createProject();
    writeFileSync(
      join(knowledgeRoot, 'original.md'),
      document('original', 'Original', 1),
      'utf8',
    );
    rebuildProjectIndex(projectRoot, project);
    const indexedBefore = readIndex(projectRoot);
    const firstPath = join(knowledgeRoot, 'one.md');
    const secondPath = join(knowledgeRoot, 'two.md');
    const duplicate = document('duplicate', 'Duplicate', 1);
    writeFileSync(firstPath, duplicate, 'utf8');
    writeFileSync(secondPath, duplicate, 'utf8');

    expect(() => rebuildProjectIndex(projectRoot, project)).toThrow(InternalError);
    expect(readIndex(projectRoot)).toEqual(indexedBefore);
    expect(readFileSync(firstPath, 'utf8')).toBe(duplicate);
    expect(readFileSync(secondPath, 'utf8')).toBe(duplicate);
  });
});

function createProject() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'qlm-reindex-'));
  temporaryDirectories.push(dataRoot);
  const project = initializeProject(dataRoot, 'demo');
  const projectRoot = join(dataRoot, 'projects', project.name);
  const knowledgeRoot = join(projectRoot, 'knowledge');
  mkdirSync(knowledgeRoot, { recursive: true });
  return { projectRoot, project, knowledgeRoot };
}

function categoryIndex(id: string, title: string, depth: number): string {
  return [
    '---',
    `id: ${id}`,
    `title: ${title}`,
    `depth: ${depth}`,
    'type: category-index',
    '---',
    '',
    `# ${title}`,
    '',
  ].join('\n');
}

function document(
  id: string,
  title: string,
  depth: number,
  category?: string,
  related: string[] = [],
): string {
  const metadata = [
    '---',
    'schema_version: 1',
    `id: ${id}`,
    `title: ${title}`,
    'type: document',
    `depth: ${depth}`,
    'status: verified',
    ...(category === undefined ? [] : [`category: ${category}`]),
    ...(related.length === 0 ? [] : ['related:', ...related.map((idValue) => `  - ${idValue}`)]),
    '---',
    '',
    `# ${title}`,
    '',
  ];
  return metadata.join('\n');
}

function readIndex(projectRoot: string) {
  const database = new Database(resolveProjectDatabasePath(projectRoot), {
    readonly: true,
  });
  try {
    return {
      categories: database
        .prepare('SELECT id, parent_id, name, path, depth FROM categories ORDER BY path')
        .all() as Array<{
        id: string;
        parent_id: string | null;
        name: string;
        path: string;
        depth: number;
      }>,
      documents: database
        .prepare(`
          SELECT id, path, title, category_id, depth, content_hash, status,
                 created_at, updated_at
          FROM documents ORDER BY path
        `)
        .all() as Array<{
        id: string;
        path: string;
        title: string;
        category_id: string | null;
        depth: number;
        content_hash: string;
        status: string;
        created_at: string;
        updated_at: string;
      }>,
      relations: database
        .prepare('SELECT source_id, target_id, relation_type FROM document_relations ORDER BY source_id, target_id, relation_type')
        .all() as Array<{
        source_id: string;
        target_id: string;
        relation_type: string;
      }>,
    };
  } finally {
    database.close();
  }
}
