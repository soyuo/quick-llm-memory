import Database from 'better-sqlite3';
import { lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { ConfigurationError } from '../config/error.js';
import { InputError, InternalError, QLMError } from '../errors/qlm-error.js';
import type { ProjectMetadata } from '../projects/schema.js';
import { initializeProjectDatabaseSchema } from './schema.js';

const INDEX_DIRECTORY = 'index';
const DATABASE_FILE = 'knowledge.db';

export function resolveProjectDatabasePath(projectRoot: string): string {
  return join(
    resolveExistingProjectRoot(projectRoot),
    INDEX_DIRECTORY,
    DATABASE_FILE,
  );
}

export function openProjectDatabase(
  projectRoot: string,
  project: ProjectMetadata,
): Database.Database {
  const canonicalProjectRoot = resolveExistingProjectRoot(projectRoot);
  if (basename(canonicalProjectRoot) !== project.name) {
    throw new InputError('The project directory name does not match its metadata.', {
      suggestedAction: 'Open the database from the initialized project directory.',
    });
  }

  const indexPath = ensureIndexDirectory(canonicalProjectRoot);
  const databasePath = join(indexPath, DATABASE_FILE);
  assertRegularDatabaseFile(databasePath);

  let database: Database.Database | undefined;
  try {
    database = new Database(databasePath);
    database.pragma('foreign_keys = ON');
    if (database.pragma('foreign_keys', { simple: true }) !== 1) {
      throw new InternalError('SQLite foreign-key enforcement could not be enabled.', {
        suggestedAction: 'Check that the SQLite database is writable and try again.',
      });
    }

    initializeProjectDatabaseSchema(database, canonicalProjectRoot, project);
    return database;
  } catch (cause) {
    if (database?.open) {
      try {
        database.close();
      } catch {
        // Preserve the original initialization error.
      }
    }
    if (cause instanceof QLMError) {
      throw cause;
    }
    throw new ConfigurationError('Unable to open or initialize the project database.', {
      filePath: databasePath,
      cause,
      suggestedAction: 'Check that the project database is accessible and not corrupted.',
    });
  }
}

function resolveExistingProjectRoot(projectRoot: string): string {
  const absolutePath = resolve(projectRoot);
  try {
    const info = lstatSync(absolutePath);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new InputError(`The project root is not a regular directory: ${absolutePath}`, {
        suggestedAction: 'Use an initialized project directory that is not a symbolic link.',
      });
    }
    return realpathSync(absolutePath);
  } catch (cause) {
    if (cause instanceof QLMError) {
      throw cause;
    }
    throw new ConfigurationError('Unable to access the project directory.', {
      filePath: absolutePath,
      cause,
      suggestedAction: 'Check that the project directory exists and is accessible.',
    });
  }
}

function ensureIndexDirectory(projectRoot: string): string {
  const indexPath = join(projectRoot, INDEX_DIRECTORY);
  try {
    mkdirSync(indexPath);
  } catch (cause) {
    if (!isAlreadyExistsError(cause)) {
      throw new InternalError('Unable to create the project index directory.', {
        cause,
        suggestedAction: 'Check that the project directory is writable.',
      });
    }
  }

  try {
    const info = lstatSync(indexPath);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new InputError(`The project index path is not a regular directory: ${indexPath}`, {
        suggestedAction: 'Remove the invalid index path and retry database initialization.',
      });
    }
  } catch (cause) {
    if (cause instanceof QLMError) {
      throw cause;
    }
    throw new ConfigurationError('Unable to access the project index directory.', {
      filePath: indexPath,
      cause,
      suggestedAction: 'Check that the project index directory is accessible.',
    });
  }

  return indexPath;
}

function assertRegularDatabaseFile(databasePath: string): void {
  try {
    const info = lstatSync(databasePath);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new InputError(`The project database path is not a regular file: ${databasePath}`, {
        suggestedAction: 'Remove the invalid database path and retry initialization.',
      });
    }
  } catch (cause) {
    if (!isMissingPathError(cause)) {
      throw cause;
    }
  }
}

function isAlreadyExistsError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === 'EEXIST';
}

function isMissingPathError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
