import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { InputError } from '../src/errors/qlm-error.js';
import { openProjectDatabase } from '../src/database/database.js';
import { initializeProject, listProjects, setProjectArchived } from '../src/projects/manager.js';
import { exportProject, importProject } from '../src/projects/transfer.js';

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('project directory transfer', () => {
  it('exports and imports a complete directory without modifying its source', async () => {
    const dataRoot = createDirectory('qlm-transfer-data-');
    const exportParent = createDirectory('qlm-transfer-export-');
    const importedDataRoot = createDirectory('qlm-transfer-import-');
    initializeProject(dataRoot, 'source-project');
    setProjectArchived(dataRoot, 'source-project', true);
    const sourceProject = join(dataRoot, 'projects', 'source-project');
    const sourceMetadata = listProjects(dataRoot)[0];
    mkdirSync(join(sourceProject, 'knowledge', 'guide'), { recursive: true });
    mkdirSync(join(sourceProject, 'index'), { recursive: true });
    writeFileSync(join(sourceProject, 'knowledge', 'guide', 'start.md'), '# Keep this');
    const sourceDatabase = openProjectDatabase(sourceProject, sourceMetadata!);
    sourceDatabase.prepare(`
      INSERT INTO documents (
        id, project_id, path, title, category_id, depth, content_hash, status,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'document-id', sourceMetadata!.id, 'guide/start.md', 'Start', null, 1,
      'hash', 'active', sourceMetadata!.created_at, sourceMetadata!.updated_at,
    );
    sourceDatabase.close();
    const sourceMetadataBefore = readFileSync(join(sourceProject, 'project.yaml'), 'utf8');
    const sourceId = listProjects(dataRoot)[0]?.id;
    const exportedPath = join(exportParent, 'saved-project');

    await exportProject(dataRoot, 'source-project', exportedPath);

    expect(readFileSync(join(exportedPath, 'knowledge', 'guide', 'start.md'), 'utf8'))
      .toBe('# Keep this');
    expect(existsSync(join(exportedPath, 'index', 'knowledge.db'))).toBe(true);
    expect(readFileSync(join(sourceProject, 'project.yaml'), 'utf8'))
      .toBe(sourceMetadataBefore);

    const imported = await importProject(
      importedDataRoot,
      exportedPath,
      'restored-project',
    );
    const importedRoot = join(importedDataRoot, 'projects', 'restored-project');
    expect(imported.name).toBe('restored-project');
    expect(imported.id).not.toBe(sourceId);
    expect(imported.archived_at).toBeDefined();
    expect(readFileSync(join(importedRoot, 'knowledge', 'guide', 'start.md'), 'utf8'))
      .toBe('# Keep this');
    const importedDatabase = openProjectDatabase(importedRoot, imported);
    const importedProjectRecord = importedDatabase
      .prepare('SELECT id, root_path FROM projects')
      .get() as { id: string; root_path: string };
    const importedDocument = importedDatabase
      .prepare('SELECT project_id FROM documents WHERE id = ?')
      .get('document-id') as { project_id: string };
    importedDatabase.close();
    expect(importedProjectRecord).toEqual({ id: imported.id, root_path: importedRoot });
    expect(importedDocument.project_id).toBe(imported.id);
    expect(existsSync(exportedPath)).toBe(true);
  });

  it('refuses existing export and import destinations without changing them', async () => {
    const dataRoot = createDirectory('qlm-transfer-conflict-data-');
    const sourcePath = createDirectory('qlm-transfer-conflict-source-');
    const exportPath = join(createDirectory('qlm-transfer-conflict-export-'), 'occupied');
    initializeProject(dataRoot, 'source-project');
    initializeProject(sourcePath, 'source-project');
    writeFileSync(exportPath, 'keep existing');
    const existingProject = join(dataRoot, 'projects', 'source-project');

    await expect(exportProject(dataRoot, 'source-project', exportPath))
      .rejects.toBeInstanceOf(InputError);
    await expect(importProject(dataRoot, join(sourcePath, 'projects', 'source-project'), 'source-project'))
      .rejects.toBeInstanceOf(InputError);

    expect(readFileSync(exportPath, 'utf8')).toBe('keep existing');
    expect(readdirSync(existingProject)).toEqual(['project.yaml']);
  });

  it('cleans staged files and preserves the source when cancelled before commit', async () => {
    const dataRoot = createDirectory('qlm-transfer-cancel-data-');
    const sourceRoot = createDirectory('qlm-transfer-cancel-source-');
    initializeProject(sourceRoot, 'source-project');
    const sourcePath = join(sourceRoot, 'projects', 'source-project');
    mkdirSync(join(sourcePath, 'knowledge'));
    writeFileSync(join(sourcePath, 'knowledge', 'one.md'), 'one');
    writeFileSync(join(sourcePath, 'knowledge', 'two.md'), 'two');
    const controller = new AbortController();
    const progress: number[] = [];

    await expect(importProject(dataRoot, sourcePath, 'cancelled-project', {
      signal: controller.signal,
      onProgress: (update) => {
        if (update.phase === 'copying' && update.completedFiles > 0) {
          progress.push(update.completedFiles);
          controller.abort();
        }
      },
    })).rejects.toBeInstanceOf(InputError);

    expect(progress).toEqual([1]);
    expect(existsSync(join(dataRoot, 'projects', 'cancelled-project'))).toBe(false);
    expect(readdirSync(dataRoot).some((name) => name.startsWith('.qlm-import-'))).toBe(false);
    expect(readFileSync(join(sourcePath, 'knowledge', 'one.md'), 'utf8')).toBe('one');
  });

  it('rejects symbolic links inside project directories', async () => {
    const dataRoot = createDirectory('qlm-transfer-link-data-');
    const sourceRoot = createDirectory('qlm-transfer-link-source-');
    initializeProject(sourceRoot, 'source-project');
    const sourcePath = join(sourceRoot, 'projects', 'source-project');
    writeFileSync(join(sourceRoot, 'outside.md'), 'outside');
    try {
      symlinkSync(join(sourceRoot, 'outside.md'), join(sourcePath, 'escape.md'), 'file');
    } catch {
      return;
    }

    await expect(importProject(dataRoot, sourcePath, 'linked-project'))
      .rejects.toBeInstanceOf(InputError);
    expect(existsSync(join(dataRoot, 'projects', 'linked-project'))).toBe(false);
  });
});

function createDirectory(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  temporaryRoots.push(path);
  return path;
}
