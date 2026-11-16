import { createHash } from 'node:crypto';
import { unified } from 'unified';
import remarkFrontmatter from 'remark-frontmatter';
import remarkParse from 'remark-parse';
import { ConfigurationError } from '../config/error.js';
import { InputError } from '../errors/qlm-error.js';
import type { ParsedDocument, SourceDocument, SourceSection } from './source.js';

const markdownParser = unified().use(remarkParse).use(remarkFrontmatter, ['yaml']);

interface MarkdownNode {
  type?: string;
  depth?: number;
  value?: string;
  alt?: string;
  children?: MarkdownNode[];
  position?: {
    start?: { offset?: number };
    end?: { offset?: number };
  };
}

export interface DocumentParser {
  supports(format: string): boolean;
  parse(source: SourceDocument): Promise<ParsedDocument>;
}

export class MarkdownDocumentParser implements DocumentParser {
  supports(format: string): boolean {
    return format.toLowerCase() === 'markdown';
  }

  async parse(source: SourceDocument): Promise<ParsedDocument> {
    if (!this.supports(source.format)) {
      throw new InputError(`Unsupported source format: ${source.format}.`, {
        details: { sourceId: source.id, sourcePath: source.path },
        suggestedAction: 'Use the Markdown parser only with Markdown sources.',
      });
    }

    try {
      const tree = markdownParser.parse(source.content) as unknown as MarkdownNode;
      return { sourceId: source.id, sections: extractSections(source, tree) };
    } catch (cause) {
      if (cause instanceof InputError || cause instanceof ConfigurationError) {
        throw cause;
      }
      throw new ConfigurationError('Unable to parse Markdown source.', {
        filePath: source.path,
        cause,
        suggestedAction: 'Check the Markdown source encoding and syntax.',
      });
    }
  }
}

export function extractMarkdownSections(source: SourceDocument): SourceSection[] {
  if (source.format.toLowerCase() !== 'markdown') {
    throw new InputError(`Unsupported source format: ${source.format}.`, {
      details: { sourceId: source.id, sourcePath: source.path },
      suggestedAction: 'Provide a Markdown source document.',
    });
  }

  try {
    const tree = markdownParser.parse(source.content) as unknown as MarkdownNode;
    return extractSections(source, tree);
  } catch (cause) {
    if (cause instanceof InputError || cause instanceof ConfigurationError) {
      throw cause;
    }
    throw new ConfigurationError('Unable to parse Markdown source.', {
      filePath: source.path,
      cause,
      suggestedAction: 'Check the Markdown source encoding and syntax.',
    });
  }
}

function extractSections(source: SourceDocument, tree: MarkdownNode): SourceSection[] {
  const nodes = tree.children ?? [];
  const headings = nodes
    .filter((node) => node.type === 'heading')
    .map((node) => ({
      node,
      depth: node.depth ?? 1,
      start: node.position?.start?.offset,
    }))
    .filter((heading): heading is typeof heading & { start: number } =>
      Number.isSafeInteger(heading.start),
    );

  if (source.content.length === 0 || source.content.trim().length === 0) {
    return [];
  }

  if (headings.length === 0) {
    return [makeSection(source, basenameWithoutExtension(source.path), [], 0, source.content.length)];
  }

  const sections: SourceSection[] = [];
  const firstHeadingStart = headings[0]?.start ?? 0;
  if (firstHeadingStart > 0 && source.content.slice(0, firstHeadingStart).trim().length > 0) {
    sections.push(makeSection(source, 'Introduction', [], 0, firstHeadingStart));
  }

  const headingStack: Array<{ depth: number; title: string }> = [];
  for (let index = 0; index < headings.length; index += 1) {
    const heading = headings[index];
    if (heading === undefined || heading.start === undefined) {
      continue;
    }
    const title =
      markdownText(heading.node).replace(/\s+/g, ' ').trim() || 'Untitled section';
    while (headingStack.length > 0) {
      const parent = headingStack.at(-1);
      if (parent === undefined || parent.depth < heading.depth) {
        break;
      }
      headingStack.pop();
    }
    headingStack.push({ depth: heading.depth, title });

    const nextBoundary = headings[index + 1]?.start;
    const end = nextBoundary ?? source.content.length;
    sections.push(
      makeSection(
        source,
        title,
        headingStack.map((entry) => entry.title),
        heading.start,
        end,
      ),
    );
  }

  return sections;
}

function makeSection(
  source: SourceDocument,
  title: string,
  headingPath: string[],
  startOffset: number,
  endOffset: number,
): SourceSection {
  const content = source.content.slice(startOffset, endOffset);
  const hash = createHash('sha256').update(content, 'utf8').digest('hex');
  const identity = `${source.id}\0${startOffset}\0${endOffset}\0${title}`;
  return {
    id: `section-${createHash('sha256').update(identity).digest('hex').slice(0, 24)}`,
    sourceId: source.id,
    title,
    content,
    headingPath,
    startOffset,
    endOffset,
    tokenCount: Math.max(1, Math.ceil(content.length / 4)),
    hash,
  };
}

function markdownText(node: MarkdownNode): string {
  if (node.type === 'image') {
    return node.alt ?? '';
  }
  if (node.type === 'break') {
    return ' ';
  }
  if (node.value !== undefined) {
    return node.value;
  }
  return (node.children ?? []).map(markdownText).join('');
}

function basenameWithoutExtension(sourcePath: string): string {
  const extension = /\.(?:md|markdown)$/i;
  return sourcePath.split(/[\\/]/).at(-1)?.replace(extension, '') || 'Untitled';
}
