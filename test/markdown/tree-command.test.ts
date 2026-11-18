import {
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runCli } from '../../src/cli.js';
import { createApplicationLogger } from '../../src/logging/logger.js';
import { createMarkdownDocument } from '../../src/markdown/repository.js';
import { initializeProject } from '../../src/projects/manager.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('qlm tree command', () => {
  it('displays categories and document paths in stable hierarchy order', async () => {
    const { dataRoot, knowledgeRoot } = createProject();
    createDocument(knowledgeRoot, 'z.md', 'Zebra');
    createDocument(knowledgeRoot, 'alpha/nested/note.md', 'Nested note');
    createDocument(knowledgeRoot, 'root.md', 'Root note');

    const result = await run(dataRoot, ['--project', 'demo']);

    expect(result.exitCode).toBe(0);
    expect(result.output).toBe(
      'Knowledge tree for demo:\n' +
        'alpha/\n' +
        '  alpha/nested/\n' +
        '    alpha/nested/note.md\n' +
        'root.md\n' +
        'z.md\n',
    );
    expect(result.errorOutput).toBe('');
  });

  it('limits displayed levels without changing Markdown files', async () => {
    const { dataRoot, knowledgeRoot } = createProject();
    const sourcePath = createDocument(
      knowledgeRoot,
      'alpha/nested/note.md',
      'Nested note',
    );
    const original = readFileSync(sourcePath, 'utf8');

    const result = await run(dataRoot, ['--project', 'demo', '--depth', '2']);

    expect(result.exitCode).toBe(0);
    expect(result.output).toBe(
      'Knowledge tree for demo:\nalpha/\n  alpha/nested/\n',
    );
    expect(readFileSync(sourcePath, 'utf8')).toBe(original);
  });

  it('uses the documented default maximum depth of 5', async () => {
    const { dataRoot, knowledgeRoot } = createProject();
    createDocument(
      knowledgeRoot,
      'one/two/three/four/five/six.md',
      'Deep note',
    );

    const result = await run(dataRoot, ['--project', 'demo']);

    expect(result.exitCode).toBe(0);
    expect(result.output).toBe(
      'Knowledge tree for demo:\n' +
        'one/\n' +
        '  one/two/\n' +
        '    one/two/three/\n' +
        '      one/two/three/four/\n' +
        '        one/two/three/four/five/\n',
    );
    expect(result.output).not.toContain('six.md');
  });

  it('reports empty projects clearly and rejects invalid inputs', async () => {
    const { dataRoot, knowledgeRoot } = createProject();

    const empty = await run(dataRoot, ['--project', 'demo']);
    createDocument(knowledgeRoot, 'visible-at-depth-one.md', 'Visible');
    const hiddenAtDepthZero = await run(dataRoot, [
      '--project',
      'demo',
      '--depth',
      '0',
    ]);
    const missing = await run(dataRoot, ['--project', 'missing']);
    const invalidDepth = await run(dataRoot, [
      '--project',
      'demo',
      '--depth',
      '1.5',
    ]);

    expect(empty.exitCode).toBe(0);
    expect(empty.output).toBe(
      'Knowledge tree for demo:\nNo knowledge documents or categories found.\n',
    );
    expect(hiddenAtDepthZero.exitCode).toBe(0);
    expect(hiddenAtDepthZero.output).toBe(
      'Knowledge tree for demo:\nNo categories or documents at depth 0.\n',
    );
    expect(missing.exitCode).toBe(1);
    expect(missing.errorOutput).toContain('[QLM_INPUT_ERROR]');
    expect(missing.errorOutput).toContain('Project not found: missing');
    expect(invalidDepth.exitCode).toBe(1);
    expect(invalidDepth.errorOutput).toContain('[QLM_INPUT_ERROR]');
    expect(invalidDepth.errorOutput).toContain(
      'Tree depth must be a non-negative integer.',
    );
  });
});

function createProject() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'qlm-tree-cli-'));
  temporaryDirectories.push(dataRoot);
  const project = initializeProject(dataRoot, 'demo');
  return {
    dataRoot,
    knowledgeRoot: join(dataRoot, 'projects', project.name, 'knowledge'),
  };
}

function createDocument(knowledgeRoot: string, relativePath: string, title: string): string {
  const document = createMarkdownDocument(knowledgeRoot, relativePath, {
    metadata: {
      schema_version: 1,
      title,
      type: 'document',
      depth: 1,
      status: 'draft',
    },
    body: `\n# ${title}\n`,
  });
  return join(knowledgeRoot, relativePath);
}

async function run(dataRoot: string, args: string[]) {
  const output: string[] = [];
  const errorOutput: string[] = [];
  const exitCode = await runCli(
    ['node', 'qlm', 'tree', ...args],
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
