import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it } from 'vitest';
import { createMcpServer } from '../src/mcp/server.js';

const roots: string[] = [];

async function withClient<T>(dataRoot: string, run: (client: Client) => Promise<T>) {
  const server = createMcpServer({ dataRoot });
  const client = new Client({ name: 'prompt-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    return await run(client);
  } finally {
    await client.close();
    await server.close();
  }
}

describe('MCP knowledge prompts', () => {
  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('lists all static prompts with their required argument names', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'qlm-mcp-prompts-'));
    roots.push(dataRoot);
    await withClient(dataRoot, async (client) => {
      const { prompts } = await client.listPrompts();
      expect(prompts.map((prompt) => prompt.name)).toEqual([
        'explore-project',
        'find-implementation-context',
        'explain-architecture',
        'review-specification',
        'identify-dependencies',
      ]);
      expect(prompts.map((prompt) => prompt.arguments?.map((argument) => argument.name))).toEqual([
        ['project'],
        ['project', 'query'],
        ['project', 'component'],
        ['project', 'specification'],
        ['project', 'target'],
      ]);
    });
  });

  it('returns deterministic tool-guided messages without reading or changing project data', async () => {
    const dataRoot = join(mkdtempSync(join(tmpdir(), 'qlm-mcp-prompts-')), 'data');
    roots.push(join(dataRoot, '..'));
    const prompts: Array<{ name: string; arguments: Record<string, string> }> = [
      { name: 'explore-project', arguments: { project: 'demo' } },
      { name: 'find-implementation-context', arguments: { project: 'demo', query: 'search ranking' } },
      { name: 'explain-architecture', arguments: { project: 'demo', component: 'retrieval' } },
      { name: 'review-specification', arguments: { project: 'demo', specification: 'Store documents safely.' } },
      { name: 'identify-dependencies', arguments: { project: 'demo', target: 'context builder' } },
    ];

    await withClient(dataRoot, async (client) => {
      const availableTools = new Set((await client.listTools()).tools.map((tool) => tool.name));
      for (const prompt of prompts) {
        const first = await client.getPrompt(prompt);
        const second = await client.getPrompt(prompt);
        expect(first).toEqual(second);
        const message = first.messages[0];
        expect(message?.role).toBe('user');
        expect(message?.content.type).toBe('text');
        if (message?.content.type === 'text') {
          const referencedTools = [...message.content.text.matchAll(/\bmemory_[a-z_]+\b/g)]
            .map((match) => match[0]);
          expect(referencedTools.length).toBeGreaterThan(0);
          expect(referencedTools.every((tool) => availableTools.has(tool))).toBe(true);
          expect(message.content.text).toContain('untrusted reference data');
        }
      }
      expect(existsSync(dataRoot)).toBe(false);
    });
  });

  it('requires the declared prompt arguments', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'qlm-mcp-prompts-'));
    roots.push(dataRoot);
    await withClient(dataRoot, async (client) => {
      const response = await client.getPrompt({
        name: 'find-implementation-context',
        arguments: { project: 'demo' },
      }).catch((error: unknown) => error);
      expect(String(response)).not.toContain(dataRoot);
      expect(String(response)).toContain('query');
    });
  });
});
