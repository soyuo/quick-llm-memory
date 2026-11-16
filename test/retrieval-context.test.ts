import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { InputError } from '../src/errors/qlm-error.js';
import { openProjectDatabase } from '../src/database/database.js';
import { rebuildProjectIndex } from '../src/database/reindex.js';
import { createMarkdownDocument } from '../src/markdown/repository.js';
import { initializeProject } from '../src/projects/manager.js';
import { buildRetrievalContext } from '../src/retrieval/context-builder.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('source-aware retrieval context', () => {
  it('returns full selected Markdown with structured provenance within budget', () => {
    const { projectRoot, project } = createIndexedProject();
    const result = buildRetrievalContext({
      projectRoot,
      project,
      projectId: project.id,
      query: 'security',
      mode: 'hierarchical',
      maxTokens: 2000,
    });

    expect(result.documents.map(({ path }) => path)).toEqual([
      'security/overview.md',
      'security/vm/create.md',
    ]);
    expect(result.context).toContain('Security guidance in full.');
    expect(result.context).toContain('Create a virtual machine in full.');
    expect(result.context).toContain('Sources: source-2');
    expect(result.sources[0]).toMatchObject({
      path: 'security/overview.md',
      sourceIds: ['source-2'],
      sourceSections: ['source-2:section-1'],
    });
    expect(result.consumedTokens).toBeLessThanOrEqual(result.maxTokens);
    expect(result.tokenCountsAreEstimates).toBe(true);
    expect(result.omittedResults).toBe(0);
  });

  it('deduplicates related documents and preserves direct relationship provenance', () => {
    const { projectRoot, project } = createIndexedProject();
    const database = openProjectDatabase(projectRoot, project);
    try {
      const rows = database.prepare('SELECT id, path FROM documents').all() as Array<{
        id: string;
        path: string;
      }>;
      const ids = Object.fromEntries(rows.map(({ id, path }) => [path, id]));
      database.prepare(`
        INSERT INTO document_relations (source_id, target_id, relation_type)
        VALUES (?, ?, 'related')
      `).run(ids['security/overview.md'], ids['security/vm/create.md']);
    } finally {
      database.close();
    }

    const result = buildRetrievalContext({
      projectRoot,
      project,
      projectId: project.id,
      query: 'security',
      mode: 'hierarchical',
      includeRelated: true,
      maxTokens: 2000,
    });

    expect(result.documents.map(({ path }) => path)).toEqual([
      'security/overview.md',
      'security/vm/create.md',
    ]);
    expect(new Set(result.documents.map(({ documentId }) => documentId)).size)
      .toBe(result.documents.length);
    expect(result.documents[1]?.relatedFrom).toEqual([result.documents[0]?.documentId]);
  });

  it('includes matching Markdown sections without unrelated sections', () => {
    const { projectRoot, project } = createIndexedProject([
      '# Relevant Section',
      'Security guidance applies to production systems.',
      '',
      '# Unrelated Section',
      'Unrelated release notes should not enter this context.',
    ].join('\n'));
    const result = buildRetrievalContext({
      projectRoot,
      project,
      projectId: project.id,
      query: 'security guidance',
      mode: 'fulltext',
      maxTokens: 2000,
    });

    expect(result.context).toContain('Relevant Section');
    expect(result.context).toContain('Security guidance applies');
    expect(result.context).not.toContain('Unrelated Section');
    expect(result.context).not.toContain('Unrelated release notes');
  });

  it('skips an oversized higher-ranked document and continues to a smaller one', () => {
    const { projectRoot, project } = createIndexedProject('x'.repeat(2000));
    const result = buildRetrievalContext({
      projectRoot,
      project,
      projectId: project.id,
      query: 'security',
      mode: 'hierarchical',
      maxTokens: 150,
    });

    expect(result.documents.map(({ path }) => path)).toEqual(['security/vm/create.md']);
    expect(result.omittedResults).toBe(1);
    expect(result.consumedTokens).toBeLessThanOrEqual(150);
  });

  it('returns a valid empty context for no matches and for zero budget', () => {
    const { projectRoot, project } = createIndexedProject();
    const empty = buildRetrievalContext({
      projectRoot,
      project,
      projectId: project.id,
      query: 'missingterm',
      mode: 'fulltext',
      maxTokens: 100,
    });
    expect(empty).toMatchObject({ context: '', documents: [], sources: [], consumedTokens: 0 });

    const zero = buildRetrievalContext({
      projectRoot,
      project,
      projectId: project.id,
      query: 'security',
      mode: 'hierarchical',
      maxTokens: 0,
    });
    expect(zero.documents).toEqual([]);
    expect(zero.consumedTokens).toBe(0);
    expect(zero.omittedResults).toBe(2);
  });

  it('rejects invalid budgets before opening the search index', () => {
    const { projectRoot, project } = createIndexedProject(undefined, false);
    expect(() => buildRetrievalContext({
      projectRoot,
      project,
      projectId: project.id,
      query: 'security',
      mode: 'fulltext',
      maxTokens: -1,
    })).toThrow(InputError);
  });
});

function createIndexedProject(overviewBody?: string, index = true) {
  const dataRoot = mkdtempSync(join(tmpdir(), 'qlm-context-'));
  temporaryDirectories.push(dataRoot);
  const project = initializeProject(dataRoot, 'demo');
  const projectRoot = join(dataRoot, 'projects', project.name);
  const knowledgeRoot = join(projectRoot, 'knowledge');
  createMarkdownDocument(knowledgeRoot, 'security/overview.md', {
    metadata: {
      schema_version: 1,
      title: 'Security Overview',
      type: 'document',
      depth: 2,
      status: 'draft',
      source_ids: ['source-2'],
      source_sections: ['source-2:section-1'],
    },
    body: `\n${overviewBody ?? 'Security guidance in full.'}\n`,
  });
  createMarkdownDocument(knowledgeRoot, 'security/vm/create.md', {
    metadata: {
      schema_version: 1,
      title: 'Create VM',
      type: 'document',
      depth: 3,
      status: 'draft',
      source_ids: ['source-1'],
      source_sections: ['source-1:section-1'],
    },
    body: '\nCreate a virtual machine in full.\n',
  });
  if (index) rebuildProjectIndex(projectRoot, project);
  return { projectRoot, project };
}
