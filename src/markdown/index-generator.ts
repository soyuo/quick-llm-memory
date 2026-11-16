import {
  lstatSync,
  readFileSync,
} from 'node:fs';
import { basename, join, posix, resolve } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import { ConfigurationError } from '../config/error.js';
import { InputError, InternalError } from '../errors/qlm-error.js';
import {
  assertNoSymlinkComponents,
  writeFileAtomicallyReplacing,
  writeNewFileAtomically,
} from './filesystem.js';
import { parseMarkdownDocument } from './parser.js';
import {
  createKnowledgeRoot,
} from './repository.js';
import { categoryIndexFrontmatterSchema } from './schema.js';
import {
  buildKnowledgeTree,
  type CategoryTreeNode,
  type DocumentTreeNode,
  type KnowledgeTree,
} from './tree.js';

const GENERATED_LISTING_START = '<!-- qlm:generated-listing:start -->';
const GENERATED_LISTING_END = '<!-- qlm:generated-listing:end -->';

export interface CategoryIndexGenerationResult {
  created: string[];
  updated: string[];
  unchanged: string[];
}

interface IndexTarget {
  relativePath: string;
  absolutePath: string;
  id: string;
  title: string;
  depth: number;
  categories: CategoryTreeNode[];
  documents: DocumentTreeNode[];
}

interface IndexWritePlan {
  target: IndexTarget;
  contents: string;
  operation: 'create' | 'update' | 'unchanged';
}

export function generateCategoryIndexes(
  knowledgeRoot: string,
): CategoryIndexGenerationResult {
  const root = createKnowledgeRoot(knowledgeRoot);
  const tree = buildTreeForGeneration(root);
  const targets = collectIndexTargets(root, tree);
  const plans = targets.map((target) => prepareIndexWrite(target, root));
  const result: CategoryIndexGenerationResult = {
    created: [],
    updated: [],
    unchanged: [],
  };

  for (const plan of plans) {
    if (plan.operation === 'unchanged') {
      result.unchanged.push(plan.target.relativePath);
      continue;
    }

    assertNoSymlinkComponents(root, plan.target.absolutePath);
    try {
      if (plan.operation === 'create') {
        writeNewFileAtomically(plan.target.absolutePath, plan.contents);
        result.created.push(plan.target.relativePath);
      } else {
        writeFileAtomicallyReplacing(plan.target.absolutePath, plan.contents);
        result.updated.push(plan.target.relativePath);
      }
    } catch (cause) {
      if (plan.operation === 'create' && isAlreadyExistsError(cause)) {
        throw indexConflictError(plan.target.absolutePath);
      }
      throw new InternalError(
        `Unable to write category index: ${plan.target.absolutePath}`,
        {
          cause,
          details: { filePath: plan.target.absolutePath },
          suggestedAction:
            'Check that the knowledge directory is writable; existing index content was preserved.',
        },
      );
    }
  }

  return result;
}

function buildTreeForGeneration(root: string): KnowledgeTree {
  try {
    return buildKnowledgeTree(root);
  } catch (cause) {
    if (
      cause instanceof ConfigurationError &&
      cause.filePath !== undefined &&
      basename(cause.filePath).toLowerCase() === 'index.md'
    ) {
      try {
        const contents = readFileSync(cause.filePath, 'utf8');
        if (!hasValidGeneratedMarkers(contents)) {
          throw indexConflictError(cause.filePath);
        }
      } catch (readCause) {
        if (readCause instanceof InputError) {
          throw readCause;
        }
        // Preserve the more specific parser or filesystem error.
      }
    }
    throw cause;
  }
}

function collectIndexTargets(root: string, tree: KnowledgeTree): IndexTarget[] {
  const targets: IndexTarget[] = [];
  const visit = (node: KnowledgeTree | CategoryTreeNode): void => {
    const relativePath = node.path.length === 0 ? 'index.md' : `${node.path}/index.md`;
    targets.push({
      relativePath,
      absolutePath: resolve(root, ...relativePath.split('/')),
      id: node.path.length === 0 ? 'knowledge' : node.path,
      title: 'title' in node ? node.title : 'Knowledge',
      depth: node.depth,
      categories: node.categories,
      documents: node.documents,
    });
    for (const category of node.categories) {
      visit(category);
    }
  };

  visit(tree);
  return targets;
}

