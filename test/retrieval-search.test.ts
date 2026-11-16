import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigurationError } from '../src/config/error.js';
import { InputError } from '../src/errors/qlm-error.js';
import { resolveProjectDatabasePath } from '../src/database/database.js';
import { rebuildProjectIndex } from '../src/database/reindex.js';
import { runCli } from '../src/cli.js';
import { createApplicationLogger } from '../src/logging/logger.js';
import { createMarkdownDocument } from '../src/markdown/repository.js';
import { initializeProject } from '../src/projects/manager.js';
import { RRF_K } from '../src/retrieval/ranker.js';
import { searchProjectDocuments } from '../src/retrieval/search.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('path and hierarchical retrieval', () => {
  it('returns one exact path result with source metadata without changing the index', () => {
    const { projectRoot, knowledgeRoot, project } = createIndexedProject();
    const databasePath = resolveProjectDatabasePath(projectRoot);
    const before = readFileSync(databasePath);

    const results = searchProjectDocuments({
      projectRoot,
      project,
      projectId: project.id,
      query: 'security/vm/create.md',
      mode: 'path',
    });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      path: 'security/vm/create.md',
      title: 'Create VM',
      sourceIds: ['source-1'],
      matchedSections: ['source-1:section-1'],
      score: 1 / (RRF_K + 1),
    });
    expect(results[0]?.tokenCount).toBeGreaterThan(0);
    expect(results[0]?.snippet).toContain('Create a virtual machine');
    expect(readFileSync(databasePath)).toEqual(before);
    expect(readFileSync(join(knowledgeRoot, 'security/vm/create.md'), 'utf8'))
      .toContain('Create a virtual machine');
  });

  it('limits hierarchy results to the requested category subtree and depth', () => {
    const { projectRoot, project } = createIndexedProject();

    const shallow = searchProjectDocuments({
      projectRoot,
      project,
      projectId: project.id,
      query: 'security',
      mode: 'hierarchical',
      maxDepth: 2,
    });
    const full = searchProjectDocuments({
      projectRoot,
      project,
      projectId: project.id,
      query: 'security',
      mode: 'hierarchical',
      maxDepth: 3,
    });

    expect(shallow.map(({ path }) => path)).toEqual(['security/overview.md']);
    expect(full.map(({ path }) => path)).toEqual([
      'security/overview.md',
      'security/vm/create.md',
    ]);

    const root = searchProjectDocuments({
      projectRoot,
      project,
      projectId: project.id,
      query: '.',
      mode: 'hierarchical',
      maxDepth: 1,
    });
    expect(root.map(({ path }) => path)).toEqual(['root.md']);

    const ranked = searchProjectDocuments({
      projectRoot,
      project,
      projectId: project.id,
      query: 'security',
      mode: 'hierarchical',
    });
    expect(ranked[0]?.score).toBeGreaterThan(ranked[1]?.score ?? 0);
  });

  it('fuses hierarchy and full-text candidates with stable scores and provenance', () => {
    const { projectRoot, project } = createIndexedProject();

    const results = searchProjectDocuments({
      projectRoot,
      project,
      projectId: project.id,
      query: 'security',
      mode: 'hybrid',
    });

    expect(results.map(({ path }) => path)).toEqual([
      'security/overview.md',
      'security/vm/create.md',
    ]);
    expect(results[0]?.score).toBeGreaterThan(results[1]?.score ?? 0);
    expect(results[0]?.sourceIds).toEqual(['source-2']);
    expect(results[0]?.matchedSections).toEqual(['source-2:section-1']);
  });

  it('lets a replaceable ranker receive exact-path candidates', () => {
    const { projectRoot, project } = createIndexedProject();
    let receivedModes: string[] = [];

    const results = searchProjectDocuments({
      projectRoot,
      project,
      projectId: project.id,
      query: 'security/overview.md',
      mode: 'hybrid',
      ranker: {
        rank(sources) {
          receivedModes = sources.map(({ mode }) => mode);
          return sources.flatMap(({ results: sourceResults }) => [...sourceResults]);
        },
      },
    });

    expect(receivedModes).toEqual(['path', 'hierarchical']);
    expect(results.map(({ path }) => path)).toEqual(['security/overview.md']);
  });

  it('passes hierarchy and full-text sources to a ranker and applies its limit afterward', () => {
    const { projectRoot, project } = createIndexedProject();
    let receivedModes: string[] = [];
    let receivedMaximum = 0;

    const results = searchProjectDocuments({
      projectRoot,
      project,
      projectId: project.id,
      query: 'security',
      mode: 'hybrid',
      maxResults: 1,
      ranker: {
        rank(sources, maxResults) {
          receivedModes = sources.map(({ mode }) => mode);
          receivedMaximum = maxResults;
          return sources.flatMap(({ results: sourceResults }) => [...sourceResults]).reverse();
        },
      },
    });

    expect(receivedModes).toEqual(['hierarchical', 'fulltext']);
    expect(receivedMaximum).toBe(1);
    expect(results).toHaveLength(1);
  });

  it('rejects traversal and invalid limits, and returns an empty result for missing paths', () => {
    const { projectRoot, project } = createIndexedProject();
    expect(() => searchProjectDocuments({
      projectRoot,
      project,
      projectId: project.id,
      query: '../outside.md',
      mode: 'path',
    })).toThrow(InputError);
    expect(() => searchProjectDocuments({
      projectRoot,
      project,
      projectId: project.id,
      query: 'security',
      mode: 'hierarchical',
      maxDepth: -1,
    })).toThrow(InputError);
    expect(() => searchProjectDocuments({
      projectRoot,
      project,
      projectId: project.id,
      query: 'security',
      mode: 'fulltext',
      maxResults: 101,
    })).toThrow(/must not exceed 100/);
    expect(searchProjectDocuments({
      projectRoot,
      project,
      projectId: project.id,
      query: 'missing.md',
      mode: 'path',
    })).toEqual([]);
  });

  it('does not create an index as a side effect when one is missing', () => {
    const { projectRoot, project } = createIndexedProject(false);
    expect(() => searchProjectDocuments({
      projectRoot,
      project,
      projectId: project.id,
      query: 'security/overview.md',
      mode: 'path',
    })).toThrow(ConfigurationError);
  });

  it('exposes path mode through qlm search with source output', async () => {
    const { dataRoot, projectRoot, project } = createIndexedProject();
    const output: string[] = [];
    const errorOutput: string[] = [];
    const exitCode = await runCli(
      ['node', 'qlm', 'search', 'security/overview.md', '--project', 'demo', '--mode', 'path'],
      {
        writeOut: (text) => output.push(text),
        writeError: (text) => errorOutput.push(text),
      },
      {
        runtimeFactory: () => ({
          dataRoot,
          logger: createApplicationLogger({ dataRoot, level: 'fatal' }),
        }),
      },
    );

    expect(exitCode).toBe(0);
    expect(errorOutput.join('')).toBe('');
    expect(output.join('')).toContain('security/overview.md');
    expect(output.join('')).toContain('source-2');
    expect(project.id).toBeTruthy();
    expect(projectRoot).toBeTruthy();
  });

  it('exposes bounded hierarchical mode through qlm search', async () => {
    const { dataRoot } = createIndexedProject();
    const output: string[] = [];
    const errorOutput: string[] = [];
    const exitCode = await runCli(
      ['node', 'qlm', 'search', 'security', '--project', 'demo', '--mode', 'hierarchical', '--max-depth', '2'],
      {
        writeOut: (text) => output.push(text),
        writeError: (text) => errorOutput.push(text),
      },
      {
        runtimeFactory: () => ({
          dataRoot,
          logger: createApplicationLogger({ dataRoot, level: 'fatal' }),
        }),
      },
    );

    expect(exitCode).toBe(0);
    expect(errorOutput.join('')).toBe('');
    expect(output.join('')).toContain('security/overview.md');
    expect(output.join('')).not.toContain('security/vm/create.md');
  });

  it('exposes hybrid retrieval with hierarchy depth through qlm search', async () => {
    const { dataRoot } = createIndexedProject();
    const output: string[] = [];
    const errorOutput: string[] = [];
    const exitCode = await runCli(
      ['node', 'qlm', 'search', 'security', '--project', 'demo', '--mode', 'hybrid'],
      {
        writeOut: (text) => output.push(text),
        writeError: (text) => errorOutput.push(text),
      },
      {
        runtimeFactory: () => ({
          dataRoot,
          logger: createApplicationLogger({ dataRoot, level: 'fatal' }),
        }),
      },
    );

    expect(exitCode).toBe(0);
    expect(errorOutput.join('')).toBe('');
    expect(output.join('')).toContain('Search results (hybrid)');
    expect(output.join('')).toContain('security/overview.md');
    expect(output.join('')).toContain('security/vm/create.md');
  });

  it('rejects retrieval limits without an explicit mode', async () => {
    const { dataRoot } = createIndexedProject();
    const errorOutput: string[] = [];
    const exitCode = await runCli(
      ['node', 'qlm', 'search', 'security', '--project', 'demo', '--max-depth', '2'],
      {
        writeOut: () => undefined,
        writeError: (text) => errorOutput.push(text),
      },
      {
        runtimeFactory: () => ({
          dataRoot,
          logger: createApplicationLogger({ dataRoot, level: 'fatal' }),
        }),
      },
    );

    expect(exitCode).toBe(1);
    expect(errorOutput.join('')).toContain('Retrieval limits require an explicit --mode.');
  });
});

