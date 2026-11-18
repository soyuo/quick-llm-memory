import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigurationError } from '../src/config/error.js';
import { InputError, InternalError } from '../src/errors/qlm-error.js';
import { initializeProject } from '../src/projects/manager.js';
import { listProjectSnapshots } from '../src/projects/snapshots.js';
import {
  createMarkdownDocument,
  moveMarkdownDocument,
  readStoredMarkdownDocument,
  saveMarkdownDocument,
  saveMarkdownDocumentIfUnchanged,
  type MarkdownDocumentDraft,
} from '../src/markdown/repository.js';

const temporaryDirectories: string[] = [];
const snapshotContexts = new Map<string, { dataRoot: string; projectId: string; projectName: string }>();

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('Markdown document repository', () => {
  it('creates and reads a Markdown document with a generated logical ID', () => {
    const knowledgeRoot = createKnowledgeRoot();
    const draft = createDraft();

    const created = createMarkdownDocument(
      knowledgeRoot,
      'security/authentication.md',
      draft,
    );
    const read = readStoredMarkdownDocument(
      knowledgeRoot,
      'security/authentication.md',
    );

    expect(created.metadata.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(created.metadata.id).toBe(read.metadata.id);
    expect(created.body).toBe(draft.body);
    expect(read.body).toBe(draft.body);
    expect(read.sourcePath).toBe(join(knowledgeRoot, 'security', 'authentication.md'));
    expect(readFileSync(read.sourcePath, 'utf8')).toContain(
      `id: ${created.metadata.id}`,
    );
  });

  it('updates an existing document while retaining its ID', () => {
    const knowledgeRoot = createKnowledgeRoot();
    const created = createMarkdownDocument(
      knowledgeRoot,
      'notes/authentication.md',
      createDraft(),
    );
    const updatedDraft = createDraft({
      title: 'Updated title',
      body: '\nUpdated body.\n',
    });

    const saved = saveMarkdownDocument(
      knowledgeRoot,
      'notes/authentication.md',
      updatedDraft,
    );

    expect(saved.metadata.id).toBe(created.metadata.id);
    expect(saved.metadata.title).toBe('Updated title');
    expect(saved.body).toBe(updatedDraft.body);
  });

  it('rejects a stale reviewed source without overwriting newer edits', () => {
    const knowledgeRoot = createKnowledgeRoot();
    const created = createMarkdownDocument(knowledgeRoot, 'notes/reviewed.md', createDraft());
    const sourcePath = join(knowledgeRoot, 'notes', 'reviewed.md');
    const reviewedSource = readFileSync(sourcePath, 'utf8');
    const reviewedHash = createHash('sha256').update(reviewedSource, 'utf8').digest('hex');
    const newerSource = `${reviewedSource}\nUser edit after review.\n`;
    writeFileSync(sourcePath, newerSource);

    expect(() => saveMarkdownDocumentIfUnchanged(
      knowledgeRoot,
      'notes/reviewed.md',
      createDraft({ title: 'Approved update', body: 'Approved body' }),
      reviewedHash,
    )).toThrow(InputError);
    expect(readFileSync(sourcePath, 'utf8')).toBe(newerSource);
    expect(created.metadata.title).not.toBe('Approved update');
  });

  it('creates a new document when saving to a path that does not exist', () => {
    const knowledgeRoot = createKnowledgeRoot();

    const saved = saveMarkdownDocument(
      knowledgeRoot,
      'new/note.md',
      createDraft(),
    );

    expect(saved.metadata.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(existsSync(saved.sourcePath)).toBe(true);
  });

  it('moves a document without changing its ID or file contents', () => {
    const knowledgeRoot = createKnowledgeRoot();
    const created = createMarkdownDocument(
      knowledgeRoot,
      'security/authentication.md',
      createDraft(),
    );
    const originalContents = readFileSync(created.sourcePath);

    const moved = moveMarkdownDocument(
      knowledgeRoot,
      'security/authentication.md',
      'identity/authentication.md',
      snapshotContexts.get(knowledgeRoot)!,
    );

    expect(moved.metadata.id).toBe(created.metadata.id);
    expect(moved.sourcePath).toBe(
      join(knowledgeRoot, 'identity', 'authentication.md'),
    );
    expect(readFileSync(moved.sourcePath)).toEqual(originalContents);
    expect(existsSync(created.sourcePath)).toBe(false);
    const context = snapshotContexts.get(knowledgeRoot)!;
    expect(listProjectSnapshots(context.dataRoot, context.projectId)[0]?.operation).toBe('markdown-move');
  });

  it('does not move a document when its pre-move snapshot fails', () => {
    const knowledgeRoot = createKnowledgeRoot();
    const created = createMarkdownDocument(knowledgeRoot, 'source.md', createDraft());
    const contents = readFileSync(created.sourcePath, 'utf8');
    const context = snapshotContexts.get(knowledgeRoot)!;
    writeFileSync(join(context.dataRoot, 'snapshots'), 'blocking file');

    expect(() => moveMarkdownDocument(knowledgeRoot, 'source.md', 'target.md', context)).toThrow();
    expect(readFileSync(created.sourcePath, 'utf8')).toBe(contents);
    expect(existsSync(join(knowledgeRoot, 'target.md'))).toBe(false);
  });

  it('restores a source that changes while a move is in progress', () => {
    const knowledgeRoot = createKnowledgeRoot();
    const created = createMarkdownDocument(
      knowledgeRoot,
      'security/authentication.md',
      createDraft(),
    );
    const sourceContents = readFileSync(created.sourcePath, 'utf8');
    const changedContents = sourceContents.replace(
      '# Authentication',
      '# Updated during move',
    );
    const originalRenameSync = fs.renameSync;
    let changedSource = false;

    fs.renameSync = ((oldPath: string, newPath: string) => {
      if (
        oldPath === created.sourcePath &&
        newPath.toString().endsWith('.move') &&
        !changedSource
      ) {
        writeFileSync(created.sourcePath, changedContents, 'utf8');
        changedSource = true;
      }
      originalRenameSync(oldPath, newPath);
    }) as typeof fs.renameSync;
    syncBuiltinESMExports();

    try {
      expect(() =>
        moveMarkdownDocument(
          knowledgeRoot,
          'security/authentication.md',
          'identity/authentication.md',
          snapshotContexts.get(knowledgeRoot)!,
        ),
      ).toThrow(InternalError);
      expect(readFileSync(created.sourcePath, 'utf8')).toBe(changedContents);
      expect(existsSync(join(knowledgeRoot, 'identity', 'authentication.md'))).toBe(
        false,
      );
      expect(
        readdirSync(join(knowledgeRoot, 'security')).some((name) =>
          name.endsWith('.move'),
        ),
      ).toBe(false);
    } finally {
      fs.renameSync = originalRenameSync;
      syncBuiltinESMExports();
    }
  });

  it('rejects symlinked directories without writing outside the knowledge root', (context) => {
    const knowledgeRoot = createKnowledgeRoot();
    const outsideDirectory = join(temporaryDirectories[0] ?? '', 'outside');
    const linkedDirectory = join(knowledgeRoot, 'linked');
    mkdirSync(knowledgeRoot, { recursive: true });
    mkdirSync(outsideDirectory);

    try {
      symlinkSync(
        outsideDirectory,
        linkedDirectory,
        process.platform === 'win32' ? 'junction' : 'dir',
      );
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EPERM' || code === 'EACCES' || code === 'ENOTSUP') {
        context.skip('Directory symlinks are unavailable in this environment.');
        return;
      }
      throw error;
    }

    expect(() =>
      createMarkdownDocument(knowledgeRoot, 'linked/escape.md', createDraft()),
    ).toThrow(InputError);
    expect(existsSync(join(outsideDirectory, 'escape.md'))).toBe(false);
  });

  it('rejects traversal paths without writing outside the knowledge root', () => {
    const knowledgeRoot = createKnowledgeRoot();
    const outsidePath = join(temporaryDirectories[0] ?? '', 'outside.md');

    expect(() =>
      createMarkdownDocument(knowledgeRoot, '../outside.md', createDraft()),
    ).toThrow(InputError);
    expect(existsSync(outsidePath)).toBe(false);
    expect(() =>
      readStoredMarkdownDocument(knowledgeRoot, '..\\outside.md'),
    ).toThrow(InputError);
  });

  it('does not overwrite duplicate create or move targets', () => {
    const knowledgeRoot = createKnowledgeRoot();
    const source = createMarkdownDocument(
      knowledgeRoot,
      'source.md',
      createDraft({ title: 'Source' }),
    );
    const destination = createMarkdownDocument(
      knowledgeRoot,
      'destination.md',
      createDraft({ title: 'Destination' }),
    );
    const sourceContents = readFileSync(source.sourcePath, 'utf8');
    const destinationContents = readFileSync(destination.sourcePath, 'utf8');

    expect(() =>
      createMarkdownDocument(knowledgeRoot, 'destination.md', createDraft()),
    ).toThrow(InputError);
    expect(() =>
      moveMarkdownDocument(knowledgeRoot, 'source.md', 'destination.md', snapshotContexts.get(knowledgeRoot)!),
    ).toThrow(InputError);
    expect(readFileSync(source.sourcePath, 'utf8')).toBe(sourceContents);
    expect(readFileSync(destination.sourcePath, 'utf8')).toBe(destinationContents);
  });

  it('preserves the previous file when an update write fails partway through', () => {
    const knowledgeRoot = createKnowledgeRoot();
    const created = createMarkdownDocument(
      knowledgeRoot,
      'notes/stable.md',
      createDraft(),
    );
    const originalContents = readFileSync(created.sourcePath, 'utf8');
    const originalWriteFileSync = fs.writeFileSync;
    let partialWriteLength = 0;

    fs.writeFileSync = ((fileDescriptor: number, contents: string | Buffer) => {
      const text = Buffer.isBuffer(contents) ? contents.toString('utf8') : contents;
      const partialContents = text.slice(0, 12);
      originalWriteFileSync(fileDescriptor, partialContents, 'utf8');
      partialWriteLength = partialContents.length;
      throw new Error('simulated document write failure');
    }) as typeof fs.writeFileSync;
    syncBuiltinESMExports();

    try {
      expect(() =>
        saveMarkdownDocument(
          knowledgeRoot,
          'notes/stable.md',
          createDraft({ title: 'Replacement' }),
        ),
      ).toThrow(InternalError);
      expect(partialWriteLength).toBe(12);
      expect(readFileSync(created.sourcePath, 'utf8')).toBe(originalContents);
      expect(readdirSync(join(knowledgeRoot, 'notes')).some((name) => name.endsWith('.tmp'))).toBe(false);
    } finally {
      fs.writeFileSync = originalWriteFileSync;
      syncBuiltinESMExports();
    }
  });

  it('returns typed path-aware errors for invalid stored Markdown', () => {
    const knowledgeRoot = createKnowledgeRoot();
    mkdirSync(knowledgeRoot, { recursive: true });
    const filePath = join(knowledgeRoot, 'broken.md');
    writeFileSync(filePath, '---\nid: [\n---\n', 'utf8');

    expect(() => readStoredMarkdownDocument(knowledgeRoot, 'broken.md')).toThrow(
      ConfigurationError,
    );
    try {
      readStoredMarkdownDocument(knowledgeRoot, 'broken.md');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigurationError);
      expect((error as ConfigurationError).filePath).toBe(filePath);
    }
  });
});

function createKnowledgeRoot(): string {
  const dataRoot = realpathSync(mkdtempSync(join(tmpdir(), 'qlm-markdown-repository-')));
  temporaryDirectories.push(dataRoot);
  const project = initializeProject(dataRoot, 'markdown-test');
  const knowledgeRoot = join(dataRoot, 'projects', project.name, 'knowledge');
  snapshotContexts.set(knowledgeRoot, { dataRoot, projectId: project.id, projectName: project.name });
  return knowledgeRoot;
}

function createDraft(
  overrides: Partial<MarkdownDocumentDraft> & {
    title?: string;
    body?: string;
  } = {},
): MarkdownDocumentDraft {
  const { title = 'Authentication', body = '\n# Authentication\n', ...rest } =
    overrides;
  return {
    metadata: {
      schema_version: 1,
      title,
      type: 'document',
      depth: 2,
      status: 'draft',
      ...rest.metadata,
    },
    body,
  };
}
