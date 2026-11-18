import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { parse as parseYaml } from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';
import { runCli } from '../src/cli.js';
import { ConfigurationError } from '../src/config/error.js';
import { InputError, InternalError } from '../src/errors/qlm-error.js';
import { createApplicationLogger } from '../src/logging/logger.js';
import {
  deleteProject,
  initializeProject,
  listProjects,
  renameProject,
  setProjectArchived,
} from '../src/projects/manager.js';
import { projectMetadataSchema } from '../src/projects/schema.js';
import { listProjectSnapshots } from '../src/projects/snapshots.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('project management', () => {
  it('creates validated project metadata under the configured data root', () => {
    const dataRoot = createTemporaryDirectory('qlm-project-init-');

    const project = initializeProject(dataRoot, 'my-project');
    const projectDirectory = join(dataRoot, 'projects', 'my-project');
    const rawMetadata = parseYaml(
      readFileSync(join(projectDirectory, 'project.yaml'), 'utf8'),
    );

    expect(projectMetadataSchema.parse(rawMetadata)).toEqual(project);
    expect(project).toMatchObject({ schema_version: 1, name: 'my-project' });
    expect(project.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(project.created_at).toBe(project.updated_at);
    expect(existsSync(join(projectDirectory, 'knowledge'))).toBe(false);
  });

  it('rejects unsafe names and does not create paths outside the project root', () => {
    const dataRoot = createTemporaryDirectory('qlm-project-invalid-');

    for (const name of ['../outside', 'Uppercase', 'bad/name', 'con', 'trailing-']) {
      expect(() => initializeProject(dataRoot, name)).toThrow(InputError);
    }

    expect(existsSync(join(dataRoot, 'projects'))).toBe(false);
  });

  it('does not overwrite existing project data', () => {
    const dataRoot = createTemporaryDirectory('qlm-project-duplicate-');
    const original = initializeProject(dataRoot, 'existing');
    const userFile = join(dataRoot, 'projects', 'existing', 'notes.md');
    writeFileSync(userFile, 'keep this data');

    expect(() => initializeProject(dataRoot, 'existing')).toThrow(InputError);
    expect(readFileSync(userFile, 'utf8')).toBe('keep this data');
    expect(listProjects(dataRoot)[0]?.id).toBe(original.id);
  });

  it('removes the new project directory after metadata writing fails', () => {
    const dataRoot = createTemporaryDirectory('qlm-project-write-failure-');
    const projectDirectory = join(dataRoot, 'projects', 'retryable');
    const originalWriteFileSync = fs.writeFileSync;
    let partialWriteLength = 0;
    fs.writeFileSync = ((fileDescriptor: number, contents: string) => {
      const partialContents = contents.slice(0, 8);
      originalWriteFileSync(fileDescriptor, partialContents, 'utf8');
      partialWriteLength = partialContents.length;
      throw new Error('simulated metadata write failure');
    }) as typeof fs.writeFileSync;
    syncBuiltinESMExports();

    try {
      expect(() => initializeProject(dataRoot, 'retryable')).toThrow(
        InternalError,
      );
      expect(partialWriteLength).toBe(8);
      expect(existsSync(projectDirectory)).toBe(false);
    } finally {
      fs.writeFileSync = originalWriteFileSync;
      syncBuiltinESMExports();
    }

    expect(initializeProject(dataRoot, 'retryable').name).toBe('retryable');
    expect(listProjects(dataRoot).map(({ name }) => name)).toEqual(['retryable']);
  });

  it('lists valid projects in stable order and ignores directories without metadata', () => {
    const dataRoot = createTemporaryDirectory('qlm-project-list-');
    initializeProject(dataRoot, 'zeta');
    initializeProject(dataRoot, 'alpha');
    mkdirSync(join(dataRoot, 'projects', 'unfinished'));

    expect(listProjects(dataRoot).map(({ name }) => name)).toEqual([
      'alpha',
      'zeta',
    ]);
  });

  it('reports malformed project metadata instead of silently skipping it', () => {
    const dataRoot = createTemporaryDirectory('qlm-project-corrupt-');
    const projectDirectory = join(dataRoot, 'projects', 'broken');
    mkdirSync(projectDirectory, { recursive: true });
    writeFileSync(join(projectDirectory, 'project.yaml'), 'id: [\n');

    expect(() => listProjects(dataRoot)).toThrow(ConfigurationError);
  });

  it('renames a project without changing its identity or project files', () => {
    const dataRoot = createTemporaryDirectory('qlm-project-rename-');
    const original = initializeProject(dataRoot, 'old-name');
    const knowledgeFile = join(dataRoot, 'projects', 'old-name', 'knowledge', 'notes.md');
    mkdirSync(join(dataRoot, 'projects', 'old-name', 'knowledge'));
    writeFileSync(knowledgeFile, '# Keep this document\n');

    const renamed = renameProject(dataRoot, 'old-name', 'new-name');

    expect(renamed).toMatchObject({
      id: original.id,
      name: 'new-name',
      created_at: original.created_at,
    });
    expect(renamed.updated_at).not.toBe(original.updated_at);
    expect(existsSync(join(dataRoot, 'projects', 'old-name'))).toBe(false);
    expect(readFileSync(join(dataRoot, 'projects', 'new-name', 'knowledge', 'notes.md'), 'utf8'))
      .toBe('# Keep this document\n');
    expect(listProjectSnapshots(dataRoot, original.id)[0]).toMatchObject({
      operation: 'project-rename',
      reason: 'rename:old-name->new-name',
    });
    expect(listProjects(dataRoot).map(({ name }) => name)).toEqual(['new-name']);
  });

  it('does not rename when the pre-operation snapshot cannot be created', () => {
    const dataRoot = createTemporaryDirectory('qlm-project-rename-snapshot-failure-');
    initializeProject(dataRoot, 'before');
    const source = join(dataRoot, 'projects', 'before', 'project.yaml');
    const original = readFileSync(source);
    writeFileSync(join(dataRoot, 'snapshots'), 'blocks snapshot directory');
    expect(() => renameProject(dataRoot, 'before', 'after')).toThrow();
    expect(existsSync(join(dataRoot, 'projects', 'before'))).toBe(true);
    expect(existsSync(join(dataRoot, 'projects', 'after'))).toBe(false);
    expect(readFileSync(source)).toEqual(original);
  });

  it('rejects rename collisions without changing either project', () => {
    const dataRoot = createTemporaryDirectory('qlm-project-rename-collision-');
    initializeProject(dataRoot, 'first');
    initializeProject(dataRoot, 'second');

    expect(() => renameProject(dataRoot, 'first', 'second')).toThrow(InputError);
    expect(listProjects(dataRoot).map(({ name }) => name)).toEqual(['first', 'second']);
  });

  it('rolls back the project directory when renamed metadata cannot be written', () => {
    const dataRoot = createTemporaryDirectory('qlm-project-rename-failure-');
    initializeProject(dataRoot, 'before');
    const originalRenameSync = fs.renameSync;
    fs.renameSync = ((source: string, destination: string) => {
      if (source.includes('.project-')) {
        throw new Error('simulated metadata replacement failure');
      }
      originalRenameSync(source, destination);
    }) as typeof fs.renameSync;
    syncBuiltinESMExports();

    try {
      expect(() => renameProject(dataRoot, 'before', 'after')).toThrow(InternalError);
    } finally {
      fs.renameSync = originalRenameSync;
      syncBuiltinESMExports();
    }

    expect(existsSync(join(dataRoot, 'projects', 'before'))).toBe(true);
    expect(existsSync(join(dataRoot, 'projects', 'after'))).toBe(false);
    expect(listProjects(dataRoot).map(({ name }) => name)).toEqual(['before']);
  });

  it('archives and restores a project through metadata without moving its data', () => {
    const dataRoot = createTemporaryDirectory('qlm-project-archive-');
    initializeProject(dataRoot, 'saved');
    const knowledgeDirectory = join(dataRoot, 'projects', 'saved', 'knowledge');
    mkdirSync(knowledgeDirectory);
    writeFileSync(join(knowledgeDirectory, 'notes.md'), 'still here');

    const archived = setProjectArchived(dataRoot, 'saved', true);
    expect(archived.archived_at).toBeDefined();
    expect(listProjects(dataRoot)[0]?.archived_at).toBe(archived.archived_at);
    expect(readFileSync(join(knowledgeDirectory, 'notes.md'), 'utf8')).toBe('still here');

    const restored = setProjectArchived(dataRoot, 'saved', false);
    expect(restored.archived_at).toBeUndefined();
    expect(listProjects(dataRoot)[0]?.archived_at).toBeUndefined();
    expect(readFileSync(join(knowledgeDirectory, 'notes.md'), 'utf8')).toBe('still here');
  });

  it('deletes only after exact-name confirmation and preserves neighboring projects', () => {
    const dataRoot = createTemporaryDirectory('qlm-project-delete-');
    const removedProject = initializeProject(dataRoot, 'remove-me');
    initializeProject(dataRoot, 'keep-me');
    const userFile = join(dataRoot, 'projects', 'remove-me', 'knowledge', 'notes.md');
    mkdirSync(join(dataRoot, 'projects', 'remove-me', 'knowledge'));
    writeFileSync(userFile, 'explicitly selected data');

    expect(() => deleteProject(dataRoot, 'remove-me', 'remove')).toThrow(InputError);
    expect(readFileSync(userFile, 'utf8')).toBe('explicitly selected data');

    deleteProject(dataRoot, 'remove-me', 'remove-me');
    expect(existsSync(join(dataRoot, 'projects', 'remove-me'))).toBe(false);
    expect(listProjects(dataRoot).map(({ name }) => name)).toEqual(['keep-me']);
    expect(listProjectSnapshots(dataRoot, removedProject.id)[0]).toMatchObject({
      operation: 'project-delete',
      reason: 'confirmed-project-deletion',
    });
  });

  it('does not delete a project when its pre-operation snapshot fails', () => {
    const dataRoot = createTemporaryDirectory('qlm-project-delete-snapshot-failure-');
    const project = initializeProject(dataRoot, 'keep-on-failure');
    const source = join(dataRoot, 'projects', project.name, 'project.yaml');
    const original = readFileSync(source);
    writeFileSync(join(dataRoot, 'snapshots'), 'blocks snapshot directory');
    expect(() => deleteProject(dataRoot, project.name, project.name)).toThrow();
    expect(existsSync(join(dataRoot, 'projects', project.name))).toBe(true);
    expect(readFileSync(source)).toEqual(original);
  });

  it('registers init and list commands and logs project creation', async () => {
    const dataRoot = createTemporaryDirectory('qlm-project-cli-');
    const logLines: string[] = [];
    const output: string[] = [];
    const errorOutput: string[] = [];
    const destination: pino.DestinationStream = {
      write: (line) => logLines.push(line),
    };
    const runtimeFactory = () => ({
      dataRoot,
      logger: createApplicationLogger({ dataRoot, level: 'info', destination }),
    });

    const initExitCode = await runCli(
      ['node', 'qlm', 'init', 'cli-project'],
      {
        writeOut: (text) => output.push(text),
        writeError: (text) => errorOutput.push(text),
      },
      { runtimeFactory },
    );
    const listExitCode = await runCli(
      ['node', 'qlm', 'project', 'list'],
      {
        writeOut: (text) => output.push(text),
        writeError: (text) => errorOutput.push(text),
      },
      { runtimeFactory },
    );
    const records = logLines.map((line) => JSON.parse(line) as { event?: string });

    expect(initExitCode).toBe(0);
    expect(listExitCode).toBe(0);
    expect(output.join('')).toContain('Created project cli-project.');
    expect(output.join('')).toContain('- cli-project');
    expect(errorOutput).toEqual([]);
    expect(records.some((record) => record.event === 'project.created')).toBe(true);
  });
});

function createTemporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}
