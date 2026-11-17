import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import {
  lstatSync,
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  unlinkSync,
} from 'node:fs';
import { extname, join } from 'node:path';
import { InputError, InternalError, QLMError } from '../errors/qlm-error.js';
import {
  assertNoSymlinkComponents,
  writeNewFileAtomically,
} from '../markdown/filesystem.js';
import {
  buildKnowledgeTree,
  type CategoryTreeNode,
  type DocumentTreeNode,
  type KnowledgeTree,
} from '../markdown/tree.js';
import type { GeneratedMarkdownCandidate } from './document-generator.js';
import {
  createKnowledgeRoot,
  resolveKnowledgeRoot,
} from '../markdown/repository.js';
import {
  assertValidGeneratedDocuments,
} from './generated-document-validator.js';
import {
  assertValidKnowledgeHierarchy,
} from './hierarchy-validator.js';
import type { HierarchyNode } from './planner.js';
import type { SourceSection } from './source.js';

export interface GeneratedDocumentCommitResult {
  created: string[];
  updated: string[];
  removed: string[];
  cleanupWarnings?: string[];
}

interface FileBackup {
  originalPath: string;
  backupPath: string;
}

/** Replace the project's generated Markdown set, restoring the old set on failure. */
export function commitGeneratedDocuments(
  knowledgeRoot: string,
  candidates: readonly GeneratedMarkdownCandidate[],
  hierarchy: readonly HierarchyNode[],
  sections: readonly SourceSection[],
): GeneratedDocumentCommitResult {
  return commitGeneratedDocumentSet(knowledgeRoot, candidates, hierarchy, hierarchy, sections, true);
}

/** Atomically update only selected generated documents, preserving every other file. */
export function commitGeneratedDocumentUpdates(
  knowledgeRoot: string,
  candidates: readonly GeneratedMarkdownCandidate[],
  fullHierarchy: readonly HierarchyNode[],
  selectedHierarchy: readonly HierarchyNode[],
  sections: readonly SourceSection[],
  expectedCurrentHashes?: ReadonlyMap<string, string | null>,
): GeneratedDocumentCommitResult {
  return commitGeneratedDocumentSet(
    knowledgeRoot,
    candidates,
    fullHierarchy,
    selectedHierarchy,
    sections,
    false,
    expectedCurrentHashes,
  );
}

