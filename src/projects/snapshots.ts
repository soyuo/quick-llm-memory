import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { ConfigurationError } from '../config/error.js';
import { InputError } from '../errors/qlm-error.js';
import { validateProjectName } from './schema.js';

export interface SnapshotFile { path: string; size: number; sha256: string }
export interface SnapshotManifest { version: 1; id: string; projectId: string; projectName: string; createdAt: string; files: SnapshotFile[] }
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

export function createProjectSnapshot(dataRoot: string, projectId: string, projectName: string): SnapshotManifest {
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
    const manifest: SnapshotManifest = { version: 1, id, projectId, projectName, createdAt: new Date().toISOString(), files };
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
