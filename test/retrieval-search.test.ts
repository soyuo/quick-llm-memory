import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigurationError } from '../src/config/error.js';
import { InputError } from '../src/errors/qlm-error.js';
import { openProjectDatabase, resolveProjectDatabasePath } from '../src/database/database.js';
import { rebuildProjectIndex } from '../src/database/reindex.js';
import { runCli } from '../src/cli.js';
import { createApplicationLogger } from '../src/logging/logger.js';
import { createMarkdownDocument } from '../src/markdown/repository.js';
import { initializeProject } from '../src/projects/manager.js';
import { reciprocalRankFusionRanker, RRF_K } from '../src/retrieval/ranker.js';
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

  it('keeps full-text candidates for path-shaped hybrid queries', () => {
    const { projectRoot, knowledgeRoot, project } = createIndexedProject();
    createMarkdownDocument(knowledgeRoot, 'other/related.md', {
      metadata: {
        schema_version: 1,
        title: 'Related Notes',
        type: 'document',
        depth: 2,
        status: 'draft',
      },
      body: '\nSee the overview before review.\n',
    });
    rebuildProjectIndex(projectRoot, project);

    const results = searchProjectDocuments({
      projectRoot,
      project,
      projectId: project.id,
      query: 'security/overview.md',
      mode: 'hybrid',
    });

    expect(results.map(({ path }) => path)).toContain('security/overview.md');
    expect(results.map(({ path }) => path)).toContain('other/related.md');
  }, 15_000);

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
        rank(sources, maxResults) {
          receivedModes = sources.map(({ mode }) => mode);
          return reciprocalRankFusionRanker.rank(sources, maxResults);
        },
      },
    });

    expect(receivedModes).toEqual(['path', 'hierarchical', 'fulltext']);
    const paths = results.map(({ path }) => path);
    expect(paths).toEqual(['security/overview.md', 'security/vm/create.md']);
    expect(new Set(paths).size).toBe(paths.length);
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
      [
        'node', 'qlm', 'search', 'security', '--project', 'demo', '--max-depth', '2',
        '--max-tokens', '100',
      ],
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

  it('applies a zero token budget and reports the estimate', async () => {
    const { dataRoot } = createIndexedProject();
    const output: string[] = [];
    const errorOutput: string[] = [];
    const exitCode = await runCli(
      [
        'node', 'qlm', 'search', 'security', '--project', 'demo', '--mode', 'fulltext',
        '--max-tokens', '0',
      ],
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
    expect(output.join('')).toContain('Estimated token budget: 0/0; counts are estimates.');
    expect(output.join('')).toContain('No matching documents fit the token budget.');
  });

  it('prints the selected context estimate for budgeted results', async () => {
    const { dataRoot } = createIndexedProject();
    const output: string[] = [];
    const exitCode = await runCli(
      [
        'node', 'qlm', 'search', 'security/overview.md', '--project', 'demo',
        '--mode', 'path', '--max-tokens', '1000',
      ],
      {
        writeOut: (text) => output.push(text),
        writeError: () => undefined,
      },
      {
        runtimeFactory: () => ({
          dataRoot,
          logger: createApplicationLogger({ dataRoot, level: 'fatal' }),
        }),
      },
    );

    expect(exitCode).toBe(0);
    expect(output.join('')).toContain('Estimated token budget: ');
    expect(output.join('')).toContain('estimated context tokens: ');
    expect(output.join('')).not.toContain('estimated tokens: ');
  });

  it('rejects malformed token budgets before retrieval', async () => {
    const { dataRoot } = createIndexedProject();
    const errorOutput: string[] = [];
    const exitCode = await runCli(
      [
        'node', 'qlm', 'search', 'security', '--project', 'demo', '--mode', 'path',
        '--max-tokens', '1.5',
      ],
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
    expect(errorOutput.join('')).toContain('Maximum tokens must be a non-negative integer.');
  });
});