function commitGeneratedDocumentSet(
  knowledgeRoot: string,
  candidates: readonly GeneratedMarkdownCandidate[],
  fullHierarchy: readonly HierarchyNode[],
  validationHierarchy: readonly HierarchyNode[],
  sections: readonly SourceSection[],
  replaceSet: boolean,
  expectedCurrentHashes?: ReadonlyMap<string, string | null>,
): GeneratedDocumentCommitResult {
  const validatedHierarchy = assertValidKnowledgeHierarchy(fullHierarchy, sections);
  const orderedCandidates = assertValidGeneratedDocuments(
    candidates,
    validationHierarchy,
    sections,
  );

  for (const candidate of orderedCandidates) {
    if (extname(candidate.path).toLowerCase() !== '.md') {
      throw new InputError(`Generated document paths must use the .md extension: ${candidate.path}.`, {
        suggestedAction: 'Use .md paths so the project knowledge tree can index generated documents.',
      });
    }
  }

  if (orderedCandidates.length === 0 && replaceSet) {
    if (!pathExists(knowledgeRoot)) {
      return emptyCommitResult();
    }
    const existingRoot = resolveKnowledgeRoot(knowledgeRoot);
    if (flattenDocuments(buildKnowledgeTree(existingRoot)).length > 0) {
      throw new InputError('An empty candidate set cannot replace existing knowledge documents.', {
        suggestedAction: 'Generate a complete non-empty document set before committing.',
      });
    }
    return emptyCommitResult();
  }

  let createdKnowledgeRoot = false;
  const stagedPaths: string[] = [];
  const backups: FileBackup[] = [];
  const installedPaths: string[] = [];
  const createdDirectories: string[] = [];
  const transactionId = randomUUID();
  let rootForRollback = knowledgeRoot;

  try {
    if (!pathExists(knowledgeRoot)) {
      createdKnowledgeRoot = true;
      rootForRollback = createKnowledgeRoot(knowledgeRoot);
    } else {
      rootForRollback = resolveKnowledgeRoot(knowledgeRoot);
    }
    const root = rootForRollback;
    const tree = buildKnowledgeTree(root);
    const existingDocuments = flattenDocuments(tree);
    const categoryIndexPaths = getCategoryIndexPaths(
      tree,
      validatedHierarchy,
    );
    const categoryIndexKeys = new Set(categoryIndexPaths.map((path) => path.toLowerCase()));

    for (const candidate of orderedCandidates) {
      if (categoryIndexKeys.has(candidate.path.toLowerCase())) {
        throw new InputError(`Generated document path conflicts with a category index: ${candidate.path}.`, {
          suggestedAction: 'Choose a document path that does not use the reserved index.md name.',
        });
      }
    }

    const existingByPath = new Map(
      existingDocuments.map((document) => [document.path.toLowerCase(), document]),
    );
    const candidatePathKeys = new Set(orderedCandidates.map((candidate) => candidate.path.toLowerCase()));
    const created = orderedCandidates
      .filter((candidate) => !existingByPath.has(candidate.path.toLowerCase()))
      .map((candidate) => candidate.path);
    const updated = orderedCandidates
      .filter((candidate) => existingByPath.has(candidate.path.toLowerCase()))
      .map((candidate) => candidate.path);
    const removed = replaceSet ? existingDocuments
      .filter((document) => !candidatePathKeys.has(document.path.toLowerCase()))
      .map((document) => document.path)
      .sort(comparePaths) : [];

    for (const candidate of orderedCandidates) {
      const targetPath = resolveUnderRoot(root, candidate.path);
      assertNoSymlinkComponents(root, targetPath);
      assertRegularFileIfPresent(targetPath);
      const stagePath = join(root, `.qlm-${transactionId}-${stagedPaths.length}.stage`);
      writeNewFileAtomically(stagePath, candidate.markdown);
      stagedPaths.push(stagePath);
    }

    const documentsToBackup = (replaceSet
      ? [...existingDocuments]
      : existingDocuments.filter((document) => candidatePathKeys.has(document.path.toLowerCase())))
      .sort((left, right) => comparePaths(left.path, right.path));
    for (const document of documentsToBackup) {
      const originalPath = resolveUnderRoot(root, document.path);
      assertNoSymlinkComponents(root, originalPath);
      const backupPath = join(root, `.qlm-${transactionId}-${backups.length}.backup`);
      renameSync(originalPath, backupPath);
      backups.push({ originalPath, backupPath });
      const expectedHash = getExpectedHash(expectedCurrentHashes, document.path);
      if (expectedHash.found) {
        const actualHash = createHash('sha256').update(readFileSync(backupPath)).digest('hex');
        if (expectedHash.value === null || actualHash !== expectedHash.value) {
          throw new InputError(
            `The document changed after conflict review: ${document.path}.`,
            { suggestedAction: 'Review the current document again before applying generated content.' },
          );
        }
      }
    }

    for (let index = 0; index < orderedCandidates.length; index += 1) {
      const candidate = orderedCandidates[index];
      const stagePath = stagedPaths[index];
      if (candidate === undefined || stagePath === undefined) {
        throw new InternalError('Generated document staging state is incomplete.');
      }
      const targetPath = resolveUnderRoot(root, candidate.path);
      ensureParentDirectories(root, candidate.path, createdDirectories);
      assertNoSymlinkComponents(root, targetPath);
      try {
        linkSync(stagePath, targetPath);
      } catch (cause) {
        if (isAlreadyExistsError(cause)) {
          throw new InputError(`A Markdown document appeared during the build: ${candidate.path}.`, {
            suggestedAction: 'Review the new document and run the incremental build again.',
          });
        }
        throw cause;
      }
      installedPaths.push(targetPath);
      unlinkSync(stagePath);
    }

    const cleanupErrors = cleanupBackupFiles(backups);
    cleanupStageFiles(stagedPaths, cleanupErrors);
    return {
      created,
      updated,
      removed,
      ...(cleanupErrors.length === 0 ? {} : { cleanupWarnings: cleanupErrors }),
    };
  } catch (cause) {
    const rollbackErrors = rollbackTransaction(
      installedPaths,
      backups,
      stagedPaths,
      createdDirectories,
      rootForRollback,
      createdKnowledgeRoot,
    );

    if (cause instanceof QLMError && rollbackErrors.length === 0) {
      throw cause;
    }

    throw new InternalError('Unable to commit generated Markdown documents.', {
      cause,
      details: {
        rollbackErrors,
        recoveryPaths: backups
          .filter(({ backupPath }) => pathExists(backupPath))
          .map(({ backupPath }) => backupPath),
      },
      suggestedAction: rollbackErrors.length === 0
        ? 'Check that the project knowledge directory is writable and retry.'
        : 'Restore files from the listed recovery paths before retrying.',
    });
  }
}

