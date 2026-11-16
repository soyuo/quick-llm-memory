import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigurationError } from '../src/config/error.js';
import {
  parseMarkdownDocument,
  readMarkdownDocument,
} from '../src/markdown/parser.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('parseMarkdownDocument', () => {
  it('validates regular document frontmatter and preserves the body exactly', () => {
    const body = '\n\n# Authentication\n\nBody stays as written.\n';
    const source = [
      '---',
      'schema_version: 1',
      'id: security.authentication',
      'title: Authentication',
      'type: document',
      'depth: 2',
      'status: verified',
      'category: security',
      'tags:',
      '  - security',
      'source_ids:',
      '  - source-001',
      'source_sections:',
      '  - source-001:section-12',
      'related:',
      '  - security.authorization',
      'created_at: 2026-11-16T00:00:00Z',
      'updated_at: 2026-11-16T00:00:00Z',
      'generation:',
      '  provider: openai',
      '  model: configured-model',
      '  revision: 1',
      '---',
    ].join('\n') + body;

    const parsed = parseMarkdownDocument(source, 'knowledge/security/authentication.md');

    expect(parsed.metadata).toMatchObject({
      schema_version: 1,
      id: 'security.authentication',
      title: 'Authentication',
      type: 'document',
      depth: 2,
      status: 'verified',
      category: 'security',
      tags: ['security'],
      source_ids: ['source-001'],
      source_sections: ['source-001:section-12'],
      related: ['security.authorization'],
      created_at: '2026-11-16T00:00:00Z',
      updated_at: '2026-11-16T00:00:00Z',
      generation: {
        provider: 'openai',
        model: 'configured-model',
        revision: 1,
      },
    });
    expect(parsed.body).toBe(body);
    expect(parsed.sourcePath).toBe('knowledge/security/authentication.md');
    expect(source).toContain(body);
  });

  it('validates category index metadata without document-only fields', () => {
    const parsed = parseMarkdownDocument(
      '---\nid: security\ntitle: Security\ntype: category-index\ndepth: 1\n---\n\n# Security\n',
      'knowledge/security/index.md',
    );

    expect(parsed.metadata).toEqual({
      id: 'security',
      title: 'Security',
      type: 'category-index',
      depth: 1,
    });
    expect(parsed.body).toBe('\n\n# Security\n');
  });

  it('accepts depth zero for the knowledge root index', () => {
    const parsed = parseMarkdownDocument(
      '---\nid: knowledge\ntitle: Knowledge\ntype: category-index\ndepth: 0\n---\n\n# Knowledge\n',
      'knowledge/index.md',
    );

    expect(parsed.metadata).toMatchObject({
      id: 'knowledge',
      title: 'Knowledge',
      type: 'category-index',
      depth: 0,
    });
  });

  it('reads Markdown from disk and reports the source path', () => {
    const directory = mkdtempSync(join(tmpdir(), 'qlm-markdown-'));
    temporaryDirectories.push(directory);
    const filePath = join(directory, 'note.md');
    writeFileSync(
      filePath,
      '---\nschema_version: 1\nid: note\ntitle: Note\ntype: document\ndepth: 1\nstatus: draft\n---\nText\n',
    );

    const parsed = readMarkdownDocument(filePath);

    expect(parsed.sourcePath).toBe(filePath);
    expect(parsed.body).toBe('\nText\n');
    expect(readFileSync(filePath, 'utf8')).toContain('title: Note');
  });

  it('returns a path-aware typed error for missing frontmatter', () => {
    expect(() => parseMarkdownDocument('# No metadata\n', 'notes/missing.md')).toThrow(
      ConfigurationError,
    );
    try {
      parseMarkdownDocument('# No metadata\n', 'notes/missing.md');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigurationError);
      expect((error as ConfigurationError).filePath).toBe('notes/missing.md');
    }
  });

  it('returns a path-aware typed error for malformed YAML', () => {
    expect(() =>
      parseMarkdownDocument('---\ntitle: [\n---\nBody', 'broken.md'),
    ).toThrow(ConfigurationError);
    expect(() =>
      parseMarkdownDocument('---\ntitle: [\n---\nBody', 'broken.md'),
    ).toThrow(/frontmatter YAML/);
  });

  it.each([
    ['missing required field', '---\ntype: document\n---\n', /schema_version/],
    [
      'unsupported type',
      '---\nid: x\ntitle: X\ntype: source\ndepth: 1\nstatus: draft\nschema_version: 1\n---\n',
      /supported type/,
    ],
    [
      'invalid required value',
      '---\nschema_version: 1\nid: x\ntitle: X\ntype: document\ndepth: deep\nstatus: draft\n---\n',
      /depth/,
    ],
    [
      'depth below SPEC minimum',
      '---\nschema_version: 1\nid: x\ntitle: X\ntype: document\ndepth: 0\nstatus: draft\n---\n',
      /depth/,
    ],
    [
      'malformed optional tags',
      '---\nschema_version: 1\nid: x\ntitle: X\ntype: document\ndepth: 1\nstatus: draft\ntags: 42\n---\n',
      /tags/,
    ],
    [
      'malformed optional generation metadata',
      '---\nschema_version: 1\nid: x\ntitle: X\ntype: document\ndepth: 1\nstatus: draft\ngeneration: nope\n---\n',
      /generation/,
    ],
  ])('rejects %s with source path', (_case, source, message) => {
    expect(() => parseMarkdownDocument(source, 'invalid.md')).toThrow(
      ConfigurationError,
    );
    try {
      parseMarkdownDocument(source, 'invalid.md');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigurationError);
      expect((error as ConfigurationError).filePath).toBe('invalid.md');
      expect((error as Error).message).toMatch(message);
    }
  });

  it('reports file read failures through the shared typed error system', () => {
    expect(() => readMarkdownDocument('missing-markdown-file.md')).toThrow(
      ConfigurationError,
    );
  });
});
