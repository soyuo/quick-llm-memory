import Database from 'better-sqlite3';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigurationError } from '../src/config/error.js';
import { InputError } from '../src/errors/qlm-error.js';
import {
  openProjectDatabase,
  resolveProjectDatabasePath,
} from '../src/database/database.js';
import {
  EMBEDDING_SCHEMA_PREVIOUS_VERSION,
  PROJECT_DATABASE_SCHEMA_VERSION,
  rollbackEmbeddingSchemaMigration,
} from '../src/database/schema.js';
import { initializeProject } from '../src/projects/manager.js';

const temporaryDirectories: string[] = [];
const openDatabases: Database.Database[] = [];

afterEach(() => {
  for (const database of openDatabases.splice(0)) {
    if (database.open) {
      database.close();
    }
  }
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('project SQLite database', () => {
  it('creates the Phase 2 schema at the project index path and enables foreign keys', () => {
    const { projectRoot, project } = createProject();
    const expectedPath = join(projectRoot, 'index', 'knowledge.db');
    const database = openDatabase(projectRoot, project);

    expect(existsSync(expectedPath)).toBe(true);
    expect(database.name).toBe(expectedPath);
    expect(database.pragma('user_version', { simple: true })).toBe(
      PROJECT_DATABASE_SCHEMA_VERSION,
    );
    expect(database.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(
      database
        .prepare(
          `SELECT name FROM sqlite_schema
           WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
             AND name NOT GLOB 'document_fts_*'
           ORDER BY name`,
        )
        .pluck()
        .all(),
    ).toEqual([
      'categories',
      'document_embeddings',
      'document_fts',
      'document_relations',
      'documents',
      'project_embedding_metadata',
      'projects',
      'source_snapshot_files',
      'source_snapshot_sections',
      'source_snapshots',
    ]);
    expect(
      database.prepare('SELECT id, name, root_path FROM projects').get(),
    ).toEqual({
      id: project.id,
      name: project.name,
      root_path: projectRoot,
    });
    expect(database.pragma('foreign_key_check')).toEqual([]);
  });

  it('enforces document uniqueness and project/category foreign keys', () => {
    const { projectRoot, project } = createProject();
    const database = openDatabase(projectRoot, project);
    const insertDocument = database.prepare(`
      INSERT INTO documents (
        id, project_id, path, title, category_id, depth, content_hash,
        status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const documentValues = [
      'doc-1', project.id, 'notes/one.md', 'One', null, 1, 'hash-1',
      'draft', project.created_at, project.updated_at,
    ] as const;

    insertDocument.run(...documentValues);
    expect(() => insertDocument.run('other-id', ...documentValues.slice(1))).toThrow(
      /UNIQUE constraint failed/,
    );
    expect(() => insertDocument.run('doc-2', 'missing-project', 'notes/two.md', 'Two', null, 1, 'hash-2', 'draft', project.created_at, project.updated_at)).toThrow(/FOREIGN KEY constraint failed/);

    const insertCategory = database.prepare(`
      INSERT INTO categories (id, project_id, parent_id, name, path, depth)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    insertCategory.run('category-1', project.id, null, 'Notes', 'notes', 1);
    expect(() => insertCategory.run('category-2', 'missing-project', null, 'Other', 'other', 1)).toThrow(/FOREIGN KEY constraint failed/);
    expect(() => insertCategory.run('category-3', project.id, 'missing-parent', 'Child', 'notes/child', 2)).toThrow(/FOREIGN KEY constraint failed/);

    const insertRelation = database.prepare(`
      INSERT INTO document_relations (source_id, target_id, relation_type)
      VALUES (?, ?, ?)
    `);
    insertRelation.run('doc-1', 'doc-2', 'related');
    expect(() => insertRelation.run('doc-1', 'doc-2', 'related')).toThrow(/UNIQUE constraint failed/);
  });

  it('supports atomic transactions with rollback on errors', () => {
    const { projectRoot, project } = createProject();
    const database = openDatabase(projectRoot, project);
    const insertProject = database.prepare(`
      INSERT INTO projects (id, name, root_path, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    const writeAndFail = database.transaction(() => {
      insertProject.run(
        'temporary-id',
        'temporary',
        projectRoot,
        project.created_at,
        project.updated_at,
      );
      throw new Error('abort transaction');
    });

    expect(() => writeAndFail()).toThrow('abort transaction');
    expect(
      database
        .prepare("SELECT count(*) AS count FROM projects WHERE id = 'temporary-id'")
        .get(),
    ).toEqual({ count: 0 });
  });

  it('can be initialized repeatedly without duplicating the project row', () => {
    const { projectRoot, project } = createProject();
    const first = openDatabase(projectRoot, project);
    first.close();

    const second = openDatabase(projectRoot, project);
    expect(second.pragma('user_version', { simple: true })).toBe(
      PROJECT_DATABASE_SCHEMA_VERSION,
    );
    expect(
      second.prepare('SELECT count(*) AS count FROM projects').get(),
    ).toEqual({ count: 1 });
  });

  it('migrates a version 1 database to FTS5 without changing existing rows', () => {
    const { projectRoot, project } = createProject();
    const original = openDatabase(projectRoot, project);
    original.prepare(`
      INSERT INTO documents (
        id, project_id, path, title, category_id, depth, content_hash,
        status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'existing-doc', project.id, 'security/existing.md', 'Existing', null, 2,
      'hash', 'verified', project.created_at, project.updated_at,
    );
    original.exec(`
      DROP TABLE document_embeddings;
      DROP TABLE project_embedding_metadata;
      DROP TABLE document_fts;
    `);
    original.pragma('user_version = 1');
    original.close();

    const migrated = openDatabase(projectRoot, project);
    expect(migrated.pragma('user_version', { simple: true })).toBe(
      PROJECT_DATABASE_SCHEMA_VERSION,
    );
    expect(migrated.prepare('SELECT id, path, title FROM documents').get()).toEqual({
      id: 'existing-doc',
      path: 'security/existing.md',
      title: 'Existing',
    });
    expect(
      migrated.prepare("SELECT sql FROM sqlite_schema WHERE name = 'document_fts'").get(),
    ).toMatchObject({ sql: expect.stringMatching(/USING fts5/i) });
  });

  it('migrates a version 2 database to the source snapshot schema without changing documents', () => {
    const { projectRoot, project } = createProject();
    const original = openDatabase(projectRoot, project);
    original.prepare(`
      INSERT INTO documents (
        id, project_id, path, title, category_id, depth, content_hash,
        status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'existing-doc', project.id, 'notes.md', 'Notes', null, 1,
      'hash', 'verified', project.created_at, project.updated_at,
    );
    original.exec(`
      DROP TABLE document_embeddings;
      DROP TABLE project_embedding_metadata;
      DROP TABLE source_snapshot_sections;
      DROP TABLE source_snapshot_files;
      DROP TABLE source_snapshots;
    `);
    original.pragma('user_version = 2');
    original.close();

    const migrated = openDatabase(projectRoot, project);
    expect(migrated.pragma('user_version', { simple: true })).toBe(PROJECT_DATABASE_SCHEMA_VERSION);
    expect(migrated.prepare('SELECT id, path FROM documents').get()).toEqual({
      id: 'existing-doc',
      path: 'notes.md',
    });
    expect(migrated.prepare("SELECT name FROM sqlite_schema WHERE name = 'source_snapshots'").get())
      .toEqual({ name: 'source_snapshots' });
  });

  it('adds the nullable parser section reference to version 3 snapshots without losing hashes', () => {
    const { projectRoot, project } = createProject();
    const original = openDatabase(projectRoot, project);
    original.exec('ALTER TABLE source_snapshot_sections DROP COLUMN parser_section_id');
    original.prepare(`
      INSERT INTO source_snapshots (project_id, source_root, snapshot_version, updated_at)
      VALUES (?, ?, 1, ?)
    `).run(project.id, 'C:/sources', project.updated_at);
    original.prepare(`
      INSERT INTO source_snapshot_files (project_id, source_root, source_id, path, content_hash)
      VALUES (?, ?, ?, ?, ?)
    `).run(project.id, 'C:/sources', 'source-1', 'notes.md', 'a'.repeat(64));
    original.prepare(`
      INSERT INTO source_snapshot_sections (project_id, source_root, source_id, section_id, content_hash)
      VALUES (?, ?, ?, ?, ?)
    `).run(project.id, 'C:/sources', 'source-1', 'stable-section', 'b'.repeat(64));
    original.exec('DROP TABLE document_embeddings; DROP TABLE project_embedding_metadata;');
    original.pragma('user_version = 3');
    original.close();

    const migrated = openDatabase(projectRoot, project);
    try {
      expect(migrated.pragma('user_version', { simple: true })).toBe(PROJECT_DATABASE_SCHEMA_VERSION);
      expect(migrated.prepare(`
        SELECT section_id, parser_section_id, content_hash FROM source_snapshot_sections
      `).get()).toEqual({
        section_id: 'stable-section',
        parser_section_id: null,
        content_hash: 'b'.repeat(64),
      });
    } finally {
      migrated.close();
    }
  });

  it('migrates version 4 indexes to embedding storage without changing documents', () => {
    const { projectRoot, project } = createProject();
    const original = openDatabase(projectRoot, project);
    original.prepare(`
      INSERT INTO documents (
        id, project_id, path, title, category_id, depth, content_hash,
        status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'existing-doc', project.id, 'notes.md', 'Notes', null, 1,
      'hash', 'verified', project.created_at, project.updated_at,
    );
    original.exec(`
      DROP TABLE document_embeddings;
      DROP TABLE project_embedding_metadata;
    `);
    original.pragma(`user_version = ${EMBEDDING_SCHEMA_PREVIOUS_VERSION}`);
    original.close();

    const migrated = openDatabase(projectRoot, project);
    try {
      expect(migrated.pragma('user_version', { simple: true })).toBe(
        PROJECT_DATABASE_SCHEMA_VERSION,
      );
      expect(migrated.prepare('SELECT id, path FROM documents').get()).toEqual({
        id: 'existing-doc',
        path: 'notes.md',
      });
      expect(migrated.prepare("SELECT name FROM sqlite_schema WHERE name = 'document_embeddings'").get())
        .toEqual({ name: 'document_embeddings' });
    } finally {
      migrated.close();
    }
  });

  it('rolls back embedding storage while preserving version 4 project data', () => {
    const { projectRoot, project } = createProject();
    const database = openDatabase(projectRoot, project);
    database.prepare(`
      INSERT INTO documents (
        id, project_id, path, title, category_id, depth, content_hash,
        status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'existing-doc', project.id, 'notes.md', 'Notes', null, 1,
      'hash', 'verified', project.created_at, project.updated_at,
    );
    database.prepare(`
      INSERT INTO project_embedding_metadata (project_id, provider_id, model, dimensions, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(project.id, 'openai', 'embed-test', 2, project.updated_at);
    database.prepare(`
      INSERT INTO document_embeddings (
        project_id, document_id, kind, section_id, source_hash, model, dimensions, vector_json
      ) VALUES (?, ?, 'document', '', ?, ?, 2, ?)
    `).run(project.id, 'existing-doc', 'a'.repeat(64), 'embed-test', '[0.1,0.2]');

    rollbackEmbeddingSchemaMigration(database);

    expect(database.pragma('user_version', { simple: true })).toBe(
      EMBEDDING_SCHEMA_PREVIOUS_VERSION,
    );
    expect(database.prepare('SELECT id, path FROM documents').get()).toEqual({
      id: 'existing-doc',
      path: 'notes.md',
    });
    expect(database.prepare("SELECT name FROM sqlite_schema WHERE name = 'document_embeddings'").get())
      .toBeUndefined();
    expect(database.prepare("SELECT name FROM sqlite_schema WHERE name = 'project_embedding_metadata'").get())
      .toBeUndefined();
  });

  it('refuses to migrate version 4 indexes with conflicting embedding objects', () => {
    const { projectRoot, project } = createProject();
    const original = openDatabase(projectRoot, project);
    original.exec(`
      DROP TABLE document_embeddings;
      DROP TABLE project_embedding_metadata;
      CREATE TABLE document_embeddings (unexpected TEXT);
    `);
    original.pragma(`user_version = ${EMBEDDING_SCHEMA_PREVIOUS_VERSION}`);
    original.close();

    expect(() => openProjectDatabase(projectRoot, project)).toThrow(
      /contains conflicting embedding objects; refusing to migrate it\./,
    );
    const unchanged = new Database(resolveProjectDatabasePath(projectRoot), { readonly: true });
    try {
      expect(unchanged.pragma('user_version', { simple: true })).toBe(
        EMBEDDING_SCHEMA_PREVIOUS_VERSION,
      );
      expect(unchanged.prepare("SELECT sql FROM sqlite_schema WHERE name = 'document_embeddings'").get())
        .toEqual({ sql: 'CREATE TABLE document_embeddings (unexpected TEXT)' });
    } finally {
      unchanged.close();
    }
  });

  it('rolls back the version 5 schema when migration completion fails', () => {
    const { projectRoot, project } = createProject();
    const original = openDatabase(projectRoot, project);
    original.prepare(`
      INSERT INTO documents (
        id, project_id, path, title, category_id, depth, content_hash,
        status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'preserved-doc', project.id, 'existing.md', 'Existing', null, 1,
      'hash', 'verified', project.created_at, project.updated_at,
    );
    original.exec(`
      DROP TABLE document_embeddings;
      DROP TABLE project_embedding_metadata;
      CREATE TRIGGER reject_project_update
      BEFORE UPDATE ON projects
      BEGIN
        SELECT RAISE(ABORT, 'injected migration failure');
      END;
    `);
    original.pragma(`user_version = ${EMBEDDING_SCHEMA_PREVIOUS_VERSION}`);
    original.close();

    expect(() => openProjectDatabase(projectRoot, project)).toThrow(ConfigurationError);
    const unchanged = new Database(resolveProjectDatabasePath(projectRoot), { readonly: true });
    try {
      expect(unchanged.pragma('user_version', { simple: true })).toBe(
        EMBEDDING_SCHEMA_PREVIOUS_VERSION,
      );
      expect(unchanged.prepare('SELECT id, path FROM documents').get()).toEqual({
        id: 'preserved-doc',
        path: 'existing.md',
      });
      expect(unchanged.prepare("SELECT name FROM sqlite_schema WHERE name = 'document_embeddings'").get())
        .toBeUndefined();
      expect(unchanged.prepare("SELECT name FROM sqlite_schema WHERE name = 'project_embedding_metadata'").get())
        .toBeUndefined();
    } finally {
      unchanged.close();
    }
  });

  it('refuses to promote a version 2 database with conflicting snapshot objects', () => {
    const { projectRoot, project } = createProject();
    const original = openDatabase(projectRoot, project);
    original.exec(`
      DROP TABLE source_snapshot_sections;
      DROP TABLE source_snapshot_files;
      DROP TABLE source_snapshots;
      CREATE TABLE source_snapshots (unexpected TEXT);
    `);
    original.pragma('user_version = 2');
    original.close();

    expect(() => openDatabase(projectRoot, project)).toThrow(
      'The version 2 project database contains conflicting source snapshot objects; refusing to migrate it.',
    );

    const unchanged = new Database(resolveProjectDatabasePath(projectRoot));
    try {
      expect(unchanged.pragma('user_version', { simple: true })).toBe(2);
      expect(unchanged.prepare("SELECT sql FROM sqlite_schema WHERE name = 'source_snapshots'").get())
        .toEqual({ sql: 'CREATE TABLE source_snapshots (unexpected TEXT)' });
    } finally {
      unchanged.close();
    }
  });

  it('refuses conflicting FTS objects without promoting a version 1 database', () => {
    const { projectRoot, project } = createProject();
    const original = openDatabase(projectRoot, project);
    original.prepare(`
      INSERT INTO documents (
        id, project_id, path, title, category_id, depth, content_hash,
        status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'preserved-doc', project.id, 'preserved.md', 'Preserved', null, 1,
      'hash', 'verified', project.created_at, project.updated_at,
    );
    original.exec('DROP TABLE document_fts; CREATE TABLE document_fts (legacy TEXT)');
    original.prepare('INSERT INTO document_fts (legacy) VALUES (?)').run('preserve me');
    original.pragma('user_version = 1');
    original.close();

    expect(() => openProjectDatabase(projectRoot, project)).toThrow(ConfigurationError);
    const unchanged = new Database(resolveProjectDatabasePath(projectRoot), { readonly: true });
    expect(unchanged.pragma('user_version', { simple: true })).toBe(1);
    expect(unchanged.prepare('SELECT id FROM documents').get()).toEqual({ id: 'preserved-doc' });
    expect(unchanged.prepare('SELECT legacy FROM document_fts').get()).toEqual({
      legacy: 'preserve me',
    });
    unchanged.close();
  });

  it('rejects a database schema version newer than the application supports', () => {
    const { projectRoot, project } = createProject();
    const indexPath = join(projectRoot, 'index');
    mkdirSync(indexPath);
    const path = resolveProjectDatabasePath(projectRoot);
    const database = new Database(path);
    database.pragma(`user_version = ${PROJECT_DATABASE_SCHEMA_VERSION + 1}`);
    database.close();

    expect(() => openProjectDatabase(projectRoot, project)).toThrow(ConfigurationError);
    const unchanged = new Database(path, { readonly: true });
    expect(unchanged.pragma('user_version', { simple: true })).toBe(
      PROJECT_DATABASE_SCHEMA_VERSION + 1,
    );
    unchanged.close();
  });

  it('preserves and rejects a partial unversioned schema', () => {
    const { projectRoot, project } = createProject();
    const indexPath = join(projectRoot, 'index');
    mkdirSync(indexPath);
    const path = resolveProjectDatabasePath(projectRoot);
    const partial = new Database(path);
    partial.exec(`
      CREATE TABLE documents (id TEXT PRIMARY KEY, title TEXT);
      INSERT INTO documents (id, title) VALUES ('existing', 'Preserve me');
    `);
    partial.close();

    expect(() => openProjectDatabase(projectRoot, project)).toThrow(ConfigurationError);

    const unchanged = new Database(path, { readonly: true });
    expect(unchanged.pragma('user_version', { simple: true })).toBe(0);
    expect(unchanged.prepare('SELECT id, title FROM documents').get()).toEqual({
      id: 'existing',
      title: 'Preserve me',
    });
    unchanged.close();
  });

  it('rejects invalid index and database paths without following them', () => {
    const first = createProject();
    const indexPath = join(first.projectRoot, 'index');
    writeFileSync(indexPath, 'occupied');
    expect(() => openProjectDatabase(first.projectRoot, first.project)).toThrow(InputError);

    const second = createProject();
    const databasePath = resolveProjectDatabasePath(second.projectRoot);
    mkdirSync(join(second.projectRoot, 'index'));
    mkdirSync(databasePath);
    expect(() => openProjectDatabase(second.projectRoot, second.project)).toThrow(InputError);
  });
});

function createProject() {
  const dataRoot = realpathSync(mkdtempSync(join(tmpdir(), 'qlm-database-')));
  temporaryDirectories.push(dataRoot);
  const project = initializeProject(dataRoot, 'demo');
  return {
    dataRoot,
    project,
    projectRoot: join(dataRoot, 'projects', project.name),
  };
}

function openDatabase(projectRoot: string, project: ReturnType<typeof initializeProject>) {
  const database = openProjectDatabase(projectRoot, project);
  openDatabases.push(database);
  return database;
}
