import { describe, expect, it } from 'vitest';
import type {
  AIProvider,
  EmbeddingProvider,
  GenerateRequest,
  StructuredRequest,
} from '../../src/providers/provider.js';

class FakeProvider implements AIProvider {
  readonly id = 'fake';

  async listModels() {
    return [{ id: 'fake-model', name: 'Fake model' }];
  }

  async generate(request: GenerateRequest) {
    return { model: request.model, text: request.prompt };
  }

  async generateStructured<T>(request: StructuredRequest<T>): Promise<T> {
    void request;
    return { title: 'Guide' } as T;
  }

  async countTokens(text: string, model: string) {
    return { count: text.length, isEstimate: model.startsWith('estimate-') };
  }
}

class FakeEmbeddingProvider implements EmbeddingProvider {
  readonly id = 'fake-embedding';

  async embed(texts: string[], _model: string) {
    return texts.map(() => [0.1, 0.2]);
  }
}

describe('provider contracts', () => {
  it('supports text, structured, model, token count, and embedding operations', async () => {
    const provider = new FakeProvider();
    const embeddingProvider = new FakeEmbeddingProvider();
    const request: GenerateRequest = { model: 'fake-model', prompt: 'Hello' };

    expect(await provider.listModels()).toEqual([
      { id: 'fake-model', name: 'Fake model' },
    ]);
    expect(await provider.generate(request)).toEqual({
      model: 'fake-model',
      text: 'Hello',
    });
    expect(
      await provider.generateStructured<{ title: string }>({
        ...request,
        schema: { type: 'object' },
      }),
    ).toEqual({ title: 'Guide' });
    expect(await provider.countTokens('Hello', 'fake-model')).toEqual({
      count: 5,
      isEstimate: false,
    });
    expect(await provider.countTokens('Hello', 'estimate-model')).toEqual({
      count: 5,
      isEstimate: true,
    });
    expect(await embeddingProvider.embed(['Hello'], 'embedding-model')).toEqual([
      [0.1, 0.2],
    ]);
  });
});
