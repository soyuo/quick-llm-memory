import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runCli } from '../../src/cli.js';
import { createApplicationLogger } from '../../src/logging/logger.js';
import { listProjects } from '../../src/projects/manager.js';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

async function run(dataRoot: string, ...args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const exitCode = await runCli(
    ['node', 'qlm', ...args],
    { writeOut: (text) => out.push(text), writeError: (text) => err.push(text) },
    {
      runtimeFactory: () => ({
        dataRoot,
        logger: createApplicationLogger({ dataRoot, level: 'error', destination: { write: () => undefined } }),
      }),
    },
  );
  return { exitCode, out: out.join(''), err: err.join('') };
}

function temporary(): string {
  const directory = mkdtempSync(join(tmpdir(), 'qlm-project-commands-'));
  directories.push(directory);
  return directory;
}

describe('project management commands', () => {
  it('shows info, lists JSON, exports, imports, and removes only with --yes', async () => {
    const dataRoot = temporary();
    await run(dataRoot, 'init', 'alpha');

    const info = await run(dataRoot, 'project', 'info', 'alpha');
    expect(info.exitCode).toBe(0);
    expect(info.out).toContain('Name: alpha');
    expect(info.out).toContain('Archived: no');

    const json = await run(dataRoot, 'project', 'list', '--json');
    expect((JSON.parse(json.out) as Array<{ name: string }>).map(({ name }) => name)).toEqual(['alpha']);

    const bundle = join(temporary(), 'bundle');
    const exported = await run(dataRoot, 'project', 'export', 'alpha', bundle);
    expect(exported.exitCode).toBe(0);

    const importRoot = temporary();
    const imported = await run(importRoot, 'project', 'import', bundle, '--name', 'beta');
    expect(imported.exitCode).toBe(0);
    expect(listProjects(importRoot).map(({ name }) => name)).toEqual(['beta']);

    const refused = await run(dataRoot, 'project', 'remove', 'alpha');
    expect(refused.exitCode).not.toBe(0);
    expect(listProjects(dataRoot)).toHaveLength(1);

    const removed = await run(dataRoot, 'project', 'remove', 'alpha', '--yes');
    expect(removed.exitCode).toBe(0);
    expect(listProjects(dataRoot)).toHaveLength(0);
  });

  it('reads a knowledge document body', async () => {
    const dataRoot = temporary();
    await run(dataRoot, 'init', 'alpha');
    const knowledge = join(dataRoot, 'projects', 'alpha', 'knowledge');
    mkdirSync(knowledge, { recursive: true });
    writeFileSync(join(knowledge, 'note.md'), ['---', 'schema_version: 1', 'id: 11111111-1111-4111-8111-111111111111', 'title: Note', 'type: document', 'depth: 1', 'status: verified', '---', '', 'hello body', ''].join(String.fromCharCode(10)));

    const result = await run(dataRoot, 'read', 'note.md', '--project', 'alpha');
    expect(result.err).toBe('');
    expect(result.out).toContain('hello body');

    const missing = await run(dataRoot, 'read', 'note.md', '--project', 'nope');
    expect(missing.exitCode).not.toBe(0);
  });
});