describe('related-document expansion', () => {
  it('ignores dangling relation targets', () => {
    const { projectRoot, project } = createIndexedProject();
    const ids = getDocumentIds(projectRoot, project);
    addRelations(projectRoot, project, [[
      ids['security/overview.md']!,
      'missing-document-id',
    ]]);

    const results = searchProjectDocuments({
      projectRoot,
      project,
      projectId: project.id,
      query: 'security/overview.md',
      mode: 'path',
      includeRelated: true,
    });

    expect(results.map(({ path }) => path)).toEqual(['security/overview.md']);
  });

  it('does not return targets belonging to another project', () => {
    const { dataRoot, projectRoot, project } = createIndexedProject();
    const foreignProject = initializeProject(dataRoot, 'foreign');
    const ids = getDocumentIds(projectRoot, project);
    const database = openProjectDatabase(projectRoot, project);
    try {
      database.prepare(`
        INSERT INTO projects (id, name, root_path, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        foreignProject.id,
        foreignProject.name,
        join(dataRoot, 'projects', foreignProject.name),
        foreignProject.created_at,
        foreignProject.updated_at,
      );
      database.prepare(`
        INSERT INTO documents (
          id, project_id, path, title, category_id, depth, content_hash,
          status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, NULL, 1, ?, 'draft', ?, ?)
      `).run(
        'foreign-document-id', foreignProject.id, 'foreign.md', 'Foreign',
        'unused-hash', foreignProject.created_at, foreignProject.updated_at,
      );
      database.prepare(`
        INSERT INTO document_relations (source_id, target_id, relation_type)
        VALUES (?, ?, 'related')
      `).run(ids['security/overview.md'], 'foreign-document-id');
    } finally {
      database.close();
    }

    const results = searchProjectDocuments({
      projectRoot,
      project,
      projectId: project.id,
      query: 'security/overview.md',
      mode: 'path',
      includeRelated: true,
    });
    expect(results.map(({ path }) => path)).toEqual(['security/overview.md']);
  });

  it('is opt-in and adds only one-hop targets with merged provenance', () => {
    const { projectRoot, project } = createIndexedProject();
    const ids = getDocumentIds(projectRoot, project);
    addRelations(projectRoot, project, [
      [ids['security/overview.md']!, ids['other/note.md']!],
      [ids['security/vm/create.md']!, ids['other/note.md']!],
      [ids['security/overview.md']!, ids['security/vm/create.md']!],
      [ids['other/note.md']!, ids['root.md']!],
    ]);
    const databasePath = resolveProjectDatabasePath(projectRoot);
    const before = readFileSync(databasePath);
    const base = {
      projectRoot,
      project,
      projectId: project.id,
      query: 'security',
      mode: 'hierarchical' as const,
    };

    const primary = searchProjectDocuments(base);
    expect(primary.map(({ path }) => path)).toEqual([
      'security/overview.md',
      'security/vm/create.md',
    ]);
    expect(primary.every(({ relatedFrom }) => relatedFrom === undefined)).toBe(true);

    const expanded = searchProjectDocuments({ ...base, includeRelated: true });
    expect(expanded.map(({ path }) => path)).toEqual([
      'security/overview.md',
      'security/vm/create.md',
      'other/note.md',
    ]);
    expect(expanded[1]?.relatedFrom).toEqual([ids['security/overview.md']]);
    expect(expanded[2]?.relatedFrom).toEqual([
      ids['security/overview.md'],
      ids['security/vm/create.md'],
    ].sort());
    expect(readFileSync(databasePath)).toEqual(before);
  });

  it('sorts and bounds related additions deterministically', () => {
    const { projectRoot, knowledgeRoot, project } = createIndexedProject();
    const targetIds: string[] = [];
    for (let index = 0; index < 6; index += 1) {
      const created = createMarkdownDocument(knowledgeRoot, `related/item-${index}.md`, {
        metadata: {
          schema_version: 1,
          title: `Related ${index}`,
          type: 'document',
          depth: 2,
          status: 'draft',
        },
        body: `\nRelated document ${index}.\n`,
      });
      targetIds.push(created.metadata.id);
    }
    rebuildProjectIndex(projectRoot, project);
    const ids = getDocumentIds(projectRoot, project);
    addRelations(projectRoot, project, targetIds.map((targetId) => [
      ids['security/overview.md']!, targetId,
    ]));
    const base = {
      projectRoot,
      project,
      projectId: project.id,
      query: 'security/overview.md',
      mode: 'path',
      includeRelated: true,
    } as const;
    const results = searchProjectDocuments(base);
    expect(results.slice(1).map(({ path }) => path)).toEqual([
      'related/item-0.md',
      'related/item-1.md',
      'related/item-2.md',
      'related/item-3.md',
      'related/item-4.md',
    ]);
    const maximum = searchProjectDocuments({
      ...base,
      maxRelatedResults: 20,
    });
    expect(maximum).toHaveLength(7);

    expect(() => searchProjectDocuments({
      ...base,
      maxRelatedResults: 21,
    })).toThrow(InputError);
  }, 15_000);

  it('renders related paths with a clear CLI separator and source link', async () => {
    const { dataRoot, projectRoot, project } = createIndexedProject();
    const ids = getDocumentIds(projectRoot, project);
    addRelations(projectRoot, project, [[ids['security/overview.md']!, ids['other/note.md']!]]);
    const output: string[] = [];
    const exitCode = await runCli(
      [
        'node', 'qlm', 'search', 'security/overview.md', '--project', 'demo',
        '--mode', 'path', '--include-related',
      ],
      { writeOut: (text) => output.push(text), writeError: () => undefined },
      {
        runtimeFactory: () => ({
          dataRoot,
          logger: createApplicationLogger({ dataRoot, level: 'fatal' }),
        }),
      },
    );

    expect(exitCode).toBe(0);
    expect(output.join('')).toContain('- security/overview.md — Security Overview\n');
    expect(output.join('')).toContain(`Related to: ${ids['security/overview.md']}`);
    expect(output.join('')).toContain('- other/note.md — Other Note\n');
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

function getDocumentIds(projectRoot: string, project: ReturnType<typeof initializeProject>) {
  const database = openProjectDatabase(projectRoot, project);
  try {
    return Object.fromEntries(
      database.prepare('SELECT path, id FROM documents ORDER BY path').all()
        .map((row) => {
          const document = row as { path: string; id: string };
          return [document.path, document.id];
        }),
    ) as Record<string, string>;
  } finally {
    database.close();
  }
}

function addRelations(
  projectRoot: string,
  project: ReturnType<typeof initializeProject>,
  relations: Array<[string, string]>,
) {
  const database = openProjectDatabase(projectRoot, project);
  try {
    const insert = database.prepare(`
      INSERT OR IGNORE INTO document_relations (source_id, target_id, relation_type)
      VALUES (?, ?, 'related')
    `);
    for (const [sourceId, targetId] of relations) {
      insert.run(sourceId, targetId);
    }
  } finally {
    database.close();
  }
}