function isAlreadyExistsError(cause: unknown): boolean {
  return typeof cause === 'object' && cause !== null && 'code' in cause && cause.code === 'EEXIST';
}

function getExpectedHash(
  expectedHashes: ReadonlyMap<string, string | null> | undefined,
  path: string,
): { found: false } | { found: true; value: string | null } {
  if (expectedHashes === undefined) return { found: false };
  for (const [expectedPath, value] of expectedHashes) {
    if (expectedPath.toLowerCase() === path.toLowerCase()) return { found: true, value };
  }
  return { found: false };
}

function flattenDocuments(tree: KnowledgeTree): DocumentTreeNode[] {
  const result: DocumentTreeNode[] = [...tree.documents];
  const stack = [...tree.categories].reverse();
  while (stack.length > 0) {
    const category = stack.pop();
    if (category === undefined) {
      continue;
    }
    result.push(...category.documents);
    stack.push(...[...category.categories].reverse());
  }
  return result.sort((left, right) => comparePaths(left.path, right.path));
}

function getCategoryIndexPaths(
  tree: KnowledgeTree,
  hierarchy: readonly HierarchyNode[],
): string[] {
  const paths = new Set<string>(['index.md']);
  const treeStack: CategoryTreeNode[] = [...tree.categories];
  while (treeStack.length > 0) {
    const category = treeStack.pop();
    if (category === undefined) {
      continue;
    }
    paths.add(`${category.path}/index.md`);
    treeStack.push(...category.categories);
  }

  const hierarchyStack = [...hierarchy];
  while (hierarchyStack.length > 0) {
    const node = hierarchyStack.pop();
    if (node === undefined || node.type !== 'category') {
      continue;
    }
    paths.add(`${node.path}/index.md`);
    hierarchyStack.push(...(node.children ?? []));
  }
  return [...paths];
}

function resolveUnderRoot(root: string, relativePath: string): string {
  return join(root, ...relativePath.split('/'));
}

function assertRegularFileIfPresent(filePath: string): void {
  try {
    const info = lstatSync(filePath);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new InputError(`Generated document target is not a regular file: ${filePath}.`, {
        suggestedAction: 'Use a regular Markdown file path under the knowledge root.',
      });
    }
  } catch (cause) {
    if (isMissingPathError(cause)) {
      return;
    }
    throw cause;
  }
}

