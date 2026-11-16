import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openProjectDatabase } from '../src/database/database.js';
import { rebuildProjectIndex } from '../src/database/reindex.js';
import { createMarkdownDocument } from '../src/markdown/repository.js';
import { initializeProject } from '../src/projects/manager.js';
import { buildRetrievalContext } from '../src/retrieval/context-builder.js';
import { searchProjectDocuments } from '../src/retrieval/search.js';

const readTracker = vi.hoisted(() => ({ paths: [] as string[] }));

vi.mock('../src/markdown/repository.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/markdown/repository.js')>();
  return {
    ...actual,
    readStoredMarkdownSource: vi.fn((knowledgeRoot: string, relativePath: string) => {
      readTracker.paths.push(relativePath);
      return actual.readStoredMarkdownSource(knowledgeRoot, relativePath);
    }),
  };
});

const temporaryDirectories: string[] = [];

afterEach(() => {
  readTracker.paths.length = 0;
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('Phase 4 retrieval quality fixture', () => {
  it('returns relevant results deterministically with provenance and bounded context', () => {
    const fixture = createFixture();
    const request = {
      projectRoot: fixture.projectRoot,
      project: fixture.project,
      projectId: fixture.project.id,
    };

    const pathResult = searchProjectDocuments({
      ...request,
      query: 'security/overview.md',
      mode: 'path',
    });
    expect(pathResult.map(({ path }) => path)).toEqual(['security/overview.md']);

    const hierarchyResults = searchProjectDocuments({
      ...request,
      query: 'security',
      mode: 'hierarchical',
    });
    expect(hierarchyResults.map(({ path }) => path)).toEqual([
      'security/access.md',
      'security/overview.md',
    ]);

    const fullText = searchProjectDocuments({
      ...request,
      query: 'firewall',
      mode: 'fulltext',
    });
    const repeatedFullText = searchProjectDocuments({
      ...request,
      query: 'firewall',
      mode: 'fulltext',
    });
    expect(fullText.map(({ path }) => path)).toEqual([
      'reference/firewall.md',
      'security/overview.md',
    ]);
    expect(repeatedFullText.map(({ path }) => path)).toEqual(fullText.map(({ path }) => path));
    expect(fullText[0]?.sourceIds).toEqual(['source-2']);
    expect(fullText[0]?.matchedSections).toEqual(['source-2:section-1']);
    expect(fullText[0]?.score).toBeGreaterThan(fullText[1]?.score ?? 0);

    const tagMatches = searchProjectDocuments({
      ...request,
      query: 'network',
      mode: 'fulltext',
    });
    expect(tagMatches.map(({ path }) => path)).toEqual(['reference/firewall.md']);

    const related = searchProjectDocuments({
      ...request,
      query: 'security/overview.md',
      mode: 'path',
      includeRelated: true,
    });
    expect(related.map(({ path }) => path)).toEqual([
      'security/overview.md',
      'reference/firewall.md',
    ]);
    expect(related[1]?.relatedFrom).toEqual([fixture.ids['security/overview.md']]);

    const context = buildRetrievalContext({
      ...request,
      query: 'security/overview.md',
      mode: 'path',
      includeRelated: true,
      maxTokens: 1000,
    });
    expect(context.documents.map(({ path }) => path)).toEqual([
      'security/overview.md',
      'reference/firewall.md',
    ]);
    expect(context.sources.map(({ sourceIds }) => sourceIds)).toEqual([
      ['source-1'],
      ['source-2'],
    ]);
    expect(context.consumedTokens).toBeLessThanOrEqual(context.maxTokens);
  });

  it('reads only the selected Markdown body rather than every fixture document', () => {
    const fixture = createFixture(18);
    readTracker.paths.length = 0;

    const context = buildRetrievalContext({
      projectRoot: fixture.projectRoot,
      project: fixture.project,
      projectId: fixture.project.id,
      query: 'security/overview.md',
      mode: 'path',
      maxTokens: 1000,
    });

    expect(context.documents.map(({ path }) => path)).toEqual(['security/overview.md']);
    expect(readTracker.paths).toEqual(['security/overview.md', 'security/overview.md']);
    expect(new Set(readTracker.paths).size).toBe(1);
    expect(readTracker.paths.length).toBeLessThan(fixture.markdownFileCount);
  });

  it('selects and omits documents under a constrained context budget', () => {
    const fixture = createFixture();
    const context = buildRetrievalContext({
      projectRoot: fixture.projectRoot,
      project: fixture.project,
      projectId: fixture.project.id,
      query: 'security',
      mode: 'hierarchical',
      maxTokens: 150,
    });

    expect(context.documents.map(({ path }) => path)).toEqual(['security/access.md']);
    expect(context.omittedResults).toBe(1);
    expect(context.consumedTokens).toBeLessThanOrEqual(context.maxTokens);
  });
});

function createFixture(extraDocuments = 0) {
  const dataRoot = mkdtempSync(join(tmpdir(), 'qlm-retrieval-quality-'));
  temporaryDirectories.push(dataRoot);
  const project = initializeProject(dataRoot, 'quality');
  const projectRoot = join(dataRoot, 'projects', project.name);
  const knowledgeRoot = join(projectRoot, 'knowledge');
  const documents = [
    {
      path: 'security/overview.md',
      title: 'Security Overview',
      tags: ['security'],
      sourceId: 'source-1',
      body: '# Firewall\nFirewall access requires authentication and review.',
    },
    {
      path: 'security/access.md',
      title: 'Access Controls',
      tags: ['security', 'access'],
      sourceId: 'source-3',
      body: '# Access\nAccess is granted by role and reviewed monthly.',
    },
    {
      path: 'reference/firewall.md',
      title: 'Firewall Reference',
      tags: ['network'],
      sourceId: 'source-2',
      body: '# Firewall Rules\nFirewall ports are restricted to approved services.',
    },
    {
      path: 'garden/roses.md',
      title: 'Rose Care',
      tags: ['gardening'],
      sourceId: 'source-4',
      body: '# Roses\nWater roses in the morning.',
    },
    ...Array.from({ length: extraDocuments }, (_, index) => ({
      path: `archive/item-${String(index).padStart(2, '0')}.md`,
      title: `Archive Item ${index}`,
      tags: ['archive'],
      sourceId: `archive-source-${index}`,
      body: `# Archive ${index}\nUnrelated archived content ${index}.`,
    })),
  ];
  const ids: Record<string, string> = {};
  for (const document of documents) {
    const created = createMarkdownDocument(knowledgeRoot, document.path, {
      metadata: {
        schema_version: 1,
        title: document.title,
        type: 'document',
        depth: document.path.split('/').length,
        status: 'draft',
        tags: document.tags,
        source_ids: [document.sourceId],
        source_sections: [`${document.sourceId}:section-1`],
      },
      body: `\n${document.body}\n`,
    });
    ids[document.path] = created.metadata.id;
  }
  rebuildProjectIndex(projectRoot, project);
  const database = openProjectDatabase(projectRoot, project);
  try {
    database.prepare(`
      INSERT INTO document_relations (source_id, target_id, relation_type)
      VALUES (?, ?, 'related')
    `).run(ids['security/overview.md'], ids['reference/firewall.md']);
  } finally {
    database.close();
  }

  return {
    project,
    projectRoot,
    ids,
    markdownFileCount: documents.length,
  };
}
