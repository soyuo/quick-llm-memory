import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigurationError } from '../../src/config/error.js';
import { InputError } from '../../src/errors/qlm-error.js';
import { generateCategoryIndexes } from '../../src/markdown/index-generator.js';
import { createMarkdownDocument } from '../../src/markdown/repository.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('category index generator', () => {
  it('creates the knowledge root and its index when the root is missing', () => {
    const knowledgeRoot = createKnowledgeRoot();

    expect(generateCategoryIndexes(knowledgeRoot)).toEqual({
      created: ['index.md'],
      updated: [],
      unchanged: [],
    });
    expect(readFileSync(join(knowledgeRoot, 'index.md'), 'utf8')).toContain(
      'id: knowledge',
    );
  });

  it('creates root and nested indexes with deterministic relative links', () => {
    const knowledgeRoot = createKnowledgeRoot();
    createMarkdownDocument(knowledgeRoot, 'security/authentication.md', {
      metadata: {
        schema_version: 1,
        title: 'Authentication',
        type: 'document',
        depth: 2,
        status: 'draft',
      },
      body: '\n# Authentication\n',
    });
    createMarkdownDocument(knowledgeRoot, 'overview.md', {
      metadata: {
        schema_version: 1,
        title: 'Overview',
        type: 'document',
        depth: 1,
        status: 'draft',
      },
      body: '\n# Overview\n',
    });

    expect(generateCategoryIndexes(knowledgeRoot)).toEqual({
      created: ['index.md', 'security/index.md'],
      updated: [],
      unchanged: [],
    });

    const rootIndex = readFileSync(join(knowledgeRoot, 'index.md'), 'utf8');
    const securityIndex = readFileSync(
      join(knowledgeRoot, 'security', 'index.md'),
      'utf8',
    );
    expect(rootIndex).toContain('id: knowledge');
    expect(rootIndex).toContain('depth: 0');
    expect(rootIndex).toContain('# Knowledge');
    expect(rootIndex).toContain('[security/](security/index.md)');
    expect(rootIndex).toContain('[overview.md](overview.md)');
    expect(securityIndex).toContain('id: security');
    expect(securityIndex).toContain('depth: 1');
    expect(securityIndex).toContain('# security');
    expect(securityIndex).toContain('[authentication.md](authentication.md)');

    expect(generateCategoryIndexes(knowledgeRoot)).toEqual({
      created: [],
      updated: [],
      unchanged: ['index.md', 'security/index.md'],
    });
  });

  it('updates only generated listings and preserves metadata and manual prose', () => {
    const knowledgeRoot = createKnowledgeRoot();
    mkdirSync(join(knowledgeRoot, 'security'), { recursive: true });
    generateCategoryIndexes(knowledgeRoot);

    const rootIndexPath = join(knowledgeRoot, 'index.md');
    const original = readFileSync(rootIndexPath, 'utf8');
    writeFileSync(
      rootIndexPath,
      original
        .replace('title: Knowledge', 'title: Team Knowledge')
        .replace(
          '<!-- qlm:generated-listing:start -->',
          'Manual introduction.\n\n<!-- qlm:generated-listing:start -->',
        )
        .replace(
          '<!-- qlm:generated-listing:end -->',
          '<!-- qlm:generated-listing:end -->\n\n## Related\n\n- ../api/index.md\n\nManual footer.',
        ),
      'utf8',
    );
    createMarkdownDocument(knowledgeRoot, 'security/review.md', {
      metadata: {
        schema_version: 1,
        title: 'Security Review',
        type: 'document',
        depth: 2,
        status: 'draft',
      },
      body: '\n# Security Review\n',
    });

    expect(generateCategoryIndexes(knowledgeRoot)).toEqual({
      created: [],
      updated: ['security/index.md'],
      unchanged: ['index.md'],
    });
    const updated = readFileSync(rootIndexPath, 'utf8');
    const updatedSecurityIndex = readFileSync(
      join(knowledgeRoot, 'security', 'index.md'),
      'utf8',
    );
    expect(updated).toContain('title: Team Knowledge');
    expect(updated).toContain('Manual introduction.');
    expect(updated).toContain('Manual footer.');
    expect(updated).toContain('- ../api/index.md');
    expect(updatedSecurityIndex).toContain('[review.md](review.md)');
  });

  it('preflights all indexes before writing when an existing index is unmarked', () => {
    const knowledgeRoot = createKnowledgeRoot();
    mkdirSync(join(knowledgeRoot, 'security'), { recursive: true });
    const manualIndex = categoryIndex('security', 'Security', 1);
    writeFileSync(join(knowledgeRoot, 'security', 'index.md'), manualIndex, 'utf8');

    expect(() => generateCategoryIndexes(knowledgeRoot)).toThrow(InputError);
    expect(existsSync(join(knowledgeRoot, 'index.md'))).toBe(false);
    expect(readFileSync(join(knowledgeRoot, 'security', 'index.md'), 'utf8')).toBe(
      manualIndex,
    );
  });

  it('reports an unmarked malformed index as a conflict without changing it', () => {
    const knowledgeRoot = createKnowledgeRoot();
    mkdirSync(join(knowledgeRoot, 'security'), { recursive: true });
    const manualIndex = '---\nid: security\ntitle: [invalid\n---\n';
    const indexPath = join(knowledgeRoot, 'security', 'index.md');
    writeFileSync(indexPath, manualIndex, 'utf8');

    expect(() => generateCategoryIndexes(knowledgeRoot)).toThrow(InputError);
    expect(existsSync(join(knowledgeRoot, 'index.md'))).toBe(false);
    expect(readFileSync(indexPath, 'utf8')).toBe(manualIndex);
  });

  it('rejects generated indexes whose metadata depth does not match the category path', () => {
    const knowledgeRoot = createKnowledgeRoot();
    mkdirSync(join(knowledgeRoot, 'security'), { recursive: true });
    generateCategoryIndexes(knowledgeRoot);
    const indexPath = join(knowledgeRoot, 'security', 'index.md');
    const original = readFileSync(indexPath, 'utf8');
    writeFileSync(indexPath, original.replace('depth: 1', 'depth: 0'), 'utf8');

    expect(() => generateCategoryIndexes(knowledgeRoot)).toThrow(ConfigurationError);
  });
});

function createKnowledgeRoot(): string {
  const directory = mkdtempSync(join(tmpdir(), 'qlm-category-index-'));
  temporaryDirectories.push(directory);
  return join(directory, 'knowledge');
}

function categoryIndex(id: string, title: string, depth: number): string {
  return `---\nid: ${id}\ntitle: ${title}\ntype: category-index\ndepth: ${depth}\n---\n\n# ${title}\n`;
}