describe('SQLite full-text retrieval', () => {
  it('searches title, path, tags, description, and body in stable order', () => {
    const { projectRoot, knowledgeRoot, project } = createIndexedProject();

    for (const [query, expectedPaths] of [
      ['security', ['security/overview.md', 'security/vm/create.md']],
      ['compliance', ['security/overview.md']],
      ['policy', ['security/overview.md']],
      ['guidance', ['security/overview.md']],
    ] as const) {
      const results = searchProjectDocuments({
        projectRoot,
        project,
        projectId: project.id,
        query,
        mode: 'fulltext',
      });
      expect(results.map(({ path }) => path)).toEqual(expectedPaths);
    }

    const bounded = searchProjectDocuments({
      projectRoot,
      project,
      projectId: project.id,
      query: 'security',
      mode: 'fulltext',
      maxResults: 1,
    });
    expect(bounded.map(({ path }) => path)).toEqual(['security/overview.md']);
    expect(bounded[0]?.score).toBe(1 / (RRF_K + 1));

    const relevant = searchProjectDocuments({
      projectRoot,
      project,
      projectId: project.id,
      query: 'security',
      mode: 'fulltext',
    });
    expect(relevant[0]?.path).toBe('security/overview.md');
    expect(relevant[0]?.score).toBeGreaterThan(relevant[1]?.score ?? 0);
    expect(readFileSync(join(knowledgeRoot, 'security/overview.md'), 'utf8'))
      .toContain('Security guidance.');
  });

  it('returns no matches and turns malformed FTS syntax into an input error', () => {
    const { projectRoot, project } = createIndexedProject();
    const search = (query: string) => searchProjectDocuments({
      projectRoot,
      project,
      projectId: project.id,
      query,
      mode: 'fulltext',
    });

    expect(search('unmatchedtoken')).toEqual([]);
    expect(() => search('"')).toThrow(InputError);
    expect(() => search('   ')).toThrow(InputError);
  });

  it('synchronizes a stale full-text index and retries the query once', () => {
    const { projectRoot, knowledgeRoot, project } = createIndexedProject();
    const path = join(knowledgeRoot, 'security/overview.md');
    const markdown = readFileSync(path, 'utf8');
    writeFileSync(path, markdown.replace('title: Security Overview', 'title: Updated Security Overview'), 'utf8');

    const results = searchProjectDocuments({
      projectRoot,
      project,
      projectId: project.id,
      query: 'security',
      mode: 'fulltext',
    });
    expect(results[0]).toMatchObject({
      path: 'security/overview.md',
      title: 'Updated Security Overview',
    });
    expect(searchProjectDocuments({
      projectRoot,
      project,
      projectId: project.id,
      query: 'updated',
      mode: 'fulltext',
    }).map(({ path }) => path)).toEqual(['security/overview.md']);
  });

  it('exposes full-text mode through qlm search', async () => {
    const { dataRoot } = createIndexedProject();
    const output: string[] = [];
    const errorOutput: string[] = [];
    const exitCode = await runCli(
      ['node', 'qlm', 'search', 'compliance', '--project', 'demo', '--mode', 'fulltext'],
      {
        writeOut: (text) => output.push(text),
        writeError: (text) => errorOutput.push(text),
      },
      {
        runtimeFactory: () => ({
          dataRoot,
          logger: createApplicationLogger({ dataRoot, level: 'fatal' }),
        }),
      },
    );

    expect(exitCode).toBe(0);
    expect(errorOutput.join('')).toBe('');
    expect(output.join('')).toContain('security/overview.md');
  });

  it('reports malformed full-text syntax as a nonzero CLI error', async () => {
    const { dataRoot } = createIndexedProject();
    const errorOutput: string[] = [];
    const exitCode = await runCli(
      ['node', 'qlm', 'search', '"', '--project', 'demo', '--mode', 'fulltext'],
      {
        writeOut: () => undefined,
        writeError: (text) => errorOutput.push(text),
      },
      {
        runtimeFactory: () => ({
          dataRoot,
          logger: createApplicationLogger({ dataRoot, level: 'fatal' }),
        }),
      },
    );

    expect(exitCode).toBe(1);
    expect(errorOutput.join('')).toContain('full-text query is malformed');
  });
});

