import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { rebuildProjectIndexWithEmbeddings } from '../src/database/reindex.js';
import type { EmbeddingProvider } from '../src/providers/provider.js';
import { initializeProject } from '../src/projects/manager.js';
import { searchProjectDocuments } from '../src/retrieval/search.js';

const temporaryDirectories: string[] = [];
const MODEL = 'fixture-embeddings-v1';
const RANKING_QUERY = 'network';
const SEMANTIC_QUERY = 'prevent illicit entry';
const RELEVANT_PATHS = [
  'network/firewall.md',
  'network/router.md',
  'security/ingress.md',
];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('Phase 7 retrieval quality evaluation', () => {
  it('meets labeled top-two coverage and the deterministic ranking baseline', async () => {
    const fixture = await createLabeledFixture();
    const request = {
      projectRoot: fixture.projectRoot,
      project: fixture.project,
      projectId: fixture.project.id,
      maxResults: 3,
      synchronizeStaleIndex: false as const,
    };

    const rankingResults = await evaluateQuery(request, fixture.provider, RANKING_QUERY);
    expect(paths(rankingResults.fulltext)).toEqual(['network/router.md', 'network/firewall.md']);
    expect(paths(rankingResults.semantic)).toEqual([
      'network/firewall.md',
      'security/ingress.md',
      'network/router.md',
    ]);
    expect(paths(rankingResults.hybrid)).toEqual([
      'network/firewall.md',
      'network/router.md',
      'security/ingress.md',
    ]);
    expect(topKCoverage(rankingResults.fulltext, RELEVANT_PATHS)).toBeCloseTo(2 / 3);
    expect(topKCoverage(rankingResults.semantic, RELEVANT_PATHS)).toBe(1);
    expect(topKCoverage(rankingResults.hybrid, RELEVANT_PATHS)).toBe(1);
    expect(rankingResults.hybrid[0]?.score).toBeGreaterThan(rankingResults.hybrid[1]?.score ?? 0);

    const semanticResults = await evaluateQuery(request, fixture.provider, SEMANTIC_QUERY);
    expect(semanticResults.fulltext).toEqual([]);
    expect(paths(semanticResults.semantic).slice(0, 2)).toEqual([
      'network/firewall.md',
      'security/ingress.md',
    ]);
    expect(paths(semanticResults.hybrid).slice(0, 2)).toEqual([
      'network/firewall.md',
      'security/ingress.md',
    ]);
    expect(topKCoverage(semanticResults.semantic.slice(0, 2), [
      'network/firewall.md',
      'security/ingress.md',
    ])).toBe(1);
    expect(topKCoverage(semanticResults.hybrid.slice(0, 2), [
      'network/firewall.md',
      'security/ingress.md',
    ])).toBe(1);
    expect(fixture.provider.queryCalls).toBe(8);
  });
});

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
    embeddingModel: MODEL,
  });
  const repeatedSemantic = await searchProjectDocuments({
    ...request,
    query,
    mode: 'semantic',
    embeddingProvider: provider,
    embeddingModel: MODEL,
  });
  expect(paths(repeatedSemantic)).toEqual(paths(semantic));
  const hybrid = await searchProjectDocuments({
    ...request,
    query,
    mode: 'hybrid',
    embeddingProvider: provider,
    embeddingModel: MODEL,
  });
  const repeatedHybrid = await searchProjectDocuments({
    ...request,
    query,
    mode: 'hybrid',
    embeddingProvider: provider,
    embeddingModel: MODEL,
  });
  expect(paths(repeatedHybrid)).toEqual(paths(hybrid));
  return { fulltext, semantic, hybrid };
}

async function createLabeledFixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'qlm-retrieval-quality-phase7-'));
  temporaryDirectories.push(dataRoot);
  const project = initializeProject(dataRoot, 'retrieval-quality');
  const projectRoot = join(dataRoot, 'projects', project.name);
  const knowledgeRoot = join(projectRoot, 'knowledge');
  const fixtureRoot = resolve('test/fixtures/retrieval-quality');
  const paths = [
    'network/firewall.md',
    'network/router.md',
    'security/ingress.md',
    'garden/roses.md',
  ];
  for (const path of paths) {
    const destination = join(knowledgeRoot, path);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(join(fixtureRoot, path), destination);
  }

  const provider = new FixtureEmbeddingProvider();
  await rebuildProjectIndexWithEmbeddings(projectRoot, project, { provider, model: MODEL });
  provider.queryCalls = 0;
  return { project, projectRoot, provider };
}

class FixtureEmbeddingProvider implements EmbeddingProvider {
  readonly id = 'deterministic-retrieval-quality-fixture';
  queryCalls = 0;

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => {
      if ([RANKING_QUERY, SEMANTIC_QUERY].includes(text.trim().toLowerCase())) {
        this.queryCalls += 1;
      }
      const normalized = text.toLowerCase();
      if ([RANKING_QUERY, SEMANTIC_QUERY].includes(text.trim().toLowerCase()) ||
          normalized.includes('firewall')) {
        return [1, 0];
      }
      if (normalized.includes('inbound threat inspection')) return [0.95, Math.sqrt(1 - 0.95 ** 2)];
      if (normalized.includes('router')) return [0.8, 0.6];
      return [0, 1];
    });
  }
}

function paths(results: readonly { path: string }[]): string[] {
  return results.map(({ path }) => path);
}

function topKCoverage(
  results: readonly { path: string }[],
  relevantPaths: readonly string[],
): number {
  const found = new Set(paths(results));
  return relevantPaths.filter((path) => found.has(path)).length / relevantPaths.length;
}
