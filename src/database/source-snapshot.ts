import { lstatSync } from 'node:fs';
import { resolve } from 'node:path';
import { ConfigurationError } from '../config/error.js';
import { QLMError } from '../errors/qlm-error.js';
import type { ProjectMetadata } from '../projects/schema.js';
import {
  openProjectDatabase,
  resolveProjectDatabasePath,
} from './database.js';

export const SOURCE_SNAPSHOT_VERSION = 1;

export interface SourceSnapshotFile {
  sourceId: string;
  path: string;
  contentHash: string;
}

export interface SourceSnapshotSection {
  sourceId: string;
  sectionId: string;
  contentHash: string;
}

export interface ProjectSourceSnapshot {
  sourceRoot: string;
  files: SourceSnapshotFile[];
  sections: SourceSnapshotSection[];
}

interface SnapshotVersionRow {
  snapshot_version: number;
}

interface SnapshotFileRow {
  source_id: string;
  path: string;
  content_hash: string;
}

interface SnapshotSectionRow {
  source_id: string;
  section_id: string;
  content_hash: string;
}

/** Read a prior snapshot without creating or changing the project index. */
export function readProjectSourceSnapshot(
  projectRoot: string,
  project: ProjectMetadata,
  sourceRoot: string,
): ProjectSourceSnapshot | undefined {
  try {
    lstatSync(resolveProjectDatabasePath(projectRoot));
  } catch (cause) {
    if (isMissingPath(cause)) return undefined;
    throw cause;
  }

  // Opening the writable handle performs additive schema migrations for older
  // project databases before the new snapshot tables are queried.
  const database = openProjectDatabase(projectRoot, project);
  try {
    const snapshot = database
      .prepare(`
        SELECT snapshot_version
        FROM source_snapshots
        WHERE project_id = ? AND source_root = ?
      `)
      .get(project.id, sourceRoot) as SnapshotVersionRow | undefined;
    if (snapshot === undefined) return undefined;
    if (snapshot.snapshot_version !== SOURCE_SNAPSHOT_VERSION) {
      throw new ConfigurationError(
        `The source snapshot version ${snapshot.snapshot_version} is not supported.`,
        {
          filePath: database.name,
          suggestedAction: 'Run a project build with a version that supports this snapshot.',
        },
      );
    }

    const files = database
      .prepare(`
        SELECT source_id, path, content_hash
        FROM source_snapshot_files
        WHERE project_id = ? AND source_root = ?
        ORDER BY path, source_id
      `)
      .all(project.id, sourceRoot) as SnapshotFileRow[];
    const sections = database
      .prepare(`
        SELECT source_id, section_id, content_hash
        FROM source_snapshot_sections
        WHERE project_id = ? AND source_root = ?
        ORDER BY source_id, section_id
      `)
      .all(project.id, sourceRoot) as SnapshotSectionRow[];

    return {
      sourceRoot,
      files: files.map(({ source_id, path, content_hash }) => ({
        sourceId: source_id,
        path,
        contentHash: content_hash,
      })),
      sections: sections.map(({ source_id, section_id, content_hash }) => ({
        sourceId: source_id,
        sectionId: section_id,
        contentHash: content_hash,
      })),
    };
  } finally {
    database.close();
  }
}

/** Replace one source-root snapshot and all of its hashes in one SQLite transaction. */
export function replaceProjectSourceSnapshot(
  projectRoot: string,
  project: ProjectMetadata,
  snapshot: ProjectSourceSnapshot,
  updatedAt = new Date().toISOString(),
): void {
  const database = openProjectDatabase(projectRoot, project);
  try {
    const replace = database.transaction(() => {
      database
        .prepare('DELETE FROM source_snapshots WHERE project_id = ? AND source_root = ?')
        .run(project.id, snapshot.sourceRoot);
      database
        .prepare(`
          INSERT INTO source_snapshots (project_id, source_root, snapshot_version, updated_at)
          VALUES (?, ?, ?, ?)
        `)
        .run(project.id, snapshot.sourceRoot, SOURCE_SNAPSHOT_VERSION, updatedAt);

      const insertFile = database.prepare(`
        INSERT INTO source_snapshot_files (
          project_id, source_root, source_id, path, content_hash
        ) VALUES (?, ?, ?, ?, ?)
      `);
      for (const file of snapshot.files) {
        insertFile.run(
          project.id,
          snapshot.sourceRoot,
          file.sourceId,
          file.path,
          file.contentHash,
        );
      }

      const insertSection = database.prepare(`
        INSERT INTO source_snapshot_sections (
          project_id, source_root, source_id, section_id, content_hash
        ) VALUES (?, ?, ?, ?, ?)
      `);
      for (const section of snapshot.sections) {
        insertSection.run(
          project.id,
          snapshot.sourceRoot,
          section.sourceId,
          section.sectionId,
          section.contentHash,
        );
      }
    });
    replace();
  } catch (cause) {
    if (cause instanceof QLMError) throw cause;
    throw new ConfigurationError('Unable to replace the project source snapshot.', {
      filePath: database.name,
      cause,
      suggestedAction: 'Check the project index and retry the build.',
    });
  } finally {
    database.close();
  }
}

function isMissingPath(cause: unknown): boolean {
  return (
    typeof cause === 'object' &&
    cause !== null &&
    'code' in cause &&
    cause.code === 'ENOENT'
  );
}
