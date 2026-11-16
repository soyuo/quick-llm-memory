import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { constants, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { InputError, InternalError, QLMError } from '../errors/qlm-error.js';
import { listProjects } from './manager.js';
import { projectMetadataSchema, validateProjectName, type ProjectMetadata } from './schema.js';

const PROJECTS_DIRECTORY = 'projects';
const PROJECT_METADATA_FILE = 'project.yaml';
const packageRoot = findPackageRoot(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(join(packageRoot, 'package.json'));
const { renameNoReplace } = require('./build/Release/qlm_rename_noreplace.node') as {
  renameNoReplace(source: string, destination: string): void;
};

export type ProjectTransferOperation = 'import' | 'export';
export type ProjectTransferPhase = 'validating' | 'copying' | 'committing';

export interface ProjectTransferProgress {
  operation: ProjectTransferOperation;
  phase: ProjectTransferPhase;
  completedFiles: number;
  totalFiles: number;
}

export interface ProjectTransferOptions {
  signal?: AbortSignal;
  onProgress?: (progress: ProjectTransferProgress) => void;
}

export async function inspectProjectBundle(sourcePath: string): Promise<ProjectMetadata> {
  const sourceDirectory = resolve(sourcePath);
  const metadata = await readBundleMetadata(sourceDirectory);
  return metadata;
}

export async function importProject(
  dataRoot: string,
  sourcePath: string,
  name: string,
  options: ProjectTransferOptions = {},
): Promise<ProjectMetadata> {
  const projectName = validateProjectName(name);
  const sourceDirectory = resolve(sourcePath);
  const projectsDirectory = join(dataRoot, PROJECTS_DIRECTORY);
  let stageParent: string;
  let targetDirectory: string;
  let stageDirectory: string | undefined;
  report(options, 'import', 'validating', 0, 0);

  try {
    const sourceMetadata = await readBundleMetadata(sourceDirectory);
    await ensureRealDirectory(projectsDirectory, true);
    stageParent = await realpath(projectsDirectory);
    targetDirectory = join(stageParent, projectName);
    if (await pathExists(targetDirectory)) {
      throw new InputError('A project with that name already exists.', {
        suggestedAction: 'Choose another project name or remove the existing project first.',
      });
    }
    const entries = await scanProjectTree(sourceDirectory);
    checkCancelled(options.signal);
    stageDirectory = await mkdtemp(join(stageParent, '.qlm-import-'));
    const projectRoot = stageDirectory;
    await copyProjectTree(sourceDirectory, projectRoot, entries, 'import', options);

    const timestamp = new Date().toISOString();
    const importedMetadata = projectMetadataSchema.parse({
      ...sourceMetadata,
      id: randomUUID(),
      name: projectName,
      updated_at: timestamp,
    });
    await rebindProjectDatabase(
      projectRoot,
      sourceMetadata,
      importedMetadata,
      targetDirectory,
    );
    await writeFile(
      join(projectRoot, PROJECT_METADATA_FILE),
      stringifyYaml(importedMetadata),
      'utf8',
    );
    checkCancelled(options.signal);
    report(options, 'import', 'committing', entries.files.length, entries.files.length);
    await yieldToInput();
    checkCancelled(options.signal);
    if (await pathExists(targetDirectory)) {
      throw new InputError('A project with that name already exists.', {
        suggestedAction: 'Choose another project name or remove the existing project first.',
      });
    }
    renameNoReplace(projectRoot, targetDirectory);
    stageDirectory = undefined;
    return importedMetadata;
  } catch (error) {
    if (stageDirectory !== undefined) {
      await rm(stageDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
    if (hasErrorCode(error, 'EEXIST')) {
      throw new InputError('A project with that name already exists.', {
        suggestedAction: 'Choose another project name or remove the existing project first.',
      });
    }
    if (error instanceof QLMError) {
      throw error;
    }
    throw new InternalError('Project import failed; existing project data was preserved.', {
      cause: error,
      suggestedAction: 'Check the source directory and data directory permissions, then retry.',
    });
  }
}

export async function exportProject(
  dataRoot: string,
  projectName: string,
  destinationPath: string,
  options: ProjectTransferOptions = {},
): Promise<string> {
  const name = validateProjectName(projectName);
  const projectsDirectory = join(dataRoot, PROJECTS_DIRECTORY);
  await ensureRealDirectory(projectsDirectory, false);
  const project = listProjects(dataRoot).find(({ name: candidate }) => candidate === name);
  if (project === undefined) {
    throw new InputError('The selected project is unavailable.', {
      suggestedAction: 'Refresh the project list and choose an available project.',
    });
  }

  const sourceDirectory = join(await realpath(projectsDirectory), name);
  const requestedDestination = resolve(destinationPath);
  const destinationParent = dirname(requestedDestination);
  const destinationName = basename(requestedDestination);
  if (destinationName === '' || destinationName === '.' || destinationName === '..') {
    throw new InputError('Choose a new directory path for the export.');
  }

  let stageDirectory: string | undefined;
  report(options, 'export', 'validating', 0, 0);
  try {
    const sourceInfo = await lstat(sourceDirectory);
    if (sourceInfo.isSymbolicLink() || !sourceInfo.isDirectory()) {
      throw new InputError('The selected project directory is not a regular directory.');
    }
    const canonicalSource = await realpath(sourceDirectory);
    const canonicalParent = await realpath(destinationParent);
    const parentInfo = await lstat(canonicalParent);
    if (parentInfo.isSymbolicLink() || !parentInfo.isDirectory()) {
      throw new InputError('The export destination parent must be a regular directory.');
    }
    const destination = join(canonicalParent, destinationName);
    if (await pathExists(destination)) {
      throw new InputError('The export destination already exists.', {
        suggestedAction: 'Choose a new directory path; exports never overwrite existing files.',
      });
    }
    if (isWithin(canonicalSource, destination)) {
      throw new InputError('The export destination cannot be inside the selected project.');
    }

    const entries = await scanProjectTree(canonicalSource);
    checkCancelled(options.signal);
    stageDirectory = await mkdtemp(join(canonicalParent, `.${destinationName}.qlm-export-`));
    await copyProjectTree(canonicalSource, stageDirectory, entries, 'export', options);
    checkCancelled(options.signal);
    report(options, 'export', 'committing', entries.files.length, entries.files.length);
    await yieldToInput();
    checkCancelled(options.signal);
    if (await pathExists(destination)) {
      throw new InputError('The export destination already exists.', {
        suggestedAction: 'Choose a new directory path; exports never overwrite existing files.',
      });
    }
    renameNoReplace(stageDirectory, destination);
    stageDirectory = undefined;
    return destination;
  } catch (error) {
    if (stageDirectory !== undefined) {
      await rm(stageDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
    if (hasErrorCode(error, 'EEXIST')) {
      throw new InputError('The export destination already exists.', {
        suggestedAction: 'Choose a new directory path; exports never overwrite existing files.',
      });
    }
    if (error instanceof QLMError) {
      throw error;
    }
    throw new InternalError('Project export failed; existing project data was preserved.', {
      cause: error,
      suggestedAction: 'Check the destination directory and project permissions, then retry.',
    });
  }
}

interface ProjectTreeEntries {
  directories: string[];
  files: Array<{ path: string; dev: number; ino: number; mode: number }>;
}

async function readBundleMetadata(sourceDirectory: string): Promise<ProjectMetadata> {
  let rootInfo;
  try {
    rootInfo = await lstat(sourceDirectory);
  } catch {
    throw new InputError('The import source directory is unavailable.');
  }
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
    throw new InputError('The import source must be a regular project directory.');
  }

  const metadataPath = join(sourceDirectory, PROJECT_METADATA_FILE);
  let metadataInfo;
  try {
    metadataInfo = await lstat(metadataPath);
  } catch {
    throw new InputError('The import source does not contain readable project metadata.');
  }
  if (metadataInfo.isSymbolicLink() || !metadataInfo.isFile()) {
    throw new InputError('Project metadata must be a regular file.');
  }

  try {
    const parsed = parseYaml(await readFile(metadataPath, 'utf8')) as unknown;
    const result = projectMetadataSchema.safeParse(parsed);
    if (!result.success) {
      throw new InputError('The import source contains invalid project metadata.');
    }
    return result.data;
  } catch (error) {
    if (error instanceof QLMError) {
      throw error;
    }
    throw new InputError('The import source contains unreadable project metadata.');
  }
}

async function scanProjectTree(root: string): Promise<ProjectTreeEntries> {
  const entries: ProjectTreeEntries = { directories: [], files: [] };
  const visit = async (directory: string, relativeDirectory: string): Promise<void> => {
    const names = await readdir(directory);
    names.sort();
    for (const name of names) {
      const sourcePath = join(directory, name);
      const relativePath = relativeDirectory === '' ? name : join(relativeDirectory, name);
      const info = await lstat(sourcePath);
      if (info.isSymbolicLink()) {
        throw new InputError('Project folders containing symbolic links cannot be transferred.');
      }
      if (info.isDirectory()) {
        entries.directories.push(relativePath);
        await visit(sourcePath, relativePath);
      } else if (info.isFile()) {
        entries.files.push({
          path: relativePath,
          dev: info.dev,
          ino: info.ino,
          mode: info.mode,
        });
      } else {
        throw new InputError('Project folders may contain only regular files and directories.');
      }
    }
  };

  await visit(root, '');
  return entries;
}

async function copyProjectTree(
  sourceRoot: string,
  targetRoot: string,
  entries: ProjectTreeEntries,
  operation: ProjectTransferOperation,
  options: ProjectTransferOptions,
): Promise<void> {
  for (const directory of entries.directories) {
    checkCancelled(options.signal);
    await mkdir(join(targetRoot, directory));
  }

  report(options, operation, 'copying', 0, entries.files.length);
  let completedFiles = 0;
  for (const file of entries.files) {
    checkCancelled(options.signal);
    await copyRegularFileSafely(sourceRoot, targetRoot, file, options.signal);
    completedFiles += 1;
    report(options, operation, 'copying', completedFiles, entries.files.length);
  }
}

async function copyRegularFileSafely(
  sourceRoot: string,
  targetRoot: string,
  expected: ProjectTreeEntries['files'][number],
  signal: AbortSignal | undefined,
): Promise<void> {
  const sourcePath = join(sourceRoot, expected.path);
  const targetPath = join(targetRoot, expected.path);
  const rootInfo = await lstat(sourceRoot);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
    throw new InputError('The source project directory changed during transfer.');
  }
  const canonicalRoot = await realpath(sourceRoot);
  const parts = expected.path.split(sep);
  let currentPath = sourceRoot;
  let sourceInfo;

  for (let index = 0; index < parts.length; index += 1) {
    currentPath = join(currentPath, parts[index]!);
    const info = await lstat(currentPath);
    const last = index === parts.length - 1;
    if (info.isSymbolicLink() || (last ? !info.isFile() : !info.isDirectory())) {
      throw new InputError('A project entry changed or became unsafe during transfer.');
    }
    const canonicalPath = await realpath(currentPath);
    if (!isWithin(canonicalRoot, canonicalPath)) {
      throw new InputError('A project entry changed or escaped the validated source directory.');
    }
    if (last) {
      sourceInfo = info;
    }
  }

  if (
    sourceInfo === undefined ||
    sourceInfo.dev !== expected.dev ||
    sourceInfo.ino !== expected.ino
  ) {
    throw new InputError('A project file changed after transfer validation.');
  }

  let sourceHandle;
  let targetHandle;
  try {
    sourceHandle = await open(
      sourcePath,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    const openedInfo = await sourceHandle.stat();
    if (
      !openedInfo.isFile() ||
      openedInfo.dev !== expected.dev ||
      openedInfo.ino !== expected.ino
    ) {
      throw new InputError('A project file changed while it was being transferred.');
    }
    targetHandle = await open(targetPath, 'wx', expected.mode & 0o777);
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    while (true) {
      checkCancelled(signal);
      const { bytesRead } = await sourceHandle.read(
        buffer,
        0,
        buffer.length,
        position,
      );
      if (bytesRead === 0) {
        break;
      }
      let written = 0;
      while (written < bytesRead) {
        const result = await targetHandle.write(
          buffer,
          written,
          bytesRead - written,
          position + written,
        );
        written += result.bytesWritten;
      }
      position += bytesRead;
    }
    await targetHandle.sync();
    await chmod(targetPath, expected.mode & 0o777);
  } catch (error) {
    await unlink(targetPath).catch(() => undefined);
    if (error instanceof QLMError) {
      throw error;
    }
    throw new InputError('A project file could not be copied safely.');
  } finally {
    await sourceHandle?.close().catch(() => undefined);
    await targetHandle?.close().catch(() => undefined);
  }
}

async function rebindProjectDatabase(
  projectRoot: string,
  sourceMetadata: ProjectMetadata,
  importedMetadata: ProjectMetadata,
  importedProjectRoot: string,
): Promise<void> {
  const databasePath = join(projectRoot, 'index', 'knowledge.db');
  if (!(await pathExists(databasePath))) {
    return;
  }

  let database: Database.Database | undefined;
  try {
    database = new Database(databasePath);
    database.pragma('foreign_keys = ON');
    const project = database
      .prepare('SELECT id, created_at FROM projects WHERE id = ?')
      .get(sourceMetadata.id) as { id: string; created_at: string } | undefined;
    if (project !== undefined) {
      const transaction = database.transaction(() => {
        database?.prepare(`
          INSERT INTO projects (id, name, root_path, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?)
        `).run(
          importedMetadata.id,
          importedMetadata.name,
          importedProjectRoot,
          project.created_at,
          importedMetadata.updated_at,
        );
        database?.prepare('UPDATE documents SET project_id = ? WHERE project_id = ?')
          .run(importedMetadata.id, sourceMetadata.id);
        database?.prepare('UPDATE categories SET project_id = ? WHERE project_id = ?')
          .run(importedMetadata.id, sourceMetadata.id);
        database?.prepare('DELETE FROM projects WHERE id = ?').run(sourceMetadata.id);
      });
      transaction();
    } else {
      const orphanedRows = database.prepare(`
        SELECT
          (SELECT COUNT(*) FROM documents WHERE project_id = ?) +
          (SELECT COUNT(*) FROM categories WHERE project_id = ?) AS count
      `).get(sourceMetadata.id, sourceMetadata.id) as { count: number };
      if (orphanedRows.count > 0) {
        throw new InputError('The project index does not match its project metadata.');
      }
    }

    const violations = database.pragma('foreign_key_check') as unknown[];
    if (violations.length > 0) {
      throw new InputError('The project index contains invalid references and cannot be imported.');
    }
  } catch (error) {
    if (error instanceof QLMError) {
      throw error;
    }
    throw new InputError('The project index is invalid or incompatible and cannot be imported.');
  } finally {
    database?.close();
  }
}

async function ensureRealDirectory(path: string, create: boolean): Promise<void> {
  if (create) {
    await mkdir(path, { recursive: true });
  }
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new InputError('The managed projects path must be a regular directory.');
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

function isWithin(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === '' || (
    pathFromRoot !== '..' &&
    !pathFromRoot.startsWith(`..${sep}`) &&
    !isAbsolute(pathFromRoot)
  );
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

function findPackageRoot(startDirectory: string): string {
  let currentDirectory = startDirectory;
  while (true) {
    if (existsSync(join(currentDirectory, 'package.json'))) {
      return currentDirectory;
    }
    const parentDirectory = dirname(currentDirectory);
    if (parentDirectory === currentDirectory) {
      throw new Error('Could not locate the quick-llm-memory package root.');
    }
    currentDirectory = parentDirectory;
  }
}

function checkCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new InputError('Project transfer was cancelled before it changed the destination.');
  }
}

function report(
  options: ProjectTransferOptions,
  operation: ProjectTransferOperation,
  phase: ProjectTransferPhase,
  completedFiles: number,
  totalFiles: number,
): void {
  options.onProgress?.({ operation, phase, completedFiles, totalFiles });
}

function yieldToInput(): Promise<void> {
  return new Promise((resolvePromise) => setImmediate(resolvePromise));
}
