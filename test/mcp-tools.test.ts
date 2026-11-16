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
  createMarkdownDocument(knowledgeRoot, 'security/overview.md', {
    metadata: {
      type: 'document', schema_version: 1, depth: 1, title: 'Security Overview',
      category: 'security', source_ids: ['source-1'], source_sections: ['source-1:section-1'],
      related: [], status: 'draft', created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
      generation: { provider: 'test', model: 'test', revision: 1 },
    },
    body: '\nAuthentication and access control.',
  });
  createMarkdownDocument(knowledgeRoot, 'security/deep/secrets.md', {
    metadata: {
      type: 'document', schema_version: 1, depth: 2, title: 'Secrets',
      category: 'security/deep', source_ids: [], source_sections: [], related: [],
      status: 'draft', created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
      generation: { provider: 'test', model: 'test', revision: 1 },
    },
    body: '\nSecret storage guidance.',
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

describe('MCP project, tree, and search tools', () => {
  it('advertises the three read-only tools and validated bounded schemas', async () => {
    const { dataRoot } = fixture();
    await withClient(dataRoot, async (client) => {
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name).sort()).toEqual([
        'memory_get_tree', 'memory_list_projects', 'memory_search',
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
});
