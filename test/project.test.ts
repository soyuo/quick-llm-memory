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
import { initializeProject, listProjects } from '../src/projects/manager.js';
import { projectMetadataSchema } from '../src/projects/schema.js';

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
    fs.writeFileSync = ((fileDescriptor: number, contents: string) => {
      originalWriteFileSync(fileDescriptor, contents, 'utf8');
      throw new Error('simulated metadata write failure');
    }) as typeof fs.writeFileSync;
    syncBuiltinESMExports();

    try {
      expect(() => initializeProject(dataRoot, 'retryable')).toThrow(
        InternalError,
      );
      expect(existsSync(projectDirectory)).toBe(false);
      expect(listProjects(dataRoot)).toEqual([]);
    } finally {
      fs.writeFileSync = originalWriteFileSync;
      syncBuiltinESMExports();
    }
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
