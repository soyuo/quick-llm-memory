import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, type Dirent } from 'node:fs';
import { basename, extname, join, relative, resolve } from 'node:path';
import { ConfigurationError } from '../config/error.js';
import { InputError } from '../errors/qlm-error.js';

export interface SourceDocument {
  id: string;
  path: string;
  format: string;
  content: string;
  hash: string;
  size: number;
  modifiedAt: string;
  metadata: Record<string, unknown>;
}

export interface SourceSection {
  id: string;
  sourceId: string;
  title: string;
  content: string;
  headingPath: string[];
  startOffset: number;
  endOffset: number;
  tokenCount: number;
  hash: string;
}

export interface ParsedDocument {
  sourceId: string;
  sections: SourceSection[];
}

/** Load one Markdown file or all Markdown files below a directory. */
export function loadMarkdownSources(sourcePath: string): SourceDocument[] {
  if (sourcePath.trim().length === 0) {
    throw new InputError('Markdown source path must not be empty.');
  }

  const rootPath = resolve(sourcePath);
  let rootInfo;
  try {
    rootInfo = lstatSync(rootPath);
  } catch (cause) {
    throw new ConfigurationError('Unable to inspect Markdown source path.', {
      filePath: rootPath,
      cause,
      suggestedAction: 'Check that the source exists and is accessible.',
    });
  }

  if (rootInfo.isSymbolicLink()) {
    throw new InputError('Symbolic links cannot be used as Markdown source roots.', {
      details: { filePath: rootPath },
    });
  }

  let files: Array<{ absolutePath: string; relativePath: string }>;
  if (rootInfo.isFile()) {
    if (!isMarkdownFile(rootPath)) {
      throw new InputError(`Unsupported source file type: ${extname(rootPath) || '(no extension)'}.`, {
        details: { filePath: rootPath },
        suggestedAction: 'Provide a .md or .markdown file, or a directory containing Markdown files.',
      });
    }
    files = [{ absolutePath: rootPath, relativePath: basename(rootPath) }];
  } else if (rootInfo.isDirectory()) {
    files = collectMarkdownFiles(rootPath);
  } else {
    throw new InputError('Markdown source path must be a regular file or directory.', {
      details: { filePath: rootPath },
    });
  }

  return files.map(({ absolutePath, relativePath }) =>
    readSource(absolutePath, relativePath),
  );
}

function collectMarkdownFiles(
  rootPath: string,
): Array<{ absolutePath: string; relativePath: string }> {
  const files: Array<{ absolutePath: string; relativePath: string }> = [];
  const visit = (directoryPath: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(directoryPath, { withFileTypes: true });
    } catch (cause) {
      throw new ConfigurationError('Unable to read Markdown source directory.', {
        filePath: directoryPath,
        cause,
        suggestedAction: 'Check directory permissions and try again.',
      });
    }

    entries.sort((left, right) => compareNames(left.name, right.name));
    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        continue;
      }
      const absolutePath = join(directoryPath, entry.name);
      if (entry.isDirectory()) {
        visit(absolutePath);
      } else if (entry.isFile() && isMarkdownFile(entry.name)) {
        files.push({
          absolutePath,
          relativePath: relative(rootPath, absolutePath).split(/[\\/]/).join('/'),
        });
      }
    }
  };

  visit(rootPath);
  return files.sort((left, right) => compareNames(left.relativePath, right.relativePath));
}

function readSource(absolutePath: string, sourceRelativePath: string): SourceDocument {
  let bytes: Buffer;
  let info;
  try {
    info = lstatSync(absolutePath);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error('Source is no longer a regular file.');
    }
    bytes = readFileSync(absolutePath);
  } catch (cause) {
    throw new ConfigurationError('Unable to read Markdown source file.', {
      filePath: absolutePath,
      cause,
      suggestedAction: 'Check that the source is a readable regular file.',
    });
  }

  let content: string;
  try {
    content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (cause) {
    throw new ConfigurationError('Markdown source is not valid UTF-8.', {
      filePath: absolutePath,
      cause,
      suggestedAction: 'Save the Markdown source as UTF-8 and try again.',
    });
  }

  const hash = createHash('sha256').update(bytes).digest('hex');
  const stablePath = sourceRelativePath.split(/[\\/]/).join('/');
  const absoluteIdentity = resolve(absolutePath)
    .split(/[\\/]/)
    .join('/');
  const sourceIdentity =
    process.platform === 'win32' ? absoluteIdentity.toLowerCase() : absoluteIdentity;
  return {
    id: `source-${createHash('sha256').update(sourceIdentity).digest('hex').slice(0, 24)}`,
    path: stablePath,
    format: 'markdown',
    content,
    hash,
    size: bytes.byteLength,
    modifiedAt: info.mtime.toISOString(),
    metadata: {},
  };
}

function isMarkdownFile(filePath: string): boolean {
  const extension = extname(filePath).toLowerCase();
  return extension === '.md' || extension === '.markdown';
}

function compareNames(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
