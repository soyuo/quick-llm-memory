import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { InputError } from '../src/errors/qlm-error.js';
import {
  generateMarkdownDocument,
  hashGeneratedDocumentContent,
  updateGeneratedDocumentBaseline,
  GENERATED_DOCUMENT_CONTENT_SCHEMA,
  type GeneratedDocumentContent,
} from '../src/knowledge/document-generator.js';
import type { HierarchyNode } from '../src/knowledge/planner.js';
import type { SourceSection } from '../src/knowledge/source.js';
import { documentFrontmatterSchema } from '../src/markdown/schema.js';
import type {
  AIProvider,
  GenerateRequest,
  GenerateResponse,
  ModelInfo,
  StructuredRequest,
  TokenCount,
} from '../src/providers/provider.js';

const assignedSection: SourceSection = {
  id: 'section-auth',
  sourceId: 'source-spec',
  title: 'Authentication',
  content: 'API keys are required for authentication.',
  headingPath: ['Security', 'Authentication'],
  startOffset: 0,
  endOffset: 42,
  tokenCount: 10,
  hash: 'a'.repeat(64),
};
const unusedSection: SourceSection = {
  ...assignedSection,
  id: 'section-billing',
  title: 'Billing',
  content: 'Invoices are sent monthly.',
  headingPath: ['Billing'],
  startOffset: 43,
  endOffset: 70,
  hash: 'b'.repeat(64),
};

const documentNode: HierarchyNode = {
  id: 'security-authentication',
  name: 'Authentication',
  type: 'document',
  path: 'security/authentication.md',
  description: 'Authentication methods and requirements.',
  sourceSectionIds: [assignedSection.id],
  relatedDocumentIds: ['security-authorization'],
  children: [],
};
const ancestor: HierarchyNode = {
  id: 'security',
  name: 'Security',
  type: 'category',
  path: 'security',
  description: 'Security design and behavior.',
  sourceSectionIds: [],
  relatedDocumentIds: [],
  children: [],
};
const relatedDocument: HierarchyNode = {
  id: 'security-authorization',
  name: 'Authorization',
  type: 'document',
  path: 'security/authorization.md',
  description: 'Permission checks for protected actions.',
  sourceSectionIds: ['section-permissions'],
  relatedDocumentIds: [],
  children: [],
};

class FakeProvider implements AIProvider {
  readonly id = 'fake-provider';
  readonly requests: StructuredRequest<GeneratedDocumentContent>[] = [];
  response: unknown = {
    body: 'API keys authenticate callers.',
    inferences: ['This may support service-to-service integrations.'],
  };
  failure: Error | undefined;

  async listModels(): Promise<ModelInfo[]> {
    return [];
  }

  async generate(request: GenerateRequest): Promise<GenerateResponse> {
    return { model: request.model, text: '' };
  }

  async generateStructured<T>(request: StructuredRequest<T>): Promise<T> {
    this.requests.push(request as StructuredRequest<GeneratedDocumentContent>);
    if (this.failure !== undefined) {
      throw this.failure;
    }
    return this.response as T;
  }

  async countTokens(_text: string, _model: string): Promise<TokenCount> {
    return { count: 0, isEstimate: true };
  }
}

