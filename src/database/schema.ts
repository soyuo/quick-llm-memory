import type Database from 'better-sqlite3';
import { ConfigurationError } from '../config/error.js';
import type { ProjectMetadata } from '../projects/schema.js';

export const PROJECT_DATABASE_SCHEMA_VERSION = 1;

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
    `);

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
