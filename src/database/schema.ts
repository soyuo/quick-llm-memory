import type Database from 'better-sqlite3';
import { ConfigurationError } from '../config/error.js';
import type { ProjectMetadata } from '../projects/schema.js';

export const PROJECT_DATABASE_SCHEMA_VERSION = 5;
export const EMBEDDING_SCHEMA_PREVIOUS_VERSION = 4;

export function initializeProjectDatabaseSchema(
  database: Database.Database,
  projectRoot: string,
  project: ProjectMetadata,
): void {
  const currentVersion = database.pragma('user_version', { simple: true });
  if (
    typeof currentVersion !== 'number' ||
    !Number.isInteger(currentVersion) ||
    currentVersion < 0
  ) {
    throw new ConfigurationError('The project database has an invalid schema version.', {
      filePath: database.name,
    });
  }

  if (currentVersion > PROJECT_DATABASE_SCHEMA_VERSION) {
    throw new ConfigurationError(
      `The project database schema version ${currentVersion} is newer than this application supports (${PROJECT_DATABASE_SCHEMA_VERSION}).`,
      {
        filePath: database.name,
        suggestedAction: 'Upgrade quick-llm-memory to a version that supports this database schema.',
      },
    );
  }

  if (currentVersion === 0) {
    const existingSchemaObjects = database
      .prepare(`
        SELECT name
        FROM sqlite_schema
        WHERE name NOT LIKE 'sqlite_%'
        ORDER BY name
      `)
      .pluck()
      .all();

    if (existingSchemaObjects.length > 0) {
      throw new ConfigurationError(
        'The unversioned project database already contains schema objects; refusing to promote it.',
        {
          filePath: database.name,
          suggestedAction:
            'Back up the database and inspect its schema before initializing it with this application.',
        },
      );
    }
  }

  if (currentVersion < 2) {
    const conflictingFtsObjects = database
      .prepare(`
        SELECT name
        FROM sqlite_schema
        WHERE name = 'document_fts' OR name GLOB 'document_fts_*'
        ORDER BY name
      `)
      .pluck()
      .all();
    if (conflictingFtsObjects.length > 0) {
      throw new ConfigurationError(
        'The project database contains conflicting full-text index objects; refusing to migrate it.',
        {
          filePath: database.name,
          suggestedAction:
            'Back up the database and inspect its document_fts objects before retrying the migration.',
        },
      );
    }
  } else {
    const ftsSchema = database
      .prepare("SELECT sql FROM sqlite_schema WHERE name = 'document_fts'")
      .get() as { sql: string | null } | undefined;
    if (ftsSchema?.sql === null || !/\bUSING\s+fts5\s*\(/i.test(ftsSchema?.sql ?? '')) {
      throw new ConfigurationError('The project database has no valid FTS5 index.', {
        filePath: database.name,
        suggestedAction: 'Run qlm reindex to rebuild the project database.',
      });
    }
  }

  if (currentVersion === 2) {
    const conflictingSnapshotObjects = database
      .prepare(`
        SELECT name
        FROM sqlite_schema
        WHERE name GLOB 'source_snapshot*'
        ORDER BY name
      `)
      .pluck()
      .all();
    if (conflictingSnapshotObjects.length > 0) {
      throw new ConfigurationError(
        'The version 2 project database contains conflicting source snapshot objects; refusing to migrate it.',
        {
          filePath: database.name,
          suggestedAction:
            'Back up the database and inspect its source_snapshot objects before retrying the migration.',
        },
      );
    }
  }

  if (currentVersion < PROJECT_DATABASE_SCHEMA_VERSION) {
    const conflictingEmbeddingObjects = database
      .prepare(`
        SELECT name
        FROM sqlite_schema
        WHERE name IN ('project_embedding_metadata', 'document_embeddings')
        ORDER BY name
      `)
      .pluck()
      .all();
    if (conflictingEmbeddingObjects.length > 0) {
      throw new ConfigurationError(
        `The version ${currentVersion} project database contains conflicting embedding objects; refusing to migrate it.`,
        {
          filePath: database.name,
          suggestedAction:
            'Back up the database and inspect its embedding objects before retrying the migration.',
        },
      );
    }
  } else {
    assertEmbeddingSchema(database);
  }

  const migrate = database.transaction(() => {
    database.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        root_path TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS documents (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        path TEXT NOT NULL,
        title TEXT NOT NULL,
        category_id TEXT,
        depth INTEGER NOT NULL,
        content_hash TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(project_id, path),
        FOREIGN KEY(project_id) REFERENCES projects(id)
      );

      CREATE TABLE IF NOT EXISTS categories (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        parent_id TEXT,
        name TEXT NOT NULL,
        path TEXT NOT NULL,
        depth INTEGER NOT NULL,
        FOREIGN KEY(project_id) REFERENCES projects(id),
        FOREIGN KEY(parent_id) REFERENCES categories(id)
      );

      CREATE TABLE IF NOT EXISTS document_relations (
        source_id TEXT NOT NULL,
        target_id TEXT NOT NULL,
        relation_type TEXT NOT NULL,
        PRIMARY KEY (source_id, target_id, relation_type)
      );

      CREATE TABLE IF NOT EXISTS source_snapshots (
        project_id TEXT NOT NULL,
        source_root TEXT NOT NULL,
        snapshot_version INTEGER NOT NULL CHECK (snapshot_version = 1),
        updated_at TEXT NOT NULL,
        PRIMARY KEY (project_id, source_root),
        FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS source_snapshot_files (
        project_id TEXT NOT NULL,
        source_root TEXT NOT NULL,
        source_id TEXT NOT NULL,
        path TEXT NOT NULL,
        content_hash TEXT NOT NULL CHECK (
          length(content_hash) = 64 AND content_hash NOT GLOB '*[^0-9a-f]*'
        ),
        PRIMARY KEY (project_id, source_root, source_id),
        FOREIGN KEY(project_id, source_root)
          REFERENCES source_snapshots(project_id, source_root) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS source_snapshot_sections (
        project_id TEXT NOT NULL,
        source_root TEXT NOT NULL,
        source_id TEXT NOT NULL,
        section_id TEXT NOT NULL,
        parser_section_id TEXT,
        content_hash TEXT NOT NULL CHECK (
          length(content_hash) = 64 AND content_hash NOT GLOB '*[^0-9a-f]*'
        ),
        PRIMARY KEY (project_id, source_root, section_id),
        FOREIGN KEY(project_id, source_root, source_id)
          REFERENCES source_snapshot_files(project_id, source_root, source_id) ON DELETE CASCADE
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS document_fts USING fts5(
        document_id UNINDEXED,
        title,
        path,
        tags,
        description,
        content
      );
    `);

    if (currentVersion < 4) {
      const sectionColumns = database
        .prepare("PRAGMA table_info('source_snapshot_sections')")
        .all() as Array<{ name: string }>;
      if (!sectionColumns.some(({ name }) => name === 'parser_section_id')) {
        database.exec('ALTER TABLE source_snapshot_sections ADD COLUMN parser_section_id TEXT');
      }
    }

    if (currentVersion < PROJECT_DATABASE_SCHEMA_VERSION) {
      database.exec(`
        CREATE TABLE project_embedding_metadata (
          project_id TEXT PRIMARY KEY,
          provider_id TEXT NOT NULL,
          model TEXT NOT NULL,
          dimensions INTEGER NOT NULL CHECK (dimensions > 0),
          updated_at TEXT NOT NULL,
          FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
        );

        CREATE TABLE document_embeddings (
          project_id TEXT NOT NULL,
          document_id TEXT NOT NULL,
          kind TEXT NOT NULL CHECK (kind IN ('document', 'section')),
          section_id TEXT NOT NULL,
          source_hash TEXT NOT NULL CHECK (
            length(source_hash) = 64 AND source_hash NOT GLOB '*[^0-9a-f]*'
          ),
          model TEXT NOT NULL,
          dimensions INTEGER NOT NULL CHECK (dimensions > 0),
          vector_json TEXT NOT NULL CHECK (length(vector_json) > 2),
          PRIMARY KEY (project_id, document_id, kind, section_id),
          CHECK (
            (kind = 'document' AND section_id = '') OR
            (kind = 'section' AND length(section_id) > 0)
          ),
          FOREIGN KEY(project_id)
            REFERENCES project_embedding_metadata(project_id) ON DELETE CASCADE,
          FOREIGN KEY(document_id) REFERENCES documents(id) ON DELETE CASCADE
        );
      `);
    }

    if (currentVersion < PROJECT_DATABASE_SCHEMA_VERSION) {
      database.pragma(`user_version = ${PROJECT_DATABASE_SCHEMA_VERSION}`);
    }

    database
      .prepare(`
        INSERT INTO projects (id, name, root_path, created_at, updated_at)
        VALUES (@id, @name, @rootPath, @createdAt, @updatedAt)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          root_path = excluded.root_path,
          updated_at = excluded.updated_at
      `)
      .run({
        id: project.id,
        name: project.name,
        rootPath: projectRoot,
        createdAt: project.created_at,
        updatedAt: project.updated_at,
      });
  });

  migrate();
}

/**
 * Roll back only the additive embedding migration. Embeddings are derived data;
 * dropping them restores the version 4 schema without changing project content.
 */
export function rollbackEmbeddingSchemaMigration(database: Database.Database): void {
  const currentVersion = database.pragma('user_version', { simple: true });
  if (currentVersion !== PROJECT_DATABASE_SCHEMA_VERSION) {
    throw new ConfigurationError(
      `Cannot roll back embedding storage from schema version ${String(currentVersion)}.`,
      { filePath: database.name },
    );
  }
  assertEmbeddingSchema(database);

  const rollback = database.transaction(() => {
    database.exec(`
      DROP TABLE document_embeddings;
      DROP TABLE project_embedding_metadata;
    `);
    database.pragma(`user_version = ${EMBEDDING_SCHEMA_PREVIOUS_VERSION}`);
  });
  rollback();
}

function assertEmbeddingSchema(database: Database.Database): void {
  const requiredColumns = {
    project_embedding_metadata: [
      'project_id', 'provider_id', 'model', 'dimensions', 'updated_at',
    ],
    document_embeddings: [
      'project_id', 'document_id', 'kind', 'section_id', 'source_hash',
      'model', 'dimensions', 'vector_json',
    ],
  } as const;

  for (const [table, required] of Object.entries(requiredColumns)) {
    const object = database
      .prepare('SELECT type FROM sqlite_schema WHERE name = ?')
      .get(table) as { type: string } | undefined;
    const columns = database.prepare(`PRAGMA table_info('${table}')`).all() as Array<{
      name: string;
    }>;
    if (
      object?.type !== 'table' ||
      required.some((column) => !columns.some(({ name }) => name === column))
    ) {
      throw new ConfigurationError(
        'The project database has an invalid embedding schema.',
        {
          filePath: database.name,
          suggestedAction: 'Back up the database and run qlm reindex to repair its schema.',
        },
      );
    }
  }
}
