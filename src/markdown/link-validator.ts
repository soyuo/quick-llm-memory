import { lstatSync, readdirSync, readFileSync, type Dirent } from 'node:fs';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { unified } from 'unified';
import remarkFrontmatter from 'remark-frontmatter';
import remarkParse from 'remark-parse';
import { ConfigurationError } from '../config/error.js';
import { InputError } from '../errors/qlm-error.js';
import { parseMarkdownDocument } from './parser.js';
import { resolveKnowledgeRoot } from './repository.js';

const markdownParser = unified().use(remarkParse).use(remarkFrontmatter, ['yaml']);

export type BrokenLinkReason =
  | 'missing'
  | 'outside-root'
  | 'symlink'
  | 'invalid-url';

export interface BrokenMarkdownLink {
  sourcePath: string;
  target: string;
  line: number;
  context: string;
  reason: BrokenLinkReason;
}

export interface InternalLinkValidationResult {
  filesScanned: number;
  linksChecked: number;
  brokenLinks: BrokenMarkdownLink[];
}

interface MarkdownAstNode {
  type?: unknown;
  url?: unknown;
  identifier?: unknown;
  children?: unknown;
  position?: {
    start?: {
      line?: unknown;
    };
  };
}

interface LinkReference {
  node: MarkdownAstNode;
  target: string;
}

type TargetInspection = 'file' | 'directory' | 'missing' | 'symlink';
type NormalizedTarget =
  | { kind: 'ignore' }
  | { kind: 'external' }
  | { kind: 'local'; path: string };

export function validateInternalLinks(
  knowledgeRoot: string,
): InternalLinkValidationResult {
  if (knowledgeRoot.trim().length === 0) {
    throw new InputError('Knowledge root must be a non-empty path.');
  }

  const requestedRoot = resolve(knowledgeRoot);
  try {
    lstatSync(requestedRoot);
  } catch (cause) {
    if (isMissingPathError(cause)) {
      return { filesScanned: 0, linksChecked: 0, brokenLinks: [] };
    }
    throw directoryReadError(requestedRoot, cause);
  }

  const root = resolveKnowledgeRoot(requestedRoot);
  const files = scanMarkdownFiles(root, root);
  const result: InternalLinkValidationResult = {
    filesScanned: files.length,
    linksChecked: 0,
    brokenLinks: [],
  };

  for (const sourcePath of files) {
    const contents = readMarkdownFile(sourcePath);
    parseMarkdownDocument(contents, sourcePath);
    const lineContents = contents.split(/\r?\n/);
    const links = collectLinks(contents, sourcePath);
    for (const { node, target } of links) {
      const line = getNodeLine(node);
      const normalized = normalizeTarget(target);
      if (normalized.kind === 'ignore') {
        continue;
      }

      result.linksChecked += 1;
      if (normalized.kind === 'external') {
        continue;
      }

      const problem = validateTarget(
        root,
        sourcePath,
        target,
        normalized.path,
        line,
        lineContents[line - 1] ?? '',
      );
      if (problem !== undefined) {
        result.brokenLinks.push(problem);
      }
    }
  }

  return result;
}

function scanMarkdownFiles(root: string, directory: string): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch (cause) {
    throw directoryReadError(directory, cause);
  }

  const files: string[] = [];
  for (const entry of entries.sort((left, right) => compareNames(left.name, right.name))) {
    if (entry.isSymbolicLink()) {
      continue;
    }

    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...scanMarkdownFiles(root, entryPath));
    } else if (entry.isFile() && extname(entry.name).toLowerCase() === '.md') {
      files.push(entryPath);
    }
  }

  return files;
}

function readMarkdownFile(sourcePath: string): string {
  try {
    return readFileSync(sourcePath, 'utf8');
  } catch (cause) {
    throw new ConfigurationError(`Unable to read Markdown file: ${sourcePath}`, {
      filePath: sourcePath,
      cause,
      suggestedAction: 'Check that the Markdown file is readable.',
    });
  }
}

function collectLinks(markdown: string, sourcePath: string): LinkReference[] {
  let tree: MarkdownAstNode;
  try {
    tree = markdownParser.parse(markdown) as unknown as MarkdownAstNode;
  } catch (cause) {
    throw new ConfigurationError(`Unable to parse Markdown links: ${sourcePath}`, {
      filePath: sourcePath,
      cause,
      suggestedAction: 'Check the Markdown syntax and link destinations.',
    });
  }

  const definitions = new Map<string, string>();
  walkMarkdownAst(tree, (node) => {
    if (
      node.type === 'definition' &&
      typeof node.identifier === 'string' &&
      typeof node.url === 'string'
    ) {
      definitions.set(normalizeReference(node.identifier), node.url);
    }
  });

  const links: LinkReference[] = [];
  walkMarkdownAst(tree, (node) => {
    if (
      (node.type === 'link' || node.type === 'image') &&
      typeof node.url === 'string'
    ) {
      links.push({ node, target: node.url });
      return;
    }

    if (
      (node.type === 'linkReference' || node.type === 'imageReference') &&
      typeof node.identifier === 'string'
    ) {
      const target = definitions.get(normalizeReference(node.identifier));
      if (target !== undefined) {
        links.push({ node, target });
      }
    }
  });

  return links;
}

