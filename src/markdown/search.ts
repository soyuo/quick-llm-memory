import { InputError } from '../errors/qlm-error.js';
import { readStoredMarkdownDocument } from './repository.js';
import {
  buildKnowledgeTree,
  type CategoryTreeNode,
  type DocumentTreeNode,
  type KnowledgeTree,
} from './tree.js';

const MAX_EXCERPT_LENGTH = 160;

export interface MarkdownSearchResult {
  path: string;
  title: string;
  excerpt: string;
}

export function searchMarkdownDocuments(
  knowledgeRoot: string,
  query: string,
): MarkdownSearchResult[] {
  if (query.trim().length === 0) {
    throw new InputError('Search query must not be empty.', {
      suggestedAction: 'Provide a non-empty literal search query.',
    });
  }

  const normalizedQuery = query.toLowerCase();
  const tree = buildKnowledgeTree(knowledgeRoot);
  const documents = collectDocuments(tree).sort(compareDocumentPaths);
  const results: MarkdownSearchResult[] = [];

  for (const document of documents) {
    const parsed = readStoredMarkdownDocument(knowledgeRoot, document.path);
    const bodyMatch = parsed.body.toLowerCase().includes(normalizedQuery);
    const titleMatch = document.title.toLowerCase().includes(normalizedQuery);
    const pathMatch = document.path.toLowerCase().includes(normalizedQuery);

    if (!bodyMatch && !titleMatch && !pathMatch) {
      continue;
    }

    const excerptSource = bodyMatch
      ? parsed.body
      : titleMatch
        ? document.title
        : document.path;
    results.push({
      path: document.path,
      title: document.title,
      excerpt: createExcerpt(excerptSource, query),
    });
  }

  return results;
}

function collectDocuments(tree: KnowledgeTree): DocumentTreeNode[] {
  const documents: DocumentTreeNode[] = [];
  const visit = (node: KnowledgeTree | CategoryTreeNode): void => {
    documents.push(...node.documents);
    for (const category of node.categories) {
      visit(category);
    }
  };

  visit(tree);
  return documents;
}

function compareDocumentPaths(left: DocumentTreeNode, right: DocumentTreeNode): number {
  return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
}

function createExcerpt(text: string, query: string): string {
  const flattenedText = text.replace(/\s+/g, ' ').trim();
  if (flattenedText.length <= MAX_EXCERPT_LENGTH) {
    return flattenedText;
  }

  const normalizedQuery = query.replace(/\s+/g, ' ').trim().toLowerCase();
  const matchIndex = flattenedText.toLowerCase().indexOf(normalizedQuery);
  const contentLength = MAX_EXCERPT_LENGTH - 6;
  const desiredStart = matchIndex < 0
    ? 0
    : Math.max(0, matchIndex - Math.floor(contentLength / 2));
  const start = Math.min(desiredStart, flattenedText.length - contentLength);
  const end = start + contentLength;
  const prefix = start > 0 ? '...' : '';
  const suffix = end < flattenedText.length ? '...' : '';

  return `${prefix}${flattenedText.slice(start, end)}${suffix}`;
}
