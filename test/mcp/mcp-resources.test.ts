import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveProjectDatabasePath } from '../../src/database/database.js';
import { createMcpServer } from '../../src/mcp/server.js';
import { parseKnowledgeResourceUri } from '../../src/mcp/resources.js';
import { createMarkdownDocument } from '../../src/markdown/repository.js';
import { initializeProject } from '../../src/projects/manager.js';

const roots: string[] = [];

function fixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'qlm-mcp-resources-'));
  roots.push(dataRoot);
  initializeProject(dataRoot, 'demo');
  const projectRoot = join(dataRoot, 'projects', 'demo');
  const knowledgeRoot = join(projectRoot, 'knowledge');
  mkdirSync(join(knowledgeRoot, 'security'), { recursive: true });
  writeFileSync(
    join(knowledgeRoot, 'index.md'),
    '---\nid: root-index\ntitle: Demo\ndepth: 0\ntype: category-index\n---\n# Demo\n',
  );
  writeFileSync(
    join(knowledgeRoot, 'security', 'index.md'),
    '---\nid: security-index\ntitle: Security\ndepth: 1\ntype: category-index\n---\n# Security\n',
  );
  createMarkdownDocument(knowledgeRoot, 'security/overview.md', {
    metadata: {
      type: 'document',
      schema_version: 1,
      depth: 1,
      title: 'Security Overview',
      category: 'security',
      source_ids: [],
      source_sections: [],
      related: [],
      status: 'draft',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
      generation: { provider: 'test', model: 'test', revision: 1 },
    },
    body: '\nSecurity guidance.\n',
  });
  return { dataRoot, projectRoot, knowledgeRoot };
}

async function withClient<T>(dataRoot: string, run: (client: Client) => Promise<T>) {
  const server = createMcpServer({ dataRoot });
  const client = new Client({ name: 'resource-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    return await run(client);
  } finally {
    await Promise.all([client.close(), server.close()]);
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('MCP knowledge resources', () => {
  it('parses canonical project-relative Markdown resource URIs', () => {
    expect(parseKnowledgeResourceUri('qlm://demo/security/overview.md')).toEqual({
      project: 'demo',
      path: 'security/overview.md',
    });
    expect(parseKnowledgeResourceUri('qlm://demo/security/space%20name.md')).toEqual({
      project: 'demo',
      path: 'security/space name.md',
    });
  });

  it.each([
    'file://demo/security/overview.md',
    'qlm://demo/%2e%2e/secret.md',
    'qlm://demo/security%2Foverview.md',
    'qlm://demo/security\\overview.md',
    'qlm://demo/security/overview.txt',
    'qlm://demo//security/overview.md',
    'qlm://demo/security/overview.md?raw=1',
  ])('rejects unsafe or unsupported URI %s', (uri) => {
    expect(() => parseKnowledgeResourceUri(uri)).toThrow();
  });

  it('lists and reads root/category indexes and documents without local paths', async () => {
    const { dataRoot, projectRoot, knowledgeRoot } = fixture();
    const docPath = join(knowledgeRoot, 'security', 'overview.md');
    const originalMarkdown = readFileSync(docPath);
    const databasePath = resolveProjectDatabasePath(projectRoot);
    expect(existsSync(databasePath)).toBe(false);

    await withClient(dataRoot, async (client) => {
      const listing = await client.listResources();
      const resources = listing.resources;
      expect(resources.map((resource) => resource.uri)).toEqual([
        'qlm://demo/index.md',
        'qlm://demo/security/index.md',
        'qlm://demo/security/overview.md',
      ]);
      expect(JSON.stringify(resources)).not.toContain(dataRoot);
      expect(resources.every((resource) => resource.mimeType === 'text/markdown')).toBe(true);
      expect(resources.map((resource) => resource.title)).toEqual([
        'index.md',
        'security/index.md',
        'security/overview.md',
      ]);

      const root = await client.readResource({ uri: 'qlm://demo/index.md' });
      expect(textContent(root.contents[0])).toContain('type: category-index');
      const category = await client.readResource({ uri: 'qlm://demo/security/index.md' });
      expect(textContent(category.contents[0])).toContain('title: Security');
      const document = await client.readResource({ uri: 'qlm://demo/security/overview.md' });
      expect(textContent(document.contents[0])).toContain('Security guidance.');
      expect(document.contents[0]?.uri).toBe('qlm://demo/security/overview.md');
      expect(JSON.stringify([root, category, document])).not.toContain(dataRoot);
    });

    expect(readFileSync(docPath)).toEqual(originalMarkdown);
    expect(existsSync(databasePath)).toBe(false);
  });

  it('returns safe errors for unknown projects and escaping or symlinked paths', async () => {
    const { dataRoot, knowledgeRoot } = fixture();
    const outsideRoot = mkdtempSync(join(tmpdir(), 'qlm-mcp-resource-outside-'));
    roots.push(outsideRoot);
    const outside = join(outsideRoot, 'secret.md');
    writeFileSync(outside, 'private outside content');
    let symlinkCreated = true;
    let directoryJunctionCreated = true;
    try {
      symlinkSync(outside, join(knowledgeRoot, 'security', 'escape.md'), 'file');
    } catch {
      symlinkCreated = false;
    }
    try {
      symlinkSync(outsideRoot, join(knowledgeRoot, 'linked-outside'), 'junction');
    } catch {
      directoryJunctionCreated = false;
    }
    if (process.platform === 'win32') {
      expect(directoryJunctionCreated).toBe(true);
    }

    await withClient(dataRoot, async (client) => {
      const unknown = await client.readResource({ uri: 'qlm://missing/index.md' }).catch((error: unknown) => error);
      expect(String(unknown)).toContain('Requested project knowledge resource is unavailable.');
      expect(String(unknown)).not.toContain(dataRoot);
      const normalizedTraversal = await client.readResource({
        uri: 'qlm://demo/%2e%2e/security/overview.md',
      });
      expect(normalizedTraversal.contents[0]?.uri).toBe(
        'qlm://demo/security/overview.md',
      );
      expect(JSON.stringify(normalizedTraversal)).not.toContain(dataRoot);
      expect(JSON.stringify(normalizedTraversal)).not.toContain('private outside content');
      const outsideTraversal = await client.readResource({
        uri: `qlm://demo/../${encodeURIComponent(outside)}`,
      }).catch((error: unknown) => error);
      expect(String(outsideTraversal)).toContain('Requested project knowledge resource is unavailable.');
      expect(String(outsideTraversal)).not.toContain(dataRoot);
      expect(String(outsideTraversal)).not.toContain('private outside content');
      if (symlinkCreated) {
        const symlink = await client.readResource({
          uri: 'qlm://demo/security/escape.md',
        }).catch((error: unknown) => error);
        expect(String(symlink)).toContain('Requested project knowledge resource is unavailable.');
        expect(String(symlink)).not.toContain(dataRoot);
      }
      if (directoryJunctionCreated) {
        const resources = await client.listResources();
        expect(resources.resources.some((resource) => resource.uri.includes('linked-outside'))).toBe(false);
        const junction = await client.readResource({
          uri: 'qlm://demo/linked-outside/secret.md',
        }).catch((error: unknown) => error);
        expect(String(junction)).toContain('Requested project knowledge resource is unavailable.');
        expect(String(junction)).not.toContain(dataRoot);
        expect(String(junction)).not.toContain('private outside content');
      }
    });
  });
});

function textContent(content: { uri: string; text?: unknown; blob?: unknown } | undefined): string {
  if (content !== null && typeof content === 'object' && 'text' in content) {
    return String(content.text);
  }
  return '';
}
