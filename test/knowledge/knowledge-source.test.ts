import {
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigurationError } from '../../src/config/error.js';
import { InputError } from '../../src/errors/qlm-error.js';
import {
  extractMarkdownSections,
  MarkdownDocumentParser,
} from '../../src/knowledge/markdown-parser.js';
import { loadMarkdownSources } from '../../src/knowledge/source.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('loadMarkdownSources', () => {
  it('loads Markdown files in deterministic relative-path order with stable metadata', () => {
    const root = makeTempDirectory();
    mkdirSync(join(root, 'nested'));
    writeFileSync(join(root, 'z.md'), '# Z\n');
    writeFileSync(join(root, 'nested', 'a.markdown'), '# A\n');
    writeFileSync(join(root, 'ignore.txt'), 'not Markdown');

    const first = loadMarkdownSources(root);
    const second = loadMarkdownSources(root);

    expect(first.map((source) => source.path)).toEqual(['nested/a.markdown', 'z.md']);
    expect(first.map((source) => source.id)).toEqual(second.map((source) => source.id));
    expect(first.map((source) => source.hash)).toEqual(second.map((source) => source.hash));
    expect(first[0]).toMatchObject({
      format: 'markdown',
      content: '# A\n',
      size: Buffer.byteLength('# A\n'),
      metadata: {},
    });
    expect(first[0]?.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(first[0]?.modifiedAt).toBe(new Date(lstatSync(join(root, 'nested', 'a.markdown')).mtime).toISOString());
  });

  it('loads a single Markdown file with a relative path and excludes unsupported directory entries', () => {
    const root = makeTempDirectory();
    const filePath = join(root, 'spec.md');
    const secondRoot = join(root, 'other');
    mkdirSync(secondRoot);
    const secondFilePath = join(secondRoot, 'spec.md');
    const original = Buffer.from('# Specification\n');
    writeFileSync(filePath, original);
    writeFileSync(secondFilePath, original);

    const sources = loadMarkdownSources(filePath);
    const secondSource = loadMarkdownSources(secondFilePath)[0];

    expect(sources).toHaveLength(1);
    expect(sources[0]?.path).toBe('spec.md');
    expect(secondSource?.id).not.toBe(sources[0]?.id);
    expect(readFileSync(filePath)).toEqual(original);
    expect(loadMarkdownSources(root).map((source) => source.path)).toEqual([
      'other/spec.md',
      'spec.md',
    ]);
  });

  it('reports unsupported single-file inputs and malformed UTF-8 with path-aware errors', () => {
    const root = makeTempDirectory();
    const unsupportedPath = join(root, 'spec.txt');
    const malformedPath = join(root, 'malformed.md');
    writeFileSync(unsupportedPath, 'text');
    writeFileSync(malformedPath, Buffer.from([0xc3, 0x28]));

    expect(() => loadMarkdownSources(unsupportedPath)).toThrow(InputError);
    try {
      loadMarkdownSources(malformedPath);
      expect.fail('Expected invalid UTF-8 to be rejected.');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigurationError);
      expect((error as ConfigurationError).filePath).toBe(malformedPath);
    }
  });
});

describe('MarkdownDocumentParser', () => {
  it('extracts ordered, non-overlapping sections with heading paths, exact offsets and hashes', async () => {
    const root = makeTempDirectory();
    const filePath = join(root, 'spec.md');
    const content = [
      'Prelude text.',
      '',
      '# Root',
      'Root body.',
      '## Child **bold**',
      'Child body.',
      '# Next',
      'Last body.',
      '',
    ].join('\n');
    writeFileSync(filePath, content);
    const [source] = loadMarkdownSources(filePath);
    expect(source).toBeDefined();
    if (source === undefined) {
      throw new Error('Expected the Markdown source to load.');
    }

    const parser = new MarkdownDocumentParser();
    const parsed = await parser.parse(source);

    expect(parser.supports('markdown')).toBe(true);
    expect(parser.supports('pdf')).toBe(false);
    expect(parsed.sourceId).toBe(source.id);
    expect(parsed.sections.map(({ title, headingPath }) => ({ title, headingPath }))).toEqual([
      { title: 'Introduction', headingPath: [] },
      { title: 'Root', headingPath: ['Root'] },
      { title: 'Child bold', headingPath: ['Root', 'Child bold'] },
      { title: 'Next', headingPath: ['Next'] },
    ]);

    let previousEnd = 0;
    for (const section of parsed.sections) {
      expect(section.sourceId).toBe(source.id);
      expect(section.startOffset).toBeGreaterThanOrEqual(previousEnd);
      expect(section.endOffset).toBeGreaterThan(section.startOffset);
      expect(source.content.slice(section.startOffset, section.endOffset)).toBe(section.content);
      expect(section.hash).toMatch(/^[a-f0-9]{64}$/);
      expect(section.tokenCount).toBeGreaterThan(0);
      expect(section.id).toMatch(/^section-[a-f0-9]{24}$/);
      previousEnd = section.endOffset;
    }
    expect(parsed.sections.map((section) => section.id)).toEqual(
      extractMarkdownSections(source).map((section) => section.id),
    );
    expect(readFileSync(filePath, 'utf8')).toBe(content);
  });

  it('returns no sections for empty input and one file-titled section without headings', async () => {
    const root = makeTempDirectory();
    const emptyPath = join(root, 'empty.md');
    const plainPath = join(root, 'plain.md');
    writeFileSync(emptyPath, ' \n');
    writeFileSync(plainPath, 'A plain specification without headings.');
    const [empty, plain] = [
      ...loadMarkdownSources(emptyPath),
      ...loadMarkdownSources(plainPath),
    ];
    expect(empty).toBeDefined();
    expect(plain).toBeDefined();
    if (empty === undefined || plain === undefined) {
      throw new Error('Expected both Markdown sources to load.');
    }

    const parser = new MarkdownDocumentParser();
    await expect(parser.parse(empty)).resolves.toMatchObject({ sections: [] });
    await expect(parser.parse(plain)).resolves.toMatchObject({
      sections: [
        {
          title: 'plain',
          headingPath: [],
          content: 'A plain specification without headings.',
          startOffset: 0,
          endOffset: plain.content.length,
        },
      ],
    });
  });

  it('keeps heading paths compact when Markdown skips heading levels', async () => {
    const root = makeTempDirectory();
    const filePath = join(root, 'skipped-levels.md');
    writeFileSync(filePath, '### Deep topic\nContent.\n');
    const source = loadMarkdownSources(filePath)[0];
    expect(source).toBeDefined();
    if (source === undefined) {
      throw new Error('Expected the Markdown source to load.');
    }

    const parsed = await new MarkdownDocumentParser().parse(source);

    expect(parsed.sections).toMatchObject([
      { title: 'Deep topic', headingPath: ['Deep topic'] },
    ]);
    expect(parsed.sections[0]?.headingPath.every((part) => part.length > 0)).toBe(true);
  });

  it('rejects unsupported source formats', async () => {
    const source = {
      id: 'source-1',
      path: 'spec.pdf',
      format: 'pdf',
      content: 'ignored',
      hash: '0'.repeat(64),
      size: 7,
      modifiedAt: new Date(0).toISOString(),
      metadata: {},
    } as const;

    await expect(new MarkdownDocumentParser().parse(source)).rejects.toBeInstanceOf(InputError);
    expect(() => extractMarkdownSections(source)).toThrow(InputError);
  });
});

function makeTempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'qlm-knowledge-source-'));
  temporaryDirectories.push(directory);
  return directory;
}
