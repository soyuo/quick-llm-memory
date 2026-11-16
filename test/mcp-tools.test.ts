import { copyFileSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it } from 'vitest';
import { rebuildProjectIndex } from '../src/database/reindex.js';
import { resolveProjectDatabasePath } from '../src/database/database.js';
import { createMcpServer } from '../src/mcp/server.js';
import { createMarkdownDocument } from '../src/markdown/repository.js';
import { initializeProject } from '../src/projects/manager.js';

const roots: string[] = [];

function fixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'qlm-mcp-tools-'));
  roots.push(dataRoot);
  const project = initializeProject(dataRoot, 'demo');
  const projectRoot = join(dataRoot, 'projects', 'demo');
  const knowledgeRoot = join(projectRoot, 'knowledge');
  const secrets = createMarkdownDocument(knowledgeRoot, 'security/deep/secrets.md', {
    metadata: {
      type: 'document', schema_version: 1, depth: 2, title: 'Secrets',
      category: 'security/deep', source_ids: [], source_sections: [], related: [],
      status: 'draft', created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
      generation: { provider: 'test', model: 'test', revision: 1 },
    },
    body: '\nSecret storage guidance.',
  });
  createMarkdownDocument(knowledgeRoot, 'security/overview.md', {
    metadata: {
      type: 'document', schema_version: 1, depth: 1, title: 'Security Overview',
      category: 'security', source_ids: ['source-1'], source_sections: ['source-1:section-1'],
      related: [secrets.metadata.id], status: 'draft', created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
      generation: { provider: 'test', model: 'test', revision: 1 },
    },
    body: '\nAuthentication and access control.',
  });
  rebuildProjectIndex(projectRoot, project);
  return { dataRoot, projectRoot, knowledgeRoot };
}

