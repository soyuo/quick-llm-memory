import {
  closeSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import {
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
  win32,
} from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import { ConfigurationError } from '../config/error.js';
import { InputError, InternalError } from '../errors/qlm-error.js';
import { parseMarkdownDocument } from './parser.js';
import {
  documentDraftFrontmatterSchema,
  documentFrontmatterSchema,
  type DocumentDraftFrontmatter,
  type DocumentFrontmatter,
} from './schema.js';
import type { ParsedMarkdownDocument } from './parser.js';

export interface MarkdownDocumentDraft {
  metadata: DocumentDraftFrontmatter;
  /** Exact text following the frontmatter delimiter, including its line break. */
  body: string;
}

export function createMarkdownDocument(
  knowledgeRoot: string,
  relativePath: string,
  draft: MarkdownDocumentDraft,
) {
  const root = ensureKnowledgeRoot(knowledgeRoot, true);
  const filePath = resolveDocumentPath(root, relativePath);
  ensureSafeParentDirectories(root, filePath, true);
  assertNoSymlinkComponents(root, filePath);

  if (pathExists(filePath)) {
    throw duplicateDocumentError(filePath);
  }

  const metadata = createDocumentMetadata(draft);
  const markdown = serializeDocument(metadata, draft.body, filePath);
  const parsed = parseMarkdownDocument(markdown, filePath);

  try {
    writeNewFileAtomically(filePath, markdown);
  } catch (cause) {
    if (isAlreadyExistsError(cause)) {
      throw duplicateDocumentError(filePath);
    }

    throw new InternalError(`Unable to create Markdown document: ${filePath}`, {
      cause,
      details: { filePath },
      suggestedAction: 'Check that the knowledge directory is writable.',
    });
  }

  return parsed;
}

export function readStoredMarkdownDocument(
  knowledgeRoot: string,
  relativePath: string,
) {
  const root = ensureKnowledgeRoot(knowledgeRoot, false);
  const filePath = resolveDocumentPath(root, relativePath);
  assertNoSymlinkComponents(root, filePath);

  let markdown: string;
  try {
    markdown = readFileSync(filePath, 'utf8');
  } catch (cause) {
    throw new ConfigurationError(`Unable to read Markdown document: ${filePath}`, {
      filePath,
      cause,
      suggestedAction: 'Check that the Markdown document exists and is readable.',
    });
  }

  const parsed = parseMarkdownDocument(markdown, filePath);
  assertRegularDocument(parsed, filePath);
  return parsed;
}

export function saveMarkdownDocument(
  knowledgeRoot: string,
  relativePath: string,
  draft: MarkdownDocumentDraft,
) {
  const root = ensureKnowledgeRoot(knowledgeRoot, true);
  const filePath = resolveDocumentPath(root, relativePath);
  ensureSafeParentDirectories(root, filePath, true);
  assertNoSymlinkComponents(root, filePath);

  let existingMarkdown: string;
  try {
    existingMarkdown = readFileSync(filePath, 'utf8');
  } catch (cause) {
    if (isMissingFileError(cause)) {
      return createMarkdownDocument(root, relativePath, draft);
    }

    throw new ConfigurationError(`Unable to read Markdown document: ${filePath}`, {
      filePath,
      cause,
      suggestedAction: 'Check that the Markdown document is readable.',
    });
  }

  const existing = parseMarkdownDocument(existingMarkdown, filePath);
  assertRegularDocument(existing, filePath);
  const validatedDraft = validateDraft(draft, filePath);
  const metadata = documentFrontmatterSchema.parse({
    ...validatedDraft,
    id: existing.metadata.id,
  });
  const markdown = serializeDocument(metadata, draft.body, filePath);
  const parsed = parseMarkdownDocument(markdown, filePath);

  try {
    writeFileAtomicallyReplacing(filePath, markdown);
  } catch (cause) {
    throw new InternalError(`Unable to save Markdown document: ${filePath}`, {
      cause,
      details: { filePath },
      suggestedAction:
        'Check that the knowledge directory is writable; the previous document was preserved.',
    });
  }

  return parsed;
}

export function moveMarkdownDocument(
  knowledgeRoot: string,
  sourceRelativePath: string,
  targetRelativePath: string,
) {
  const root = ensureKnowledgeRoot(knowledgeRoot, false);
  const sourcePath = resolveDocumentPath(root, sourceRelativePath);
  const targetPath = resolveDocumentPath(root, targetRelativePath);

  if (sourcePath === targetPath) {
    throw new InputError('Source and target Markdown paths are identical.');
  }

  assertNoSymlinkComponents(root, sourcePath);
  let sourceContents: Buffer;
  try {
    sourceContents = readFileSync(sourcePath);
  } catch (cause) {
    throw new ConfigurationError(`Unable to read Markdown document: ${sourcePath}`, {
      filePath: sourcePath,
      cause,
      suggestedAction: 'Check that the source Markdown document exists and is readable.',
    });
  }

  const parsedSource = parseMarkdownDocument(
    sourceContents.toString('utf8'),
    sourcePath,
  );
  assertRegularDocument(parsedSource, sourcePath);
  ensureSafeParentDirectories(root, targetPath, true);
  assertNoSymlinkComponents(root, targetPath);

  try {
    writeNewFileAtomically(targetPath, sourceContents);
  } catch (cause) {
    if (isAlreadyExistsError(cause)) {
      throw duplicateDocumentError(targetPath);
    }

    throw new InternalError(`Unable to move Markdown document to: ${targetPath}`, {
      cause,
      details: { sourcePath, targetPath },
      suggestedAction: 'Check that the target knowledge directory is writable.',
    });
  }

  const quarantinePath = join(dirname(sourcePath), `.qlm-${randomUUID()}.move`);
  try {
    renameSync(sourcePath, quarantinePath);
  } catch (cause) {
    try {
      unlinkSync(targetPath);
    } catch {
      // Keep the source as the authoritative copy if destination cleanup fails.
    }

    throw new InternalError(`Unable to stage Markdown source for move: ${sourcePath}`, {
      cause,
      details: { sourcePath, targetPath },
      suggestedAction: 'The source document was preserved; check permissions and retry.',
    });
  }

  let quarantinedContents: Buffer;
  try {
    quarantinedContents = readFileSync(quarantinePath);
  } catch (cause) {
    restoreQuarantinedSource(quarantinePath, sourcePath, targetPath);
    throw new InternalError(`Unable to verify Markdown source during move: ${sourcePath}`, {
      cause,
      details: { sourcePath, targetPath },
      suggestedAction: 'The source document was restored; check permissions and retry.',
    });
  }

  if (!quarantinedContents.equals(sourceContents)) {
    const cause = new Error('Source Markdown changed while it was being moved.');
    restoreQuarantinedSource(quarantinePath, sourcePath, targetPath);
    throw new InternalError(`Markdown source changed during move: ${sourcePath}`, {
      cause,
      details: { sourcePath, targetPath },
      suggestedAction: 'The changed source document was restored; retry the move.',
    });
  }

  try {
    unlinkSync(quarantinePath);
  } catch (cause) {
    restoreQuarantinedSource(quarantinePath, sourcePath, targetPath);
    throw new InternalError(`Unable to finish moving Markdown document: ${sourcePath}`, {
      cause,
      details: { sourcePath, targetPath },
      suggestedAction: 'The source document was restored; check permissions and retry.',
    });
  }

  return {
    ...parsedSource,
    sourcePath: targetPath,
  };
}

function createDocumentMetadata(draft: MarkdownDocumentDraft, filePath?: string) {
  const validatedDraft = validateDraft(draft, filePath);
  return documentFrontmatterSchema.parse({
    ...validatedDraft,
    id: randomUUID(),
  });
}

function validateDraft(draft: MarkdownDocumentDraft, filePath?: string) {
  const result = documentDraftFrontmatterSchema.safeParse(draft.metadata);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join('.') || 'frontmatter'}: ${issue.message}`)
      .join('; ');
    throw new InputError(`Invalid Markdown document metadata: ${details}`, {
      details: filePath === undefined ? undefined : { filePath },
      suggestedAction: 'Provide valid document metadata before saving.',
    });
  }

  if (
    draft.body.length > 0 &&
    !draft.body.startsWith('\n') &&
    !draft.body.startsWith('\r\n')
  ) {
    throw new InputError(
      'Markdown document body must include the line break after frontmatter.',
      {
        details: filePath === undefined ? undefined : { filePath },
        suggestedAction:
          'Include the original frontmatter separator line break at the start of the body.',
      },
    );
  }

  return result.data;
}

function serializeDocument(
  metadata: ReturnType<typeof documentFrontmatterSchema.parse>,
  body: string,
  filePath: string,
): string {
  const frontmatter = stringifyYamlMetadata(metadata, filePath);
  return `---\n${frontmatter}\n---${body}`;
}

function stringifyYamlMetadata(
  metadata: ReturnType<typeof documentFrontmatterSchema.parse>,
  filePath: string,
): string {
  try {
    return stringifyYaml(metadata).trimEnd();
  } catch (cause) {
    throw new ConfigurationError(`Unable to serialize Markdown metadata: ${filePath}`, {
      filePath,
      cause,
      suggestedAction: 'Check that the document metadata contains supported YAML values.',
    });
  }
}

function ensureKnowledgeRoot(knowledgeRoot: string, create: boolean): string {
  if (knowledgeRoot.trim().length === 0) {
    throw new InputError('Knowledge root must be a non-empty path.');
  }

  const root = resolve(knowledgeRoot);
  if (create) {
    try {
      mkdirSync(root, { recursive: true });
    } catch (cause) {
      throw new InternalError(`Unable to create knowledge directory: ${root}`, {
        cause,
        details: { filePath: root },
        suggestedAction: 'Check that the project directory is writable.',
      });
    }
  }

  let rootInfo;
  try {
    rootInfo = lstatSync(root);
  } catch (cause) {
    throw new ConfigurationError(`Unable to access knowledge directory: ${root}`, {
      filePath: root,
      cause,
      suggestedAction: 'Create the project knowledge directory before reading documents.',
    });
  }

  let canonicalRoot: string;
  try {
    canonicalRoot = realpathSync(root);
  } catch (cause) {
    throw new ConfigurationError(`Unable to resolve knowledge directory: ${root}`, {
      filePath: root,
      cause,
      suggestedAction: 'Check that the project knowledge directory is accessible.',
    });
  }

  if (rootInfo.isFile() || !statSync(canonicalRoot).isDirectory()) {
    throw new InputError(`Knowledge root must be a real directory: ${root}`, {
      suggestedAction: 'Use a project knowledge directory.',
    });
  }

  return canonicalRoot;
}

function assertRegularDocument(
  parsed: ParsedMarkdownDocument,
  filePath: string,
): asserts parsed is ParsedMarkdownDocument & { metadata: DocumentFrontmatter & { type: 'document' } } {
  if (parsed.metadata.type !== 'document') {
    throw new InputError(`Expected a regular Markdown document: ${filePath}`, {
      details: { filePath },
      suggestedAction:
        'Use the document repository only for files with type: document.',
    });
  }
}

function resolveDocumentPath(root: string, relativePath: string): string {
  const segments = relativePath.split(/[\\/]/);
  if (
    relativePath.length === 0 ||
    isAbsolute(relativePath) ||
    win32.isAbsolute(relativePath) ||
    /^[a-zA-Z]:/.test(relativePath) ||
    segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')
  ) {
    throw new InputError(`Invalid relative Markdown path: ${relativePath}`, {
      suggestedAction: 'Use a relative path inside the knowledge directory.',
    });
  }

  const filePath = resolve(root, ...segments);
  const pathFromRoot = relative(root, filePath);
  if (
    pathFromRoot.length === 0 ||
    pathFromRoot === '..' ||
    pathFromRoot.startsWith(`..${sep}`) ||
    isAbsolute(pathFromRoot) ||
    extname(filePath).toLowerCase() !== '.md'
  ) {
    throw new InputError(`Markdown path must stay inside the knowledge root: ${relativePath}`, {
      suggestedAction: 'Use a relative .md path inside the knowledge directory.',
    });
  }

  return filePath;
}

function ensureSafeParentDirectories(
  root: string,
  filePath: string,
  create: boolean,
): void {
  assertNoSymlinkComponents(root, filePath);
  if (create) {
    try {
      mkdirSync(dirname(filePath), { recursive: true });
    } catch (cause) {
      throw new InternalError(`Unable to create Markdown directory: ${dirname(filePath)}`, {
        cause,
        details: { filePath },
        suggestedAction: 'Check that the knowledge directory is writable.',
      });
    }
    assertNoSymlinkComponents(root, filePath);
  }
}

function assertNoSymlinkComponents(root: string, filePath: string): void {
  const segments = relative(root, filePath).split(sep);
  let current = root;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (segment === undefined || segment.length === 0) {
      continue;
    }
    current = join(current, segment);

    let info;
    try {
      info = lstatSync(current);
    } catch (cause) {
      if (isMissingFileError(cause)) {
        return;
      }
      throw new ConfigurationError(`Unable to inspect Markdown path: ${current}`, {
        filePath: current,
        cause,
        suggestedAction: 'Check that the knowledge path is accessible.',
      });
    }

    if (info.isSymbolicLink()) {
      throw new InputError(`Symbolic links are not allowed in Markdown paths: ${current}`, {
        suggestedAction: 'Use a regular directory and Markdown file under the knowledge root.',
      });
    }

    const isLast = index === segments.length - 1;
    if ((!isLast && !info.isDirectory()) || (isLast && info.isDirectory())) {
      throw new InputError(`Invalid Markdown path component: ${current}`);
    }
  }
}

function writeNewFileAtomically(
  filePath: string,
  contents: string | Buffer,
): void {
  const temporaryPath = join(dirname(filePath), `.qlm-${randomUUID()}.tmp`);
  let descriptor: number | undefined;
  let linked = false;
  try {
    descriptor = openSync(temporaryPath, 'wx', 0o666);
    writeFileSync(descriptor, contents);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    linkSync(temporaryPath, filePath);
    linked = true;
    unlinkSync(temporaryPath);
  } catch (cause) {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // Continue removing only the temporary paths created above.
      }
    }
    removeFileIfPresent(temporaryPath);
    if (linked) {
      removeFileIfPresent(filePath);
    }
    throw cause;
  }
}

function writeFileAtomicallyReplacing(filePath: string, contents: string): void {
  const temporaryPath = join(dirname(filePath), `.qlm-${randomUUID()}.tmp`);
  let descriptor: number | undefined;
  try {
    const mode = statSync(filePath).mode & 0o777;
    descriptor = openSync(temporaryPath, 'wx', mode);
    writeFileSync(descriptor, contents);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporaryPath, filePath);
  } catch (cause) {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // Continue removing only the temporary path created above.
      }
    }
    removeFileIfPresent(temporaryPath);
    throw cause;
  }
}

function restoreQuarantinedSource(
  quarantinePath: string,
  sourcePath: string,
  targetPath: string,
): void {
  try {
    linkSync(quarantinePath, sourcePath);
    unlinkSync(quarantinePath);
  } catch (restoreCause) {
    throw new InternalError(`Unable to restore Markdown source: ${sourcePath}`, {
      cause: restoreCause,
      details: { sourcePath, targetPath, recoveryPath: quarantinePath },
      suggestedAction: `Recover the source from ${quarantinePath} before retrying.`,
    });
  }

  try {
    removeFileIfPresent(targetPath);
  } catch (cause) {
    throw new InternalError(`Source restored but move target remains: ${targetPath}`, {
      cause,
      details: { sourcePath, targetPath },
      suggestedAction: 'Remove the incomplete target after verifying the restored source.',
    });
  }
}

function removeFileIfPresent(filePath: string): void {
  try {
    unlinkSync(filePath);
  } catch (cause) {
    if (!isMissingFileError(cause)) {
      throw cause;
    }
  }
}

function pathExists(filePath: string): boolean {
  try {
    lstatSync(filePath);
    return true;
  } catch (cause) {
    if (isMissingFileError(cause)) {
      return false;
    }
    throw cause;
  }
}

function duplicateDocumentError(filePath: string): InputError {
  return new InputError(`Markdown document already exists: ${filePath}`, {
    details: { filePath },
    suggestedAction: 'Choose another path or save explicitly to update this document.',
  });
}

function isAlreadyExistsError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === 'EEXIST';
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
