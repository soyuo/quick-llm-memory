import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { ConfigurationError } from '../config/error.js';
import { InputError } from '../errors/qlm-error.js';
import { projectMetadataSchema, validateProjectName } from './schema.js';
import { parse as parseYaml } from 'yaml';

export interface SnapshotFile { path: string; size: number; sha256: string }
export interface SnapshotManifest { version: 1; id: string; projectId: string; projectName: string; createdAt: string; operation?: string; reason?: string; files: SnapshotFile[] }
const hash = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function assertProjectId(projectId: string): void {
  if (!uuidPattern.test(projectId)) throw new InputError('Project ID is invalid.');
}
function assertNoSymlinkPath(root: string, target: string): void {
  const rel = relative(root, target);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new InputError('Snapshot path is outside storage.');
  let current = root;
  for (const part of rel.split(sep).filter(Boolean)) {
    current = join(current, part);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) throw new InputError('Snapshot paths cannot contain symbolic links.');
  }
}
function isDatabaseArtifact(name: string): boolean {
  return /\.(?:sqlite|sqlite3|db)(?:-(?:wal|shm|journal))?$/i.test(name);
}

function collect(root: string, dir = root): SnapshotFile[] {
  const files: SnapshotFile[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new InputError(`Snapshot refuses symbolic link: ${relative(root, path)}`);
    if (stat.isDirectory()) files.push(...collect(root, path));
    else if (stat.isFile() && !isDatabaseArtifact(name)) {
      const content = readFileSync(path);
      files.push({ path: relative(root, path).split(sep).join('/'), size: content.length, sha256: hash(content) });
    }
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

export function listProjectFilePaths(projectRoot: string): string[] {
  return collect(projectRoot).map(({ path }) => path);
}

export function assertSnapshotInventoryUnchanged(before: readonly SnapshotFile[], after: readonly SnapshotFile[]): void {
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    throw new InputError('Project changed while its snapshot was being created.');
  }
}

export function createProjectSnapshot(dataRoot: string, projectId: string, projectName: string, context: { operation?: string; reason?: string } = {}): SnapshotManifest {
  assertProjectId(projectId);
  validateProjectName(projectName);
  const root = realpathSync(resolve(dataRoot));
  const project = join(root, 'projects', projectName);
  if (realpathSync(project) !== project) throw new InputError('Project path is not canonical.');
  const id = randomUUID();
  const snapshotsRoot = join(root, 'snapshots');
  mkdirSync(snapshotsRoot, { recursive: true });
  if (lstatSync(snapshotsRoot).isSymbolicLink() || !lstatSync(snapshotsRoot).isDirectory()) throw new InputError('Snapshot directory cannot be a symbolic link.');
  const snapshots = join(snapshotsRoot, projectId);
  mkdirSync(snapshots, { recursive: true });
  if (lstatSync(snapshots).isSymbolicLink() || !lstatSync(snapshots).isDirectory()) throw new InputError('Snapshot directory cannot be a symbolic link.');
  const stage = join(snapshots, `.${id}.tmp`);
  mkdirSync(stage);
  try {
    const files = collect(project);
    for (const file of files) {
      const source = join(project, ...file.path.split('/'));
      const target = join(stage, ...file.path.split('/'));
      // Recheck immediately before copying so replaced symlinks are rejected.
      if (!lstatSync(source).isFile()) throw new InputError('Snapshot source changed during copy.');
      mkdirSync(resolve(target, '..'), { recursive: true });
      const bytes = readFileSync(source);
      if (hash(bytes) !== file.sha256) throw new InputError('Snapshot source changed during copy.');
      writeFileSync(target, bytes, { flag: 'wx' });
    }
    const verifiedFiles = collect(project);
    assertSnapshotInventoryUnchanged(files, verifiedFiles);
    for (const file of files) {
      const copied = readFileSync(join(stage, ...file.path.split('/')));
      if (copied.length !== file.size || hash(copied) !== file.sha256) {
        throw new InputError('Snapshot copy verification failed.');
      }
    }
    const manifest: SnapshotManifest = { version: 1, id, projectId, projectName, createdAt: new Date().toISOString(), ...context, files };
    writeFileSync(join(stage, 'manifest.json'), JSON.stringify(manifest, null, 2), { flag: 'wx' });
    renameSync(stage, join(snapshots, id));
    return manifest;
  } catch (error) { rmSync(stage, { recursive: true, force: true }); throw error; }
}

export function listProjectSnapshots(dataRoot: string, projectId: string): SnapshotManifest[] {
  assertProjectId(projectId);
  const dir = join(realpathSync(resolve(dataRoot)), 'snapshots', projectId);
  try { lstatSync(dir); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new ConfigurationError('Unable to verify project snapshots.');
  }
  try {
    if (!lstatSync(dir).isDirectory() || lstatSync(dir).isSymbolicLink()) throw new Error('invalid snapshot directory');
    return readdirSync(dir).filter((name) => !name.startsWith('.')).map((name) => {
      const snapshotDir = join(dir, name);
      if (!lstatSync(snapshotDir).isDirectory() || lstatSync(snapshotDir).isSymbolicLink()) throw new Error('invalid snapshot');
      const manifestPath = join(snapshotDir, 'manifest.json');
      assertNoSymlinkPath(snapshotDir, manifestPath);
      const raw = JSON.parse(readFileSync(manifestPath, 'utf8')) as SnapshotManifest;
      if (raw.version !== 1 || raw.id !== basename(name) || raw.projectId !== projectId ||
          typeof raw.projectName !== 'string' || !Number.isFinite(Date.parse(raw.createdAt)) || !Array.isArray(raw.files)) throw new Error('invalid');
      const seen = new Set<string>();
      for (const file of raw.files) {
        if (typeof file.path !== 'string' || isAbsolute(file.path) || file.path.includes('\\') ||
            file.path.split('/').some((part) => part === '..' || part === '' || part === '.') ||
            !Number.isSafeInteger(file.size) || file.size < 0 || !/^[a-f0-9]{64}$/.test(file.sha256) || seen.has(file.path)) throw new Error('invalid path');
        seen.add(file.path);
        const filePath = join(snapshotDir, ...file.path.split('/'));
        assertNoSymlinkPath(snapshotDir, filePath);
        if (!lstatSync(filePath).isFile()) throw new Error('not regular');
        const bytes = readFileSync(filePath);
        if (bytes.length !== file.size || hash(bytes) !== file.sha256) throw new Error('checksum');
      }
      return raw;
    }).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
  } catch { throw new ConfigurationError('Unable to verify project snapshots.'); }
}

export async function restoreProjectSnapshot(
  dataRoot: string,
  projectId: string,
  projectName: string,
  snapshotId: string,
  rebuildIndex: () => void | Promise<void>,
): Promise<SnapshotManifest> {
  assertProjectId(projectId);
  validateProjectName(projectName);
  if (!uuidPattern.test(snapshotId)) throw new InputError('Snapshot ID is invalid.');
  const root = realpathSync(resolve(dataRoot));
  const projectRoot = join(root, 'projects', projectName);
  recoverInterruptedProjectRestore(root, projectName);
  if (realpathSync(projectRoot) !== projectRoot) throw new InputError('Project path is not canonical.');
  const manifest = listProjectSnapshots(root, projectId).find((item) => item.id === snapshotId);
  if (!manifest || manifest.projectName !== projectName) throw new InputError('Snapshot does not belong to this project.');
  const metadataEntry = manifest.files.find(({ path }) => path === 'project.yaml');
  if (!metadataEntry) throw new InputError('Snapshot is missing project metadata.');
  const metadata = projectMetadataSchema.parse(parseYaml(readFileSync(join(root, 'snapshots', projectId, snapshotId, 'project.yaml'), 'utf8')));
  if (metadata.id !== projectId || metadata.name !== projectName) throw new InputError('Snapshot project metadata does not match this project.');
  createProjectSnapshot(root, projectId, projectName, { operation: 'snapshot-restore', reason: `before-restore:${snapshotId}` });
  const snapshotRoot = join(root, 'snapshots', projectId, snapshotId);
  const stage = join(root, 'projects', `.${projectName}.${randomUUID()}.restore`);
  const backup = join(root, 'projects', `.${projectName}.${randomUUID()}.backup`);
  const journal = join(root, 'projects', `.${projectName}.restore-journal.json`);
  mkdirSync(stage);
  let backedUp = false;
  let restoreCommitted = false;
  try {
    for (const file of manifest.files) {
      const source = join(snapshotRoot, ...file.path.split('/'));
      const target = join(stage, ...file.path.split('/'));
      assertNoSymlinkPath(snapshotRoot, source);
      mkdirSync(resolve(target, '..'), { recursive: true });
      copyFileSync(source, target);
    }
    assertSnapshotInventoryUnchanged(manifest.files, collect(stage));
    if (realpathSync(projectRoot) !== projectRoot) throw new InputError('Project path is not canonical.');
    writeFileSync(journal, JSON.stringify({ projectRoot, backup, stage }), { flag: 'wx', mode: 0o600 });
    renameSync(projectRoot, backup);
    backedUp = true;
    renameSync(stage, projectRoot);
    await rebuildIndex();
    const committedJournal = `${journal}.${randomUUID()}.tmp`;
    writeFileSync(committedJournal, JSON.stringify({ projectRoot, backup, stage, committed: true }), { flag: 'wx', mode: 0o600 });
    renameSync(committedJournal, journal);
    restoreCommitted = true;
    rmSync(backup, { recursive: true, force: true });
    rmSync(journal, { force: true });
    return manifest;
  } catch (error) {
    if (backedUp && !restoreCommitted && existsSync(backup)) {
      const failedInstall = `${stage}.failed`;
      if (existsSync(projectRoot)) renameSync(projectRoot, failedInstall);
      try {
        renameSync(backup, projectRoot);
        rmSync(failedInstall, { recursive: true, force: true });
      } catch (rollbackError) {
        if (!existsSync(projectRoot) && existsSync(failedInstall)) renameSync(failedInstall, projectRoot);
        throw new ConfigurationError(`Snapshot restore failed and rollback could not complete: ${String(rollbackError)}`);
      }
    }
    rmSync(stage, { recursive: true, force: true });
    rmSync(journal, { force: true });
    throw error;
  }
}

export function recoverInterruptedProjectRestore(root: string, projectName: string): void {
  validateProjectName(projectName);
  const projectRoot = resolve(root, 'projects', projectName);
  const projectsRoot = join(root, 'projects');
  const journal = join(projectsRoot, `.${projectName}.restore-journal.json`);
  if (!existsSync(journal)) return;
  try {
    const value = JSON.parse(readFileSync(journal, 'utf8')) as { projectRoot?: unknown; backup?: unknown; stage?: unknown; committed?: unknown };
    const validPath = (candidate: unknown, kind: 'backup' | 'restore'): candidate is string =>
      typeof candidate === 'string' && dirname(candidate) === projectsRoot &&
      new RegExp(`^\\.${projectName}\\.[0-9a-f-]{36}\\.${kind}$`).test(basename(candidate));
    if (value.projectRoot !== projectRoot || !validPath(value.backup, 'backup') || !validPath(value.stage, 'restore')) {
      throw new Error('invalid restore journal');
    }
    if (value.committed === true) {
      if (existsSync(value.backup)) {
        assertJournalDirectory(value.backup);
        rmSync(value.backup, { recursive: true, force: true });
      }
    } else if (existsSync(value.backup)) {
      assertJournalDirectory(value.backup);
      const failedInstall = `${value.stage}.failed`;
      if (existsSync(projectRoot)) renameSync(projectRoot, failedInstall);
      try {
        renameSync(value.backup, projectRoot);
        rmSync(failedInstall, { recursive: true, force: true });
      } catch (error) {
        if (!existsSync(projectRoot) && existsSync(failedInstall)) renameSync(failedInstall, projectRoot);
        throw error;
      }
    }
    if (existsSync(value.stage)) assertJournalDirectory(value.stage);
    rmSync(value.stage, { recursive: true, force: true });
    rmSync(journal, { force: true });
  } catch {
    throw new ConfigurationError('An interrupted snapshot restore requires manual recovery.');
  }
}

function assertJournalDirectory(path: string): void {
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('restore journal entry is not a regular directory');
}
