import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveProjectDatabasePath } from '../../src/database/database.js';
import { rebuildProjectIndex } from '../../src/database/reindex.js';
import type { SourceChangeSet } from '../../src/knowledge/source-changes.js';
import { planProjectKnowledgeImpact } from '../../src/knowledge/impact-planner.js';
import { initializeProject } from '../../src/projects/manager.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('read-only knowledge impact planning', () => {
  it('plans direct, related, and parent-index work deterministically while excluding unrelated docs', () => {
    const fixture = createFixture();
    const originalFiles = snapshotFiles(fixture.knowledgeRoot, fixture.projectRoot);
    const changes: SourceChangeSet = {
      files: [],
      sections: [{
        sourceId: 'source-a', sourcePath: 'a.md', sectionId: 'stable-a', status: 'modified',
        previousHash: 'a'.repeat(64), currentHash: 'b'.repeat(64),
        previousParserSectionId: 'source-a:old-parser-id',
        currentParserSectionId: 'source-a:current-parser-id',
      }],
    };

    const first = planProjectKnowledgeImpact(
      fixture.projectRoot, fixture.project, fixture.knowledgeRoot, changes,
    );
    const second = planProjectKnowledgeImpact(
      fixture.projectRoot, fixture.project, fixture.knowledgeRoot, changes,
    );

    expect(first).toEqual(second);
    expect(first.documents.map(({ id, action }) => [id, action])).toEqual([
      ['doc-b', 'regenerate'],
      ['doc-c', 'regenerate'],
      ['doc-a', 'regenerate'],
      ['doc-unrelated', 'unaffected'],
    ]);
    expect(first.documents.find(({ id }) => id === 'doc-a')?.reasons).toContain('section:stable-a');
    expect(first.categoryIndexes).toEqual([
      { path: 'security/index.md', affectedDocumentIds: ['doc-a', 'doc-b', 'doc-c'] },
      { path: 'security/nested/index.md', affectedDocumentIds: ['doc-a'] },
    ]);
    expect(snapshotFiles(fixture.knowledgeRoot, fixture.projectRoot)).toEqual(originalFiles);
  });

  it('uses source IDs for legacy section snapshots and reports deleted sources without deleting documents', () => {
    const fixture = createFixture();
    const changes: SourceChangeSet = {
      files: [{
        sourceId: 'source-a', path: 'a.md', status: 'deleted',
        previousHash: 'a'.repeat(64), currentHash: null,
      }],
      sections: [{
        sourceId: 'source-a', sourcePath: 'a.md', sectionId: 'stable-a', status: 'deleted',
        previousHash: 'b'.repeat(64), currentHash: null,
        previousParserSectionId: null,
        currentParserSectionId: null,
      }],
    };
    const before = readFileSync(join(fixture.knowledgeRoot, 'security', 'nested', 'a.md'), 'utf8');

    const plan = planProjectKnowledgeImpact(
      fixture.projectRoot, fixture.project, fixture.knowledgeRoot, changes,
    );

    expect(plan.documents.find(({ id }) => id === 'doc-a')?.action).toBe('regenerate');
    expect(plan.removedSources).toEqual([{
      sourceId: 'source-a', path: 'a.md', documentIds: ['doc-a'], action: 'review-removed-source',
    }]);
    expect(readFileSync(join(fixture.knowledgeRoot, 'security', 'nested', 'a.md'), 'utf8')).toBe(before);
  });

  it('returns an empty plan without creating an index when no index exists', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'qlm-impact-empty-'));
    temporaryDirectories.push(dataRoot);
    const project = initializeProject(dataRoot, 'empty');
    const projectRoot = join(dataRoot, 'projects', project.name);
    const knowledgeRoot = join(projectRoot, 'knowledge');
    const changes: SourceChangeSet = { files: [], sections: [] };

    expect(planProjectKnowledgeImpact(projectRoot, project, knowledgeRoot, changes)).toEqual({
      documents: [], categoryIndexes: [], removedSources: [],
    });
    expect(() => readFileSync(resolveProjectDatabasePath(projectRoot))).toThrow();
  });
});

function createFixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'qlm-impact-'));
  temporaryDirectories.push(dataRoot);
  const project = initializeProject(dataRoot, 'demo');
  const projectRoot = join(dataRoot, 'projects', project.name);
  const knowledgeRoot = join(projectRoot, 'knowledge');
  mkdirSync(join(knowledgeRoot, 'security', 'nested'), { recursive: true });
  writeFileSync(join(knowledgeRoot, 'security', 'index.md'), categoryIndex('security', 'Security', 1));
  writeFileSync(join(knowledgeRoot, 'security', 'nested', 'index.md'), categoryIndex('nested', 'Nested', 2));
  writeFileSync(
    join(knowledgeRoot, 'security', 'nested', 'a.md'),
    document('doc-a', 'A', 3, 'security/nested', ['doc-b'], ['source-a'], ['source-a:current-parser-id']),
  );
  writeFileSync(
    join(knowledgeRoot, 'security', 'b.md'),
    document('doc-b', 'B', 2, 'security', ['doc-a', 'doc-c', 'doc-c'], ['source-b'], ['source-b:section-b']),
  );
  writeFileSync(
    join(knowledgeRoot, 'security', 'c.md'),
    document('doc-c', 'C', 2, 'security', ['doc-a'], ['source-c'], ['source-c:section-c']),
  );
  writeFileSync(
    join(knowledgeRoot, 'unrelated.md'),
    document('doc-unrelated', 'Unrelated', 1, undefined, [], ['source-c'], ['source-c:section-c']),
  );
  rebuildProjectIndex(projectRoot, project);
  return { project, projectRoot, knowledgeRoot };
}

function categoryIndex(id: string, title: string, depth: number): string {
  return `---\nid: ${id}\ntitle: ${title}\ndepth: ${depth}\ntype: category-index\n---\n\n# ${title}\n`;
}

function document(
  id: string,
  title: string,
  depth: number,
  category: string | undefined,
  related: string[],
  sourceIds: string[],
  sourceSections: string[],
): string {
  const fields = [
    '---', 'schema_version: 1', `id: ${id}`, `title: ${title}`, 'type: document',
    `depth: ${depth}`, 'status: verified',
    ...(category === undefined ? [] : [`category: ${category}`]),
    `source_ids: [${sourceIds.map((value) => JSON.stringify(value)).join(', ')}]`,
    `source_sections: [${sourceSections.map((value) => JSON.stringify(value)).join(', ')}]`,
    ...(related.length === 0 ? [] : [`related: [${related.map((value) => JSON.stringify(value)).join(', ')}]`]),
    '---', '', `# ${title}`, '', `Body for ${title}.`, '',
  ];
  return fields.join('\n');
}

function snapshotFiles(knowledgeRoot: string, projectRoot: string): string[] {
  const paths = [
    'security/index.md', 'security/nested/index.md',
    'security/nested/a.md', 'security/b.md', 'security/c.md', 'unrelated.md',
  ];
  return [
    ...paths.map((path) => readFileSync(join(knowledgeRoot, path), 'utf8')),
    String(createHash('sha256').update(readFileSync(resolveProjectDatabasePath(projectRoot))).digest('hex')),
  ];
}
