import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openProjectDatabase } from '../src/database/database.js';
import { rebuildProjectIndex, rebuildProjectIndexWithEmbeddings } from '../src/database/reindex.js';
import { createMarkdownDocument } from '../src/markdown/repository.js';
import type { EmbeddingProvider } from '../src/providers/provider.js';
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

const QUALITY_MODEL = 'fixture-embeddings-v1';
const RANKING_QUERY = 'network';
const SEMANTIC_QUERY = 'prevent illicit entry';
const NETWORK_RELEVANT_PATHS = [
  'network/firewall.md',
  'network/router.md',
  'security/ingress.md',
];

describe('Phase 7 retrieval quality evaluation', () => {
  it('meets labeled top-three coverage and the deterministic ranking baseline', async () => {
    const fixture = await createLabeledFixture();
    const request = {
      projectRoot: fixture.projectRoot,
      project: fixture.project,
      projectId: fixture.project.id,
      maxResults: 3,
      synchronizeStaleIndex: false as const,
    };

    const rankingResults = await evaluateQuery(request, fixture.provider, RANKING_QUERY);
    expect(qualityPaths(rankingResults.fulltext)).toEqual([
      'network/router.md',
      'network/firewall.md',
    ]);
    expect(qualityPaths(rankingResults.semantic)).toEqual([
      'network/firewall.md',
      'security/ingress.md',
      'network/router.md',
    ]);
    expect(qualityPaths(rankingResults.hybrid)).toEqual([
      'network/firewall.md',
      'network/router.md',
      'security/ingress.md',
    ]);
    expect(topKCoverage(rankingResults.fulltext, NETWORK_RELEVANT_PATHS)).toBeCloseTo(2 / 3);
    expect(topKCoverage(rankingResults.semantic, NETWORK_RELEVANT_PATHS)).toBe(1);
    expect(topKCoverage(rankingResults.hybrid, NETWORK_RELEVANT_PATHS)).toBe(1);
    expect(rankingResults.hybrid[0]?.score).toBeGreaterThan(rankingResults.hybrid[1]?.score ?? 0);

    const semanticResults = await evaluateQuery(request, fixture.provider, SEMANTIC_QUERY);
    expect(semanticResults.fulltext).toEqual([]);
    const semanticRelevant = ['network/firewall.md', 'security/ingress.md'];
    expect(qualityPaths(semanticResults.semantic).slice(0, 2)).toEqual(semanticRelevant);
    expect(qualityPaths(semanticResults.hybrid).slice(0, 2)).toEqual(semanticRelevant);
    expect(topKCoverage(semanticResults.semantic.slice(0, 2), semanticRelevant)).toBe(1);
    expect(topKCoverage(semanticResults.hybrid.slice(0, 2), semanticRelevant)).toBe(1);
    expect(fixture.provider.queryCalls).toBe(8);
  });
});

async function createLabeledFixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'qlm-retrieval-quality-phase7-'));
  temporaryDirectories.push(dataRoot);
  const project = initializeProject(dataRoot, 'retrieval-quality');
  const projectRoot = join(dataRoot, 'projects', project.name);
  const knowledgeRoot = join(projectRoot, 'knowledge');
  const fixtureRoot = resolve('test/fixtures/retrieval-quality');
  const fixturePaths = [
    'network/firewall.md',
    'network/router.md',
    'security/ingress.md',
    'garden/roses.md',
  ];
  for (const path of fixturePaths) {
    const destination = join(knowledgeRoot, path);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(join(fixtureRoot, path), destination);
  }

  const provider = new FixtureEmbeddingProvider();
  await rebuildProjectIndexWithEmbeddings(projectRoot, project, {
    provider,
    model: QUALITY_MODEL,
  });
  provider.queryCalls = 0;
  return { project, projectRoot, provider };
}

class FixtureEmbeddingProvider implements EmbeddingProvider {
  readonly id = 'deterministic-retrieval-quality-fixture';
  queryCalls = 0;

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => {
      const query = text.trim().toLowerCase();
      if ([RANKING_QUERY, SEMANTIC_QUERY].includes(query)) this.queryCalls += 1;
      const normalized = text.toLowerCase();
      if ([RANKING_QUERY, SEMANTIC_QUERY].includes(query) || normalized.includes('firewall')) {
        return [1, 0];
      }
      if (normalized.includes('inbound threat inspection')) {
        return [0.95, Math.sqrt(1 - 0.95 ** 2)];
      }
      if (normalized.includes('router')) return [0.8, 0.6];
      return [0, 1];
    });
  }
}

async function evaluateQuery(
  request: {
    projectRoot: string;
    project: ReturnType<typeof initializeProject>;
    projectId: string;
    maxResults: number;
    synchronizeStaleIndex: false;
  },
  provider: EmbeddingProvider,
  query: string,
) {
  const fulltext = searchProjectDocuments({ ...request, query, mode: 'fulltext' });
  const semantic = await searchProjectDocuments({
    ...request,
    query,
    mode: 'semantic',
    embeddingProvider: provider,
    embeddingModel: QUALITY_MODEL,
  });
  const repeatedSemantic = await searchProjectDocuments({
    ...request,
    query,
    mode: 'semantic',
    embeddingProvider: provider,
    embeddingModel: QUALITY_MODEL,
  });
  expect(qualityPaths(repeatedSemantic)).toEqual(qualityPaths(semantic));
  const hybrid = await searchProjectDocuments({
    ...request,
    query,
    mode: 'hybrid',
    embeddingProvider: provider,
    embeddingModel: QUALITY_MODEL,
  });
  const repeatedHybrid = await searchProjectDocuments({
    ...request,
    query,
    mode: 'hybrid',
    embeddingProvider: provider,
    embeddingModel: QUALITY_MODEL,
  });
  expect(qualityPaths(repeatedHybrid)).toEqual(qualityPaths(hybrid));
  return { fulltext, semantic, hybrid };
}

function qualityPaths(results: readonly { path: string }[]): string[] {
  return results.map(({ path }) => path);
}

function topKCoverage(
  results: readonly { path: string }[],
  relevantPaths: readonly string[],
): number {
  const found = new Set(qualityPaths(results));
  return relevantPaths.filter((path) => found.has(path)).length / relevantPaths.length;
}

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
