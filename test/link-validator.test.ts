import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import { runCli } from '../src/cli.js';
import { createApplicationLogger } from '../src/logging/logger.js';
import { generateCategoryIndexes } from '../src/markdown/index-generator.js';
import { validateInternalLinks } from '../src/markdown/link-validator.js';
import { createMarkdownDocument } from '../src/markdown/repository.js';
import { initializeProject } from '../src/projects/manager.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('internal Markdown link validation', () => {
  it('accepts valid document, category, encoded, reference, image, external, and anchor links', () => {
    const knowledgeRoot = createKnowledgeRoot();
    createDocument(knowledgeRoot, 'target.md', 'Target');
    createDocument(knowledgeRoot, 'space name.md', 'Encoded target');
    createDocument(knowledgeRoot, 'security/policy.md', 'Security policy');
    createDocument(
      knowledgeRoot,
      'links.md',
      'Links',
      [
        '[Document](target.md#overview)',
        '[Encoded](space%20name.md)',
        '[Category](security/)',
        '[Reference][target]',
        '[External](https://example.com/docs)',
        '[Mail](mailto:team@example.com)',
        '[Anchor](#links)',
        '![Image](diagram.png)',
        '',
        '[target]: target.md',
      ].join('\n'),
    );
    writeFileSync(join(knowledgeRoot, 'diagram.png'), 'image');
    generateCategoryIndexes(knowledgeRoot);

    const result = validateInternalLinks(knowledgeRoot);

    expect(result.filesScanned).toBeGreaterThanOrEqual(6);
    expect(result.linksChecked).toBeGreaterThan(5);
    expect(result.brokenLinks).toEqual([]);
  });

  it('reports missing, escaping, and malformed encoded targets with source context', () => {
    const knowledgeRoot = createKnowledgeRoot();
    const outsideTarget = join(temporaryDirectories[0] ?? '', 'outside.md');
    writeFileSync(outsideTarget, 'outside');
    const source = createDocument(
      knowledgeRoot,
      'security/links.md',
      'Links',
      [
        '[Missing](missing.md)',
        '[Escapes](../../outside.md)',
        '[Invalid encoding](bad%ZZ.md)',
        '[External](https://example.com)',
      ].join('\n'),
    );
    const originalContents = readFileSync(source, 'utf8');

    const result = validateInternalLinks(knowledgeRoot);

    expect(result.brokenLinks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourcePath: 'security/links.md',
          target: 'missing.md',
          reason: 'missing',
          context: '[Missing](missing.md)',
        }),
        expect.objectContaining({
          sourcePath: 'security/links.md',
          target: '../../outside.md',
          reason: 'outside-root',
          context: '[Escapes](../../outside.md)',
        }),
        expect.objectContaining({
          target: 'bad%ZZ.md',
          reason: 'invalid-url',
          context: '[Invalid encoding](bad%ZZ.md)',
        }),
      ]),
    );
    expect(result.brokenLinks).toHaveLength(3);
    expect(result.brokenLinks.every(({ line }) => line > 0)).toBe(true);
    expect(existsSync(outsideTarget)).toBe(true);
    expect(readFileSync(source, 'utf8')).toBe(originalContents);
  });

  it('does not follow a symlink target outside the knowledge root', (context) => {
    const knowledgeRoot = createKnowledgeRoot();
    const outsideTarget = join(temporaryDirectories[0] ?? '', 'outside-secret.md');
    writeFileSync(outsideTarget, 'outside');
    const source = createDocument(
      knowledgeRoot,
      'links.md',
      'Links',
      '[Outside](linked.md)',
    );
    try {
      symlinkSync(outsideTarget, join(knowledgeRoot, 'linked.md'), 'file');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EPERM' || code === 'EACCES' || code === 'ENOTSUP') {
        context.skip('File symlinks are unavailable in this environment.');
        return;
      }
      throw error;
    }
    const originalContents = readFileSync(source, 'utf8');

    expect(validateInternalLinks(knowledgeRoot).brokenLinks).toContainEqual(
      expect.objectContaining({ target: 'linked.md', reason: 'symlink' }),
    );
    expect(readFileSync(source, 'utf8')).toBe(originalContents);
    expect(readFileSync(outsideTarget, 'utf8')).toBe('outside');
  });

  it('returns an empty result for a missing, uninitialized knowledge root', () => {
    const knowledgeRoot = createKnowledgeRoot();

    expect(validateInternalLinks(knowledgeRoot)).toEqual({
      filesScanned: 0,
      linksChecked: 0,
      brokenLinks: [],
    });
    expect(existsSync(knowledgeRoot)).toBe(false);
  });

  it('exposes a read-only CLI command that exits nonzero for broken links', async () => {
    const dataRoot = createTemporaryDirectory('qlm-link-cli-');
    initializeProject(dataRoot, 'demo');
    const knowledgeRoot = join(dataRoot, 'projects', 'demo', 'knowledge');
    const output: string[] = [];
    const errorOutput: string[] = [];
    const destination: pino.DestinationStream = { write: () => undefined };
    const runtimeFactory = () => ({
      dataRoot,
      logger: createApplicationLogger({ dataRoot, level: 'info', destination }),
    });

    const emptyOutput: string[] = [];
    const emptyExitCode = await runCli(
      ['node', 'qlm', 'validate', '--project', 'demo'],
      { writeOut: (text) => emptyOutput.push(text) },
      { runtimeFactory },
    );
    expect(emptyExitCode).toBe(0);
    expect(emptyOutput.join('')).toContain('no broken links found');

    const source = createDocument(knowledgeRoot, 'links.md', 'Links', '[Missing](missing.md)');
    const originalContents = readFileSync(source, 'utf8');

    const exitCode = await runCli(
      ['node', 'qlm', 'validate', '--project', 'demo'],
      {
        writeOut: (text) => output.push(text),
        writeError: (text) => errorOutput.push(text),
      },
      { runtimeFactory },
    );

    expect(exitCode).toBe(1);
    expect(output.join('')).toContain('links.md:');
    expect(output.join('')).toContain('missing.md');
    expect(errorOutput.join('')).toContain('Found 1 broken internal link');
    expect(readFileSync(source, 'utf8')).toBe(originalContents);
  });
});

function createKnowledgeRoot(): string {
  return join(createTemporaryDirectory('qlm-link-validation-'), 'knowledge');
}

function createTemporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function createDocument(
  knowledgeRoot: string,
  relativePath: string,
  title: string,
  body = `\n# ${title}\n`,
): string {
  return createMarkdownDocument(knowledgeRoot, relativePath, {
    metadata: {
      schema_version: 1,
      title,
      type: 'document',
      depth: relativePath.includes('/') ? 2 : 1,
      status: 'draft',
    },
    body: `\n${body}\n`,
  }).sourcePath;
}