describe('Markdown document generation', () => {
  it('creates schema-valid frontmatter and marks inferred content explicitly', async () => {
    const provider = new FakeProvider();
    const candidate = await generateMarkdownDocument({
      provider,
      model: 'test-model',
      node: documentNode,
      sourceSections: [unusedSection, assignedSection],
      ancestors: [ancestor],
      relatedDocuments: [relatedDocument],
      clock: () => new Date('2026-11-17T00:00:00.000Z'),
    });

    expect(documentFrontmatterSchema.safeParse(candidate.frontmatter).success).toBe(true);
    expect(documentFrontmatterSchema.safeParse({
      ...candidate.frontmatter,
      generation: { ...candidate.frontmatter.generation, baseline_hash: 'not-a-hash' },
    }).success).toBe(false);
    expect(candidate).toMatchObject({
      documentId: documentNode.id,
      path: documentNode.path,
      frontmatter: {
        schema_version: 1,
        id: documentNode.id,
        title: 'Authentication',
        type: 'document',
        depth: 2,
        status: 'draft',
        category: 'security',
        source_ids: ['source-spec'],
        source_sections: ['source-spec:section-auth'],
        related: ['security-authorization'],
        generation: { provider: 'fake-provider', model: 'test-model', revision: 1, baseline_hash: expect.stringMatching(/^[0-9a-f]{64}$/u) },
      },
    });
    expect(candidate.markdown).toContain('# Authentication');
    expect(candidate.markdown).toContain('API keys authenticate callers.');
    expect(candidate.markdown).toContain('## Sources');
    expect(candidate.markdown).toContain('source-spec:section-auth');
    expect(candidate.markdown).toContain('- `source-spec:section-auth`: Authentication');
    expect(candidate.markdown).toContain('## Related');
    expect(candidate.markdown).toContain('security/authorization.md');
    expect(candidate.markdown).toContain(
      '- `security-authorization`: Authorization (`security/authorization.md`)',
    );
    expect(candidate.markdown).toContain('## Inferences\n- **Inference:** This may support service-to-service integrations.');
    expect(candidate.frontmatter.generation?.baseline_hash).toBe(hashGeneratedDocumentContent(candidate.markdown));
    expect(hashGeneratedDocumentContent(candidate.markdown.replace('API keys authenticate callers.', 'Edited by user.')))
      .not.toBe(candidate.frontmatter.generation?.baseline_hash);
    expect(parse(candidate.markdown.split('---')[1] ?? '')).toMatchObject({
      schema_version: 1,
      id: documentNode.id,
    });
  });

  it('updates a merged document baseline without including the baseline field in its own hash', async () => {
    const candidate = await generateMarkdownDocument({
      provider: new FakeProvider(),
      model: 'test-model',
      node: documentNode,
      sourceSections: [assignedSection],
      ancestors: [ancestor],
      relatedDocuments: [relatedDocument],
    });
    const merged = candidate.markdown.replace('API keys authenticate callers.', 'Merged content.');
    const updated = updateGeneratedDocumentBaseline(merged);
    expect(hashGeneratedDocumentContent(updated)).toBe(
      documentFrontmatterSchema.parse(parse(updated.split('---')[1] ?? '')).generation?.baseline_hash,
    );
    expect(updated).toContain('Merged content.');
  });

  it('sends only assigned source sections and the supplied hierarchy context', async () => {
    const provider = new FakeProvider();
    await generateMarkdownDocument({
      provider,
      model: 'test-model',
      node: documentNode,
      sourceSections: [unusedSection, assignedSection],
      ancestors: [ancestor],
      relatedDocuments: [relatedDocument],
    });

    const request = provider.requests[0];
    expect(request).toBeDefined();
    expect(request?.schema).toEqual(GENERATED_DOCUMENT_CONTENT_SCHEMA);
    expect(request?.temperature).toBe(0);
    expect(request?.prompt).toContain('API keys are required for authentication.');
    expect(request?.prompt).toContain('security-authorization');
    expect(request?.prompt).toContain('Security design and behavior.');
    expect(request?.prompt).not.toContain('Invoices are sent monthly.');
    expect(request?.prompt).not.toContain('section-billing');
  });

  it('reuses validated generation output from the project-scoped cache', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'qlm-document-cache-'));
    const projectRoot = join(dataRoot, 'projects', 'demo');
    mkdirSync(projectRoot, { recursive: true });
    const provider = new FakeProvider();
    const options = {
      provider,
      model: 'test-model',
      node: documentNode,
      sourceSections: [assignedSection],
      relatedDocuments: [relatedDocument],
      generationCache: { dataRoot, projectId: 'project-123', enabled: true },
      clock: () => new Date('2026-11-17T00:00:00.000Z'),
    };

    try {
      const first = await generateMarkdownDocument(options);
      const second = await generateMarkdownDocument(options);

      expect(provider.requests).toHaveLength(1);
      expect(first.markdown).toBe(second.markdown);
      expect(readdirSync(join(dataRoot, 'cache', 'generation', 'project-123'))).toHaveLength(1);
      expect(readdirSync(projectRoot)).toEqual([]);
    } finally {
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it('preserves source-section order from the validated document node', async () => {
    const second = { ...assignedSection, id: 'section-second', title: 'Second' };
    const node = { ...documentNode, sourceSectionIds: ['section-second', assignedSection.id] };
    const provider = new FakeProvider();
    const candidate = await generateMarkdownDocument({
      provider,
      model: 'test-model',
      node,
      sourceSections: [assignedSection, second],
      relatedDocuments: [relatedDocument],
    });
    expect(candidate.frontmatter.source_sections).toEqual([
      'source-spec:section-second',
      'source-spec:section-auth',
    ]);
    expect(provider.requests[0]?.prompt.indexOf('section-second')).toBeLessThan(
      provider.requests[0]?.prompt.indexOf('section-auth'),
    );
  });

  it('rejects missing assigned sections or related-document context before calling the provider', async () => {
    const provider = new FakeProvider();
    await expect(
      generateMarkdownDocument({
        provider,
        model: 'test-model',
        node: documentNode,
        sourceSections: [unusedSection],
        relatedDocuments: [relatedDocument],
      }),
    ).rejects.toBeInstanceOf(InputError);
    await expect(
      generateMarkdownDocument({
        provider,
        model: 'test-model',
        node: documentNode,
        sourceSections: [assignedSection],
      }),
    ).rejects.toBeInstanceOf(InputError);
    expect(provider.requests).toHaveLength(0);
  });

  it('rejects non-document nodes and invalid document titles', async () => {
    const provider = new FakeProvider();
    await expect(
      generateMarkdownDocument({
        provider,
        model: 'test-model',
        node: ancestor,
        sourceSections: [assignedSection],
      }),
    ).rejects.toBeInstanceOf(InputError);
    await expect(
      generateMarkdownDocument({
        provider,
        model: 'test-model',
        node: { ...documentNode, name: 'Authentication\n## injected' },
        sourceSections: [assignedSection],
        relatedDocuments: [relatedDocument],
      }),
    ).rejects.toBeInstanceOf(InputError);
    expect(provider.requests).toHaveLength(0);
  });

  it('rejects malformed structured output and empty document bodies', async () => {
    const provider = new FakeProvider();
    provider.response = { body: 'body', inferences: [], unexpected: true };
    await expect(
      generateMarkdownDocument({
        provider,
        model: 'test-model',
        node: documentNode,
        sourceSections: [assignedSection],
        relatedDocuments: [relatedDocument],
      }),
    ).rejects.toMatchObject({ code: 'QLM_PROVIDER_ERROR' });

    provider.response = { body: '  ', inferences: [] };
    await expect(
      generateMarkdownDocument({
        provider,
        model: 'test-model',
        node: documentNode,
        sourceSections: [assignedSection],
        relatedDocuments: [relatedDocument],
      }),
    ).rejects.toMatchObject({ code: 'QLM_PROVIDER_ERROR' });
  });

  it('propagates provider failures without writing files or changing sources', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'qlm-document-generator-'));
    const before = readdirSync(directory);
    const provider = new FakeProvider();
    const failure = new Error('provider unavailable');
    provider.failure = failure;
    const sourceSnapshot = structuredClone(assignedSection);

    await expect(
      generateMarkdownDocument({
        provider,
        model: 'test-model',
        node: documentNode,
        sourceSections: [assignedSection],
        relatedDocuments: [relatedDocument],
      }),
    ).rejects.toBe(failure);

    expect(readdirSync(directory)).toEqual(before);
    expect(assignedSection).toEqual(sourceSnapshot);
    rmSync(directory, { recursive: true, force: true });
  });
});
