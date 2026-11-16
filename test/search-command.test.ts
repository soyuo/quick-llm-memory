import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runCli } from '../src/cli.js';
import { createApplicationLogger } from '../src/logging/logger.js';
import { createMarkdownDocument } from '../src/markdown/repository.js';
import { initializeProject } from '../src/projects/manager.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('qlm search command', () => {
  it('matches title, path, and body case-insensitively in stable order', async () => {
    const { dataRoot, knowledgeRoot } = createProject();
    createDocument(knowledgeRoot, 'alpha/needle-in-path.md', 'A route', 'No body match.');
    createDocument(knowledgeRoot, 'body.md', 'Body note', `${'a'.repeat(110)} NEEDLE ${'b'.repeat(110)}`);
    createDocument(knowledgeRoot, 'title.md', 'Needle Guide', 'Title match only.');

    const first = await run(dataRoot, ['needle', '--project', 'demo']);
    const second = await run(dataRoot, ['needle', '--project', 'demo']);

    expect(first.exitCode).toBe(0);
    expect(first.errorOutput).toBe('');
    expect(first.output).toBe(second.output);
    expect(first.output).toContain('alpha/needle-in-path.md — A route');
    expect(first.output).toContain('body.md — Body note');
    expect(first.output).toContain('title.md — Needle Guide');
    expect(first.output.indexOf('alpha/needle-in-path.md')).toBeLessThan(
      first.output.indexOf('body.md'),
    );
    expect(first.output.indexOf('body.md')).toBeLessThan(
      first.output.indexOf('title.md'),
    );

    const excerpt = first.output
      .split('\n')
      .find((line) => line.startsWith('  ') && line.toLowerCase().includes('needle'));
    expect(excerpt).toBeDefined();
    expect(excerpt?.trim().length).toBeLessThanOrEqual(160);
  });

  it('reports no matches without modifying source Markdown', async () => {
    const { dataRoot, knowledgeRoot } = createProject();
    const sourcePath = createDocument(
      knowledgeRoot,
      'note.md',
      'A note',
      'Stored text.',
    );
    const original = readFileSync(sourcePath, 'utf8');

    const result = await run(dataRoot, ['missing-term', '--project', 'demo']);

    expect(result.exitCode).toBe(0);
    expect(result.output).toBe(
      'Search results for "missing-term":\nNo matching documents found.\n',
    );
    expect(readFileSync(sourcePath, 'utf8')).toBe(original);
  });

  it('returns typed errors for invalid projects, blank queries, and malformed Markdown', async () => {
    const { dataRoot, knowledgeRoot } = createProject();

    const missingProject = await run(dataRoot, ['term', '--project', 'missing']);
    const blankQuery = await run(dataRoot, ['   ', '--project', 'demo']);
    mkdirSync(knowledgeRoot, { recursive: true });
    const malformedPath = join(knowledgeRoot, 'malformed.md');
    const malformedSource = '---\ntitle: [\n---\nBody\n';
    writeFileSync(malformedPath, malformedSource, 'utf8');
    const malformedDocument = await run(dataRoot, ['term', '--project', 'demo']);

    expect(missingProject.exitCode).toBe(1);
    expect(missingProject.errorOutput).toContain('[QLM_INPUT_ERROR]');
    expect(missingProject.errorOutput).toContain('Project not found: missing');
    expect(blankQuery.exitCode).toBe(1);
    expect(blankQuery.errorOutput).toContain('[QLM_INPUT_ERROR]');
    expect(blankQuery.errorOutput).toContain('Search query must not be empty.');
    expect(malformedDocument.exitCode).toBe(1);
    expect(malformedDocument.errorOutput).toContain('[QLM_CONFIG_ERROR]');
    expect(readFileSync(malformedPath, 'utf8')).toBe(malformedSource);
  });
});

function createProject() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'qlm-search-cli-'));
  temporaryDirectories.push(dataRoot);
  const project = initializeProject(dataRoot, 'demo');
  return {
    dataRoot,
    knowledgeRoot: join(dataRoot, 'projects', project.name, 'knowledge'),
  };
}

function createDocument(
  knowledgeRoot: string,
  relativePath: string,
  title: string,
  body: string,
): string {
  createMarkdownDocument(knowledgeRoot, relativePath, {
    metadata: {
      schema_version: 1,
      title,
      type: 'document',
      depth: 1,
      status: 'draft',
    },
    body: `\n${body}\n`,
  });
  return join(knowledgeRoot, relativePath);
}

async function run(dataRoot: string, args: string[]) {
  const output: string[] = [];
  const errorOutput: string[] = [];
  const exitCode = await runCli(
    ['node', 'qlm', 'search', ...args],
    {
      writeOut: (text) => output.push(text),
      writeError: (text) => errorOutput.push(text),
    },
    {
      runtimeFactory: () => ({
        dataRoot,
        logger: createApplicationLogger({ dataRoot, level: 'fatal' }),
      }),
    },
  );

  return { exitCode, output: output.join(''), errorOutput: errorOutput.join('') };
}