function createIndexedProject(index = true) {
  const dataRoot = mkdtempSync(join(tmpdir(), 'qlm-retrieval-'));
  temporaryDirectories.push(dataRoot);
  const project = initializeProject(dataRoot, 'demo');
  const projectRoot = join(dataRoot, 'projects', project.name);
  const knowledgeRoot = join(projectRoot, 'knowledge');
  createMarkdownDocument(knowledgeRoot, 'root.md', {
    metadata: {
      schema_version: 1,
      title: 'Root Document',
      type: 'document',
      depth: 1,
      status: 'draft',
    },
    body: '\nA root level document.\n',
  });
  createMarkdownDocument(knowledgeRoot, 'security/overview.md', {
    metadata: {
      schema_version: 1,
      title: 'Security Overview',
      type: 'document',
      depth: 2,
      status: 'draft',
      source_ids: ['source-2'],
      source_sections: ['source-2:section-1'],
      tags: ['compliance'],
      description: 'Policy overview',
    },
    body: '\nSecurity guidance.\n',
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
    body: '\nCreate a virtual machine.\n',
  });
  createMarkdownDocument(knowledgeRoot, 'other/note.md', {
    metadata: {
      schema_version: 1,
      title: 'Other Note',
      type: 'document',
      depth: 2,
      status: 'draft',
    },
    body: '\nAn unrelated note.\n',
  });
  if (index) {
    rebuildProjectIndex(projectRoot, project);
  }
  return { dataRoot, projectRoot, knowledgeRoot, project };
}
