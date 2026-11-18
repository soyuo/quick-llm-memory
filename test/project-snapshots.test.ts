import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runCli } from '../src/cli.js';
import { createApplicationLogger } from '../src/logging/logger.js';
import { assertSnapshotInventoryUnchanged, createProjectSnapshot, listProjectSnapshots, restoreProjectSnapshot } from '../src/projects/snapshots.js';
import { initializeProject } from '../src/projects/manager.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'qlm-snapshots-')); roots.push(root);
  const project = initializeProject(root, 'demo');
  const dir = join(root, 'projects', 'demo');
  mkdirSync(join(dir, 'knowledge'), { recursive: true });
  writeFileSync(join(dir, 'knowledge', 'note.md'), '---\nschema_version: 1\nid: note\ntitle: Note\ndepth: 1\ntype: document\nstatus: draft\n---\n\n# Note\n');
  writeFileSync(join(dir, 'index.sqlite'), 'rebuildable');
  writeFileSync(join(dir, 'index.sqlite-wal'), 'transient');
  writeFileSync(join(dir, 'index.sqlite-shm'), 'transient');
  return { root, dir, project };
}

describe('project snapshots', () => {
  it('recovers a project backup left by an interrupted directory swap', async () => {
    const { root, project } = setup();
    const snapshot = createProjectSnapshot(root, project.id, project.name);
    const projectsRoot = join(root, 'projects');
    const projectRoot = join(projectsRoot, project.name);
    const backup = join(projectsRoot, `.${project.name}.123e4567-e89b-12d3-a456-426614174000.backup`);
    const stage = join(projectsRoot, `.${project.name}.123e4567-e89b-12d3-a456-426614174000.restore`);
    renameSync(projectRoot, backup);
    mkdirSync(stage);
    writeFileSync(join(projectsRoot, `.${project.name}.restore-journal.json`), JSON.stringify({ projectRoot, backup, stage }));

    await restoreProjectSnapshot(root, project.id, project.name, snapshot.id, () => {});

    expect(readFileSync(join(projectRoot, 'project.yaml'), 'utf8')).toContain(project.id);
    expect(readFileSync(join(projectRoot, 'knowledge', 'note.md'), 'utf8')).toContain('# Note');
  });

  it('restores a snapshot through the CLI and reports index rebuilding', async () => {
    const { root, dir, project } = setup();
    const snapshot = createProjectSnapshot(root, project.id, project.name);
    writeFileSync(join(dir, 'knowledge', 'untracked-after-snapshot.txt'), 'user data');
    writeFileSync(join(dir, 'knowledge', 'note.md'), '---\nschema_version: 1\nid: note\ntitle: Current\ndepth: 1\ntype: document\nstatus: draft\n---\n\n# Current\n');
    const output: string[] = [];
    const exitCode = await runCli(['node', 'qlm', 'snapshot', 'restore', project.name, snapshot.id, '--yes'], {
      writeOut: (text) => output.push(text),
      writeError: (text) => output.push(text),
    }, {
      runtimeFactory: () => ({ dataRoot: root, logger: createApplicationLogger({ dataRoot: root, level: 'fatal' }) }),
    });

    expect({ exitCode, output: output.join('') }).toEqual({ exitCode: 0, output: expect.stringContaining(`Restored snapshot ${snapshot.id}`) });
    expect(readFileSync(join(dir, 'knowledge', 'note.md'), 'utf8')).toContain('title: Note');
    expect(output.join('')).toContain(`Restored snapshot ${snapshot.id}`);
    expect(output.join('')).toContain('knowledge/untracked-after-snapshot.txt');
    expect(listProjectSnapshots(root, project.id)).toHaveLength(2);
  });

  it('rejects an inventory that changes while files are copied', () => {
    const before = [{ path: 'knowledge/note.md', size: 2, sha256: 'a'.repeat(64) }];
    const modified = [{ ...before[0]!, size: 3, sha256: 'b'.repeat(64) }];
    const added = [...before, { path: 'knowledge/new.md', size: 1, sha256: 'c'.repeat(64) }];

    expect(() => assertSnapshotInventoryUnchanged(before, modified)).toThrow('Project changed while its snapshot');
    expect(() => assertSnapshotInventoryUnchanged(before, added)).toThrow('Project changed while its snapshot');
    expect(() => assertSnapshotInventoryUnchanged(before, before)).not.toThrow();
  });

  it('restores verified project files and rebuilds the index before removing its backup', async () => {
    const { root, dir, project } = setup();
    const snapshot = createProjectSnapshot(root, project.id, project.name);
    writeFileSync(join(dir, 'knowledge', 'note.md'), '# Changed\n');
    let rebuilt = false;

    await restoreProjectSnapshot(root, project.id, project.name, snapshot.id, () => { rebuilt = true; });

    expect(readFileSync(join(dir, 'knowledge', 'note.md'), 'utf8')).toContain('title: Note');
    expect(rebuilt).toBe(true);
    expect(listProjectSnapshots(root, project.id)).toHaveLength(2);
  });

  it('rolls back project files when index rebuilding fails during restore', async () => {
    const { root, dir, project } = setup();
    const snapshot = createProjectSnapshot(root, project.id, project.name);
    writeFileSync(join(dir, 'knowledge', 'note.md'), '# Current\n');

    await expect(restoreProjectSnapshot(root, project.id, project.name, snapshot.id, () => {
      throw new Error('index rebuild failed');
    })).rejects.toThrow('index rebuild failed');

    expect(readFileSync(join(dir, 'knowledge', 'note.md'), 'utf8')).toBe('# Current\n');
    expect(listProjectSnapshots(root, project.id)).toHaveLength(2);
  });

  it('rejects a corrupt snapshot before changing current project files', async () => {
    const { root, dir, project } = setup();
    const snapshot = createProjectSnapshot(root, project.id, project.name);
    writeFileSync(join(dir, 'knowledge', 'note.md'), '# Current\n');
    writeFileSync(join(root, 'snapshots', project.id, snapshot.id, 'knowledge', 'note.md'), '# Tampered\n');

    await expect(restoreProjectSnapshot(root, project.id, project.name, snapshot.id, () => {})).rejects.toThrow();
    expect(readFileSync(join(dir, 'knowledge', 'note.md'), 'utf8')).toBe('# Current\n');
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
