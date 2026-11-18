import {
  closeSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { dirname, join, relative, sep } from 'node:path';
import { ConfigurationError } from '../config/error.js';
import { InputError } from '../errors/qlm-error.js';

export function assertNoSymlinkComponents(root: string, filePath: string): void {
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

export function writeNewFileAtomically(
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

export function writeFileAtomicallyReplacing(
  filePath: string,
  contents: string,
  expectedCurrentHash?: string,
): void {
  const temporaryPath = join(dirname(filePath), `.qlm-${randomUUID()}.tmp`);
  let descriptor: number | undefined;
  try {
    const mode = statSync(filePath).mode & 0o777;
    descriptor = openSync(temporaryPath, 'wx', mode);
    writeFileSync(descriptor, contents);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    if (expectedCurrentHash !== undefined) {
      const actualHash = createHash('sha256').update(readFileSync(filePath)).digest('hex');
      if (actualHash !== expectedCurrentHash) {
        throw new InputError('The document changed during approval; the newer version was preserved.');
      }
    }
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

export function removeFileIfPresent(filePath: string): void {
  try {
    unlinkSync(filePath);
  } catch (cause) {
    if (!isMissingFileError(cause)) {
      throw cause;
    }
  }
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT';
}
