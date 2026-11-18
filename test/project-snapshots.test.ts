import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assertSnapshotInventoryUnchanged, createProjectSnapshot, listProjectSnapshots } from '../src/projects/snapshots.js';
import { initializeProject } from '../src/projects/manager.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'qlm-snapshots-')); roots.push(root);
  const project = initializeProject(root, 'demo');
  const dir = join(root, 'projects', 'demo');
  mkdirSync(join(dir, 'knowledge'), { recursive: true });
  writeFileSync(join(dir, 'knowledge', 'note.md'), '# Note\n');
  writeFileSync(join(dir, 'index.sqlite'), 'rebuildable');
  writeFileSync(join(dir, 'index.sqlite-wal'), 'transient');
  writeFileSync(join(dir, 'index.sqlite-shm'), 'transient');
  return { root, dir, project };
}

describe('project snapshots', () => {
  it('rejects an inventory that changes while files are copied', () => {
    const before = [{ path: 'knowledge/note.md', size: 2, sha256: 'a'.repeat(64) }];
    const modified = [{ ...before[0]!, size: 3, sha256: 'b'.repeat(64) }];
    const added = [...before, { path: 'knowledge/new.md', size: 1, sha256: 'c'.repeat(64) }];

    expect(() => assertSnapshotInventoryUnchanged(before, modified)).toThrow('Project changed while its snapshot');
    expect(() => assertSnapshotInventoryUnchanged(before, added)).toThrow('Project changed while its snapshot');
    expect(() => assertSnapshotInventoryUnchanged(before, before)).not.toThrow();
  });

  it('publishes immutable checksummed copies and omits rebuildable databases', () => {
    const { root, dir, project } = setup();
    const source = readFileSync(join(dir, 'knowledge', 'note.md'));
    const snapshot = createProjectSnapshot(root, project.id, project.name);
    expect(snapshot.version).toBe(1);
    expect(snapshot.files.map(({ path }) => path).filter((path) => path.startsWith('index.sqlite'))).toEqual([]);
    expect(readFileSync(join(root, 'snapshots', project.id, snapshot.id, 'knowledge', 'note.md'))).toEqual(source);
    writeFileSync(join(dir, 'knowledge', 'note.md'), 'changed');
    expect(readFileSync(join(root, 'snapshots', project.id, snapshot.id, 'knowledge', 'note.md'))).toEqual(source);
    expect(listProjectSnapshots(root, project.id)).toHaveLength(1);
  });

  it('rejects corrupted snapshot content during listing', () => {
    const { root, project } = setup();
    const snapshot = createProjectSnapshot(root, project.id, project.name);
    writeFileSync(join(root, 'snapshots', project.id, snapshot.id, 'knowledge', 'note.md'), 'corrupt');
    expect(() => listProjectSnapshots(root, project.id)).toThrow('Unable to verify project snapshots');
  });

  it('reports a missing manifest as corruption rather than an empty snapshot list', () => {
    const { root, project } = setup();
    const snapshot = createProjectSnapshot(root, project.id, project.name);
    unlinkSync(join(root, 'snapshots', project.id, snapshot.id, 'manifest.json'));
    expect(() => listProjectSnapshots(root, project.id)).toThrow('Unable to verify project snapshots');
  });

  it('rejects symlinks in project data without publishing a partial snapshot', () => {
    const { root, dir, project } = setup();
    const outside = join(root, 'outside.md'); writeFileSync(outside, 'outside');
    try { symlinkSync(outside, join(dir, 'knowledge', 'linked.md')); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') return;
      throw error;
    }
    expect(() => createProjectSnapshot(root, project.id, project.name)).toThrow('Snapshot refuses symbolic link');
    expect(listProjectSnapshots(root, project.id)).toEqual([]);
  });

  it('lists files in a deterministic path order', () => {
    const { root, dir, project } = setup();
    writeFileSync(join(dir, 'z.md'), 'z'); writeFileSync(join(dir, 'a.md'), 'a');
    expect(createProjectSnapshot(root, project.id, project.name).files.map(({ path }) => path))
      .toEqual(['a.md', 'knowledge/note.md', 'project.yaml', 'z.md']);
  });

  it('rejects unsafe project IDs before using snapshot paths', () => {
    expect(() => listProjectSnapshots('unused', '../outside')).toThrow('Project ID is invalid');
    expect(() => createProjectSnapshot('unused', '../outside', 'demo')).toThrow('Project ID is invalid');
  });

  it('rejects traversal project names in the snapshot service', () => {
    expect(() => createProjectSnapshot('unused', '00000000-0000-4000-8000-000000000000', '../outside')).toThrow('Invalid project name');
  });
});