function prepareIndexWrite(target: IndexTarget, root: string): IndexWritePlan {
  assertNoSymlinkComponents(root, target.absolutePath);
  let existingContents: string | undefined;
  try {
    lstatSync(target.absolutePath);
    try {
      existingContents = readFileSync(target.absolutePath, 'utf8');
    } catch (cause) {
      throw new ConfigurationError(
        `Unable to read category index: ${target.absolutePath}`,
        {
          filePath: target.absolutePath,
          cause,
          suggestedAction: 'Check that the category index is readable.',
        },
      );
    }
  } catch (cause) {
    if (!isMissingPathError(cause)) {
      throw cause;
    }
  }

  if (existingContents === undefined) {
    return {
      target,
      contents: renderNewIndex(target),
      operation: 'create',
    };
  }

  const updatedContents = updateGeneratedListing(
    existingContents,
    target,
    target.absolutePath,
  );
  return {
    target,
    contents: updatedContents,
    operation: updatedContents === existingContents ? 'unchanged' : 'update',
  };
}

function renderNewIndex(target: IndexTarget): string {
  const metadata = categoryIndexFrontmatterSchema.parse({
    id: target.id,
    title: target.title,
    depth: target.depth,
    type: 'category-index',
  });
  const metadataText = stringifyYaml(metadata).trimEnd();
  return [
    '---',
    metadataText,
    '---',
    '',
    GENERATED_LISTING_START,
    renderGeneratedListing(target),
    GENERATED_LISTING_END,
    '',
  ].join('\n');
}

function updateGeneratedListing(
  contents: string,
  target: IndexTarget,
  filePath: string,
): string {
  const start = contents.indexOf(GENERATED_LISTING_START);
  const end = contents.indexOf(GENERATED_LISTING_END);
  if (!hasValidGeneratedMarkers(contents) || start < 0 || end < start) {
    throw indexConflictError(filePath);
  }

  const parsed = parseMarkdownDocument(contents, filePath);
  if (parsed.metadata.type !== 'category-index') {
    throw new ConfigurationError(
      `Category index must use type: category-index: ${filePath}`,
      {
        filePath,
        suggestedAction: 'Use category-index frontmatter for index.md files.',
      },
    );
  }
  if (parsed.metadata.depth !== target.depth) {
    throw new ConfigurationError(
      `Category index depth does not match its path: ${filePath}`,
      {
        filePath,
        suggestedAction: `Set the index depth to ${target.depth} to match its current category location.`,
      },
    );
  }

  const insertionPoint = start + GENERATED_LISTING_START.length;
  return `${contents.slice(0, insertionPoint)}\n${renderGeneratedListing(target)}\n${contents.slice(end)}`;
}

function renderGeneratedListing(target: IndexTarget): string {
  const currentDirectory = target.relativePath === 'index.md'
    ? '.'
    : target.relativePath.slice(0, -'/index.md'.length);
  const categoryRows = target.categories.map((category) => {
    const destination = posix.relative(
      currentDirectory,
      `${category.path}/index.md`,
    );
    return renderTableRow(`${category.name}/`, destination);
  });
  const documentRows = target.documents.map((document) => {
    const destination = posix.relative(currentDirectory, document.path);
    return renderTableRow(destination, destination);
  });

  return [
    `# ${escapeMarkdownHeading(target.title)}`,
    '',
    '## Categories',
    '',
    '| Path | Description |',
    '|---|---|',
    ...categoryRows,
    '',
    '## Documents',
    '',
    '| Path | Description |',
    '|---|---|',
    ...documentRows,
  ].join('\n');
}

function renderTableRow(label: string, destination: string): string {
  return `| [${escapeMarkdownLabel(label)}](${encodeRelativeLink(destination)}) | |`;
}

function escapeMarkdownLabel(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .replace(/\|/g, '\\|')
    .replace(/[\r\n]+/g, ' ');
}

function escapeMarkdownHeading(value: string): string {
  return value.replace(/[\\`*_{}\[\]()#+.!|>~-]/g, '\\$&').replace(/[\r\n]+/g, ' ');
}

function encodeRelativeLink(value: string): string {
  return value.split('/').map((segment) => encodeURIComponent(segment)).join('/');
}

function hasValidGeneratedMarkers(contents: string): boolean {
  const starts = contents.split(GENERATED_LISTING_START).length - 1;
  const ends = contents.split(GENERATED_LISTING_END).length - 1;
  const start = contents.indexOf(GENERATED_LISTING_START);
  const end = contents.indexOf(GENERATED_LISTING_END);
  return starts === 1 && ends === 1 && start < end;
}

function indexConflictError(filePath: string): InputError {
  return new InputError(`Existing category index needs a generated listing section: ${filePath}`, {
    details: { filePath },
    suggestedAction:
      'Add exactly one `<!-- qlm:generated-listing:start -->` and `<!-- qlm:generated-listing:end -->` marker pair before regenerating; unmarked index content was not changed.',
  });
}

function isMissingPathError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function isAlreadyExistsError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'EEXIST';
}
