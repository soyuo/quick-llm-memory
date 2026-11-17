import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  generateStructuredWithCache,
  type CachedGenerationRequest,
} from '../src/knowledge/generation-cache.js';
import type { AIProvider, StructuredRequest } from '../src/providers/provider.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('generation response cache', () => {
  it('reuses validated responses and stores only digests and the response', async () => {
    const root = makeProjectRoot();
    const provider = new FakeProvider();
    const input = createRequest(provider, root);

    expect(await generateStructuredWithCache(input)).toEqual({ body: 'generated', inferences: [] });
    expect(await generateStructuredWithCache(input)).toEqual({ body: 'generated', inferences: [] });
    expect(provider.calls).toBe(1);

    const cachePath = join(root, 'cache', 'generation', 'project-123');
    const files = readdirSync(cachePath);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^[0-9a-f]{64}\.json$/u);
    const entry = readFileSync(join(cachePath, files[0] ?? ''), 'utf8');
    expect(entry).toContain('generated');
    expect(entry).not.toContain('private source prompt');
    expect(entry).not.toContain('sk-test-secret');
  });

  it('invalidates entries when source content or generation settings change', async () => {
    const root = makeProjectRoot();
    const provider = new FakeProvider();
    const base = createRequest(provider, root);

    await generateStructuredWithCache(base);
    await generateStructuredWithCache({ ...base, sourceContentHash: 'new-source-hash' });
    await generateStructuredWithCache({
      ...base,
      request: { ...base.request, temperature: 0.7 },
    });
    await generateStructuredWithCache({
      ...base,
      request: { ...base.request, maxTokens: 100 },
    });
    await generateStructuredWithCache({
      ...base,
      request: { ...base.request, model: 'different-model' },
    });
    await generateStructuredWithCache({
      ...base,
      request: { ...base.request, prompt: 'changed prompt' },
    });
    await generateStructuredWithCache({
      ...base,
      request: { ...base.request, systemPrompt: 'changed system prompt' },
    });
    await generateStructuredWithCache({
      ...base,
      request: { ...base.request, schemaName: 'different_schema' },
    });
    await generateStructuredWithCache({
      ...base,
      request: { ...base.request, schema: { type: 'string' } },
    });
    const otherProvider = new FakeProvider();
    otherProvider.cacheIdentity = 'different-endpoint-digest';
    await generateStructuredWithCache({ ...base, provider: otherProvider });

    expect(provider.calls).toBe(9);
    expect(otherProvider.calls).toBe(1);
  });

  it('keeps entries isolated by project ID', async () => {
    const root = makeProjectRoot();
    const provider = new FakeProvider();
    const firstProject = createRequest(provider, root);
    await generateStructuredWithCache(firstProject);

    await generateStructuredWithCache({
      ...firstProject,
      options: { dataRoot: root, projectId: 'project-456', enabled: true },
    });

    expect(provider.calls).toBe(2);
    expect(readdirSync(join(root, 'cache', 'generation')).sort()).toEqual(['project-123', 'project-456']);
  });

  it('treats corrupt entries as misses and replaces them after validation', async () => {
    const root = makeProjectRoot();
    const provider = new FakeProvider();
    const input = createRequest(provider, root);
    await generateStructuredWithCache(input);

    const cachePath = join(root, 'cache', 'generation', 'project-123');
    const filename = readdirSync(cachePath)[0];
    expect(filename).toBeDefined();
    writeFileSync(join(cachePath, filename ?? ''), '{corrupt');

    await generateStructuredWithCache(input);
    expect(provider.calls).toBe(2);
    expect(JSON.parse(readFileSync(join(cachePath, filename ?? ''), 'utf8'))).toMatchObject({
      cacheVersion: 1,
    });
  });

  it('bypasses existing cache reads and writes when disabled', async () => {
    const root = makeProjectRoot();
    const provider = new FakeProvider();
    const enabled = createRequest(provider, root);
    await generateStructuredWithCache(enabled);
    const cachePath = join(root, 'cache', 'generation', 'project-123');
    const filename = readdirSync(cachePath)[0];
    const originalContents = readFileSync(join(cachePath, filename ?? ''), 'utf8');
    const disabled = createRequest(provider, root, false);

    await generateStructuredWithCache(disabled);
    await generateStructuredWithCache(disabled);

    expect(provider.calls).toBe(3);
    expect(readdirSync(cachePath)).toEqual([filename]);
    expect(readFileSync(join(cachePath, filename ?? ''), 'utf8')).toBe(originalContents);
  });

  it('keeps the project cache bounded to 128 entries', async () => {
    const root = makeProjectRoot();
    const provider = new FakeProvider();
    const input = createRequest(provider, root);

    for (let index = 0; index < 130; index += 1) {
      await generateStructuredWithCache({ ...input, sourceContentHash: `source-${index}` });
    }

    expect(readdirSync(join(root, 'cache', 'generation', 'project-123'))).toHaveLength(128);
  });

  it('does not cache responses larger than the per-entry limit', async () => {
    const root = makeProjectRoot();
    const provider = new FakeProvider({ body: 'x'.repeat(600 * 1024), inferences: [] });

    await generateStructuredWithCache(createRequest(provider, root));

    expect(readdirSync(join(root, 'cache', 'generation', 'project-123'))).toHaveLength(0);
  });

  it('does not persist responses rejected by the caller validator', async () => {
    const root = makeProjectRoot();
    const provider = new FakeProvider({ body: 42, inferences: [] });

    await expect(generateStructuredWithCache(createRequest(provider, root))).rejects.toThrow('Invalid cached response');
    expect(readdirSync(join(root, 'cache', 'generation', 'project-123'))).toHaveLength(0);
  });
});

function createRequest(
  provider: AIProvider,
  projectRoot: string,
  enabled = true,
): CachedGenerationRequest<{ body: string; inferences: string[] }> {
  const request: StructuredRequest<{ body: string; inferences: string[] }> = {
    model: 'test-model',
    prompt: 'private source prompt: sk-test-secret',
    systemPrompt: 'system instructions',
    temperature: 0,
    maxTokens: 200,
    schemaName: 'test_document',
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: { body: { type: 'string' }, inferences: { type: 'array' } },
      required: ['body', 'inferences'],
    },
  };
  return {
    provider,
    request,
    sourceContentHash: 'source-hash',
    options: { dataRoot: projectRoot, projectId: 'project-123', enabled },
    validate: validateResponse,
  };
}

function validateResponse(value: unknown): { body: string; inferences: string[] } {
  if (typeof value !== 'object' || value === null || !('body' in value) || !('inferences' in value)) {
    throw new Error('Invalid cached response');
  }
  const response = value as { body: unknown; inferences: unknown };
  if (typeof response.body !== 'string' || !Array.isArray(response.inferences) ||
    !response.inferences.every((item) => typeof item === 'string')) {
    throw new Error('Invalid cached response');
  }
  return { body: response.body, inferences: response.inferences };
}

function makeProjectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'qlm-generation-cache-'));
  temporaryDirectories.push(root);
  return root;
}

class FakeProvider implements AIProvider {
  id = 'test-provider';
  cacheIdentity?: string;
  calls = 0;

  constructor(private readonly response: unknown = { body: 'generated', inferences: [] }) {}

  async listModels() { return [{ id: 'test-model' }]; }

  async generate() { return { model: 'test-model', text: '' }; }

  async generateStructured<T>(_request: StructuredRequest<T>): Promise<T> {
    this.calls += 1;
    return this.response as T;
  }

  async countTokens() { return { count: 1, isEstimate: true }; }
}