function walkMarkdownAst(
  node: MarkdownAstNode,
  visit: (node: MarkdownAstNode) => void,
): void {
  visit(node);
  if (!Array.isArray(node.children)) {
    return;
  }
  for (const child of node.children) {
    if (typeof child === 'object' && child !== null) {
      walkMarkdownAst(child as MarkdownAstNode, visit);
    }
  }
}

function normalizeReference(identifier: string): string {
  return identifier.trim().replace(/\s+/g, ' ').toLowerCase();
}

function normalizeTarget(
  target: string,
): NormalizedTarget {
  const trimmed = target.trim();
  if (trimmed.length === 0 || trimmed.startsWith('#') || trimmed.startsWith('?')) {
    return { kind: 'ignore' };
  }

  if (trimmed.startsWith('//')) {
    return { kind: 'external' };
  }

  if (/^[a-z]:[\\/]/i.test(trimmed)) {
    return { kind: 'local', path: trimmed };
  }

  if (/^[a-z][a-z\d+.-]*:/i.test(trimmed)) {
    return /^file:/i.test(trimmed)
      ? { kind: 'local', path: trimmed }
      : { kind: 'external' };
  }

  const suffixIndex = [trimmed.indexOf('#'), trimmed.indexOf('?')]
    .filter((index) => index >= 0)
    .reduce((left, right) => Math.min(left, right), trimmed.length);
  const path = trimmed.slice(0, suffixIndex);
  if (path.length === 0) {
    return { kind: 'ignore' };
  }

  try {
    return { kind: 'local', path: decodeURIComponent(path) };
  } catch {
    return { kind: 'local', path: '' };
  }
}

function validateTarget(
  root: string,
  sourcePath: string,
  rawTarget: string,
  localPath: string,
  line: number,
  context: string,
): BrokenMarkdownLink | undefined {
  const sourceRelativePath = toPortableRelativePath(root, sourcePath);
  if (localPath.length === 0 || /^file:/i.test(localPath)) {
    return createBrokenLink(
      sourceRelativePath,
      rawTarget,
      line,
      context,
      localPath.length === 0 ? 'invalid-url' : 'outside-root',
    );
  }

  const normalizedPath = localPath.replace(/\\/g, '/');
  if (/^[a-z]:\//i.test(normalizedPath)) {
    return createBrokenLink(sourceRelativePath, rawTarget, line, context, 'outside-root');
  }

  const absoluteTarget = normalizedPath.startsWith('/')
    ? resolve(root, normalizedPath.slice(1))
    : resolve(root, sourceRelativePath.split('/').slice(0, -1).join('/'), normalizedPath);
  const pathFromRoot = relative(root, absoluteTarget);
  if (
    pathFromRoot === '..' ||
    pathFromRoot.startsWith(`..${sep}`) ||
    isAbsolute(pathFromRoot)
  ) {
    return createBrokenLink(sourceRelativePath, rawTarget, line, context, 'outside-root');
  }

  let targetPath = absoluteTarget;
  if (normalizedPath.endsWith('/')) {
    targetPath = join(targetPath, 'index.md');
  }

  let inspection = inspectTargetPath(root, targetPath);
  if (inspection === 'directory') {
    targetPath = join(targetPath, 'index.md');
    inspection = inspectTargetPath(root, targetPath);
  }

  if (inspection === 'file') {
    return undefined;
  }

  return createBrokenLink(
    sourceRelativePath,
    rawTarget,
    line,
    context,
    inspection === 'symlink' ? 'symlink' : 'missing',
  );
}

function inspectTargetPath(root: string, targetPath: string): TargetInspection {
  const segments = relative(root, targetPath).split(sep).filter(Boolean);
  let currentPath = root;
  if (segments.length === 0) {
    return 'directory';
  }

  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (segment === undefined) {
      return 'missing';
    }
    currentPath = join(currentPath, segment);

    let info;
    try {
      info = lstatSync(currentPath);
    } catch (cause) {
      if (isMissingPathError(cause)) {
        return 'missing';
      }
      throw directoryReadError(currentPath, cause);
    }

    if (info.isSymbolicLink()) {
      return 'symlink';
    }

    const isLast = index === segments.length - 1;
    if (!isLast && !info.isDirectory()) {
      return 'missing';
    }
    if (isLast) {
      if (info.isFile()) {
        return 'file';
      }
      if (info.isDirectory()) {
        return 'directory';
      }
      return 'missing';
    }
  }

  return 'missing';
}

function createBrokenLink(
  sourcePath: string,
  target: string,
  line: number,
  context: string,
  reason: BrokenLinkReason,
): BrokenMarkdownLink {
  return { sourcePath, target, line, context: context.trim(), reason };
}

function getNodeLine(node: MarkdownAstNode): number {
  const line = node.position?.start?.line;
  return typeof line === 'number' && Number.isInteger(line) && line > 0 ? line : 1;
}

function toPortableRelativePath(root: string, filePath: string): string {
  return relative(root, filePath).split(sep).join('/');
}

function compareNames(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function directoryReadError(filePath: string, cause: unknown): ConfigurationError {
  return new ConfigurationError(`Unable to inspect knowledge path: ${filePath}`, {
    filePath,
    cause,
    suggestedAction: 'Check that the project knowledge directory is accessible.',
  });
}

function isMissingPathError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT';
}
