import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigurationError } from '../src/config/error.js';
import { createMarkdownDocument } from '../src/markdown/repository.js';
import { buildKnowledgeTree } from '../src/markdown/tree.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('Markdown knowledge tree', () => {
  it('returns an empty tree without creating a missing knowledge root', () => {
    const knowledgeRoot = createKnowledgeRoot();

    expect(buildKnowledgeTree(knowledgeRoot)).toEqual({
      path: '',
      depth: 0,
      categories: [],
      documents: [],
    });
    expect(existsSync(knowledgeRoot)).toBe(false);
  });

  it('discovers nested categories and validated documents in stable order', () => {
    const knowledgeRoot = createKnowledgeRoot();
    createMarkdownDocument(knowledgeRoot, 'security/authentication.md', {
      metadata: createMetadata('Authentication', 2),
      body: '\n# Authentication\n',
    });
    createMarkdownDocument(knowledgeRoot, 'overview.md', {
      metadata: createMetadata('Overview', 1),
      body: '\n# Overview\n',
    });
    createMarkdownDocument(knowledgeRoot, 'security/vm/create.md', {
      metadata: createMetadata('Create VM', 3),
      body: '\n# Create VM\n',
    });
    mkdirSync(join(knowledgeRoot, 'empty'), { recursive: true });
    mkdirSync(join(knowledgeRoot, 'alpha', 'nested'), { recursive: true });
    writeFileSync(
      join(knowledgeRoot, 'index.md'),
      categoryIndex('knowledge', 'Knowledge', 1),
      'utf8',
    );
    writeFileSync(
      join(knowledgeRoot, 'security', 'index.md'),
      categoryIndex('security', 'Security', 1),
      'utf8',
    );

    const tree = buildKnowledgeTree(knowledgeRoot);

    expect(tree.documents).toEqual([
      expect.objectContaining({
        type: 'document',
        name: 'overview.md',
        title: 'Overview',
        path: 'overview.md',
        depth: 1,
      }),
    ]);
    expect(tree.categories.map(({ name }) => name)).toEqual([
      'alpha',
      'empty',
      'security',
    ]);
    expect(tree.categories[0]).toMatchObject({
      path: 'alpha',
      depth: 1,
      categories: [{ name: 'nested', path: 'alpha/nested', depth: 2 }],
      documents: [],
    });
    expect(tree.categories[1]).toMatchObject({
      name: 'empty',
      path: 'empty',
      depth: 1,
      categories: [],
      documents: [],
    });
    expect(tree.categories[2]).toMatchObject({
      name: 'security',
      title: 'Security',
      depth: 1,
      documents: [
        expect.objectContaining({
          name: 'authentication.md',
          title: 'Authentication',
          path: 'security/authentication.md',
          depth: 2,
        }),
      ],
      categories: [
        expect.objectContaining({
          name: 'vm',
          path: 'security/vm',
          depth: 2,
          documents: [
            expect.objectContaining({
              name: 'create.md',
              path: 'security/vm/create.md',
              depth: 3,
            }),
          ],
        }),
      ],
    });
    expect(JSON.stringify(tree)).not.toContain('index.md');
  });

  it('reports invalid Markdown metadata with the document path', () => {
    const knowledgeRoot = createKnowledgeRoot();
    mkdirSync(knowledgeRoot, { recursive: true });
    const filePath = join(knowledgeRoot, 'invalid.md');
    writeFileSync(
      filePath,
      '---\nschema_version: 1\nid: invalid\ntitle: Invalid\ntype: document\ndepth: wrong\nstatus: draft\n---\n\nBody\n',
      'utf8',
    );

    try {
      buildKnowledgeTree(knowledgeRoot);
      throw new Error('Expected invalid document metadata to fail.');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigurationError);
      expect((error as ConfigurationError).filePath).toBe(filePath);
    }
  });

  it('reports malformed category index metadata with its path', () => {
    const knowledgeRoot = createKnowledgeRoot();
    const categoryDirectory = join(knowledgeRoot, 'security');
    mkdirSync(categoryDirectory, { recursive: true });
    const filePath = join(categoryDirectory, 'index.md');
    writeFileSync(filePath, '---\nid: security\ntype: category-index\n---\n', 'utf8');

    try {
      buildKnowledgeTree(knowledgeRoot);
      throw new Error('Expected invalid category index metadata to fail.');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigurationError);
      expect((error as ConfigurationError).filePath).toBe(filePath);
    }
  });

  it('skips symlinked directories', (context) => {
    const knowledgeRoot = createKnowledgeRoot();
    const outsideDirectory = join(temporaryDirectories[0] ?? '', 'outside');
    mkdirSync(knowledgeRoot, { recursive: true });
    mkdirSync(outsideDirectory);
    writeFileSync(
      join(outsideDirectory, 'outside.md'),
      serializeDocument('outside', 'Outside'),
      'utf8',
    );

    try {
      symlinkSync(
        outsideDirectory,
        join(knowledgeRoot, 'linked-category'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EPERM' || code === 'EACCES' || code === 'ENOTSUP') {
        context.skip('Directory symlinks are unavailable in this environment.');
        return;
      }
      throw error;
    }

    expect(buildKnowledgeTree(knowledgeRoot)).toMatchObject({
      categories: [],
      documents: [],
    });
  });

  it('skips symlinked Markdown files', (context) => {
    const knowledgeRoot = createKnowledgeRoot();
    const outsideDirectory = join(temporaryDirectories[0] ?? '', 'outside');
    mkdirSync(knowledgeRoot, { recursive: true });
    mkdirSync(outsideDirectory);
    const outsideFile = join(outsideDirectory, 'outside.md');
    writeFileSync(outsideFile, serializeDocument('outside', 'Outside'), 'utf8');

    try {
      symlinkSync(outsideFile, join(knowledgeRoot, 'linked-document.md'), 'file');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EPERM' || code === 'EACCES' || code === 'ENOTSUP') {
        context.skip('File symlinks are unavailable in this environment.');
        return;
      }
      throw error;
    }

    expect(buildKnowledgeTree(knowledgeRoot)).toMatchObject({
      categories: [],
      documents: [],
    });
  });
});

function createKnowledgeRoot(): string {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'qlm-markdown-tree-')));
  temporaryDirectories.push(directory);
  return join(directory, 'knowledge');
}

function createMetadata(title: string, depth: number) {
  return {
    schema_version: 1 as const,
    title,
    type: 'document' as const,
    depth,
    status: 'draft',
  };
}

function categoryIndex(id: string, title: string, depth: number): string {
  return `---\nid: ${id}\ntitle: ${title}\ntype: category-index\ndepth: ${depth}\n---\n\n# ${title}\n`;
}

function serializeDocument(id: string, title: string): string {
  return `---\nschema_version: 1\nid: ${id}\ntitle: ${title}\ntype: document\ndepth: 1\nstatus: draft\n---\n\n# ${title}\n`;
}