function ensureParentDirectories(
  root: string,
  relativePath: string,
  createdDirectories: string[],
): void {
  const segments = relativePath.split('/').slice(0, -1);
  let current = root;
  for (const segment of segments) {
    current = join(current, segment);
    let info;
    try {
      info = lstatSync(current);
    } catch (cause) {
      if (!isMissingPathError(cause)) {
        throw cause;
      }
      mkdirSync(current);
      createdDirectories.push(current);
      info = lstatSync(current);
    }
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new InputError(`Generated document parent is not a regular directory: ${current}.`, {
        suggestedAction: 'Use regular directories under the knowledge root.',
      });
    }
  }
}

function rollbackTransaction(
  installedPaths: readonly string[],
  backups: readonly FileBackup[],
  stagedPaths: readonly string[],
  createdDirectories: readonly string[],
  root: string | undefined,
  createdKnowledgeRoot: boolean,
): string[] {
  const errors: string[] = [];
  for (const filePath of [...installedPaths].reverse()) {
    try {
      unlinkSync(filePath);
    } catch (cause) {
      if (!isMissingPathError(cause)) {
        errors.push(`Could not remove ${filePath}: ${errorMessage(cause)}`);
      }
    }
  }
  for (const backup of [...backups].reverse()) {
    try {
      renameSync(backup.backupPath, backup.originalPath);
    } catch (cause) {
      if (!isMissingPathError(cause)) {
        errors.push(`Could not restore ${backup.originalPath} from ${backup.backupPath}: ${errorMessage(cause)}`);
      }
    }
  }
  for (const stagePath of stagedPaths) {
    try {
      unlinkSync(stagePath);
    } catch (cause) {
      if (!isMissingPathError(cause)) {
        errors.push(`Could not remove staged file ${stagePath}: ${errorMessage(cause)}`);
      }
    }
  }
  for (const directory of [...createdDirectories].reverse()) {
    removeEmptyDirectory(directory, errors);
  }
  if (createdKnowledgeRoot && root !== undefined) {
    removeEmptyDirectory(root, errors);
  }
  return errors;
}

function cleanupBackupFiles(backups: readonly FileBackup[]): string[] {
  const errors: string[] = [];
  for (const { backupPath } of backups) {
    try {
      unlinkSync(backupPath);
    } catch (cause) {
      if (!isMissingPathError(cause)) {
        errors.push(`Could not remove committed backup ${backupPath}: ${errorMessage(cause)}`);
      }
    }
  }
  return errors;
}

function cleanupStageFiles(stagedPaths: readonly string[], errors: string[]): void {
  for (const stagePath of stagedPaths) {
    try {
      unlinkSync(stagePath);
    } catch (cause) {
      if (!isMissingPathError(cause)) {
        errors.push(`Could not remove staged file ${stagePath}: ${errorMessage(cause)}`);
      }
    }
  }
}

function removeEmptyDirectory(directory: string, errors: string[]): void {
  try {
    rmdirSync(directory);
  } catch (cause) {
    if (!isMissingPathError(cause) && !isDirectoryNotEmptyError(cause)) {
      errors.push(`Could not remove created directory ${directory}: ${errorMessage(cause)}`);
    }
  }
}

function pathExists(filePath: string): boolean {
  try {
    lstatSync(filePath);
    return true;
  } catch (cause) {
    if (isMissingPathError(cause)) {
      return false;
    }
    throw cause;
  }
}

function isMissingPathError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function isDirectoryNotEmptyError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error &&
    (error.code === 'ENOTEMPTY' || error.code === 'EEXIST');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown filesystem error';
}

function comparePaths(left: string, right: string): number {
  const leftLower = left.toLowerCase();
  const rightLower = right.toLowerCase();
  return leftLower < rightLower ? -1 : leftLower > rightLower ? 1 : left < right ? -1 : left > right ? 1 : 0;
}

function emptyCommitResult(): GeneratedDocumentCommitResult {
  return { created: [], updated: [], removed: [] };
}