async function withClient<T>(dataRoot: string, run: (client: Client) => Promise<T>): Promise<T> {
  const server = createMcpServer({ dataRoot });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'qlm-tools-test', version: '1.0.0' });
  try {
    await client.connect(clientTransport);
    return await run(client);
  } finally {
    await client.close();
    await server.close();
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('MCP read-only project tools', () => {
  it('advertises the three read-only tools and validated bounded schemas', async () => {
    const { dataRoot } = fixture();
    await withClient(dataRoot, async (client) => {
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name).sort()).toEqual([
        'memory_get_context', 'memory_get_metadata', 'memory_get_related',
        'memory_get_tree', 'memory_list_projects', 'memory_read', 'memory_read_many',
        'memory_search', 'memory_validate',
      ]);
      expect(tools.every((tool) => tool.annotations?.readOnlyHint === true)).toBe(true);
      const tree = tools.find((tool) => tool.name === 'memory_get_tree');
      expect(tree?.inputSchema.properties).toHaveProperty('maxDepth');
      expect(tree?.inputSchema.properties).toMatchObject({ maxEntries: { maximum: 500 } });
      const search = tools.find((tool) => tool.name === 'memory_search');
      expect(search?.inputSchema.properties).toMatchObject({
        mode: { enum: ['path', 'hierarchical', 'fulltext', 'hybrid'] },
        maxResults: { maximum: 100 },
      });
      const readMany = tools.find((tool) => tool.name === 'memory_read_many');
      expect(readMany?.inputSchema.properties).toMatchObject({
        max_tokens: { maximum: 100_000 },
      });
      expect(tools.filter((tool) => tool.name.startsWith('memory_get_') || tool.name === 'memory_validate')
        .every((tool) => tool.annotations?.readOnlyHint === true)).toBe(true);
    });
  });

  it('builds source-aware context within a token bound without changing project files', async () => {
    const { dataRoot, projectRoot, knowledgeRoot } = fixture();
    const databasePath = resolveProjectDatabasePath(projectRoot);
    const beforeDatabase = readFileSync(databasePath);
    const beforeMarkdown = readFileSync(join(knowledgeRoot, 'security/overview.md'));
    await withClient(dataRoot, async (client) => {
      const result = await client.callTool({
        name: 'memory_get_context',
        arguments: {
          project: 'demo', query: 'authentication', mode: 'fulltext', max_tokens: 1000,
        },
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        project: 'demo',
        documents: [{ path: 'security/overview.md', title: 'Security Overview' }],
        sources: [{ path: 'security/overview.md', sourceIds: ['source-1'] }],
        tokenCountsAreEstimates: true,
      });
      const context = result.structuredContent as {
        context: string; maxTokens: number; consumedTokens: number;
      };
      expect(context.context).toContain('Authentication');
      expect(context.consumedTokens).toBeLessThanOrEqual(context.maxTokens);
      expect(JSON.stringify(result.structuredContent)).not.toContain(dataRoot);

      const zero = await client.callTool({
        name: 'memory_get_context',
        arguments: { project: 'demo', query: 'authentication', mode: 'fulltext', max_tokens: 0 },
      });
      expect(zero.structuredContent).toMatchObject({
        context: '', documents: [], consumedTokens: 0,
      });
      const ignoredDepth = await client.callTool({
        name: 'memory_get_context',
        arguments: {
          project: 'demo', query: 'authentication', mode: 'fulltext', max_depth: 2,
        },
      });
      expect(ignoredDepth.isError).toBe(true);
      expect(JSON.stringify(ignoredDepth)).not.toContain(dataRoot);
      const hybridDepth = await client.callTool({
        name: 'memory_get_context',
        arguments: {
          project: 'demo', query: 'authentication', mode: 'hybrid', max_depth: 2,
        },
      });
      expect(hybridDepth.isError).toBe(true);
      expect(JSON.stringify(hybridDepth)).not.toContain(dataRoot);
    });
    expect(readFileSync(databasePath)).toEqual(beforeDatabase);
    expect(readFileSync(join(knowledgeRoot, 'security/overview.md'))).toEqual(beforeMarkdown);
  });

  it('returns only direct related documents with bounded results and safe relative references', async () => {
    const { dataRoot, projectRoot, knowledgeRoot } = fixture();
    const databasePath = resolveProjectDatabasePath(projectRoot);
    const beforeDatabase = readFileSync(databasePath);
    await withClient(dataRoot, async (client) => {
      const result = await client.callTool({
        name: 'memory_get_related',
        arguments: { project: 'demo', path: 'security/overview.md', max_results: 1 },
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        related: [{ path: 'security/deep/secrets.md', title: 'Secrets' }],
      });
      expect(JSON.stringify(result.structuredContent)).not.toContain(dataRoot);

      const none = await client.callTool({
        name: 'memory_get_related',
        arguments: { project: 'demo', path: 'security/overview.md', max_results: 0 },
      });
      expect(none.structuredContent).toMatchObject({ related: [] });
      const missing = await client.callTool({
        name: 'memory_get_related',
        arguments: { project: 'demo', path: '../outside.md' },
      });
      expect(missing.isError).toBe(true);
      expect(JSON.stringify(missing)).not.toContain(dataRoot);
      expect(readFileSync(databasePath)).toEqual(beforeDatabase);
      expect(readFileSync(join(knowledgeRoot, 'security/overview.md'))).toBeTruthy();
    });
  });

  it('validates project links and omits out-of-project targets and raw Markdown context', async () => {
    const { dataRoot, projectRoot, knowledgeRoot } = fixture();
    const sourcePath = join(knowledgeRoot, 'security/overview.md');
    const maliciousBody = readFileSync(sourcePath, 'utf8') +
      '\n[private](C:\\\\outside-secret\\\\key.md)\n';
    writeFileSync(sourcePath, maliciousBody);
    const databasePath = resolveProjectDatabasePath(projectRoot);
    const beforeDatabase = readFileSync(databasePath);
    await withClient(dataRoot, async (client) => {
      const result = await client.callTool({
        name: 'memory_validate',
        arguments: { project: 'demo' },
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        project: 'demo', valid: false,
        brokenLinks: [{ sourcePath: 'security/overview.md', reason: 'outside-root' }],
      });
      expect(JSON.stringify(result.structuredContent)).not.toContain('outside-secret');
      expect(JSON.stringify(result.structuredContent)).not.toContain(dataRoot);
      expect(readFileSync(sourcePath, 'utf8')).toBe(maliciousBody);
      expect(readFileSync(databasePath)).toEqual(beforeDatabase);
    });
  });

  it('lists initialized project metadata without filesystem paths', async () => {
    const { dataRoot } = fixture();
    await withClient(dataRoot, async (client) => {
      const result = await client.callTool({ name: 'memory_list_projects', arguments: {} });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        projects: [{ name: 'demo' }],
      });
      expect(JSON.stringify(result.structuredContent)).not.toContain(dataRoot);
    });
  });

  it('returns a depth-bounded relative tree and rejects invalid project input', async () => {
    const { dataRoot, knowledgeRoot } = fixture();
    writeFileSync(join(knowledgeRoot, 'security/deep/unreadable.md'), '---\ninvalid: [yaml\n---\n');
    await withClient(dataRoot, async (client) => {
      const result = await client.callTool({
        name: 'memory_get_tree',
        arguments: { project: 'demo', maxDepth: 2 },
      });
      expect(result.isError).not.toBe(true);
      const json = JSON.stringify(result.structuredContent);
      expect(json).toContain('security');
      expect(json).toContain('overview.md');
      expect(json).not.toContain('secrets.md');
      expect(json).not.toContain(dataRoot);

      const bounded = await client.callTool({
        name: 'memory_get_tree',
        arguments: { project: 'demo', maxDepth: 3, maxEntries: 3 },
      });
      expect(bounded.structuredContent).toMatchObject({ truncated: true });

      const invalid = await client.callTool({
        name: 'memory_get_tree',
        arguments: { project: '../outside' },
      });
      expect(invalid.isError).toBe(true);
      expect(JSON.stringify(invalid)).not.toContain(dataRoot);
    });
  });

  it('searches through the existing retrieval service and leaves the index unchanged', async () => {
    const { dataRoot, projectRoot, knowledgeRoot } = fixture();
    const databasePath = resolveProjectDatabasePath(projectRoot);
    const beforeDatabase = readFileSync(databasePath);
    const beforeMarkdown = readFileSync(join(knowledgeRoot, 'security/overview.md'));

    await withClient(dataRoot, async (client) => {
      const result = await client.callTool({
        name: 'memory_search',
        arguments: { project: 'demo', query: 'authentication', mode: 'fulltext', maxResults: 3 },
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        project: 'demo',
        results: [{ path: 'security/overview.md', title: 'Security Overview' }],
      });
      expect(JSON.stringify(result.structuredContent)).not.toContain(dataRoot);

      const invalid = await client.callTool({
        name: 'memory_search',
        arguments: { project: 'demo', query: '   ', mode: 'fulltext' },
      });
      expect(invalid.isError).toBe(true);
    });

    expect(readFileSync(databasePath)).toEqual(beforeDatabase);
    expect(readFileSync(join(knowledgeRoot, 'security/overview.md'))).toEqual(beforeMarkdown);
  });

  it('does not repair a stale full-text index during a read-only tool call', async () => {
    const { dataRoot, projectRoot, knowledgeRoot } = fixture();
    const databasePath = resolveProjectDatabasePath(projectRoot);
    const documentPath = join(knowledgeRoot, 'security/overview.md');
    const changedMarkdown = readFileSync(documentPath, 'utf8').replace(
      'Authentication and access control.',
      'Changed authentication content.',
    );
    writeFileSync(documentPath, changedMarkdown);
    const beforeDatabase = readFileSync(databasePath);

    await withClient(dataRoot, async (client) => {
      const result = await client.callTool({
        name: 'memory_search',
        arguments: { project: 'demo', query: 'authentication', mode: 'fulltext' },
      });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).not.toContain(dataRoot);
    });

    expect(readFileSync(databasePath)).toEqual(beforeDatabase);
    expect(readFileSync(documentPath, 'utf8')).toBe(changedMarkdown);
  });

  it('maps absolute index-path errors to a safe MCP error', async (context) => {
    const { dataRoot, projectRoot } = fixture();
    const databasePath = resolveProjectDatabasePath(projectRoot);
    const outsideRoot = mkdtempSync(join(tmpdir(), 'qlm-mcp-outside-index-'));
    roots.push(outsideRoot);
    const outsideDatabase = join(outsideRoot, 'knowledge.db');
    copyFileSync(databasePath, outsideDatabase);
    rmSync(databasePath);
    try {
      symlinkSync(outsideDatabase, databasePath, 'file');
    } catch {
      context.skip();
      return;
    }

    await withClient(dataRoot, async (client) => {
      const result = await client.callTool({
        name: 'memory_search',
        arguments: { project: 'demo', query: 'authentication', mode: 'fulltext' },
      });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).not.toContain(dataRoot);
      expect(JSON.stringify(result)).not.toContain(outsideRoot);
    });
  });

  it('reads one document and exposes validated metadata without local paths', async () => {
    const { dataRoot, knowledgeRoot } = fixture();
    const sourcePath = join(knowledgeRoot, 'security/overview.md');
    const before = readFileSync(sourcePath);
    await withClient(dataRoot, async (client) => {
      const read = await client.callTool({
        name: 'memory_read',
        arguments: { project: 'demo', path: 'security/overview.md' },
      });
      expect(read.isError).not.toBe(true);
      expect(read.structuredContent).toMatchObject({
        document: {
          path: 'security/overview.md',
          metadata: { title: 'Security Overview', source_ids: ['source-1'] },
          body: expect.stringContaining('Authentication'),
        },
      });
      const metadata = await client.callTool({
        name: 'memory_get_metadata',
        arguments: { project: 'demo', path: 'security/overview.md' },
      });
      expect(metadata.isError).not.toBe(true);
      expect(metadata.structuredContent).toMatchObject({
        path: 'security/overview.md',
        metadata: { title: 'Security Overview', source_ids: ['source-1'] },
      });
      expect(JSON.stringify(metadata.structuredContent)).not.toContain('Authentication');
      expect(JSON.stringify(read.structuredContent)).not.toContain(dataRoot);
      expect(readFileSync(sourcePath)).toEqual(before);
    });
  });

  it('reads many documents in stable order and respects max_tokens', async () => {
    const { dataRoot, knowledgeRoot } = fixture();
    const sourcePath = join(knowledgeRoot, 'security/overview.md');
    const databasePath = resolveProjectDatabasePath(join(dataRoot, 'projects', 'demo'));
    const sourceBefore = readFileSync(sourcePath);
    const databaseBefore = readFileSync(databasePath);
    await withClient(dataRoot, async (client) => {
      const paths = ['security/overview.md', 'security/deep/secrets.md'];
      const single = await client.callTool({
        name: 'memory_read_many',
        arguments: { project: 'demo', paths: [paths[0]], max_tokens: 100_000 },
      });
      const full = await client.callTool({
        name: 'memory_read_many',
        arguments: { project: 'demo', paths, max_tokens: 100_000 },
      });
      const fullDocuments = (full.structuredContent as {
        documents: Array<{ path: string }>;
      }).documents;
      expect(fullDocuments).toHaveLength(paths.length);
      expect(fullDocuments.map((document) => document.path)).toEqual(
        [...fullDocuments.map((document) => document.path)].sort(),
      );
      const singleTokens = (single.structuredContent as { consumedTokens: number }).consumedTokens;
      const fullTokens = (full.structuredContent as { consumedTokens: number }).consumedTokens;
      const budget = Math.ceil((singleTokens + fullTokens) / 2);
      const bounded = await client.callTool({
        name: 'memory_read_many',
        arguments: { project: 'demo', paths, max_tokens: budget },
      });
      expect(bounded.isError).not.toBe(true);
      const result = bounded.structuredContent as {
        documents: Array<{ path: string }>;
        maxTokens: number;
        consumedTokens: number;
        omittedCount: number;
      };
      expect(result.consumedTokens).toBeLessThanOrEqual(budget);
      expect(result.documents.length).toBeGreaterThan(0);
      expect(result.documents.length).toBeLessThan(paths.length);
      expect(result.documents.map((document) => document.path)).toEqual(
        [...result.documents.map((document) => document.path)].sort(),
      );
      expect(result.maxTokens).toBe(budget);
      expect(result.omittedCount).toBe(paths.length - result.documents.length);

      const zero = await client.callTool({
        name: 'memory_read_many',
        arguments: { project: 'demo', paths, max_tokens: 0 },
      });
      expect(zero.structuredContent).toMatchObject({
        documents: [], consumedTokens: 0, omittedCount: paths.length,
      });
      const invalidBudget = await client.callTool({
        name: 'memory_read_many',
        arguments: { project: 'demo', paths, max_tokens: 100_001 },
      });
      expect(invalidBudget.isError).toBe(true);
      expect(readFileSync(sourcePath)).toEqual(sourceBefore);
      expect(readFileSync(databasePath)).toEqual(databaseBefore);
    });
  });

  it('rejects unsafe and missing document paths without exposing absolute paths', async () => {
    const { dataRoot } = fixture();
    await withClient(dataRoot, async (client) => {
      for (const path of ['../outside.md', 'C:\\outside.md', 'missing.md']) {
        const result = await client.callTool({
          name: 'memory_read',
          arguments: { project: 'demo', path },
        });
        expect(result.isError).toBe(true);
        expect(JSON.stringify(result)).not.toContain(dataRoot);
      }
    });
  });
});
