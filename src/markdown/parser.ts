import { readFileSync } from 'node:fs';
import { unified } from 'unified';
import remarkFrontmatter from 'remark-frontmatter';
import remarkParse from 'remark-parse';
import { parse as parseYaml } from 'yaml';
import { ConfigurationError } from '../config/error.js';
import {
  categoryIndexFrontmatterSchema,
  documentFrontmatterSchema,
  type MarkdownFrontmatter,
} from './schema.js';

const markdownParser = unified().use(remarkParse).use(remarkFrontmatter, [
  'yaml',
]);

interface YamlFrontmatterNode {
  type: 'yaml';
  value: string;
  position?: {
    end?: {
      offset?: number;
    };
  };
}

export interface ParsedMarkdownDocument {
  metadata: MarkdownFrontmatter;
  body: string;
  sourcePath: string;
}

export function parseMarkdownDocument(
  markdown: string,
  sourcePath: string,
): ParsedMarkdownDocument {
  const tree = markdownParser.parse(markdown);
  const firstNode = tree.children[0] as unknown as
    | YamlFrontmatterNode
    | undefined;

  if (firstNode?.type !== 'yaml' || typeof firstNode.value !== 'string') {
    throw new ConfigurationError('Markdown file is missing YAML frontmatter.', {
      filePath: sourcePath,
      suggestedAction:
        'Add a YAML frontmatter block with the required document or category-index fields.',
    });
  }

  let rawMetadata: unknown;
  try {
    rawMetadata = parseYaml(firstNode.value);
  } catch (cause) {
    throw new ConfigurationError('Unable to parse Markdown frontmatter YAML.', {
      filePath: sourcePath,
      cause,
      suggestedAction: 'Correct the YAML syntax in the frontmatter block.',
    });
  }

  const metadata = validateFrontmatter(rawMetadata, sourcePath);
  const bodyOffset = firstNode.position?.end?.offset;
  if (bodyOffset === undefined) {
    throw new ConfigurationError('Unable to locate the Markdown body.', {
      filePath: sourcePath,
      suggestedAction: 'Check that the Markdown frontmatter block is complete.',
    });
  }

  return {
    metadata,
    body: markdown.slice(bodyOffset),
    sourcePath,
  };
}

export function readMarkdownDocument(filePath: string): ParsedMarkdownDocument {
  let markdown: string;
  try {
    markdown = readFileSync(filePath, 'utf8');
  } catch (cause) {
    throw new ConfigurationError('Unable to read Markdown file.', {
      filePath,
      cause,
      suggestedAction: 'Check that the file exists and is readable.',
    });
  }

  return parseMarkdownDocument(markdown, filePath);
}

function validateFrontmatter(
  value: unknown,
  sourcePath: string,
): MarkdownFrontmatter {
  const rawType =
    typeof value === 'object' && value !== null && 'type' in value
      ? value.type
      : undefined;
  const schema =
    rawType === 'document'
      ? documentFrontmatterSchema
      : rawType === 'category-index'
        ? categoryIndexFrontmatterSchema
        : undefined;

  if (schema === undefined) {
    throw new ConfigurationError(
      `Invalid Markdown frontmatter type ${JSON.stringify(rawType)}; supported types are document and category-index.`,
      {
        filePath: sourcePath,
        suggestedAction:
          'Set the frontmatter type to document or category-index.',
      },
    );
  }

  const result = schema.safeParse(value);
  if (result.success) {
    return result.data;
  }

  const issueSummary = result.error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : 'frontmatter';
      return `${path}: ${issue.message}`;
    })
    .join('; ');

  throw new ConfigurationError(
    `Invalid Markdown frontmatter: ${issueSummary}`,
    {
      filePath: sourcePath,
      suggestedAction:
        'Provide the required fields and a supported type: document or category-index.',
    },
  );
}
