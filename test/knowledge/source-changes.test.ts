import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openProjectDatabase } from '../../src/database/database.js';
import {
  readProjectSourceSnapshot,
  replaceProjectSourceSnapshot,
} from '../../src/database/source-snapshot.js';
import {
  compareProjectSourceSnapshots,
  createProjectSourceSnapshot,
} from '../../src/knowledge/source-changes.js';
import type { SourceDocument, SourceSection } from '../../src/knowledge/source.js';
import { initializeProject } from '../../src/projects/manager.js';

describe('project source change classification', () => {
  it('reports added, modified, deleted, and unchanged files and sections deterministically', () => {
    const previous = {
      sourceRoot: '/sources',
      files: [
        { sourceId: 'source-unchanged', path: 'a.md', contentHash: 'a'.repeat(64) },
        { sourceId: 'source-modified', path: 'b.md', contentHash: 'b'.repeat(64) },
        { sourceId: 'source-deleted', path: 'c.md', contentHash: 'c'.repeat(64) },
      ],
      sections: [
        { sourceId: 'source-unchanged', sectionId: 'section-unchanged', contentHash: '1'.repeat(64) },
        { sourceId: 'source-modified', sectionId: 'section-modified', contentHash: '2'.repeat(64) },
        { sourceId: 'source-deleted', sectionId: 'section-deleted', contentHash: '3'.repeat(64) },
      ],
    };
    const current = {
      sourceRoot: '/sources',
      files: [
        { sourceId: 'source-added', path: 'd.md', contentHash: 'd'.repeat(64) },
        { sourceId: 'source-modified', path: 'b.md', contentHash: 'e'.repeat(64) },
        { sourceId: 'source-unchanged', path: 'a.md', contentHash: 'a'.repeat(64) },
      ],
      sections: [
        { sourceId: 'source-added', sectionId: 'section-added', contentHash: '4'.repeat(64) },
        { sourceId: 'source-modified', sectionId: 'section-modified', contentHash: '5'.repeat(64) },
        { sourceId: 'source-unchanged', sectionId: 'section-unchanged', contentHash: '1'.repeat(64) },
      ],
    };

    const first = compareProjectSourceSnapshots(current, previous);
    const second = compareProjectSourceSnapshots(current, previous);

    expect(first).toEqual(second);
    expect(first.files.map(({ path, status }) => [path, status])).toEqual([
      ['a.md', 'unchanged'],
      ['b.md', 'modified'],
      ['c.md', 'deleted'],
      ['d.md', 'added'],
    ]);
    expect(first.sections.map(({ sectionId, status }) => [sectionId, status])).toEqual([
      ['section-unchanged', 'unchanged'],
      ['section-modified', 'modified'],
      ['section-deleted', 'deleted'],
      ['section-added', 'added'],
    ]);
  });

  it('uses stable structural section identities and stores hashes rather than source text', () => {
    const source = makeSource('notes.md', 'sensitive source body');
    const originalSection = makeSection(source, 'Summary', 12, 27);
    const shiftedSection = makeSection(source, 'Summary', 212, 227);
    const original = createProjectSourceSnapshot('/sources', [source], [originalSection]);
    const shifted = createProjectSourceSnapshot('/sources', [source], [shiftedSection]);

    expect(shifted.sections[0]?.sectionId).toBe(original.sections[0]?.sectionId);
    expect(JSON.stringify(original)).not.toContain(source.content);
    expect(JSON.stringify(original)).not.toContain(originalSection.content);
  });

  it('marks an identical second snapshot unchanged', () => {
    const source = makeSource('notes.md', 'content');
    const section = makeSection(source, 'Notes', 0, 7);
    const snapshot = createProjectSourceSnapshot('/sources', [source], [section]);

    const changes = compareProjectSourceSnapshots(snapshot, snapshot);
    expect(changes.files.map(({ status }) => status)).toEqual(['unchanged']);
    expect(changes.sections.map(({ status }) => status)).toEqual(['unchanged']);
  });
});

function makeSource(path: string, content: string): SourceDocument {
  return {
    id: `source-${path}`,
    path,
    format: 'markdown',
    content,
    hash: 'a'.repeat(64),
    size: content.length,
    modifiedAt: '2026-11-17T00:00:00.000Z',
    metadata: {},
  };
}

function makeSection(
  source: SourceDocument,
  title: string,
  startOffset: number,
  endOffset: number,
): SourceSection {
  return {
    id: `parser-section-${startOffset}`,
    sourceId: source.id,
    title,
    content: `section body ${startOffset}`,
    headingPath: [title],
    startOffset,
    endOffset,
    tokenCount: 1,
    hash: 'b'.repeat(64),
  };
}

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('project source snapshot persistence', () => {
  it('atomically replaces versioned hash-only snapshots', async () => {
    const dataRoot = realpathSync(mkdtempSync(join(tmpdir(), 'qlm-source-snapshot-')));
    temporaryDirectories.push(dataRoot);
    const project = initializeProject(dataRoot, 'demo');
    const projectRoot = join(dataRoot, 'projects', project.name);
    const sourceRoot = join(dataRoot, 'sources');
    const database = openProjectDatabase(projectRoot, project);
    database.close();
    const baseline = {
      sourceRoot,
      files: [{ sourceId: 'source-1', path: 'notes.md', contentHash: 'a'.repeat(64) }],
      sections: [{ sourceId: 'source-1', sectionId: 'section-1', contentHash: 'b'.repeat(64) }],
    };

    replaceProjectSourceSnapshot(projectRoot, project, baseline, '2026-11-17T00:00:00.000Z');
    expect(readProjectSourceSnapshot(projectRoot, project, sourceRoot)).toEqual(baseline);

    expect(() => replaceProjectSourceSnapshot(projectRoot, project, {
      sourceRoot,
      files: [{ sourceId: 'source-2', path: 'new.md', contentHash: 'c'.repeat(64) }],
      sections: [{ sourceId: 'missing-source', sectionId: 'section-2', contentHash: 'd'.repeat(64) }],
    })).toThrow();
    expect(readProjectSourceSnapshot(projectRoot, project, sourceRoot)).toEqual(baseline);

    const persisted = readProjectSourceSnapshot(projectRoot, project, sourceRoot);
    expect(JSON.stringify(persisted)).not.toContain('sensitive');
    const checkDatabase = openProjectDatabase(projectRoot, project);
    try {
      expect(checkDatabase.prepare('SELECT snapshot_version FROM source_snapshots').get()).toEqual({
        snapshot_version: 1,
      });
      expect(checkDatabase.prepare(`
        SELECT name FROM pragma_table_info('source_snapshot_files') ORDER BY name
      `).pluck().all()).not.toContain('content');
    } finally {
      checkDatabase.close();
    }
  });
});
