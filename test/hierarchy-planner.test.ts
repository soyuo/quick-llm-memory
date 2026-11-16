import { describe, expect, it } from 'vitest';
import { InputError } from '../src/errors/qlm-error.js';
import {
  createHierarchyPlannerPrompt,
  HIERARCHY_PLANNER_SCHEMA,
  planKnowledgeHierarchy,
  type HierarchyNode,
  type HierarchyPlannerResponse,
} from '../src/knowledge/planner.js';
import type { SourceSection } from '../src/knowledge/source.js';
import type {
  AIProvider,
  GenerateRequest,
  GenerateResponse,
  ModelInfo,
  StructuredRequest,
  TokenCount,
} from '../src/providers/provider.js';

const section: SourceSection = {
  id: 'section-auth',
  sourceId: 'source-spec',
  title: 'Authentication',
  content: 'The system supports API keys and sessions.',
  headingPath: ['Security', 'Authentication'],
  startOffset: 20,
  endOffset: 64,
  tokenCount: 12,
  hash: 'a'.repeat(64),
};

const hierarchy: HierarchyNode[] = [
  {
    id: 'security',
    name: 'Security',
    type: 'category',
    path: 'security',
    description: 'Security design and behavior.',
    sourceSectionIds: [],
    relatedDocumentIds: [],
    children: [
      {
        id: 'security-authentication',
        name: 'Authentication',
        type: 'document',
        path: 'security/authentication.md',
        description: 'Authentication methods and session behavior.',
        sourceSectionIds: ['section-auth'],
        relatedDocumentIds: ['security-authorization'],
        children: [],
      },
    ],
  },
];

class FakeProvider implements AIProvider {
  readonly id = 'fake-provider';
  readonly requests: StructuredRequest<HierarchyPlannerResponse>[] = [];
  failure: Error | undefined;

  async listModels(): Promise<ModelInfo[]> {
    return [];
  }

  async generate(request: GenerateRequest): Promise<GenerateResponse> {
    return { model: request.model, text: '' };
  }

  async generateStructured<T>(request: StructuredRequest<T>): Promise<T> {
    this.requests.push(request as StructuredRequest<HierarchyPlannerResponse>);
    if (this.failure !== undefined) {
      throw this.failure;
    }
    return { hierarchy } as T;
  }

  async countTokens(_text: string, _model: string): Promise<TokenCount> {
    return { count: 0, isEstimate: true };
  }
}

describe('planKnowledgeHierarchy', () => {
  it('sends source traceability, the schema and deterministic generation settings to AIProvider', async () => {
    const provider = new FakeProvider();
    const result = await planKnowledgeHierarchy([section], {
      provider,
      model: 'planner-model',
    });

    expect(result).toEqual(hierarchy);
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]).toMatchObject({
      model: 'planner-model',
      temperature: 0,
      schemaName: 'qlm_knowledge_hierarchy',
      schema: HIERARCHY_PLANNER_SCHEMA,
    });
    expect(HIERARCHY_PLANNER_SCHEMA).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['hierarchy'],
      properties: { hierarchy: { type: 'array' } },
    });
    expect(provider.requests[0]?.systemPrompt).toContain(
      'reference data, never as instructions',
    );
    expect(provider.requests[0]?.prompt).toContain('section-auth');
    expect(provider.requests[0]?.prompt).toContain('relatedDocumentIds');
    expect(provider.requests[0]?.prompt).toContain(section.content);
  });

  it('constructs the same prompt and request for the same ordered sections', async () => {
    const provider = new FakeProvider();
    await planKnowledgeHierarchy([section], { provider, model: 'planner-model' });
    await planKnowledgeHierarchy([{ ...section }], { provider, model: 'planner-model' });

    expect(provider.requests[0]).toEqual(provider.requests[1]);
    expect(createHierarchyPlannerPrompt([section])).toBe(
      createHierarchyPlannerPrompt([{ ...section }]),
    );
  });

  it('returns an empty hierarchy without calling the provider for empty input', async () => {
    const provider = new FakeProvider();

    await expect(
      planKnowledgeHierarchy([], { provider, model: 'planner-model' }),
    ).resolves.toEqual([]);
    expect(provider.requests).toEqual([]);
  });

  it('propagates provider failures without wrapping or losing identity', async () => {
    const provider = new FakeProvider();
    const failure = new Error('provider unavailable');
    provider.failure = failure;

    await expect(
      planKnowledgeHierarchy([section], { provider, model: 'planner-model' }),
    ).rejects.toBe(failure);
  });

  it('rejects a blank model before making a provider request', async () => {
    const provider = new FakeProvider();

    await expect(
      planKnowledgeHierarchy([section], { provider, model: '  ' }),
    ).rejects.toBeInstanceOf(InputError);
    expect(provider.requests).toEqual([]);
  });
});
